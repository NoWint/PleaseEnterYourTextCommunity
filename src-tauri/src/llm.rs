use std::time::Duration;

use crate::dto::LlmConfig;
use crate::error::{AppError, AppResult};

/// LLM 提供商。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    Anthropic,
    Gemini,
}

impl Provider {
    /// provider 字符串 → Provider;缺省/未知 → OpenAi。
    pub fn parse(p: &Option<String>) -> Provider {
        match p.as_deref() {
            Some("anthropic") => Provider::Anthropic,
            Some("gemini") => Provider::Gemini,
            _ => Provider::OpenAi,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::OpenAi => "openai",
            Provider::Anthropic => "anthropic",
            Provider::Gemini => "gemini",
        }
    }
}

/// 模型发起的工具调用。
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String, // 由 provider 返回的调用 id
    pub name: String,
    pub arguments: String, // JSON 字符串
}

/// 一次 provider 调用的返回:文本 或 工具调用,二选一。
pub struct ProviderRound {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

/// OpenAI 兼容 chat 消息。
#[derive(Debug, Clone, Default)]
pub struct ChatMessage {
    pub role: String,                 // "system" | "user" | "assistant" | "tool"
    pub content: String,              // tool 角色 = 工具返回文本
    pub tool_calls: Vec<ToolCall>,    // assistant 发起的工具调用
    pub tool_call_id: Option<String>, // tool 角色回填调用 id
}

/// 构造 chat/completions 请求体 (纯函数,便于单测)。
/// 工具 defs 为 provider 无关的 `{name, description, parameters}` 数组。
pub fn build_openai_body(
    cfg: &LlmConfig,
    msgs: &[ChatMessage],
    defs: &[serde_json::Value],
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": cfg.model.clone().unwrap_or_default(),
        "messages": msgs.iter().map(openai_message).collect::<Vec<_>>(),
        "temperature": cfg.temperature,
    });
    if let Some(v) = cfg.max_tokens {
        body["max_tokens"] = serde_json::json!(v);
    }
    if let Some(v) = cfg.top_p {
        body["top_p"] = serde_json::json!(v);
    }
    if !defs.is_empty() {
        body["tools"] = serde_json::json!(defs
            .iter()
            .map(|d| serde_json::json!({ "type": "function", "function": d }))
            .collect::<Vec<_>>());
    }
    body
}

/// 构造 Anthropic messages 请求体 (纯函数,便于单测)。
/// 系统提示从 system 消息提取到顶层 `system` 字段;max_tokens 缺省 1024。
pub fn build_anthropic_body(
    cfg: &LlmConfig,
    msgs: &[ChatMessage],
    defs: &[serde_json::Value],
) -> serde_json::Value {
    let mut system: Option<String> = None;
    let mut messages: Vec<serde_json::Value> = Vec::new();
    for m in msgs {
        if m.role == "system" {
            if system.is_none() {
                system = Some(m.content.clone());
            }
        } else {
            messages.push(anthropic_message(m));
        }
    }
    let mut body = serde_json::json!({
        "model": cfg.model.clone().unwrap_or_default(),
        "max_tokens": cfg.max_tokens.unwrap_or(1024),
        "messages": messages,
    });
    if let Some(s) = system {
        if !s.is_empty() {
            body["system"] = serde_json::json!(s);
        }
    }
    if !defs.is_empty() {
        body["tools"] = serde_json::json!(defs
            .iter()
            .map(|d| serde_json::json!({
                "name": d.get("name"),
                "description": d.get("description"),
                "input_schema": d.get("parameters"),
            }))
            .collect::<Vec<_>>());
    }
    body
}

