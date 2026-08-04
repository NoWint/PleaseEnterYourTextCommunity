//! GitHub API HTTP 客户端:认证头、错误分类、限速提示。
//! 错误映射到 `crate::error::AppError` 的 GitHub 变体。

use reqwest::header::{HeaderMap, AUTHORIZATION};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// 请求 User-Agent(GitHub API 强制要求)。
pub const USER_AGENT_VALUE: &str = "peytchat";

/// 请求认证:None = 公开只读(限速 60/h);Some = `Authorization: Bearer <token>`。
pub struct GithubAuth {
    pub token: Option<String>,
}

/// GitHub REST API 客户端(reqwest 连接池)。
pub struct GithubClient {
    http: reqwest::Client,
}

impl GithubClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT_VALUE)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client");
        Self { http }
    }

    /// GET → JSON(顶层可为 array)。
    pub async fn get_json(&self, auth: &GithubAuth, url: &str) -> AppResult<Value> {
        self.execute(auth, reqwest::Method::GET, url, None).await
    }

    /// GET → 原始字节(raw 内容,如文件)。
    pub async fn get_bytes(&self, auth: &GithubAuth, url: &str) -> AppResult<Vec<u8>> {
        let mut req = self.http.request(reqwest::Method::GET, url);
        if let Some(t) = &auth.token {
            req = req.header(AUTHORIZATION, format!("Bearer {t}"));
        }
        let resp = req.send().await.map_err(|e| AppError::Network(format!("GitHub 请求失败: {e}")))?;
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Network(format!("GitHub 读取响应失败: {e}")))?;
        let body_text = String::from_utf8_lossy(&bytes);
        let body = serde_json::from_str(&body_text).unwrap_or(Value::Null);
        if let Some(err) = classify_http_error(status.as_u16(), &body) {
            return Err(augment_error(err, &headers));
        }
        Ok(bytes.to_vec())
    }

    /// POST JSON → JSON。
    pub async fn post_json(&self, auth: &GithubAuth, url: &str, body: &Value) -> AppResult<Value> {
        self.execute(auth, reqwest::Method::POST, url, Some(body)).await
    }

    /// PATCH JSON → JSON。
    pub async fn patch_json(&self, auth: &GithubAuth, url: &str, body: &Value) -> AppResult<Value> {
        self.execute(auth, reqwest::Method::PATCH, url, Some(body)).await
    }

    /// DELETE。
    pub async fn delete(&self, auth: &GithubAuth, url: &str) -> AppResult<()> {
        self.execute(auth, reqwest::Method::DELETE, url, None).await.map(|_| ())
    }

    async fn execute(
        &self,
        auth: &GithubAuth,
        method: reqwest::Method,
        url: &str,
        body: Option<&Value>,
    ) -> AppResult<Value> {
        let mut req = self.http.request(method, url);
        if let Some(t) = &auth.token {
            req = req.header(AUTHORIZATION, format!("Bearer {t}"));
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| AppError::Network(format!("GitHub 请求失败: {e}")))?;
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AppError::Network(format!("GitHub 读取响应失败: {e}")))?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    if status.is_success() {
                        return Err(AppError::Core(format!("GitHub 响应解析失败: {e}")));
                    }
                    Value::Null
                }
            }
        };
        if let Some(err) = classify_http_error(status.as_u16(), &body) {
            return Err(augment_error(err, &headers));
        }
        Ok(body)
    }
}

impl Default for GithubClient {
    fn default() -> Self {
        Self::new()
    }
}

