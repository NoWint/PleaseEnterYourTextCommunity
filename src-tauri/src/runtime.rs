use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use deltachat::accounts::Accounts;
use deltachat::chat::{self, ChatId};
use deltachat::config::Config;
use deltachat::contact::Contact;
use deltachat::message::{Message, MsgId, Viewtype};
use deltachat::EventType;
use tokio::sync::{Mutex, Semaphore};

use crate::activity::ActivityLog;
use crate::db::{BotRow, Db};
use crate::dto::{BotConfig, bot_activity_kind as act};
use crate::drivers::{BotDriver, BotRuntime, DriverRegistry, IncomingMsg, driver_kind_label};

/// 全局并发上限:跨所有 bot 的 LLM/驱动调用总数。
/// 未抢到 permit 的进站事件直接丢弃(不排队,避免内存无界增长)。
const GLOBAL_MAX_CONCURRENT: usize = 4;

/// 无有效配置时 NO_CONFIG 活动写入的节流间隔。
const DEFAULT_RECORD_INTERVAL: Duration = Duration::from_secs(3);

/// 启动 bot 事件调度器。常驻后台:接收所有账号 IncomingMsg,
/// 命中 bot_ids 后快速 spawn 处理任务(并发受信号量限制)。
pub async fn spawn(
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
    bot_ids: Arc<Mutex<HashSet<u32>>>,
    activity: ActivityLog,
    registry: DriverRegistry,
    data_dir: PathBuf,
) {
    let emitter = {
        let accounts = accounts.lock().await;
        accounts.get_event_emitter()
    };
    let global = Arc::new(Semaphore::new(GLOBAL_MAX_CONCURRENT));
    let per_bot: Arc<Mutex<HashMap<u32, (u32, Arc<Semaphore>)>>> = Arc::new(Mutex::new(HashMap::new()));
    let rate: Arc<RateLimiter> = Arc::new(RateLimiter::new());
    // Bot 间互动轮数:(bot 账号 id, chat id) → 连续 bot→bot 回复计数
    let bot_rounds: Arc<Mutex<HashMap<(u32, u32), u32>>> = Arc::new(Mutex::new(HashMap::new()));

    // 事件循环:接收所有账号 IncomingMsg,命中 bot_ids 后快速 spawn 处理任务
    let event_loop = async {
        while let Some(event) = emitter.recv().await {
            let EventType::IncomingMsg { chat_id, msg_id } = event.typ else {
                continue;
            };
            let account_id = event.id;
            let is_bot = {
                bot_ids.lock().await.contains(&account_id)
            };
            if !is_bot {
                continue;
            }

            let accounts = accounts.clone();
            let db = db.clone();
            let bot_ids = bot_ids.clone();
            let activity = activity.clone();
            let registry = registry.clone();
            let data_dir = data_dir.clone();
            let global = global.clone();
            let per_bot = per_bot.clone();
            let rate = rate.clone();
            let bot_rounds = bot_rounds.clone();
            tokio::spawn(async move {
                // 未抢到全局 permit 的事件直接丢弃(不排队,避免任务无界堆积)
                let Ok(_permit) = global.try_acquire() else {
                    log::debug!("bot {account_id}: global 并发超限,丢弃事件");
                    return;
                };
                handle_bot_message(
                    &accounts, &db, &bot_ids, &activity, &registry, &per_bot, &rate,
                    &bot_rounds, &data_dir, account_id, chat_id, msg_id,
                )
                .await;
            });
        }
    };

    // 定时 tick:每 30s 调度一次各驱动 on_tick,与消息循环并行
    let tick = tick_loop(
        accounts.clone(),
        db.clone(),
        activity.clone(),
        registry.clone(),
        data_dir.clone(),
    );

    tokio::join!(event_loop, tick);
}

