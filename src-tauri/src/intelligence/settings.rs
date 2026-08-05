//! 智能运行时设置:读写 intelligence_settings 表,并按来源组装 LLM 配置。
//!
//! 数据模型见 db.rs `intelligence_settings`(单行 id=1);`IntelligenceSettingsDto`
//! 与 `LlmConfig` 见 dto.rs。来源分两种:
//! - `api`:OpenAI 兼容远端,base_url/api_key/model 三者齐即可用;
//! - `local`:本地 llama-server 旁路进程,base_url 指向 `http://127.0.0.1:<port>/v1`,
//!   model 用模型文件名,api_key 留空。

use std::sync::Arc;

use crate::db::Db;
use crate::dto::{IntelligenceSettingsDto, LlmConfig};
use crate::error::{AppError, AppResult};

/// 默认设置(数据库无行时的兜底):off / api / 0.5b / 窗口 50。
pub fn default_settings() -> IntelligenceSettingsDto {
    IntelligenceSettingsDto {
        mode: "off".into(),
        source: "api".into(),
        model_tier: "0.5b".into(),
        window_n: 50,
        base_url: None,
        api_key: None,
        model: None,
    }
}

/// 智能设置存储。port 与 LocalRunner 同源注入(local 模式的 base_url 需要),
/// 避免两处硬编码端口漂移。
#[derive(Clone)]
pub struct SettingsStore {
    db: Arc<Db>,
    port: u16,
}

impl SettingsStore {
    pub fn new(db: Arc<Db>, port: u16) -> Self {
        Self { db, port }
    }

    /// 读设置;无行 → 默认值。
    pub async fn get(&self) -> AppResult<IntelligenceSettingsDto> {
        match self.db.get_intelligence_settings().await? {
            Some(row) => Ok(IntelligenceSettingsDto {
                mode: row.mode,
                source: row.source,
                model_tier: row.model_tier,
                window_n: row.window_n,
                base_url: row.base_url,
                api_key: row.api_key,
                model: row.model,
            }),
            None => Ok(default_settings()),
        }
    }

    /// 写设置(UPSERT 单行 id=1)。
    pub async fn set(&self, dto: &IntelligenceSettingsDto) -> AppResult<()> {
        self.db
            .set_intelligence_settings(
                &dto.mode,
                &dto.source,
                &dto.model_tier,
                dto.window_n,
                dto.base_url.as_deref(),
                dto.api_key.as_deref(),
                dto.model.as_deref(),
            )
            .await
    }

    /// 组装 LLM 配置。
    /// - mode != llm → `[llm_not_configured]`;
    /// - source=api 且 base_url/api_key/model 齐 → 远端配置;
    /// - source=local → base_url=本地 llama-server `/v1`,model=模型文件名,api_key 留空。
    pub async fn build_llm_config(&self) -> AppResult<LlmConfig> {
        let s = self.get().await?;
        if s.mode != "llm" {
            return Err(AppError::Core(
                "[llm_not_configured] 智能运行时未开启 LLM 模式,请到智能设置开启".into(),
            ));
        }
        let non_empty =
            |v: &Option<String>| v.as_deref().is_some_and(|s| !s.trim().is_empty());
        if s.source != "api" {
            // source=local(未知值按 local 处理,避免误走 API 校验)
            let model = super::download::model_asset_name(&s.model_tier);
            return Ok(LlmConfig {
                system_prompt: None,
                base_url: Some(format!("http://127.0.0.1:{}/v1", self.port)),
                api_key: None,
                model: Some(model.to_string()),
                provider: Some("openai".into()),
                temperature: 0.7,
                max_tokens: None,
                top_p: None,
                timeout_secs: 120,
                max_retries: 2,
            });
        }
        if !non_empty(&s.base_url) || !non_empty(&s.api_key) || !non_empty(&s.model) {
            return Err(AppError::Core(
                "[llm_not_configured] API 来源缺少 base_url / api_key / model 之一,请到智能设置补齐"
                    .into(),
            ));
        }
        Ok(LlmConfig {
            system_prompt: None,
            base_url: s.base_url,
            api_key: s.api_key,
            model: s.model,
            provider: Some("openai".into()),
            temperature: 0.7,
            max_tokens: None,
            top_p: None,
            timeout_secs: 120,
            max_retries: 2,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store(port: u16) -> (tempfile::TempDir, SettingsStore) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::new(tmp.path().join("t.db")).await.unwrap());
        db.migrate().await.unwrap();
        (tmp, SettingsStore::new(db, port))
    }

    fn dto(mode: &str, source: &str, tier: &str) -> IntelligenceSettingsDto {
        IntelligenceSettingsDto {
            mode: mode.into(),
            source: source.into(),
            model_tier: tier.into(),
            window_n: 50,
            base_url: Some("https://api.example.com/v1".into()),
            api_key: Some("sk-test".into()),
            model: Some("gpt-4o-mini".into()),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_default_settings_when_no_row() {
        let (_tmp, s) = store(12700).await;
        let d = s.get().await.unwrap();
        assert_eq!(d.mode, "off");
        assert_eq!(d.source, "api");
        assert_eq!(d.model_tier, "0.5b");
        assert_eq!(d.window_n, 50);
        assert!(d.base_url.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_set_then_get_roundtrip() {
        let (_tmp, s) = store(12700).await;
        let d = dto("llm", "api", "1.5b");
        s.set(&d).await.unwrap();
        let got = s.get().await.unwrap();
        assert_eq!(got, d);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_build_llm_config_requires_llm_mode() {
        let (_tmp, s) = store(12700).await;
        let d = dto("off", "api", "0.5b");
        s.set(&d).await.unwrap();
        let err = s.build_llm_config().await.unwrap_err();
        assert_eq!(crate::intelligence::error_code(&err), "llm_not_configured");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_build_llm_config_api_ok() {
        let (_tmp, s) = store(12700).await;
        s.set(&dto("llm", "api", "0.5b")).await.unwrap();
        let cfg = s.build_llm_config().await.unwrap();
        assert_eq!(cfg.base_url.as_deref(), Some("https://api.example.com/v1"));
        assert_eq!(cfg.api_key.as_deref(), Some("sk-test"));
        assert_eq!(cfg.model.as_deref(), Some("gpt-4o-mini"));
        assert_eq!(cfg.provider.as_deref(), Some("openai"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_build_llm_config_api_missing_fields() {
        let (_tmp, s) = store(12700).await;
        let mut d = dto("llm", "api", "0.5b");
        d.api_key = None;
        s.set(&d).await.unwrap();
        let err = s.build_llm_config().await.unwrap_err();
        assert_eq!(crate::intelligence::error_code(&err), "llm_not_configured");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_build_llm_config_local() {
        let (_tmp, s) = store(12799).await;
        let mut d = dto("llm", "local", "1.5b");
        d.api_key = None;
        s.set(&d).await.unwrap();
        let cfg = s.build_llm_config().await.unwrap();
        assert_eq!(cfg.base_url.as_deref(), Some("http://127.0.0.1:12799/v1"));
        assert_eq!(cfg.model.as_deref(), Some("Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"));
        assert!(cfg.api_key.is_none());
        assert_eq!(cfg.provider.as_deref(), Some("openai"));
    }
}
