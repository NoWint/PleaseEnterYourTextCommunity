//! API 来源:复用 llm.rs 的 LlmClient 做纯文本补全,并把 HTTP 错误映射为
//! 主题总结 spec §10.2 的错误码字符串(api_auth / api_quota / api_rate_limit /
//! api_bad_request / api_network),以 `[code] message` 前缀的 Core 错误返回,
//! 上层可用 `crate::intelligence::error_code()` 提取 code。

use crate::dto::LlmConfig;
use crate::error::{AppError, AppResult};
use crate::llm::ChatMessage;

/// 把 HTTP 状态码 + 响应体映射为 §10.2 错误码(纯函数,可单测)。
///
/// | 状态码 | 错误码 |
/// |---|---|
/// | 401 / 403 | `api_auth` |
/// | 402 | `api_quota` |
/// | 429 | `api_rate_limit`;body 含 quota/insufficient/billing/credit → `api_quota` |
/// | 400 | `api_bad_request`;body 含配额关键词同样升级 `api_quota` |
/// | 5xx / 其它 | `api_network` |
///
/// 注:llm.rs 的 `LlmClient` 会先对 429/5xx 指数退避重试,重试耗尽后才走到
/// 本映射;`complete` 内部不暴露 reqwest 状态码,classify_status 作为纯函数
/// 保留,实际映射在调用处尽力而为。
pub fn classify_status(status: reqwest::StatusCode, body: &str) -> &'static str {
    let lower = body.to_ascii_lowercase();
    let quota_hint = ["quota", "insufficient", "billing", "credit"]
        .iter()
        .any(|k| lower.contains(k));
    match status.as_u16() {
        401 | 403 => "api_auth",
        402 => "api_quota",
        429 => {
            if quota_hint {
                "api_quota"
            } else {
                "api_rate_limit"
            }
        }
        400 => {
            if quota_hint {
                "api_quota"
            } else {
                "api_bad_request"
            }
        }
        500..=599 => "api_network",
        _ => "api_network",
    }
}

/// 纯文本补全;错误统一转成带 `[code]` 前缀的 Core 错误。
pub async fn complete(cfg: &LlmConfig, messages: Vec<ChatMessage>) -> AppResult<String> {
    match crate::llm::shared_client().complete(cfg, messages).await {
        Ok(text) => Ok(text),
        Err(AppError::Http(code, body)) => {
            let status = reqwest::StatusCode::from_u16(code)
                .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR);
            Err(AppError::Core(format!(
                "[{}] API 请求失败 HTTP {code}: {body}",
                classify_status(status, &body)
            )))
        }
        Err(AppError::Network(msg)) => {
            Err(AppError::Core(format!("[api_network] API 请求网络错误: {msg}")))
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_status() {
        use reqwest::StatusCode;
        assert_eq!(classify_status(StatusCode::UNAUTHORIZED, ""), "api_auth");
        assert_eq!(classify_status(StatusCode::FORBIDDEN, ""), "api_auth");
        assert_eq!(classify_status(StatusCode::PAYMENT_REQUIRED, ""), "api_quota");
        assert_eq!(
            classify_status(StatusCode::TOO_MANY_REQUESTS, "rate limited"),
            "api_rate_limit"
        );
        assert_eq!(
            classify_status(StatusCode::TOO_MANY_REQUESTS, "quota exceeded"),
            "api_quota"
        );
        assert_eq!(
            classify_status(StatusCode::TOO_MANY_REQUESTS, "Insufficient balance"),
            "api_quota"
        );
        assert_eq!(
            classify_status(StatusCode::BAD_REQUEST, "model not found"),
            "api_bad_request"
        );
        assert_eq!(
            classify_status(StatusCode::BAD_REQUEST, "billing error"),
            "api_quota"
        );
        assert_eq!(
            classify_status(StatusCode::BAD_REQUEST, "credit limit"),
            "api_quota"
        );
        assert_eq!(classify_status(StatusCode::INTERNAL_SERVER_ERROR, ""), "api_network");
        assert_eq!(classify_status(StatusCode::BAD_GATEWAY, ""), "api_network");
        assert_eq!(classify_status(StatusCode::OK, ""), "api_network");
        assert_eq!(classify_status(StatusCode::FOUND, ""), "api_network");
    }
}
