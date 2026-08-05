// 推理队列:本地串行(信号量=1)+ API 并发;bubble 抢占正在跑的 detail;
// 同 chat 同 lane 丢旧留新;结果/流经回调 emit summary-event。
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
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
    pub async fn enqueue(&self, job: SummaryJob) -> AppResult<()> {
        let mut inner = self.inner.lock().await;
        // 同 chat 同 lane:丢弃 pending 里的旧任务
        inner.pending.retain(|j| !(j.chat_id == job.chat_id && j.lane == job.lane));
        if job.lane == Lane::Bubble {
            inner.pending.push_front(job);
        } else {
            inner.pending.push_back(job);
        }
        Ok(())
    }

    /// 取下一个任务(worker 循环调用,非阻塞)。同 chat 同 lane 若队列里还有更新的 → 这个过期,丢。
    pub async fn next_job(&self) -> Option<SummaryJob> {
        let mut inner = self.inner.lock().await;
        loop {
            let job = inner.pending.pop_front()?;
            let newer = inner.pending.iter().any(|j| j.chat_id == job.chat_id && j.lane == job.lane);
            if newer { continue; }
            return Some(job);
        }
    }

    /// 跑单个 job 并发事件。不递归取下一个 —— 常驻 worker 循环(commands.rs)负责拉取。
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
