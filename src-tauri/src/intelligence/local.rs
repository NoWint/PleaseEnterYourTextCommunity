//! 本地 llama-server 旁路进程:懒启动/复用子进程 + /health 就绪检查 +
//! OpenAI 兼容 HTTP 推理(非流式)。
//!
//! 生命周期(§10.4):空闲 10 分钟 kill(后台回收循环由集成者在命令层挂,
//! 本期只提供 `idle_check` + `kill`);下次入队懒启动(health 未就绪才 spawn);
//! 启动期崩溃自动重启一次,连败两次 → `engine_start_failed`。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::process::Command;

use crate::dto::LlmConfig;
use crate::error::{AppError, AppResult};
use crate::llm::ChatMessage;

/// 空闲回收阈值:超过该秒数无任务即 kill 进程(§10.4)。
pub const IDLE_KILL_SECS: i64 = 10 * 60;
/// 就绪轮询窗口与间隔。
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const READY_INTERVAL: Duration = Duration::from_millis(500);
/// 上下文长度与 GPU 层数(CPU 推理,跨端一致)。
const CTX_LEN: &str = "4096";
const GPU_LAYERS: &str = "0";
/// 引擎就绪后最大启动尝试次数(崩溃自愈重启一次)。
const MAX_START_ATTEMPTS: u32 = 2;

/// 当前 unix 时间(秒)。
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 本地 llama-server 旁路进程句柄。
pub struct LocalRunner {
    /// 端口,从 12700 起(固定基址;多实例同机冲突本期不做,健康检查会复用
    /// 已在跑的进程,见 `ensure_ready`)。
    port: u16,
    data_dir: PathBuf,
    /// 当前子进程;None = 未拉起(或已 kill)。
    child: Arc<StdMutex<Option<tokio::process::Child>>>,
    /// 最后使用时间(秒),`touch()` 维护;回收循环用。
    last_used: Arc<StdMutex<i64>>,
    http: reqwest::Client,
}

impl LocalRunner {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            port: 12700,
            data_dir,
            child: Arc::new(StdMutex::new(None)),
            last_used: Arc::new(StdMutex::new(0)),
            http: reqwest::Client::new(),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// 引擎可执行文件路径:data_dir/models/llama-server(.exe)。
    pub fn engine_path(&self) -> PathBuf {
        let name = if cfg!(target_os = "windows") {
            "llama-server.exe"
        } else {
            "llama-server"
        };
        self.data_dir.join("models").join(name)
    }

    /// 指定档位的模型文件路径:data_dir/models/<gguf>。
    pub fn model_path(&self, tier: &str) -> PathBuf {
        self.data_dir
            .join("models")
            .join(super::download::model_asset_name(tier))
    }

    /// 记录一次使用时间(complete / ensure_ready 调用)。
    pub fn touch(&self) {
        *self.last_used.lock().unwrap() = now_secs();
    }

    /// 最近一次使用时间(秒)。
    pub fn last_used(&self) -> i64 {
        *self.last_used.lock().unwrap()
    }

    /// 空闲判定:超过 `IDLE_KILL_SECS` 未使用。集成者在命令层挂后台循环:
    /// `if runner.idle_check(runner.last_used()) { runner.kill().await; }`。
    pub fn idle_check(&self, last_used: i64) -> bool {
        let now = now_secs();
        last_used > 0 && now.saturating_sub(last_used) > IDLE_KILL_SECS
    }

    /// 子进程是否在跑。
    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    /// kill 当前子进程并复位状态(空闲回收 / 崩溃清理用)。
    pub async fn kill(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        *self.last_used.lock().unwrap() = 0;
    }

