//! 智能运行时:LLM 主题总结 + 知识库共享的推理引擎。
//!
//! 模块构成:
//! - `settings`:智能设置读写 + LLM 配置组装(本地/API 双来源);
//! - `api` / `local`:两个推理来源(远端 LlmClient / 本地 llama-server 旁路进程);
//! - `queue`:摘要双车道队列(bubble / detail),统一事件回传;
//! - `download`:引擎 + 模型下载器(进度事件 / sha256 / post-process)。
//!
//! 集成者入口:`Intelligence::new(db, data_dir, handle)` 装配;
//! `complete_text()` 统一 LLM 补全(知识库 /ask 等复用);
//! `error_code()` 从 AppError 提取 §10.2 错误码。

pub mod api;
pub mod download;
pub mod local;
pub mod queue;
pub mod settings;

use std::path::PathBuf;
use std::sync::Arc;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::llm::ChatMessage;

use download::Downloader;
use local::LocalRunner;
use queue::SummaryQueue;
use settings::SettingsStore;

/// 智能运行时:设置 + 摘要队列 + 本地引擎 + 下载器。
pub struct Intelligence {
    pub settings: SettingsStore,
    pub queue: SummaryQueue,
    pub local: Arc<LocalRunner>,
    pub downloader: Downloader,
}

impl Intelligence {
    /// 装配:先建 LocalRunner(端口单一来源),SettingsStore 注入同端口。
    pub fn new(db: Arc<Db>, data_dir: PathBuf, handle: tauri::AppHandle) -> Self {
        let local = Arc::new(LocalRunner::new(data_dir.clone()));
        let settings = SettingsStore::new(db, local.port());
        let queue = SummaryQueue::new(handle.clone(), local.clone(), Arc::new(settings.clone()));
        let downloader = Downloader::new(data_dir);
        Self {
            settings,
            queue,
            local,
            downloader,
        }
    }

    /// 统一 LLM 入口(知识库集成者用):读设置 → build_llm_config →
    /// 按来源(local/api)complete。错误消息带 `[code]` 前缀,
    /// 集成者可用 `error_code()` 提取错误码。
    pub async fn complete_text(&self, messages: Vec<ChatMessage>) -> AppResult<String> {
        let dto = self.settings.get().await?;
        if dto.mode != "llm" {
            return Err(AppError::Core(
                "[llm_not_configured] 智能运行时未开启 LLM 模式,请到智能设置开启".into(),
            ));
        }
        if messages.is_empty() {
            return Err(AppError::Core("[window_empty] 输入为空,无可推理内容".into()));
        }
        let cfg = self.settings.build_llm_config().await?;
        match dto.source.as_str() {
            "local" => {
                let model_path = self.local.model_path(&dto.model_tier);
                self.local.ensure_ready(&model_path).await?;
                self.local.complete(&cfg, messages).await
            }
            _ => api::complete(&cfg, messages).await,
        }
    }
}

/// 从 AppError 提取错误码(§10.2,纯函数,可单测)。
/// - Core 消息以 `[code] ` 开头 → 返回 code;
/// - Http → 按 `api::classify_status` 映射(api_auth/api_quota/...);
/// - Network → `api_network`;其它 → `unknown`。
pub fn error_code(e: &AppError) -> &str {
    match e {
        AppError::Http(code, body) => {
            let status = reqwest::StatusCode::from_u16(*code)
                .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR);
            api::classify_status(status, body)
        }
        AppError::Network(_) => "api_network",
        AppError::Core(msg) => msg
            .strip_prefix('[')
            .and_then(|m| m.split(']').next())
            .map(|c| if c.is_empty() { "unknown" } else { c })
            .unwrap_or("unknown"),
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_code_core_prefix() {
        assert_eq!(
            error_code(&AppError::Core("[engine_not_ready] x".into())),
            "engine_not_ready"
        );
        assert_eq!(
            error_code(&AppError::Core("[llm_not_configured] x".into())),
            "llm_not_configured"
        );
        assert_eq!(error_code(&AppError::Core("plain message".into())), "unknown");
        assert_eq!(error_code(&AppError::Core("[] x".into())), "unknown");
    }

    #[test]
    fn test_error_code_http_and_network() {
        assert_eq!(error_code(&AppError::Network("timeout".into())), "api_network");
        assert_eq!(error_code(&AppError::Http(401, "bad key".into())), "api_auth");
        assert_eq!(error_code(&AppError::Http(403, "denied".into())), "api_auth");
        assert_eq!(error_code(&AppError::Http(402, "quota".into())), "api_quota");
        assert_eq!(error_code(&AppError::Http(429, "slow down".into())), "api_rate_limit");
        assert_eq!(error_code(&AppError::Http(429, "quota exceeded".into())), "api_quota");
        assert_eq!(error_code(&AppError::Http(400, "bad".into())), "api_bad_request");
        assert_eq!(error_code(&AppError::Http(500, "boom".into())), "api_network");
        assert_eq!(error_code(&AppError::AuthFailed), "unknown");
    }
}