#[allow(clippy::too_many_arguments)]
async fn handle_bot_message(
    accounts: &Arc<Mutex<Accounts>>,
    db: &Arc<Db>,
    bot_ids: &Arc<Mutex<HashSet<u32>>>,
    activity: &ActivityLog,
    registry: &DriverRegistry,
    per_bot: &Arc<Mutex<HashMap<u32, (u32, Arc<Semaphore>)>>>,
    rate: &Arc<RateLimiter>,
    bot_rounds: &Arc<Mutex<HashMap<(u32, u32), u32>>>,
    data_dir: &PathBuf,
    account_id: u32,
    chat_id: ChatId,
    msg_id: MsgId,
) {
    // 限流/节流间隔:config 解析前先用默认值(NO_CONFIG 活动节流),解析后用配置值
    let mut interval = DEFAULT_RECORD_INTERVAL;

    let row = match db.get_bot_by_account_id(account_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return,
        Err(e) => {
            log::warn!("bot {account_id}: query row failed: {e}");
            return;
        }
    };
    let bot_id = row.id;
    if row.status != "running" {
        log::debug!("bot {bot_id}: status != running, skip");
        return;
    }

    // config_json 单独查询(BotRow 不含该列)
    let config_json = match db.get_bot_config_by_id(bot_id).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("bot {bot_id}: query config failed: {e}");
            return;
        }
    };
    let Some(config) = BotConfig::parse(config_json.as_deref()) else {
        // 节流:同一会话在间隔内至多写一条 NO_CONFIG,避免洪水刷爆活动表
        if !rate.should_record(bot_id, chat_id.to_u32(), interval) {
            return;
        }
        activity
            .record(
                bot_id,
                act::NO_CONFIG,
                Some(chat_id.to_u32()),
                Some(msg_id.to_u32()),
                format!("bot {bot_id}: 无有效配置,跳过自动回复"),
                None,
            )
            .await;
        return;
    };
    interval = Duration::from_secs(config.limits.reply_min_interval_secs.max(1));

    // 每 bot 并发信号量(按账号缓存;max_concurrent 变更时重建)
    let max_concurrent = config.limits.max_concurrent.max(1) as u32;
    let sema = {
        let mut map = per_bot.lock().await;
        match map.get(&account_id) {
            Some((cached_max, sema)) if *cached_max == max_concurrent => sema.clone(),
            _ => {
                let sema = Arc::new(Semaphore::new(max_concurrent as usize));
                map.insert(account_id, (max_concurrent, sema.clone()));
                sema
            }
        }
    };
    // 未抢到 permit 的事件直接丢弃(记 reply_skipped 活动),不排队
    let _permit = match sema.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            activity
                .record(
                    bot_id,
                    act::REPLY_SKIPPED,
                    Some(chat_id.to_u32()),
                    Some(msg_id.to_u32()),
                    "并发超限,本次丢弃",
                    None,
                )
                .await;
            return;
        }
    };

    // 短取 context + 触发消息 + 发送者
    let ctx = {
        accounts.lock().await.get_account(account_id)
    };
    let Some(ctx) = ctx else {
        log::warn!("bot {bot_id} (account {account_id}) context unavailable");
        return;
    };
    let m = match Message::load_from_db(&ctx, msg_id).await {
        Ok(m) => m,
        Err(e) => {
            log::warn!("bot {bot_id}: load msg failed: {e}");
            return;
        }
    };
    let from_addr = match Contact::get_by_id(&ctx, m.get_from_id()).await {
        Ok(c) => c.get_addr().to_string(),
        Err(e) => {
            log::warn!("bot {bot_id}: sender contact load failed: {e}");
            return;
        }
    };

    // Bot 间互动:发送者是另一个 bot → 条件放行(开关 + 轮数上限),否则跳过
    if is_bot_addr(&from_addr, &collect_bot_addrs(accounts, bot_ids).await) {
        let max = config.limits.interaction_max_rounds;
        let allow = config.limits.allow_bot_interaction;
        let mut rounds = bot_rounds.lock().await;
        let key = (account_id, chat_id.to_u32());
        let cur = *rounds.entry(key).or_insert(0);
        match interaction_step(cur, max, allow) {
            Some(next) => {
                rounds.insert(key, next);
            }
            None => {
                drop(rounds);
                activity
                    .record(
                        bot_id,
                        act::REPLY_SKIPPED,
                        Some(chat_id.to_u32()),
                        Some(msg_id.to_u32()),
                        "跳过回复(Bot 互动关闭或达轮数上限)",
                        None,
                    )
                    .await;
                return;
            }
        }
    } else {
        // 非 Bot 消息重置该会话的互动计数
        bot_rounds.lock().await.retain(|&(_, c), _| c != chat_id.to_u32());
    }

    // 每会话回复间隔限流(is_allowed 纯检查,不占槽;发送成功后才 stamp)
    if !rate.is_allowed(bot_id, chat_id.to_u32(), interval) {
        // 活动写入同样节流,避免洪水刷爆活动表
        if !rate.should_record(bot_id, chat_id.to_u32(), interval) {
            return;
        }
        activity
            .record(
                bot_id,
                act::REPLY_RATE_LIMITED,
                Some(chat_id.to_u32()),
                Some(msg_id.to_u32()),
                "回复过于频繁,本次跳过",
                None,
            )
            .await;
        return;
    }

    // 记录 thinking 活动(驱动调度开始前)
    activity
        .record(
            bot_id,
            act::THINKING,
            Some(chat_id.to_u32()),
            Some(msg_id.to_u32()),
            "正在处理…",
            None,
        )
        .await;

    // 组装运行时上下文,逐个驱动调度
    let runtime = BotRuntime {
        bot_id,
        account_id,
        dc: &ctx,
        config: &config,
        db,
        activity,
        data_dir,
    };
    let msg_text = m.get_text();
    let incoming = IncomingMsg {
        chat_id,
        msg_id,
        from_addr: from_addr.as_str(),
        text: Some(msg_text.as_str()),
        viewtype: m.get_viewtype(),
    };

    let replies = dispatch_drivers(registry.drivers(), &runtime, &incoming).await;

    for reply in replies {
        let mut out = Message::new(Viewtype::Text);
        out.set_text(reply.clone());
        match chat::send_msg(&ctx, chat_id, &mut out).await {
            Ok(_) => {
                // 仅成功回复才占用限流槽位;未回复的消息不烧间隔
                rate.stamp(bot_id, chat_id.to_u32());
                activity
                    .record(
                        bot_id,
                        act::REPLY_SENT,
                        Some(chat_id.to_u32()),
                        Some(msg_id.to_u32()),
                        format!("回复 {from_addr}: {}", truncate(&reply, 40)),
                        None,
                    )
                    .await;
            }
            Err(e) => log::warn!("bot {bot_id}: send reply failed: {e}"),
        }
    }
}

