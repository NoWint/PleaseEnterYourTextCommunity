// llama-server 子进程生命周期:懒启动(GET /health 未就绪才 spawn)、
// 空闲 10 分钟 kill 回收、崩溃重启一次、流式调用(断连即取消生成)。
// 注意:不存 model_path —— 模型档位可切换(0.5B/1.5B),调用时由队列传入。
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::Mutex;
use crate::dto::LlmConfig;
use crate::error::{AppError, AppResult};
use crate::llm::ChatMessage;

pub struct LocalRunner {
    pub engine_path: PathBuf,
    pub child: Mutex<Option<tokio::process::Child>>,
    pub port: Mutex<u16>,
    pub http: reqwest::Client,
}

impl LocalRunner {
    pub fn new(engine_path: PathBuf) -> Self {
        Self {
            engine_path,
            child: Mutex::new(None),
            port: Mutex::new(12700),
            http: reqwest::Client::new(),
        }
    }

    pub fn is_downloaded(&self, model_path: &Path) -> bool {
        self.engine_path.exists() && model_path.exists()
    }

    /// 确保子进程在跑且模型就绪。未 spawn → spawn(用给定 model_path);health != ok → 等。
    pub async fn ensure_running(&self, model_path: &Path) -> AppResult<()> {
        if !self.is_downloaded(model_path) {
            return Err(AppError::Core("engine_not_ready".into()));
        }
        let base = self.base_url().await;
        let ok = self.health_ok(&base).await;
        if ok { return Ok(()); }
        // 子进程可能没起/崩了 → spawn
        self.spawn(model_path).await?;
        // 等模型加载(0.5B 约 1s;1.5B 约几秒),轮询 /health 直到 ok,上限 60s
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            if self.health_ok(&self.base_url().await).await { return Ok(()); }
            if std::time::Instant::now() > deadline {
                return Err(AppError::Core("engine_timeout".into()));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn base_url(&self) -> String {
        let p = *self.port.lock().await;
        format!("http://127.0.0.1:{p}")
    }

    async fn health_ok(&self, base: &str) -> bool {
        let url = format!("{base}/health");
        match self.http.get(&url).timeout(Duration::from_secs(2)).send().await {
            Ok(r) => {
                if let Ok(v) = r.json::<serde_json::Value>().await {
                    return v.get("status").and_then(|s| s.as_str()) == Some("ok");
                }
                false
            }
            Err(_) => false,
        }
    }

    async fn spawn(&self, model_path: &Path) -> AppResult<()> {
        // 探测空闲端口 12700..12710
        let port = self.next_free_port().await;
        {
            let mut p = self.port.lock().await;
            *p = port;
        }
        let mut cmd = tokio::process::Command::new(&self.engine_path);
        cmd.arg("--model")
            .arg(model_path)
            .arg("--port")
            .arg(port.to_string())
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--ctx-size")
            .arg("4096")
            .arg("--n-predict")
            .arg("-1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = cmd.spawn().map_err(|e| AppError::Core(format!("engine_start_failed: {e}")))?;
        {
            let mut guard = self.child.lock().await;
            *guard = Some(child);
        }
        Ok(())
    }

    async fn next_free_port(&self) -> u16 {
        for port in 12700..12711 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err() {
                return port;
            }
        }
        12700
    }

    /// 空闲回收:10 分钟无任务 → kill。
    pub async fn stop_if_idle(&self, idle: Duration) {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill().await;
            }
        }
        *guard = None;
    }

    /// 流式调用本地引擎。on_delta 回调增量。model_path 为当前选中档位模型文件。
    pub async fn complete_stream(
        &self,
        model_path: &Path,
        cfg: &LlmConfig,
        messages: Vec<ChatMessage>,
        mut on_delta: impl FnMut(String) -> AppResult<()> + Send,
    ) -> AppResult<String> {
        self.ensure_running(model_path).await?;
        let base = self.base_url().await;
        let url = format!("{base}/v1/chat/completions");
        // ChatMessage 未实现 Serialize,复用 llm.rs 的 openai_message 转 JSON(与非流式路径同构)
        let mut body = serde_json::json!({
            "model": "local",
            "messages": messages.iter().map(crate::llm::openai_message).collect::<Vec<_>>(),
            "stream": true,
        });
        body["temperature"] = serde_json::json!(cfg.temperature);
        if let Some(mt) = cfg.max_tokens { body["max_tokens"] = serde_json::json!(mt); }
        let resp = self.http.post(&url).json(&body).send().await
            .map_err(|e| AppError::Core(format!("llm stream: {e}")))?;
        let mut full = String::new();
        let mut bytes = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        use futures_util::StreamExt;
        while let Some(chunk) = bytes.next().await {
            let chunk = chunk.map_err(|e| AppError::Core(format!("llm stream read: {e}")))?;
            buf.extend_from_slice(&chunk);
            while let Some(ev) = crate::summary::sse::extract_sse_text(&mut buf) {
                for line in ev.lines() {
                    if let Some(d) = crate::summary::sse::parse_sse_line(line) {
                        if d.done { return Ok(full); }
                        if !d.text.is_empty() {
                            full.push_str(&d.text);
                            on_delta(d.text)?;
                        }
                    }
                }
            }
        }
        Ok(full)
    }
}

/// 本地推理用 OpenAI 兼容 LlmConfig(model 填 "local")。
/// 注意:LlmConfig 无 Default,用 From<LlmConfigInput> 构造(dto.rs:436)。
pub fn local_llm_config() -> LlmConfig {
    crate::dto::LlmConfigInput {
        system_prompt: None,
        base_url: Some("http://127.0.0.1:12700/v1".into()),
        api_key: Some("local".into()),
        model: Some("local".into()),
        provider: Some("openai".into()),
    }
    .into()
}
