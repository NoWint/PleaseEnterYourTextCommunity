// 推理队列:本地串行(信号量=1)+ API 并发;bubble 抢占正在跑的 detail;
// 同 chat 同 lane 丢旧留新;结果/流经回调 emit summary-event。
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Semaphore};
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, LlmClient};
use crate::summary::runner::LocalRunner;

#[derive(Clone, Copy, PartialEq)]
pub enum Lane { Bubble, Detail }

#[derive(Clone)]
pub struct SummaryJob {
    pub chat_id: u64,
    pub lane: Lane,
    pub kind: String,        // analysis kind(Detail), bubble 填 "bubble"
    pub messages: Vec<ChatMessage>, // system+user(prompt 已含上次分析块)
    pub timeout: Duration,
}

pub struct QueueInner {
    pub pending: VecDeque<SummaryJob>,
}

pub struct SummaryQueue {
    pub inner: Mutex<QueueInner>,
    pub local_sem: Arc<Semaphore>, // 本地 llama-server 单进程 → 串行(容量 1);API 模式不占
    pub app: AppHandle,
    pub runner: Arc<LocalRunner>,
    pub api: LlmClient,
    pub api_cfg: Mutex<Option<crate::dto::LlmConfig>>,
    pub current_model: Mutex<PathBuf>, // 当前选中档位的模型文件(可切换)
}

impl SummaryQueue {
    pub fn new(app: AppHandle, runner: Arc<LocalRunner>, default_model: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(QueueInner { pending: VecDeque::new() }),
            local_sem: Arc::new(Semaphore::new(1)),
            app, runner,
            api: LlmClient::new(),
            api_cfg: Mutex::new(None),
            current_model: Mutex::new(default_model),
        })
    }

    /// 切换模型档位(下载完成 / save_prefs 时调用)。
    pub async fn set_current_model(&self, p: PathBuf) {
        *self.current_model.lock().await = p;
    }

    /// 入队。bubble 插队到队头(优先级);同 chat 同 lane 旧任务丢弃。
    /// 注:bubble「抢占」v1 用优先级重排实现 —— 正在跑的 detail 自然跑完再跑 bubble,
    /// 不做物理中止(CancellationToken 贯穿 SSE 循环复杂度高,0.5B 下 detail 仅几秒,收益低)。
    /// 入队。去重键:
    /// - Bubble:同 chat 只留最新(气泡一句话,旧任务过期)。
    /// - Detail:同 chat 同 kind 只留最新(summary/action_items/... 各分析类型独立,
    ///   不能按 lane 去重 —— 否则打开看板入队 7 个 detail 时互相顶掉,只剩最后一个)。
    pub async fn enqueue(&self, job: SummaryJob) -> AppResult<()> {
        let mut inner = self.inner.lock().await;
        inner.pending.retain(|j| !same_scope(&j, &job));
        if job.lane == Lane::Bubble {
            inner.pending.push_front(job);
        } else {
            inner.pending.push_back(job);
        }
        Ok(())
    }

    /// 取下一个任务(worker 循环调用,非阻塞)。同 scope 若队列里还有更新的 → 这个过期,丢。
    pub async fn next_job(&self) -> Option<SummaryJob> {
        let mut inner = self.inner.lock().await;
        loop {
            let job = inner.pending.pop_front()?;
            let newer = inner.pending.iter().any(|j| same_scope(&j, &job));
            if newer { continue; }
            return Some(job);
        }
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
        tokio::time::timeout(
            job.timeout,
            self.api.complete_stream_openai(&cfg, job.messages.clone(), |delta| {
                self.emit_delta(job, &delta);
                Ok(())
            }),
        )
        .await
        .map_err(|_| AppError::Core("api_timeout".into()))?
    }

    fn emit_delta(&self, job: &SummaryJob, delta: &str) {
        let _ = self.app.emit("summary-event", &serde_json::json!({
            "chatId": job.chat_id, "lane": lane_str(job.lane), "kind": job.kind,
            "status": "streaming", "delta": delta,
        }));
    }

    async fn emit_result(&self, job: &SummaryJob, result: AppResult<String>) {
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

/// 任务去重判定:Bubble 同 chat;Detail 同 chat 同 kind。
fn same_scope(a: &SummaryJob, b: &SummaryJob) -> bool {
    if a.chat_id != b.chat_id || a.lane != b.lane { return false; }
    match a.lane {
        Lane::Bubble => true,
        Lane::Detail => a.kind == b.kind,
    }
}