/// 构造 Gemini generateContent 请求体 (纯函数,便于单测)。
pub fn build_gemini_body(
    cfg: &LlmConfig,
    msgs: &[ChatMessage],
    defs: &[serde_json::Value],
) -> serde_json::Value {
    let mut system_instruction: Option<String> = None;
    let mut contents: Vec<serde_json::Value> = Vec::new();
    for m in msgs {
        if m.role == "system" {
            if system_instruction.is_none() {
                system_instruction = Some(m.content.clone());
            }
        } else if let Some(c) = gemini_content(m) {
            contents.push(c);
        }
    }
    let mut body = serde_json::json!({
        "contents": contents,
        "generationConfig": { "temperature": cfg.temperature },
    });
    if let Some(s) = system_instruction {
        if !s.is_empty() {
            body["system_instruction"] = serde_json::json!({ "parts": [{ "text": s }] });
        }
    }
    if let Some(v) = cfg.max_tokens {
        body["generationConfig"]["maxOutputTokens"] = serde_json::json!(v);
    }
    if let Some(v) = cfg.top_p {
        body["generationConfig"]["topP"] = serde_json::json!(v);
    }
    if !defs.is_empty() {
        body["tools"] = serde_json::json!([{ "functionDeclarations": defs }]);
    }
    body
}

/// OpenAI 单条消息 → chat/completions 消息。
/// pub(crate): 本地推理路径复用同一序列化(避免重复逻辑)。
pub(crate) fn openai_message(m: &ChatMessage) -> serde_json::Value {
    match m.role.as_str() {
        "tool" => serde_json::json!({
            "role": "tool",
            "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
            "content": m.content,
        }),
        "assistant" if !m.tool_calls.is_empty() => serde_json::json!({
            "role": "assistant",
            "content": serde_json::Value::Null,
            "tool_calls": m.tool_calls.iter().map(|tc| serde_json::json!({
                "id": tc.id,
                "type": "function",
                "function": { "name": tc.name, "arguments": tc.arguments },
            })).collect::<Vec<_>>(),
        }),
        _ => serde_json::json!({
            "role": m.role,
            "content": m.content,
        }),
    }
}

/// Anthropic 单条消息 → content 块数组。
fn anthropic_message(m: &ChatMessage) -> serde_json::Value {
    let role = if m.role == "assistant" { "assistant" } else { "user" };
    let mut content: Vec<serde_json::Value> = Vec::new();
    match m.role.as_str() {
        "tool" => {
            content.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content,
            }));
        }
        _ if !m.content.is_empty() => {
            content.push(serde_json::json!({ "type": "text", "text": m.content }));
        }
        _ => {}
    }
    for tc in &m.tool_calls {
        let input: serde_json::Value = serde_json::from_str(&tc.arguments)
            .unwrap_or_else(|_| serde_json::Value::Null);
        content.push(serde_json::json!({
            "type": "tool_use",
            "id": tc.id,
            "name": tc.name,
            "input": input,
        }));
    }
    serde_json::json!({ "role": role, "content": content })
}

/// Gemini 单条消息 → contents 元素(无内容时返回 None)。
fn gemini_content(m: &ChatMessage) -> Option<serde_json::Value> {
    let role = if m.role == "assistant" { "model" } else { "user" };
    let mut parts: Vec<serde_json::Value> = Vec::new();
    match m.role.as_str() {
        "tool" => {
            parts.push(serde_json::json!({
                "functionResponse": {
                    "name": m.tool_call_id.clone().unwrap_or_default(),
                    "response": { "result": m.content },
                }
            }));
        }
        _ => {
            if !m.content.is_empty() {
                parts.push(serde_json::json!({ "text": m.content }));
            }
            for tc in &m.tool_calls {
                let args: serde_json::Value = serde_json::from_str(&tc.arguments)
                    .unwrap_or_else(|_| serde_json::Value::Null);
                parts.push(serde_json::json!({
                    "functionCall": { "name": tc.name, "args": args }
                }));
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "role": role, "parts": parts }))
}

/// 解析 chat/completions 响应 (纯函数,便于单测)。
pub fn parse_openai_response(body: &str) -> AppResult<ProviderRound> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| AppError::Core(format!("llm parse openai response: 无效 JSON: {e}")))?;
    let choices = parsed
        .get("choices")
        .and_then(|c| c.as_array())
        .ok_or_else(|| AppError::Core("llm parse openai response: 缺少 choices 字段".into()))?;
    if choices.is_empty() {
        return Err(AppError::Core("llm parse openai response: choices 为空".into()));
    }
    let message = choices[0]
        .get("message")
        .ok_or_else(|| AppError::Core("llm parse openai response: 缺少 message 字段".into()))?;
    if let Some(calls) = message.get("tool_calls").and_then(|c| c.as_array()) {
        if !calls.is_empty() {
            let mut tool_calls = Vec::with_capacity(calls.len());
            for c in calls {
                let id = c.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let name = c
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let arguments = c
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                tool_calls.push(ToolCall { id, name, arguments });
            }
            return Ok(ProviderRound { text: None, tool_calls });
        }
    }
    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or_else(|| AppError::Core("llm parse openai response: 缺少 message.content".into()))?;
    Ok(ProviderRound {
        text: Some(content.to_string()),
        tool_calls: vec![],
    })
}