/// 驱动调度:按注册顺序逐个调用 on_message,收集回复。
/// 一旦某驱动返回非空回复即短路(规则命中 → 不进 LLM,spec §2.1 优先级语义);
/// 驱动 Err 仅记 LLM_ERROR 活动,不短路、不中断后续调度。
async fn dispatch_drivers(
    drivers: &[Arc<dyn BotDriver>],
    runtime: &BotRuntime<'_>,
    incoming: &IncomingMsg<'_>,
) -> Vec<String> {
    let mut replies: Vec<String> = Vec::new();
    for driver in drivers {
        match driver.on_message(runtime, incoming).await {
            Ok(rs) => {
                replies.extend(rs);
                if !replies.is_empty() {
                    break;
                }
            }
            Err(e) => {
                runtime
                    .activity
                    .record(
                        runtime.bot_id,
                        act::LLM_ERROR,
                        Some(incoming.chat_id.to_u32()),
                        Some(incoming.msg_id.to_u32()),
                        format!("驱动 {} 执行失败: {e}", driver_kind_label(driver.kind())),
                        Some(serde_json::json!({ "error": e.to_string() }).to_string()),
                    )
                    .await;
            }
        }
    }
    replies
}

/// 定时 tick 循环:每 30s 对每个 running bot 逐个驱动调 on_tick,
/// 收集 ScheduledSend → 用 bot ctx chat::send_msg 发送 → 记录 SCHEDULE_SENT 活动。
/// 每个 bot 的 tick pass 以独立 task 运行(见 run_tick_pass),单个 bot panic 不影响
/// tick 循环与其他 bot。
async fn tick_loop(
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
    activity: ActivityLog,
    registry: DriverRegistry,
    data_dir: PathBuf,
) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let rows = match db.list_all_bots().await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("tick: list bots failed: {e}");
                continue;
            }
        };
        run_tick_pass(
            accounts.clone(),
            db.clone(),
            activity.clone(),
            registry.clone(),
            data_dir.clone(),
            rows,
        )
        .await;
    }
}

