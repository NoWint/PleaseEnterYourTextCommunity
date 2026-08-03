use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("认证失败：邮箱或密码错误")]
    AuthFailed,
    #[error("网络错误：{0}")]
    Network(String),
    #[error("未找到自动配置，请手动填写 IMAP/SMTP")]
    AutoconfigNotFound,
    #[error("核心错误：{0}")]
    Core(String),
    #[error("IO 错误：{0}")]
    Io(String),
    #[error("数据库错误：{0}")]
    Db(String),
    #[error("插件错误：{0}")]
    Plugin(String),
    #[error("HTTP {0}: {1}")]
    Http(u16, String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Core(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::Core(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_error_serialization() {
        let e = AppError::Http(500, "boom".into());
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"Http\""));
        assert!(json.contains("boom"));
    }
}
