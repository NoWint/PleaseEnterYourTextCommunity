use std::time::Duration;

use crate::dto::LlmConfig;
use crate::error::{AppError, AppResult};

/// OpenAI 兼容 chat 消息
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// 构造 chat/completions 请求体 (纯函数,便于单测)
pub fn build_request_body(cfg: &LlmConfig, messages: Vec<ChatMessage>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": cfg.model.clone().unwrap_or_default(),
        "messages": messages.into_iter().map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        }).collect::<Vec<_>>(),
        "temperature": cfg.temperature,
    });
    if let Some(v) = cfg.max_tokens {
        body["max_tokens"] = serde_json::json!(v);
    }
    if let Some(v) = cfg.top_p {
        body["top_p"] = serde_json::json!(v);
    }
    body
}

/// 解析 chat/completions 响应 (纯函数,便于单测)
pub fn parse_response(body: &str) -> AppResult<String> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| AppError::Core(format!("llm parse response: 无效 JSON: {e}")))?;
    let choices = parsed
        .get("choices")
        .and_then(|c| c.as_array())
        .ok_or_else(|| AppError::Core("llm parse response: 缺少 choices 字段".into()))?;
    if choices.is_empty() {
        return Err(AppError::Core("llm parse response: choices 为空".into()));
    }
    let content = choices[0]
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| AppError::Core("llm parse response: 缺少 message.content".into()))?;
    Ok(content.to_string())
}

/// 错误是否值得重试:网络错误、429、5xx 视为瞬时。
pub fn is_retryable(e: &AppError) -> bool {
    match e {
        AppError::Network(_) => true,
        AppError::Http(code, _) => matches!(code, 429 | 500 | 502 | 503 | 504),
        _ => false,
    }
}

/// 指数退避延迟:1s * 2^attempt + 0–499ms 抖动(基于系统时钟,避免新增随机依赖)。
pub fn backoff_delay(attempt: u32) -> Duration {
    let base_ms = 1000u64.saturating_mul(1u64 << attempt.min(10));
    let jitter_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() % 500)
        .unwrap_or(0);
    Duration::from_millis(base_ms + jitter_ms as u64)
}

/// LLM 客户端:共享 reqwest 连接池 + 超时 + 瞬时错误重试退避。
pub struct LlmClient {
    http: reqwest::Client,
}

impl LlmClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .build()
                .expect("failed to build reqwest client"),
        }
    }

    /// 调用 chat/completions;瞬时错误按 cfg.max_retries 指数退避重试。
    pub async fn complete(&self, cfg: &LlmConfig, messages: Vec<ChatMessage>) -> AppResult<String> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        if key.is_empty() {
            return Err(AppError::Core("llm missing api_key".into()));
        }
        let base = cfg.base_url.as_deref().unwrap_or("").trim_end_matches('/');
        if base.is_empty() {
            return Err(AppError::Core("llm missing base_url".into()));
        }
        let url = format!("{base}/chat/completions");
        let body = build_request_body(cfg, messages);

        let max_retries = cfg.max_retries;
        for attempt in 0..=max_retries {
            match self.call_once(cfg, &url, &body).await {
                Ok(text) => return Ok(text),
                Err(e) if is_retryable(&e) && attempt < max_retries => {
                    log::warn!("llm attempt {attempt} failed (will retry): {e}");
                    tokio::time::sleep(backoff_delay(attempt)).await;
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!("complete loop always returns")
    }

    async fn call_once(
        &self,
        cfg: &LlmConfig,
        url: &str,
        body: &serde_json::Value,
    ) -> AppResult<String> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        let resp = self
            .http
            .post(url)
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .json(body)
            .timeout(Duration::from_secs(cfg.timeout_secs.max(1)))
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let truncated: String = text.chars().take(200).collect();
            return Err(AppError::Http(status.as_u16(), truncated));
        }
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        parse_response(&text)
    }
}

impl Default for LlmClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::LlmConfig;

    fn cfg() -> LlmConfig {
        LlmConfig {
            system_prompt: None,
            base_url: Some("https://api.openai.com/v1".to_string()),
            api_key: Some("test-key".to_string()),
            model: Some("gpt-4o-mini".to_string()),
            provider: Some("openai".to_string()),
            temperature: 0.7,
            max_tokens: None,
            top_p: None,
            timeout_secs: 120,
            max_retries: 2,
        }
    }

    #[test]
    fn test_build_request_body_with_params() {
        let messages = vec![ChatMessage { role: "user".into(), content: "你好".into() }];
        let body = build_request_body(&cfg(), messages.clone());
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["max_tokens"], serde_json::Value::Null); // 未设则不输出
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");

        let mut c = cfg();
        c.temperature = 0.2;
        c.max_tokens = Some(100);
        c.top_p = Some(0.9);
        let body = build_request_body(&c, messages);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["max_tokens"], 100);
        assert_eq!(body["top_p"], 0.9);
    }

    #[test]
    fn test_parse_response_success() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"你好，我是助手"}}]}"#;
        assert_eq!(parse_response(body).unwrap(), "你好，我是助手");
    }

    #[test]
    fn test_parse_response_missing_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant"}}]}"#;
        assert!(parse_response(body).is_err());
    }

    #[test]
    fn test_is_retryable() {
        assert!(is_retryable(&AppError::Network("timeout".into())));
        assert!(is_retryable(&AppError::Http(429, "limit".into())));
        assert!(is_retryable(&AppError::Http(500, "srv".into())));
        assert!(is_retryable(&AppError::Http(503, "srv".into())));
        assert!(!is_retryable(&AppError::Http(400, "bad".into())));
        assert!(!is_retryable(&AppError::Http(401, "auth".into())));
        assert!(!is_retryable(&AppError::Core("other".into())));
    }

    #[test]
    fn test_backoff_delay_scales_with_attempt() {
        assert!(backoff_delay(2) > backoff_delay(1));
        assert!(backoff_delay(1) >= backoff_delay(0));
    }

    #[tokio::test]
    async fn test_complete_missing_api_key() {
        let client = LlmClient::new();
        let mut c = cfg();
        c.api_key = Some(String::new());
        let err = client.complete(&c, vec![]).await.unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("api_key")));
    }

    #[tokio::test]
    async fn test_complete_missing_base_url() {
        let client = LlmClient::new();
        let mut c = cfg();
        c.base_url = None;
        let err = client.complete(&c, vec![]).await.unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("base_url")));
    }
}