/// 纯函数:按 HTTP 状态码 + 响应 body(GitHub 错误格式 `{message}`)分类错误。
/// 2xx → None(成功)。可单测(注入 status + body,不触发网络)。
pub fn classify_http_error(status: u16, body: &Value) -> Option<AppError> {
    if (200..300).contains(&status) {
        return None;
    }
    let message = body
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let msg = |suffix: &str| {
        if message.is_empty() {
            suffix.to_string()
        } else {
            format!("{message} {suffix}")
        }
    };
    match status {
        401 => Some(AppError::GitHubAuth(msg("(检查 token 是否正确)"))),
        403 | 429 => Some(AppError::GitHubRateLimit(msg("(触发限速)"))),
        404 => Some(AppError::GitHubNotFound(msg("(仓库/资源不存在)"))),
        500..=599 => Some(AppError::GitHubServer(msg("(GitHub 服务器错误)"))),
        other => Some(AppError::Http(other, message)),
    }
}

/// 限速错误补 `X-RateLimit-Reset` 头部提示。
fn augment_error(err: AppError, headers: &HeaderMap) -> AppError {
    match err {
        AppError::GitHubRateLimit(_) => rate_limit_reset_hint(headers)
            .map(AppError::GitHubRateLimit)
            .unwrap_or(err),
        other => other,
    }
}

fn rate_limit_reset_hint(headers: &HeaderMap) -> Option<String> {
    let reset = headers
        .get("x-ratelimit-reset")?
        .to_str()
        .ok()?
        .parse::<i64>()
        .ok()?;
    let now = chrono::Utc::now().timestamp();
    let secs = (reset - now).max(0);
    Some(format!("GitHub 限速,约 {secs} 秒后可重试"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kind(e: &AppError) -> &'static str {
        match e {
            AppError::GitHubRateLimit(_) => "rate",
            AppError::GitHubAuth(_) => "auth",
            AppError::GitHubServer(_) => "server",
            AppError::GitHubNotFound(_) => "notfound",
            AppError::Http(_, _) => "http",
            _ => "other",
        }
    }

    #[test]
    fn test_classify_http_error_success_is_none() {
        assert!(classify_http_error(200, &json!({})).is_none());
        assert!(classify_http_error(201, &json!({ "id": 1 })).is_none());
    }

    #[test]
    fn test_classify_http_error_401_auth() {
        let e = classify_http_error(401, &json!({ "message": "Bad credentials" })).unwrap();
        assert_eq!(kind(&e), "auth");
        assert!(e.to_string().contains("Bad credentials"));
    }

    #[test]
    fn test_classify_http_error_rate_limit_403_429() {
        let e = classify_http_error(429, &json!({ "message": "API rate limit exceeded" })).unwrap();
        assert_eq!(kind(&e), "rate");
        assert!(e.to_string().contains("API rate limit exceeded"));

        let e403 = classify_http_error(403, &json!({})).unwrap();
        assert_eq!(kind(&e403), "rate");
    }

    #[test]
    fn test_classify_http_error_404_not_found() {
        let e = classify_http_error(404, &json!({ "message": "Not Found" })).unwrap();
        assert_eq!(kind(&e), "notfound");
        assert!(e.to_string().contains("Not Found"));
    }

    #[test]
    fn test_classify_http_error_5xx_server() {
        for code in [500, 502, 503] {
            let e = classify_http_error(code, &json!({ "message": "boom" })).unwrap();
            assert_eq!(kind(&e), "server");
            assert!(e.to_string().contains("boom"));
        }
    }

    #[test]
    fn test_classify_http_error_other_status_http() {
        let e = classify_http_error(400, &json!({ "message": "Validation Failed" })).unwrap();
        assert_eq!(kind(&e), "http");
        assert!(e.to_string().contains("Validation Failed"));
    }

    #[test]
    fn test_classify_http_error_empty_message_still_classifies() {
        let e = classify_http_error(404, &json!({})).unwrap();
        assert_eq!(kind(&e), "notfound");
    }

    #[test]
    fn test_rate_limit_reset_hint_from_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-reset", "9999999999".parse().unwrap());
        let hint = rate_limit_reset_hint(&headers);
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("秒后可重试"));

        assert!(rate_limit_reset_hint(&HeaderMap::new()).is_none());
    }
}