/// 一次 tick pass:遍历全部 running bot,每个 bot 以独立 task 运行,逐个 await。
/// 单个 bot 的 on_tick panic 会被 task 边界捕获(JoinHandle 返回 Err),仅该 bot 失败,
/// 循环继续处理后续 bot。返回 (成功数, panic/失败数)。
async fn run_tick_pass(
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
    activity: ActivityLog,
    registry: DriverRegistry,
    data_dir: PathBuf,
    rows: Vec<BotRow>,
) -> (usize, usize) {
    let mut ok = 0usize;
    let mut failed = 0usize;
    for row in rows {
        if row.status != "running" {
            continue;
        }
        let result = tokio::task::spawn(tick_one_bot(
            accounts.clone(),
            db.clone(),
            activity.clone(),
            registry.clone(),
            data_dir.clone(),
            row.id,
            row.bot_account_id,
        ))
        .await;
        match result {
            Ok(()) => ok += 1,
            Err(e) => {
                // JoinError::is_panic() 时 panic 已在该 bot 的 task 内被隔离
                log::error!("tick: bot {} 的 tick pass 失败(已隔离): {e}", row.id);
                failed += 1;
            }
        }
    }
    (ok, failed)
}

/// 单个 bot 的一次 tick pass:查配置 → 取账号 ctx → 逐个驱动 on_tick → 发送定时消息。
/// 由 run_tick_pass 以独立 task 运行,panic 被隔离在 task 边界内。
async fn tick_one_bot(
    accounts: Arc<Mutex<Accounts>>,
    db: Arc<Db>,
    activity: ActivityLog,
    registry: DriverRegistry,
    data_dir: PathBuf,
    bot_id: i64,
    bot_account_id: u32,
) {
    let config_json = match db.get_bot_config_by_id(bot_id).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("tick: config failed: {e}");
            return;
        }
    };
    let Some(config) = BotConfig::parse(config_json.as_deref()) else {
        return;
    };
    let ctx = { accounts.lock().await.get_account(bot_account_id) };
    let Some(ctx) = ctx else {
        return;
    };
    let runtime = BotRuntime {
        bot_id,
        account_id: bot_account_id,
        dc: &ctx,
        config: &config,
        db: &db,
        activity: &activity,
        data_dir: &data_dir,
    };
    for driver in registry.drivers() {
        let sends = match driver.on_tick(&runtime).await {
            Ok(v) => v,
            Err(e) => {
                log::warn!(
                    "tick: driver {} failed: {e}",
                    driver_kind_label(driver.kind())
                );
                continue;
            }
        };
        for s in sends {
            let mut out = Message::new(Viewtype::Text);
            out.set_text(s.text.clone());
            match chat::send_msg(&ctx, ChatId::new(s.chat_id), &mut out).await {
                Ok(_) => {
                    activity
                        .record(
                            bot_id,
                            act::SCHEDULE_SENT,
                            Some(s.chat_id),
                            None,
                            format!("定时消息 → {}", truncate(&s.text, 40)),
                            None,
                        )
                        .await;
                }
                Err(e) => log::warn!("tick: send failed: {e}"),
            }
        }
    }
}

