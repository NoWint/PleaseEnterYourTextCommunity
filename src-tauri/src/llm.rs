use crate::dto::LlmConfigInput;
use crate::error::{AppError, AppResult};

/// OpenAI 兼容 chat 消息
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// 构造 chat/completions 请求体 (纯函数,便于单测)
pub fn build_request_body(cfg: &LlmConfigInput, messages: Vec<ChatMessage>) -> serde_json::Value {
    serde_json::json!({
        "model": cfg.model.clone().unwrap_or_default(),
        "messages": messages.into_iter().map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        }).collect::<Vec<_>>(),
        "temperature": 0.7,
    })
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

/// 调用 OpenAI 兼容 /chat/completions, 返回助手回复文本
pub async fn complete(cfg: &LlmConfigInput, messages: Vec<ChatMessage>) -> AppResult<String> {
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
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let truncated: String = text.chars().take(200).collect();
        return Err(AppError::Core(format!("llm http {status}: {truncated}")));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;
    parse_response(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> LlmConfigInput {
        LlmConfigInput {
            system_prompt: None,
            base_url: Some("https://api.openai.com/v1".to_string()),
            api_key: Some("test-key".to_string()),
            model: Some("gpt-4o-mini".to_string()),
            provider: None,
        }
    }

    #[test]
    fn test_build_request_body() {
        let messages = vec![
            ChatMessage {
                role: "system".to_string(),
                content: "你是个助手".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: "你好".to_string(),
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: "有什么可以帮你？".to_string(),
            },
        ];
        let body = build_request_body(&cfg(), messages);
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["temperature"], 0.7);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "你是个助手");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[2]["role"], "assistant");
    }

    #[test]
    fn test_build_request_body_model_missing_is_empty() {
        let mut c = cfg();
        c.model = None;
        let body = build_request_body(&c, vec![]);
        assert_eq!(body["model"], "");
    }

    #[test]
    fn test_parse_response_success() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"你好，我是助手"}}]}"#;
        let out = parse_response(body).unwrap();
        assert_eq!(out, "你好，我是助手");
    }

    #[test]
    fn test_parse_response_missing_choices() {
        let body = r#"{"foo":"bar"}"#;
        let err = parse_response(body).unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("choices")));
    }

    #[test]
    fn test_parse_response_empty_choices() {
        let body = r#"{"choices":[]}"#;
        assert!(parse_response(body).is_err());
    }

    #[test]
    fn test_parse_response_missing_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant"}}]}"#;
        let err = parse_response(body).unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("message.content")));
    }

    #[test]
    fn test_parse_response_content_not_string() {
        let body = r#"{"choices":[{"message":{"content":123}}]}"#;
        assert!(parse_response(body).is_err());
    }

    #[test]
    fn test_parse_response_invalid_json() {
        let err = parse_response("not json").unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("JSON")));
    }

    #[tokio::test]
    async fn test_complete_missing_api_key() {
        let mut c = cfg();
        c.api_key = None;
        let err = complete(&c, vec![]).await.unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("api_key")));
    }

    #[tokio::test]
    async fn test_complete_empty_api_key() {
        let mut c = cfg();
        c.api_key = Some(String::new());
        let err = complete(&c, vec![]).await.unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("api_key")));
    }

    #[tokio::test]
    async fn test_complete_missing_base_url() {
        let mut c = cfg();
        c.base_url = None;
        let err = complete(&c, vec![]).await.unwrap_err();
        assert!(matches!(err, AppError::Core(m) if m.contains("base_url")));
    }
}