/// 解析 Anthropic messages 响应 (纯函数,便于单测)。
pub fn parse_anthropic_response(body: &str) -> AppResult<ProviderRound> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| AppError::Core(format!("llm parse anthropic response: 无效 JSON: {e}")))?;
    let content = parsed
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| AppError::Core("llm parse anthropic response: 缺少 content 字段".into()))?;
    let mut text: Option<String> = None;
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
                let arguments = serde_json::to_string(&input).unwrap_or_default();
                tool_calls.push(ToolCall { id, name, arguments });
            }
            Some("text") => {
                let t = block.get("text").and_then(|v| v.as_str()).unwrap_or_default();
                if !t.is_empty() {
                    text.get_or_insert_with(|| t.to_string());
                }
            }
            _ => {}
        }
    }
    if !tool_calls.is_empty() {
        Ok(ProviderRound { text: None, tool_calls })
    } else if let Some(t) = text {
        Ok(ProviderRound { text: Some(t), tool_calls: vec![] })
    } else {
        Err(AppError::Core(
            "llm parse anthropic response: 无 text 或 tool_use 块".into(),
        ))
    }
}

/// 解析 Gemini generateContent 响应 (纯函数,便于单测)。
pub fn parse_gemini_response(body: &str) -> AppResult<ProviderRound> {
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| AppError::Core(format!("llm parse gemini response: 无效 JSON: {e}")))?;
    let parts = parsed
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|cand| cand.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .ok_or_else(|| {
            AppError::Core("llm parse gemini response: 缺少 candidates[0].content.parts".into())
        })?;
    let mut text: Option<String> = None;
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    for part in parts {
        if let Some(fc) = part.get("functionCall") {
            let name = fc.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let args = fc.get("args").cloned().unwrap_or(serde_json::Value::Null);
            let arguments = serde_json::to_string(&args).unwrap_or_default();
            tool_calls.push(ToolCall {
                id: name.clone(),
                name,
                arguments,
            });
        }
        if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                text.get_or_insert_with(|| t.to_string());
            }
        }
    }
    if !tool_calls.is_empty() {
        Ok(ProviderRound { text: None, tool_calls })
    } else if let Some(t) = text {
        Ok(ProviderRound { text: Some(t), tool_calls: vec![] })
    } else {
        Err(AppError::Core(
            "llm parse gemini response: 无 text 或 functionCall 部分".into(),
        ))
    }
}