    /// 引擎 + 模型就绪检查;未就绪则拉起并轮询 /health(最多 30s)。
    /// 崩溃自愈:启动期提前退出 → 自动重启一次;连败两次 → `engine_start_failed`。
    pub async fn ensure_ready(&self, model_path: &Path) -> AppResult<()> {
        let engine = self.engine_path();
        if !engine.exists() {
            return Err(AppError::Core(format!(
                "[engine_not_ready] 未找到引擎 {} ,请先到智能设置下载",
                engine.display()
            )));
        }
        if !model_path.exists() {
            return Err(AppError::Core(format!(
                "[engine_not_ready] 未找到模型 {} ,请先到智能设置下载",
                model_path.display()
            )));
        }
        // 已有健康进程(本进程拉起或上次残留的孤儿)→ 直接复用(懒启动)
        if self.is_healthy().await {
            self.touch();
            return Ok(());
        }
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            self.spawn(&engine, model_path).await?;
            match self.poll_ready().await {
                Ok(true) => {
                    self.touch();
                    return Ok(());
                }
                Ok(false) => {
                    log::warn!("intelligence local: llama-server 30s 未就绪,尝试重启");
                }
                Err(e) => {
                    // 启动期崩溃(engine_crash):自动重启一次
                    log::warn!("intelligence local: engine crash during startup: {e}");
                }
            }
            if attempt >= MAX_START_ATTEMPTS {
                self.kill().await;
                return Err(AppError::Core(
                    "[engine_start_failed] llama-server 连续两次启动失败".into(),
                ));
            }
        }
    }

    /// 拉起子进程(stdout/stderr 丢空,避免管道阻塞)。
    async fn spawn(&self, engine: &Path, model_path: &Path) -> AppResult<()> {
        let model = model_path.to_string_lossy().to_string();
        let port = self.port.to_string();
        let mut cmd = Command::new(engine);
        cmd.args([
            "-m",
            model.as_str(),
            "--port",
            port.as_str(),
            "-c",
            CTX_LEN,
            "-ngl",
            GPU_LAYERS,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| {
            AppError::Core(format!("[engine_start_failed] 拉起 llama-server 失败: {e}"))
        })?;
        *self.child.lock().unwrap() = Some(child);
        Ok(())
    }

    /// 轮询 /health:`Ok(true)` 就绪;`Ok(false)` 超时;`Err(engine_crash)` 进程提前退出。
    async fn poll_ready(&self) -> AppResult<bool> {
        let deadline = std::time::Instant::now() + READY_TIMEOUT;
        while std::time::Instant::now() < deadline {
            if self.is_healthy().await {
                return Ok(true);
            }
            // 进程提前退出 → 崩溃信号,上层重启一次(§10.4)
            if let Some(c) = self.child.lock().unwrap().as_mut() {
                if let Ok(Some(status)) = c.try_wait() {
                    return Err(AppError::Core(format!(
                        "[engine_crash] llama-server 启动后异常退出: {status}"
                    )));
                }
            }
            tokio::time::sleep(READY_INTERVAL).await;
        }
        Ok(false)
    }

    async fn is_healthy(&self) -> bool {
        let url = format!("http://127.0.0.1:{}/health", self.port);
        self.http
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// 非流式补全:POST `{base_url}/chat/completions`(base_url 已含 /v1),
    /// body OpenAI 兼容 `{"model","messages","stream":false,"temperature"}`。
    pub async fn complete(&self, cfg: &LlmConfig, messages: Vec<ChatMessage>) -> AppResult<String> {
        self.touch();
        let url = chat_url(cfg.base_url.as_deref());
        let body = serde_json::json!({
            "model": cfg.model.clone().unwrap_or_default(),
            "messages": messages.iter().map(|m| serde_json::json!({
                "role": m.role,
                "content": m.content,
            })).collect::<Vec<_>>(),
            "stream": false,
            "temperature": cfg.temperature,
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .timeout(Duration::from_secs(cfg.timeout_secs.max(1)))
            .send()
            .await
            .map_err(|e| AppError::Core(format!("[api_network] 本地引擎请求失败: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if !status.is_success() {
            // 本地引擎无配额概念,非 2xx 映射为 engine_crash(推理进程异常),
            // 集成者可进一步细分(engine_timeout 由上层超时产生)。
            let snippet: String = text.chars().take(200).collect();
            return Err(AppError::Core(format!(
                "[engine_crash] 本地引擎 HTTP {}: {snippet}",
                status.as_u16()
            )));
        }
        let parsed: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| AppError::Core(format!("[engine_crash] 本地引擎响应非 JSON: {e}")))?;
        let content = parsed["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                AppError::Core(
                    "[engine_crash] 本地引擎响应缺少 choices[0].message.content".into(),
                )
            })?;
        Ok(content.to_string())
    }
}

/// 拼接本地 chat/completions URL(纯函数,可单测):
/// base_url 已含 `/chat/completions` 则直接用;否则拼上(避免 /v1 + /v1 重复)。
pub fn chat_url(base_url: Option<&str>) -> String {
    let base = base_url.unwrap_or_default().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        return base.to_string();
    }
    format!("{base}/chat/completions")
}

/// SSE 行解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseLine {
    /// 增量文本(可能为空串,如 role 首帧)。
    Delta(String),
    /// `data: [DONE]` 流结束标记。
    Done,
}

