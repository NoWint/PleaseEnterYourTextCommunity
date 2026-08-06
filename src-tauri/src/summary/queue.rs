// 推理队列:本地串行(信号量=1)+ API 并发(信号量=4);bubble 插队。
// 去重/代际机制:每 scope(chat+lane+kind)维护版本号,enqueue 时 +1;
// running 注册表记录正在跑的任务。过期任务(版本落后)的 delta/result 整体丢弃,
// 根治「同 scope 双任务流污染 + 过期结果写缓存」。
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;
use tokio::sync::Mutex as AsyncMutex;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, LlmClient};
use crate::summary::runner::LocalRunner;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane { Bubble, Detail }

#[derive(Clone)]
pub struct SummaryJob {
    pub gen: u64,          // scope 代际(enqueue 时分配;旧任务版本落后 → 结果丢弃)
    pub chat_id: u64,
    pub lane: Lane,
    pub kind: String,        // analysis kind(Detail),bubble 填 "bubble"
    pub messages: Vec<ChatMessage>, // system+user(prompt 已含上次分析块)
    pub timeout: Duration,
}

type ScopeKey = (u64, Lane, String);

pub struct QueueInner {
    pub pending: VecDeque<SummaryJob>,
    /// scope → 正在跑的任务代际。同一 scope 只保留最新代际(新任务登记时覆盖旧)。
    pub running: HashMap<ScopeKey, u64>,
    /// scope → 已入队最新代际(pending+running 的并集最大值)。
    pub versions: HashMap<ScopeKey, u64>,
}

pub struct SummaryQueue {
    /// std Mutex:临界区无 await(enqueue/next_job/emit 校验都是短操作),
    /// 换成 std 让 emit_delta(同步回调)也能校验代际。
    pub inner: std::sync::Mutex<QueueInner>,
    pub local_sem: Arc<Semaphore>, // 本地 llama-server 单进程 → 串行(容量 1);API 模式不占
    pub api_sem: Arc<Semaphore>,   // API 并发上限(容量 4),防撞 RPS 限流
    pub app: AppHandle,
    pub runner: Arc<LocalRunner>,
    pub api: LlmClient,
    pub api_cfg: AsyncMutex<Option<crate::dto::LlmConfig>>,
    pub current_model: AsyncMutex<PathBuf>, // 当前选中档位的模型文件(可切换)
}

