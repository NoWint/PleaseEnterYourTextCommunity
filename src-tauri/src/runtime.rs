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
use crate::db::Db;
use crate::dto::{BotConfig, bot_activity_kind as act};
use crate::drivers::{BotRuntime, DriverRegistry, IncomingMsg, driver_kind_label};

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
            tokio::spawn(async move {
                // 未抢到全局 permit 的事件直接丢弃(不排队,避免任务无界堆积)
                let Ok(_permit) = global.try_acquire() else {
                    log::debug!("bot {account_id}: global 并发超限,丢弃事件");
                    return;
                };
                handle_bot_message(
                    &accounts, &db, &bot_ids, &activity, &registry, &per_bot, &rate,
                    &data_dir, account_id, chat_id, msg_id,
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

    // 防循环:发送者是另一个 bot → 跳过
    if is_bot_addr(&from_addr, &collect_bot_addrs(accounts, bot_ids).await) {
        activity
            .record(
                bot_id,
                act::REPLY_SKIPPED,
                Some(chat_id.to_u32()),
                Some(msg_id.to_u32()),
                "跳过回复(发送者是另一个 Bot)",
                None,
            )
            .await;
        return;
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

    let mut replies: Vec<String> = Vec::new();
    for driver in registry.drivers() {
        match driver.on_message(&runtime, &incoming).await {
            Ok(rs) => replies.extend(rs),
            Err(e) => {
                activity
                    .record(
                        bot_id,
                        act::LLM_ERROR,
                        Some(chat_id.to_u32()),
                        Some(msg_id.to_u32()),
                        format!("驱动 {} 执行失败: {e}", driver_kind_label(driver.kind())),
                        Some(serde_json::json!({ "error": e.to_string() }).to_string()),
                    )
                    .await;
            }
        }
    }

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

/// 定时 tick 循环:每 30s 对每个 running bot 逐个驱动调 on_tick,
/// 收集 ScheduledSend → 用 bot ctx chat::send_msg 发送 → 记录 SCHEDULE_SENT 活动。
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
        for row in rows {
            if row.status != "running" {
                continue;
            }
            let config_json = match db.get_bot_config_by_id(row.id).await {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("tick: config failed: {e}");
                    continue;
                }
            };
            let Some(config) = BotConfig::parse(config_json.as_deref()) else {
                continue;
            };
            let ctx = { accounts.lock().await.get_account(row.bot_account_id) };
            let Some(ctx) = ctx else {
                continue;
            };
            let runtime = BotRuntime {
                bot_id: row.id,
                account_id: row.bot_account_id,
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
                                    row.id,
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
    use std::sync::atomic::{AtomicU64, Ordering};

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