/// 收集所有 bot 账号的已配置邮箱地址,用于防 bot 互聊。
async fn collect_bot_addrs(
    accounts: &Arc<Mutex<Accounts>>,
    bot_ids: &Arc<Mutex<HashSet<u32>>>,
) -> HashSet<String> {
    let ids: Vec<u32> = bot_ids.lock().await.iter().copied().collect();
    let mut addrs = HashSet::new();
    for id in ids {
        let ctx = {
            accounts.lock().await.get_account(id)
        };
        if let Some(ctx) = ctx {
            if let Ok(Some(addr)) = ctx.get_config(Config::ConfiguredAddr).await {
                addrs.insert(addr);
            }
        }
    }
    addrs
}

/// 互动轮数门控:返回 Some(新轮数) 表示允许,None 表示拒绝。
/// allow=false 一律拒绝;轮数达到上限拒绝。
pub fn interaction_step(rounds: u32, max_rounds: u32, allow: bool) -> Option<u32> {
    if !allow {
        return None;
    }
    let max = max_rounds.max(1);
    if rounds >= max {
        return None;
    }
    Some(rounds + 1)
}

/// 判断地址是否属于某个 bot 账号(用于阻止 bot 之间互聊)。
fn is_bot_addr(addr: &str, bot_addrs: &HashSet<String>) -> bool {
    bot_addrs.contains(addr)
}

/// 截断字符串到 n 个字符,超长加省略号。
fn truncate(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    let t: String = s.chars().take(n).collect();
    format!("{t}…")
}