impl SummaryQueue {
    pub fn new(app: AppHandle, runner: Arc<LocalRunner>, default_model: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            inner: std::sync::Mutex::new(QueueInner {
                pending: VecDeque::new(),
                running: HashMap::new(),
                versions: HashMap::new(),
            }),
            local_sem: Arc::new(Semaphore::new(1)),
            api_sem: Arc::new(Semaphore::new(4)),
            app, runner,
            api: LlmClient::new(),
            api_cfg: AsyncMutex::new(None),
            current_model: AsyncMutex::new(default_model),
        })
    }

    /// 切换模型档位(下载完成 / save_prefs 时调用)。
    pub async fn set_current_model(&self, p: PathBuf) {
        *self.current_model.lock().await = p;
    }

    /// 入队。bubble 插队到队头(优先级);同 scope 只留最新代际:
    /// 旧的 pending 移除,正在跑的旧任务靠版本校验丢弃其输出。
    /// 注:bubble「抢占」v1 用优先级重排实现 —— 正在跑的 detail 自然跑完再跑 bubble,
    /// 不做物理中止(CancellationToken 贯穿 SSE 循环复杂度高,0.5B 下 detail 仅几秒,收益低)。
    pub async fn enqueue(&self, job: SummaryJob) -> AppResult<()> {
        let mut inner = self.inner.lock().unwrap();
        let key = scope_key(&job);
        let ver = inner.versions.entry(key.clone()).or_insert(0);
        *ver += 1;
        let job = SummaryJob { gen: *ver, ..job };
        // 移除 pending 里同 scope 的旧代际任务(新代际已入队,旧的等不到 spawn 即废弃)
        inner.pending.retain(|j| scope_key(j) != key);
        if job.lane == Lane::Bubble {
            inner.pending.push_front(job);
        } else {
            inner.pending.push_back(job);
        }
        Ok(())
    }

    /// 取下一个任务(worker 循环调用,非阻塞)。仅放行当前最新代际:
    /// pop 到过期任务(已有更新版本入队)→ 丢弃继续取下一个。
    pub async fn next_job(&self) -> Option<SummaryJob> {
        let mut inner = self.inner.lock().unwrap();
        loop {
            let job = inner.pending.pop_front()?;
            let key = scope_key(&job);
            if inner.versions.get(&key) != Some(&job.gen) {
                continue; // 过期代际 → 丢
            }
            // 登记 running(覆盖旧的同 scope 代际);旧任务继续跑但输出被版本校验丢弃
            inner.running.insert(key, job.gen);
            return Some(job);
        }
    }

    /// 是否完全空闲:无 pending 且无 running(供 worker 决定回收引擎进程)。
    pub fn is_idle(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.pending.is_empty() && inner.running.is_empty()
    }

    /// spawn 一个独立 task 跑 job —— 支持 API 模式并发(多个 detail 同时跑)。
    /// 本地模式由 run_local 内信号量串行。接受 Arc 以便廉价 clone 进 task。
    pub fn spawn_job(this: &Arc<Self>, job: SummaryJob) {
        let this = this.clone();
        tokio::spawn(async move {
            this.run_job(job).await;
        });
    }

    /// 跑单个 job 并发事件。API 模式并发;本地走信号量串行。
    pub async fn run_job(&self, job: SummaryJob) {
        let result = if self.use_local().await {
            self.run_local(&job).await
        } else {
            self.run_api(&job).await
        };
        self.emit_result(&job, result).await;
    }

    async fn use_local(&self) -> bool {
        let cfg = self.api_cfg.lock().await;
        cfg.is_none() // 未配 API → 走本地
    }

    async fn run_local(&self, job: &SummaryJob) -> AppResult<String> {
        // llama-server 单进程 → 本地推理全局串行(信号量容量 1)。
        // 并发请求会抢引擎,故多个 detail 在此排队。
        let _permit = self.local_sem.clone().acquire_owned().await;
        let cfg = crate::summary::runner::local_llm_config();
        let model = self.current_model.lock().await.clone();
        // 本地引擎超时:由 job.timeout 控制(bubble 60s / detail 120s)
        tokio::time::timeout(
            job.timeout,
            self.runner.complete_stream(&model, &cfg, job.messages.clone(), |delta| {
                self.emit_delta(job, &delta);
                Ok(())
            }),
        )
        .await
        .map_err(|_| AppError::Core("engine_timeout".into()))?
    }

    async fn run_api(&self, job: &SummaryJob) -> AppResult<String> {
        let cfg = self.api_cfg.lock().await.clone();
        let cfg = cfg.ok_or_else(|| AppError::Core("api_not_configured".into()))?;
        // API 并发上限:容量 4,超出的 detail 排队,防并发 7 请求撞 DeepSeek RPS 限流
        let _permit = self.api_sem.clone().acquire_owned().await;
        tokio::time::timeout(
            job.timeout,
            self.api.complete_stream_openai(&cfg, job.messages.clone(), is_json_kind(&job.kind), |delta| {
                self.emit_delta(job, &delta);
                Ok(())
            }),
        )
        .await
        .map_err(|_| AppError::Core("api_timeout".into()))?
    }

    /// 该 job 是否已过期(scope 有新代际入队)。同步:emit_delta 回调内调用。
    fn is_stale(&self, job: &SummaryJob) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.versions.get(&scope_key(job)) != Some(&job.gen)
    }

    fn emit_delta(&self, job: &SummaryJob, delta: &str) {
        if self.is_stale(job) { return; } // 过期任务:不流任何增量,防交叉污染
        let _ = self.app.emit("summary-event", &serde_json::json!({
            "chatId": job.chat_id, "lane": lane_str(job.lane), "kind": job.kind,
            "status": "streaming", "delta": delta,
        }));
    }

    async fn emit_result(&self, job: &SummaryJob, result: AppResult<String>) {
        let key = scope_key(job);
        let stale = {
            let inner = self.inner.lock().unwrap();
            inner.versions.get(&key) != Some(&job.gen)
        };
        // 无论是否过期都清理 running 中本代际条目(新代际登记时会覆盖,这里兜底)
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.running.get(&key) == Some(&job.gen) {
                inner.running.remove(&key);
            }
        }
        if stale { return; } // 过期:done/error 均不 emit(不覆盖新结果,不落盘)
        match result {
            Ok(text) => {
                let _ = self.app.emit("summary-event", &serde_json::json!({
                    "chatId": job.chat_id, "lane": lane_str(job.lane), "kind": job.kind,
                    "status": "done", "result": text,
                }));
            }
            Err(e) => {
                let msg = e.to_string();
                // AppError::Core 的 Display 是全角冒号「核心错误：…」,不能用 split(':');
                // 用已知错误码子串匹配提取 spec §10.2 的 code。
                const KNOWN_CODES: [&str; 11] = [
                    "engine_not_ready", "engine_timeout", "engine_start_failed",
                    "engine_stream_failed", "api_quota", "api_auth", "api_rate_limit",
                    "api_bad_request", "api_network", "api_not_configured", "api_timeout",
                ];
                let code = KNOWN_CODES.iter().find(|c| msg.contains(*c)).copied().unwrap_or("unknown").to_string();
                let _ = self.app.emit("summary-event", &serde_json::json!({
                    "chatId": job.chat_id, "lane": lane_str(job.lane), "kind": job.kind,
                    "status": "error", "error": { "code": code, "message": msg },
                }));
            }
        }
    }
}

pub fn lane_str(l: Lane) -> &'static str {
    match l { Lane::Bubble => "bubble", Lane::Detail => "detail" }
}

fn scope_key(job: &SummaryJob) -> ScopeKey {
    (job.chat_id, job.lane, job.kind.clone())
}

/// 该 kind 是否输出 JSON(用于 API 请求加 response_format:json_object)。
/// summary(段落 markdown)/participation(统计+解读文本)非 JSON;其余 5 类 JSON。
fn is_json_kind(kind: &str) -> bool {
    matches!(kind, "action_items" | "resources" | "open_questions" | "timeline" | "decisions")
}