/// 解析单行 SSE(OpenAI 兼容流,纯函数,可单测):
/// 非 `data:` 行(空行 / `event:` / 注释)→ None;
/// `data: [DONE]` → `Some(Done)`;
/// `data: {json}` → `Some(Delta(choices[0].delta.content))`,JSON 非法 → None。
pub fn parse_sse_line(line: &str) -> Option<SseLine> {
    let payload = line.trim().strip_prefix("data:")?.trim();
    if payload == "[DONE]" {
        return Some(SseLine::Done);
    }
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let content = v["choices"][0]["delta"]["content"].as_str().unwrap_or_default();
    Some(SseLine::Delta(content.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sse_line_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#;
        assert_eq!(parse_sse_line(line), Some(SseLine::Delta("你好".into())));
    }

    #[test]
    fn test_parse_sse_line_done() {
        assert_eq!(parse_sse_line("data: [DONE]"), Some(SseLine::Done));
        assert_eq!(parse_sse_line("data:[DONE]"), Some(SseLine::Done));
    }

    #[test]
    fn test_parse_sse_line_non_data_lines() {
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line("event: message"), None);
        assert_eq!(parse_sse_line(": comment"), None);
        assert_eq!(parse_sse_line("data: not-json"), None);
    }

    #[test]
    fn test_parse_sse_line_empty_delta() {
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert_eq!(parse_sse_line(line), Some(SseLine::Delta("".into())));
    }

    #[test]
    fn test_parse_sse_line_no_choices() {
        let line = r#"data: {"id":"x"}"#;
        assert_eq!(parse_sse_line(line), Some(SseLine::Delta("".into())));
    }

    #[test]
    fn test_chat_url() {
        assert_eq!(
            chat_url(Some("http://127.0.0.1:12700/v1")),
            "http://127.0.0.1:12700/v1/chat/completions"
        );
        assert_eq!(
            chat_url(Some("http://127.0.0.1:12700/v1/")),
            "http://127.0.0.1:12700/v1/chat/completions"
        );
        assert_eq!(
            chat_url(Some("http://127.0.0.1:12700/v1/chat/completions")),
            "http://127.0.0.1:12700/v1/chat/completions"
        );
        assert_eq!(chat_url(None), "/chat/completions");
    }

    #[test]
    fn test_local_runner_basics() {
        let r = LocalRunner::new(PathBuf::from("/tmp/intel-test"));
        assert_eq!(r.port(), 12700);
        assert!(!r.is_running());
        assert_eq!(r.last_used(), 0);
        assert_eq!(r.engine_path(), PathBuf::from("/tmp/intel-test/models/llama-server"));
        assert_eq!(
            r.model_path("1.5b"),
            PathBuf::from("/tmp/intel-test/models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf")
        );
    }

    #[test]
    fn test_idle_check() {
        let r = LocalRunner::new(PathBuf::from("/tmp/intel-test"));
        let now = now_secs();
        assert!(!r.idle_check(0)); // 从未使用 → 不回收
        assert!(!r.idle_check(now - 60));
        assert!(!r.idle_check(now - IDLE_KILL_SECS));
        assert!(r.idle_check(now - IDLE_KILL_SECS - 1));
        assert!(r.idle_check(now - 3600));
    }

    #[test]
    fn test_touch_records_usage() {
        let r = LocalRunner::new(PathBuf::from("/tmp/intel-test"));
        r.touch();
        let used = r.last_used();
        assert!(used > 0 && (now_secs() - used).abs() < 5);
    }
}