/// 错误是否值得重试:网络错误、HTTP 429 或任意 5xx 视为瞬时。
pub fn is_retryable(e: &AppError) -> bool {
    match e {
        AppError::Network(_) => true,
        AppError::Http(code, _) => *code == 429 || (500..=599).contains(code),
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

    /// 无工具调用,返回纯文本;供 test_llm_config 使用。
    pub async fn complete(&self, cfg: &LlmConfig, messages: Vec<ChatMessage>) -> AppResult<String> {
        let round = self.call(cfg, messages, &[]).await?;
        round
            .text
            .ok_or_else(|| AppError::Core("llm complete: 模型未返回文本".into()))
    }

    /// 调用 LLM;按 cfg.provider 分派到对应 provider,支持工具调用往返。
    pub async fn call(
        &self,
        cfg: &LlmConfig,
        msgs: Vec<ChatMessage>,
        defs: &[serde_json::Value],
    ) -> AppResult<ProviderRound> {
        match Provider::parse(&cfg.provider) {
            Provider::OpenAi => self.call_openai(cfg, msgs, defs).await,
            Provider::Anthropic => self.call_anthropic(cfg, msgs, defs).await,
            Provider::Gemini => self.call_gemini(cfg, msgs, defs).await,
        }
    }

    async fn call_openai(
        &self,
        cfg: &LlmConfig,
        msgs: Vec<ChatMessage>,
        defs: &[serde_json::Value],
    ) -> AppResult<ProviderRound> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        if key.is_empty() {
            return Err(AppError::Core("llm missing api_key".into()));
        }
        let base = cfg.base_url.as_deref().unwrap_or("").trim_end_matches('/');
        if base.is_empty() {
            return Err(AppError::Core("llm missing base_url".into()));
        }
        let url = format!("{base}/chat/completions");
        let body = build_openai_body(cfg, &msgs, defs);
        let auth = format!("Bearer {key}");
        let headers = [("Authorization", auth.as_str())];
        self.call_with_retry(cfg, &url, &body, &headers, "openai", parse_openai_response)
            .await
    }

    async fn call_anthropic(
        &self,
        cfg: &LlmConfig,
        msgs: Vec<ChatMessage>,
        defs: &[serde_json::Value],
    ) -> AppResult<ProviderRound> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        if key.is_empty() {
            return Err(AppError::Core("llm missing api_key".into()));
        }
        let url = "https://api.anthropic.com/v1/messages";
        let body = build_anthropic_body(cfg, &msgs, defs);
        let headers = [("x-api-key", key), ("anthropic-version", "2023-06-01")];
        self.call_with_retry(cfg, url, &body, &headers, "anthropic", parse_anthropic_response)
            .await
    }

    async fn call_gemini(
        &self,
        cfg: &LlmConfig,
        msgs: Vec<ChatMessage>,
        defs: &[serde_json::Value],
    ) -> AppResult<ProviderRound> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        if key.is_empty() {
            return Err(AppError::Core("llm missing api_key".into()));
        }
        let model = cfg.model.clone().unwrap_or_default();
        let model = model.strip_prefix("models/").unwrap_or(&model);
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        );
        let body = build_gemini_body(cfg, &msgs, defs);
        let headers: [(&str, &str); 0] = [];
        self.call_with_retry(cfg, &url, &body, &headers, "gemini", parse_gemini_response)
            .await
    }

    /// POST JSON;瞬时错误按 cfg.max_retries 指数退避重试,行为与 B1 的 complete 循环一致。
    async fn call_with_retry(
        &self,
        cfg: &LlmConfig,
        url: &str,
        body: &serde_json::Value,
        headers: &[(&str, &str)],
        label: &str,
        parse: impl Fn(&str) -> AppResult<ProviderRound>,
    ) -> AppResult<ProviderRound> {
        let max_retries = cfg.max_retries;
        for attempt in 0..=max_retries {
            match self.post_json(url, body, headers, cfg).await {
                Ok(resp) => return parse(&resp),
                Err(e) if is_retryable(&e) && attempt < max_retries => {
                    log::warn!("llm {label} attempt {attempt} failed (will retry): {e}");
                    tokio::time::sleep(backoff_delay(attempt)).await;
                }
                Err(e) => return Err(e),
            }
        }
        unreachable!("call_with_retry loop always returns")
    }

    async fn post_json(
        &self,
        url: &str,
        body: &serde_json::Value,
        headers: &[(&str, &str)],
        cfg: &LlmConfig,
    ) -> AppResult<String> {
        let mut req = self
            .http
            .post(url)
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(cfg.timeout_secs.max(1)))
            .json(body);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let truncated: String = text.chars().take(200).collect();
            return Err(AppError::Http(status.as_u16(), truncated));
        }
        resp.text()
            .await
            .map_err(|e| AppError::Network(e.to_string()))
    }

    /// OpenAI 兼容流式补全(本地 llama-server 与 API 共用)。on_delta 回调每个增量块。
    /// 仅支持 OpenAI 兼容协议(base_url + api_key + model);Anthropic/Gemini 不走此路径。
    /// `json_mode=true` 时加 `response_format:{type:json_object}`(DeepSeek 结构化输出,
    /// 要求 prompt 含「json」字样,已由 system_prompt 满足);同时不开启思考模式(默认)。
    /// 注意:本方法刻意不设整请求 .timeout()(流中间停摆由调用方的 tokio::time::timeout 兜底)。
    pub async fn complete_stream_openai(
        &self,
        cfg: &LlmConfig,
        messages: Vec<ChatMessage>,
        json_mode: bool,
        mut on_delta: impl FnMut(String) -> AppResult<()> + Send,
    ) -> AppResult<String> {
        let key = cfg.api_key.as_deref().unwrap_or("");
        if key.is_empty() {
            return Err(AppError::Core("llm missing api_key".into()));
        }
        let base = cfg.base_url.as_deref().unwrap_or("").trim_end_matches('/');
        if base.is_empty() {
            return Err(AppError::Core("llm missing base_url".into()));
        }
        let url = format!("{base}/chat/completions");
        // ChatMessage 未实现 Serialize,复用 openai_message 转 JSON(与非流式路径同构)
        let body = {
            let mut b = serde_json::json!({
                "model": cfg.model.as_deref().unwrap_or(""),
                "messages": messages.iter().map(openai_message).collect::<Vec<_>>(),
                "stream": true,
            });
            b["temperature"] = serde_json::json!(cfg.temperature); // f64, 非 Option
            if let Some(mt) = cfg.max_tokens { b["max_tokens"] = serde_json::json!(mt); }
            if json_mode {
                b["response_format"] = serde_json::json!({ "type": "json_object" });
            }
            b
        };
        // 初始 POST 瞬时错误重试(网络抖动/429/5xx),与 B1 非流式路径同策略。
        // 注意:流中途断连无法整体重试(部分 delta 已推给前端,重发会重复),surface 为 api_network 由前端刷新兜底。
        let max_retries = cfg.max_retries;
        let resp = {
            let mut chosen: Option<reqwest::Response> = None;
            for attempt in 0..=max_retries {
                match self.http.post(&url).bearer_auth(key).json(&body).send().await {
                    Ok(r) if r.status().is_success() => { chosen = Some(r); break; }
                    Ok(r) => {
                        let status = r.status();
                        let text = r.text().await.unwrap_or_default();
                        // 瞬时(429/5xx)退避重试;4xx(401/400/402…)直接判错
                        let transient = status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
                        if transient && attempt < max_retries {
                            log::warn!("llm stream attempt {attempt} failed (will retry): {status} {text}");
                            tokio::time::sleep(backoff_delay(attempt)).await;
                            continue;
                        }
                        // 余额/配额识别:402 一律;429/400 时查 body 特征
                        let is_quota = status == reqwest::StatusCode::PAYMENT_REQUIRED
                            || (status == reqwest::StatusCode::TOO_MANY_REQUESTS
                                || status == reqwest::StatusCode::BAD_REQUEST)
                                && ["quota", "insufficient", "billing", "credit"]
                                    .iter()
                                    .any(|k| text.to_lowercase().contains(*k));
                        let code = if is_quota { "api_quota" }
                            else if status.as_u16() == 401 || status.as_u16() == 403 { "api_auth" }
                            else if status.as_u16() == 429 { "api_rate_limit" }
                            else if status.as_u16() == 400 { "api_bad_request" }
                            else { "api_network" };
                        return Err(AppError::Core(format!("llm stream {code}: {status} {text}")));
                    }
                    Err(e) => {
                        let retryable = is_retryable(&AppError::Network(e.to_string()));
                        if retryable && attempt < max_retries {
                            log::warn!("llm stream attempt {attempt} failed (will retry): {e}");
                            tokio::time::sleep(backoff_delay(attempt)).await;
                            continue;
                        }
                        return Err(AppError::Core(format!("llm stream: {e}")));
                    }
                }
            }
            chosen.ok_or_else(|| AppError::Core("llm stream: no response".into()))?
        };
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

impl Default for LlmClient {
    fn default() -> Self {
        Self::new()
    }
}

static LLM_CLIENT: std::sync::OnceLock<LlmClient> = std::sync::OnceLock::new();

/// 进程级共享 LLM 客户端(复用 reqwest 连接池,避免每个命令新建)。
pub fn shared_client() -> &'static LlmClient {
    LLM_CLIENT.get_or_init(LlmClient::new)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn def(name: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "description": "测试工具",
            "parameters": { "type": "object", "properties": {} }
        })
    }

    #[test]
    fn test_provider_parse() {
        assert_eq!(Provider::parse(&None), Provider::OpenAi);
        assert_eq!(Provider::parse(&Some("openai".into())), Provider::OpenAi);
        assert_eq!(Provider::parse(&Some("anthropic".into())), Provider::Anthropic);
        assert_eq!(Provider::parse(&Some("gemini".into())), Provider::Gemini);
        assert_eq!(Provider::parse(&Some("weird".into())), Provider::OpenAi);
        assert_eq!(Provider::as_str(&Provider::OpenAi), "openai");
        assert_eq!(Provider::as_str(&Provider::Anthropic), "anthropic");
        assert_eq!(Provider::as_str(&Provider::Gemini), "gemini");
    }

    #[test]
    fn test_build_openai_body() {
        let messages = vec![
            ChatMessage { role: "system".into(), content: "你是助手".into(), ..Default::default() },
            ChatMessage { role: "user".into(), content: "你好".into(), ..Default::default() },
            ChatMessage {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: "call_1".into(),
                    name: "get_time".into(),
                    arguments: r#"{"timezone":"utc"}"#.into(),
                }],
                ..Default::default()
            },
            ChatMessage {
                role: "tool".into(),
                content: "本地时间 2026-08-03 22:30:00 (UTC+08:00)".into(),
                tool_call_id: Some("call_1".into()),
                ..Default::default()
            },
        ];
        let body = build_openai_body(&cfg(), &messages, &[]);
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["max_tokens"], serde_json::Value::Null); // 未设则不输出
        assert_eq!(body["top_p"], serde_json::Value::Null);
        assert!(body.get("tools").is_none());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "你是助手");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "你好");
        // assistant with tool_calls
        assert_eq!(msgs[2]["role"], "assistant");
        assert_eq!(msgs[2]["content"], serde_json::Value::Null);
        let calls = msgs[2]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(calls[0]["type"], "function");
        assert_eq!(calls[0]["function"]["name"], "get_time");
        assert_eq!(calls[0]["function"]["arguments"], r#"{"timezone":"utc"}"#);
        // tool message
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "call_1");
        assert_eq!(msgs[3]["content"], "本地时间 2026-08-03 22:30:00 (UTC+08:00)");

        let mut c = cfg();
        c.temperature = 0.2;
        c.max_tokens = Some(100);
        c.top_p = Some(0.9);
        let body = build_openai_body(&c, &messages, &[]);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(body["max_tokens"], 100);
        assert_eq!(body["top_p"], 0.9);

        // tools 数组形状
        let defs = vec![def("get_time")];
        let body = build_openai_body(&cfg(), &messages, &defs);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "get_time");
        assert_eq!(tools[0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn test_build_anthropic_body() {
        let messages = vec![
            ChatMessage { role: "system".into(), content: "你是助手".into(), ..Default::default() },
            ChatMessage { role: "user".into(), content: "你好".into(), ..Default::default() },
        ];
        let body = build_anthropic_body(&cfg(), &messages, &[]);
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["max_tokens"], 1024); // cfg.max_tokens None → 默认 1024
        assert_eq!(body["system"], "你是助手");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"][0]["type"], "text");
        assert_eq!(msgs[0]["content"][0]["text"], "你好");

        let mut c = cfg();
        c.max_tokens = Some(512);
        let body = build_anthropic_body(&c, &messages, &[]);
        assert_eq!(body["max_tokens"], 512);

        // tools 形状 input_schema
        let defs = vec![def("get_time")];
        let body = build_anthropic_body(&cfg(), &messages, &defs);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools[0]["name"], "get_time");
        assert_eq!(tools[0]["description"], "测试工具");
        assert_eq!(tools[0]["input_schema"]["type"], "object");
        assert!(tools[0].get("parameters").is_none());
    }

    #[test]
    fn test_build_gemini_body() {
        let messages = vec![
            ChatMessage { role: "system".into(), content: "你是助手".into(), ..Default::default() },
            ChatMessage { role: "user".into(), content: "你好".into(), ..Default::default() },
        ];
        let mut c = cfg();
        c.max_tokens = Some(256);
        c.top_p = Some(0.8);
        let body = build_gemini_body(&c, &messages, &[]);
        assert_eq!(body["system_instruction"]["parts"][0]["text"], "你是助手");
        assert_eq!(body["generationConfig"]["temperature"], 0.7);
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 256);
        assert_eq!(body["generationConfig"]["topP"], 0.8);
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "你好");
        assert!(body.get("tools").is_none());

        // functionDeclarations 形状
        let defs = vec![def("get_time")];
        let body = build_gemini_body(&c, &messages, &defs);
        let decls = body["tools"][0]["functionDeclarations"].as_array().unwrap();
        assert_eq!(decls[0]["name"], "get_time");
        assert_eq!(decls[0]["parameters"]["type"], "object");
    }

    #[test]
    fn test_parse_openai_response_text() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"你好，我是助手"}}]}"#;
        let round = parse_openai_response(body).unwrap();
        assert_eq!(round.text.as_deref(), Some("你好，我是助手"));
        assert!(round.tool_calls.is_empty());
    }

    #[test]
    fn test_parse_openai_response_tool_calls() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{\"timezone\":\"utc\"}"}}]}}]}"#;
        let round = parse_openai_response(body).unwrap();
        assert!(round.text.is_none());
        assert_eq!(round.tool_calls.len(), 1);
        assert_eq!(round.tool_calls[0].id, "call_1");
        assert_eq!(round.tool_calls[0].name, "get_time");
        assert_eq!(round.tool_calls[0].arguments, r#"{"timezone":"utc"}"#);
    }

    #[test]
    fn test_parse_openai_response_missing_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant"}}]}"#;
        assert!(parse_openai_response(body).is_err());
    }

    #[test]
    fn test_parse_anthropic_response_text() {
        let body = r#"{"content":[{"type":"text","text":"你好，我是助手"}],"stop_reason":"end_turn"}"#;
        let round = parse_anthropic_response(body).unwrap();
        assert_eq!(round.text.as_deref(), Some("你好，我是助手"));
        assert!(round.tool_calls.is_empty());
    }

    #[test]
    fn test_parse_anthropic_response_tool_use() {
        let body = r#"{"content":[{"type":"tool_use","id":"toolu_1","name":"get_time","input":{"timezone":"utc"}}],"stop_reason":"tool_use"}"#;
        let round = parse_anthropic_response(body).unwrap();
        assert!(round.text.is_none());
        assert_eq!(round.tool_calls.len(), 1);
        assert_eq!(round.tool_calls[0].id, "toolu_1");
        assert_eq!(round.tool_calls[0].name, "get_time");
        assert_eq!(round.tool_calls[0].arguments, r#"{"timezone":"utc"}"#);
    }

    #[test]
    fn test_parse_gemini_response_text() {
        let body = r#"{"candidates":[{"content":{"parts":[{"text":"你好，我是助手"}]}}]}"#;
        let round = parse_gemini_response(body).unwrap();
        assert_eq!(round.text.as_deref(), Some("你好，我是助手"));
        assert!(round.tool_calls.is_empty());
    }

    #[test]
    fn test_parse_gemini_response_function_call() {
        let body = r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_time","args":{"timezone":"utc"}}}]}}]}"#;
        let round = parse_gemini_response(body).unwrap();
        assert!(round.text.is_none());
        assert_eq!(round.tool_calls.len(), 1);
        assert_eq!(round.tool_calls[0].id, "get_time");
        assert_eq!(round.tool_calls[0].name, "get_time");
        assert_eq!(round.tool_calls[0].arguments, r#"{"timezone":"utc"}"#);
    }

    #[test]
    fn test_is_retryable() {
        assert!(is_retryable(&AppError::Network("timeout".into())));
        assert!(is_retryable(&AppError::Http(429, "limit".into())));
        assert!(is_retryable(&AppError::Http(500, "srv".into())));
        assert!(is_retryable(&AppError::Http(501, "srv".into())));
        assert!(is_retryable(&AppError::Http(503, "srv".into())));
        assert!(is_retryable(&AppError::Http(599, "srv".into())));
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