/// 每会话回复间隔限流 + 活动写入节流(时钟可注入,便于单测)。
pub struct RateLimiter {
    /// 最近一次成功回复时间(每会话)。
    last: StdMutex<HashMap<(i64, u32), Instant>>,
    /// 最近一次活动写入时间(每会话,节流刷屏)。
    record_cooldown: StdMutex<HashMap<(i64, u32), Instant>>,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::with_clock(Instant::now)
    }
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_clock<F>(now: F) -> Self
    where
        F: Fn() -> Instant + Send + Sync + 'static,
    {
        Self {
            last: StdMutex::new(HashMap::new()),
            record_cooldown: StdMutex::new(HashMap::new()),
            now: Box::new(now),
        }
    }

    /// 纯检查:距上次成功回复是否已过 interval。不修改状态。
    pub fn is_allowed(&self, bot_id: i64, chat_id: u32, interval: Duration) -> bool {
        let last = self.last.lock().unwrap();
        match last.get(&(bot_id, chat_id)) {
            Some(t) if (self.now)() - *t < interval => false,
            _ => true,
        }
    }

    /// 记录本次成功回复时间(供 is_allowed 判定)。
    pub fn stamp(&self, bot_id: i64, chat_id: u32) {
        self.last
            .lock()
            .unwrap()
            .insert((bot_id, chat_id), (self.now)());
    }

    /// 活动写入节流:同一 (bot,chat) 在 interval 内至多放行一次写入,并记录本次时间。
    pub fn should_record(&self, bot_id: i64, chat_id: u32, interval: Duration) -> bool {
        let mut record = self.record_cooldown.lock().unwrap();
        let key = (bot_id, chat_id);
        match record.get(&key) {
            Some(t) if (self.now)() - *t < interval => false,
            _ => {
                record.insert(key, (self.now)());
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use async_trait::async_trait;
    use deltachat::accounts::Accounts;
    use deltachat::chat::ChatId;
    use deltachat::message::{MsgId, Viewtype};

    use crate::drivers::{BotDriver, DriverKind, ScheduledSend};
    use crate::error::AppResult;

    /// 测试用假驱动:reply 为 None 返回空(不命中),Some 返回单条回复;记录调用次数。
    struct FakeDriver {
        kind: DriverKind,
        reply: Option<&'static str>,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl BotDriver for FakeDriver {
        fn kind(&self) -> DriverKind {
            self.kind
        }

        async fn on_message(
            &self,
            _bot: &BotRuntime<'_>,
            _msg: &IncomingMsg<'_>,
        ) -> AppResult<Vec<String>> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(match self.reply {
                Some(r) => vec![r.to_string()],
                None => vec![],
            })
        }
    }

    /// 构造轻量测试环境(临时账号 Context + 内存库 + 空配置),返回各 owned 值。
    async fn test_env(
    ) -> (
        tempfile::TempDir,
        deltachat::context::Context,
        Arc<Db>,
        crate::activity::ActivityLog,
        crate::dto::BotConfig,
        std::path::PathBuf,
        u32,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let mut accounts = Accounts::new(tmp.path().join("accounts"), true)
            .await
            .unwrap();
        let account_id = accounts.add_account().await.unwrap();
        let ctx = accounts.get_account(account_id).unwrap();
        let db = Arc::new(
            crate::db::Db::new(tmp.path().join("test.db"))
                .await
                .unwrap(),
        );
        db.migrate().await.unwrap();
        let activity = crate::activity::ActivityLog::new(db.clone());
        let config = crate::dto::BotConfig::default();
        let data_dir = tmp.path().to_path_buf();
        (tmp, ctx, db, activity, config, data_dir, account_id)
    }

    /// on_tick 仅在指定 bot_id 上 panic 的驱动(用于验证 tick panic 隔离)。
    struct PanicOnTickBot {
        panic_bot: i64,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl BotDriver for PanicOnTickBot {
        fn kind(&self) -> DriverKind {
            DriverKind::Rule
        }

        async fn on_message(
            &self,
            _bot: &BotRuntime<'_>,
            _msg: &IncomingMsg<'_>,
        ) -> AppResult<Vec<String>> {
            Ok(vec![])
        }

        async fn on_tick(&self, bot: &BotRuntime<'_>) -> AppResult<Vec<ScheduledSend>> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if bot.bot_id == self.panic_bot {
                panic!("tick panic for bot {}", bot.bot_id);
            }
            Ok(vec![])
        }
    }

    /// on_tick 计数驱动(验证正常 bot 的 tick 仍会执行)。
    struct CountOnTickBot {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl BotDriver for CountOnTickBot {
        fn kind(&self) -> DriverKind {
            DriverKind::Schedule
        }

        async fn on_message(
            &self,
            _bot: &BotRuntime<'_>,
            _msg: &IncomingMsg<'_>,
        ) -> AppResult<Vec<String>> {
            Ok(vec![])
        }

        async fn on_tick(&self, _bot: &BotRuntime<'_>) -> AppResult<Vec<ScheduledSend>> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(vec![])
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_panic_is_isolated_per_bot() {
        let tmp = tempfile::tempdir().unwrap();
        let accounts = Arc::new(Mutex::new(
            Accounts::new(tmp.path().join("accounts"), true).await.unwrap(),
        ));
        let account_id = accounts.lock().await.add_account().await.unwrap();
        let db = Arc::new(
            crate::db::Db::new(tmp.path().join("test.db"))
                .await
                .unwrap(),
        );
        db.migrate().await.unwrap();
        let activity = crate::activity::ActivityLog::new(db.clone());
        let data_dir = tmp.path().to_path_buf();

        // 两个 running bot 共享同一账号 ctx;bot1 命中 panic 驱动, bot2 正常
        let b1 = db.insert_bot(1, account_id, "bot1", 0).await.unwrap();
        let b2 = db.insert_bot(2, account_id, "bot2", 0).await.unwrap();
        let cfg_json = serde_json::to_string(&crate::dto::BotConfig::default()).unwrap();
        db.set_bot_config_by_id(b1, Some(&cfg_json)).await.unwrap();
        db.set_bot_config_by_id(b2, Some(&cfg_json)).await.unwrap();

        let panic_calls = Arc::new(AtomicUsize::new(0));
        let count_calls = Arc::new(AtomicUsize::new(0));
        let mut registry = DriverRegistry::new();
        registry.register(Arc::new(PanicOnTickBot {
            panic_bot: b1,
            calls: panic_calls.clone(),
        }));
        registry.register(Arc::new(CountOnTickBot {
            calls: count_calls.clone(),
        }));

        let rows = db.list_all_bots().await.unwrap();
        assert_eq!(rows.len(), 2);

        // 一次 tick pass:bot1 panic 被隔离, bot2 仍正常执行
        let (ok, failed) = run_tick_pass(accounts, db, activity, registry, data_dir, rows).await;
        assert_eq!(ok, 1, "正常 bot 的 tick 应执行成功");
        assert_eq!(failed, 1, "panic 的 bot 应被隔离并计数失败");
        assert_eq!(count_calls.load(Ordering::Relaxed), 1, "bot2 的 on_tick 应执行");
        assert_eq!(panic_calls.load(Ordering::Relaxed), 2, "panic 驱动对两个 bot 均被调用");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_one_bot_panic_is_caught_by_task_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let accounts = Arc::new(Mutex::new(
            Accounts::new(tmp.path().join("accounts"), true).await.unwrap(),
        ));
        let account_id = accounts.lock().await.add_account().await.unwrap();
        let db = Arc::new(
            crate::db::Db::new(tmp.path().join("test.db"))
                .await
                .unwrap(),
        );
        db.migrate().await.unwrap();
        let activity = crate::activity::ActivityLog::new(db.clone());
        let data_dir = tmp.path().to_path_buf();
        let b1 = db.insert_bot(1, account_id, "bot1", 0).await.unwrap();
        let cfg_json = serde_json::to_string(&crate::dto::BotConfig::default()).unwrap();
        db.set_bot_config_by_id(b1, Some(&cfg_json)).await.unwrap();

        let mut registry = DriverRegistry::new();
        registry.register(Arc::new(PanicOnTickBot {
            panic_bot: b1,
            calls: Arc::new(AtomicUsize::new(0)),
        }));

        // spawn 后 await JoinHandle:panic 以 Err(JoinError) 返回而非向上传播
        let handle = tokio::task::spawn(tick_one_bot(
            accounts.clone(),
            db.clone(),
            activity.clone(),
            registry.clone(),
            data_dir.clone(),
            b1,
            account_id,
        ));
        let res = handle.await;
        assert!(res.is_err(), "panic 应被 task 边界捕获");
        assert!(res.err().unwrap().is_panic(), "JoinError 应为 panic 类型");
    }

    fn test_incoming<'a>(text: Option<&'a str>) -> IncomingMsg<'a> {
        IncomingMsg {
            chat_id: ChatId::new(42),
            msg_id: MsgId::new(7),
            from_addr: "dev@x.io",
            text,
            viewtype: Viewtype::Text,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispatch_short_circuits_after_first_reply() {
        let (_tmp, ctx, db, activity, config, data_dir, account_id) = test_env().await;
        let runtime = BotRuntime {
            bot_id: 1,
            account_id,
            dc: &ctx,
            config: &config,
            db: &db,
            activity: &activity,
            data_dir: &data_dir,
        };
        let incoming = test_incoming(Some("hello"));

        let rule_calls = Arc::new(AtomicUsize::new(0));
        let llm_calls = Arc::new(AtomicUsize::new(0));
        let drivers: Vec<Arc<dyn BotDriver>> = vec![
            Arc::new(FakeDriver {
                kind: DriverKind::Rule,
                reply: Some("rule reply"),
                calls: rule_calls.clone(),
            }),
            Arc::new(FakeDriver {
                kind: DriverKind::Llm,
                reply: Some("llm reply"),
                calls: llm_calls.clone(),
            }),
        ];

        // 规则驱动返回非空 → 短路,后续 LLM 驱动不再被调用(无双回复)
        let replies = dispatch_drivers(&drivers, &runtime, &incoming).await;
        assert_eq!(replies, vec!["rule reply".to_string()]);
        assert_eq!(rule_calls.load(Ordering::Relaxed), 1);
        assert_eq!(llm_calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dispatch_continues_after_empty_reply() {
        let (_tmp, ctx, db, activity, config, data_dir, account_id) = test_env().await;
        let runtime = BotRuntime {
            bot_id: 1,
            account_id,
            dc: &ctx,
            config: &config,
            db: &db,
            activity: &activity,
            data_dir: &data_dir,
        };
        let incoming = test_incoming(Some("hello"));

        let rule_calls = Arc::new(AtomicUsize::new(0));
        let llm_calls = Arc::new(AtomicUsize::new(0));
        let drivers: Vec<Arc<dyn BotDriver>> = vec![
            Arc::new(FakeDriver {
                kind: DriverKind::Rule,
                reply: None,
                calls: rule_calls.clone(),
            }),
            Arc::new(FakeDriver {
                kind: DriverKind::Llm,
                reply: Some("llm reply"),
                calls: llm_calls.clone(),
            }),
        ];

        // 规则未命中(空) → 继续调用 LLM 驱动
        let replies = dispatch_drivers(&drivers, &runtime, &incoming).await;
        assert_eq!(replies, vec!["llm reply".to_string()]);
        assert_eq!(rule_calls.load(Ordering::Relaxed), 1);
        assert_eq!(llm_calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn test_is_bot_addr() {
        let mut addrs = HashSet::new();
        addrs.insert("bot1@example.com".to_string());
        addrs.insert("bot2@example.com".to_string());
        assert!(is_bot_addr("bot1@example.com", &addrs));
        assert!(is_bot_addr("bot2@example.com", &addrs));
        assert!(!is_bot_addr("alice@example.com", &addrs));
        assert!(!is_bot_addr("", &addrs));
    }

    #[test]
    fn test_interaction_step() {
        assert_eq!(interaction_step(0, 3, true), Some(1));
        assert_eq!(interaction_step(3, 3, true), None);
        assert_eq!(interaction_step(2, 3, true), Some(3));
        assert_eq!(interaction_step(0, 3, false), None);
        assert_eq!(interaction_step(0, 0, true), Some(1));
    }

    #[test]
    fn test_truncate() {
        assert_eq!(truncate("short", 40), "short");
        assert_eq!(truncate("a", 1), "a");
        let s = truncate("这是一个很长的回复内容", 5);
        assert_eq!(s.chars().count(), 6);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn test_rate_limiter_enforces_interval() {
        let ms = Arc::new(AtomicU64::new(0));
        let ms_clone = ms.clone();
        let start = Instant::now();
        let limiter = RateLimiter::with_clock(move || {
            start + Duration::from_millis(ms_clone.load(Ordering::Relaxed))
        });

        let interval = Duration::from_millis(1000);

        // is_allowed 是纯检查:不推进时间时反复调用,状态不变(无 stamp 副作用)
        assert!(limiter.is_allowed(1, 100, interval));
        assert!(limiter.is_allowed(1, 100, interval));
        assert!(limiter.is_allowed(1, 100, interval));

        // stamp 记录本次回复 → 同一 chat 在间隔内被拒,其他 chat 不受影响
        limiter.stamp(1, 100);
        assert!(!limiter.is_allowed(1, 100, interval));
        assert!(limiter.is_allowed(1, 101, interval));
        assert!(limiter.is_allowed(2, 100, interval));

        ms.store(1000, Ordering::Relaxed);
        assert!(limiter.is_allowed(1, 100, interval));

        // 重新 stamp(模拟第二次成功回复)→ 边界行为正确
        limiter.stamp(1, 100);
        ms.store(1499, Ordering::Relaxed);
        assert!(!limiter.is_allowed(1, 100, interval));
        ms.store(2000, Ordering::Relaxed);
        assert!(limiter.is_allowed(1, 100, interval));

        // should_record:每个 chat 每个间隔至多放行一次写入
        assert!(limiter.should_record(3, 100, interval));
        assert!(!limiter.should_record(3, 100, interval));
        assert!(limiter.should_record(3, 101, interval));
        ms.store(3000, Ordering::Relaxed);
        assert!(limiter.should_record(3, 100, interval));
    }
}
