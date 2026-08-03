//! 联网工具:get_weather / fetch_url / web_search。
//!
//! 三个工具均为 `is_safe=true`,默认开放给 LLM。各自持有共享的
//! `reqwest::Client` 连接池,在 `new()` 中构造。

use async_trait::async_trait;
use reqwest::Client;

use crate::error::{AppError, AppResult};
use crate::tools::{Tool, ToolContext};

/// 天气工具:按城市名(Open-Meteo 地理编码)或经纬度查询当前天气。
pub struct GetWeatherTool {
    http: Client,
}

/// 网页抓取工具:GET 页面 → 剥 HTML 标签 → 纯文本前 2000 字符。
pub struct FetchUrlTool {
    http: Client,
}

/// 搜索工具:DuckDuckGo Instant Answer(免 API key)。
pub struct WebSearchTool {
    http: Client,
}

impl GetWeatherTool {
    pub fn new() -> Self {
        Self {
            http: Client::new(),
        }
    }
}

impl FetchUrlTool {
    pub fn new() -> Self {
        Self {
            http: Client::new(),
        }
    }
}

impl WebSearchTool {
    pub fn new() -> Self {
        Self {
            http: Client::new(),
        }
    }
}

impl Default for GetWeatherTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for FetchUrlTool {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for GetWeatherTool {
    fn name(&self) -> &'static str {
        "get_weather"
    }

    fn description(&self) -> &'static str {
        "查询天气(按城市名或经纬度)"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "city": { "type": "string" },
                "latitude": { "type": "number" },
                "longitude": { "type": "number" }
            }
        })
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext<'_>) -> AppResult<String> {
        let city = args
            .get("city")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let latitude = args.get("latitude").and_then(|v| v.as_f64());
        let longitude = args.get("longitude").and_then(|v| v.as_f64());

        let (lat, lon, label) = if let Some(city) = city {
            let (lat, lon) = self.geocode(city).await?;
            (lat, lon, city.to_string())
        } else if let (Some(lat), Some(lon)) = (latitude, longitude) {
            (lat, lon, format!("{lat},{lon}"))
        } else {
            return Err(AppError::Core("请提供 city 或 latitude/longitude".into()));
        };

        let url = format!(
            "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true"
        );
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Network(format!("请求天气失败: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Network(format!(
                "天气服务响应异常: {}",
                resp.status()
            )));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Core(format!("解析天气数据失败: {e}")))?;
        let cw = &json["current_weather"];
        let temperature = cw["temperature"].as_f64().unwrap_or(0.0);
        let windspeed = cw["windspeed"].as_f64().unwrap_or(0.0);
        let weathercode = cw["weathercode"].as_i64().unwrap_or(-1);
        let time = cw["time"].as_str().unwrap_or("");

        Ok(format!(
            "{} 当前 {:.1}°C,{},风速 {:.1} km/h ({})",
            label,
            temperature,
            weather_code_to_cn(weathercode),
            windspeed,
            time
        ))
    }
}

impl GetWeatherTool {
    async fn geocode(&self, city: &str) -> AppResult<(f64, f64)> {
        let encoded = urlencoding::encode(city);
        let url = format!("https://geocoding-api.open-meteo.com/v1/search?name={encoded}&count=1");
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Network(format!("地理编码失败: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Network(format!(
                "地理编码服务响应异常: {}",
                resp.status()
            )));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Core(format!("解析地理编码数据失败: {e}")))?;
        let first = json["results"]
            .get(0)
            .ok_or_else(|| AppError::Core(format!("未找到城市: {city}")))?;
        let lat = first
            .get("latitude")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| AppError::Core(format!("未找到城市: {city}")))?;
        let lon = first
            .get("longitude")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| AppError::Core(format!("未找到城市: {city}")))?;
        Ok((lat, lon))
    }
}

#[async_trait]
impl Tool for FetchUrlTool {
    fn name(&self) -> &'static str {
        "fetch_url"
    }

    fn description(&self) -> &'static str {
        "抓取网页内容并返回纯文本摘要(前 2000 字符)"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "url": { "type": "string" }
            },
            "required": ["url"]
        })
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext<'_>) -> AppResult<String> {
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("");
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(AppError::Core("仅支持 http/https URL".into()));
        }

        let resp = match self
            .http
            .get(url)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return Ok("无法抓取该 URL".to_string()),
        };
        if !resp.status().is_success() {
            return Ok("无法抓取该 URL".to_string());
        }
        let body = match resp.text().await {
            Ok(t) => t,
            Err(_) => return Ok("无法抓取该 URL".to_string()),
        };
        let text = collapse_ws(&strip_html(&body));
        let text: String = text.chars().take(2000).collect();
        if text.is_empty() {
            Ok("无法抓取该 URL".to_string())
        } else {
            Ok(text)
        }
    }
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &'static str {
        "web_search"
    }

    fn description(&self) -> &'static str {
        "网页搜索(使用 DuckDuckGo Instant Answer,无需 API key)"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" }
            },
            "required": ["query"]
        })
    }

    async fn execute(&self, args: serde_json::Value, _ctx: &ToolContext<'_>) -> AppResult<String> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("");
        if query.is_empty() {
            return Err(AppError::Core("请提供搜索关键词".into()));
        }
        let encoded = urlencoding::encode(query);
        let url = format!(
            "https://api.duckduckgo.com/?q={encoded}&format=json&no_html=1&skip_disambig=1"
        );
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Network(format!("搜索请求失败: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Network(format!(
                "搜索服务响应异常: {}",
                resp.status()
            )));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Core(format!("解析搜索结果失败: {e}")))?;
        let answer = json["AbstractText"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                json["RelatedTopics"]
                    .get(0)
                    .and_then(|t| t["Text"].as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "未找到直接结果".to_string());
        let answer: String = answer.chars().take(500).collect();
        Ok(answer)
    }
}

/// Open-Meteo weathercode → 中文描述。
fn weather_code_to_cn(code: i64) -> &'static str {
    match code {
        0 => "晴",
        1 | 2 => "多云",
        3 => "阴",
        45 | 48 => "雾",
        51..=57 => "毛毛雨",
        61..=67 => "雨",
        71..=77 => "雪",
        80..=82 => "阵雨",
        85 | 86 => "阵雪",
        95..=99 => "雷暴",
        _ => "未知",
    }
}

/// 剥离 HTML 标签(简单扫描,零依赖)。
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        if in_tag {
            if c == '>' {
                in_tag = false;
            }
        } else if c == '<' {
            in_tag = true;
        } else {
            out.push(c);
        }
    }
    out
}

/// 连续空白折叠为单个空格,并去掉首尾空白。
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending = false;
    for c in s.trim().chars() {
        if c.is_whitespace() {
            pending = true;
        } else {
            if pending {
                out.push(' ');
                pending = false;
            }
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use deltachat::chat::ChatId;
    use deltachat::context::Context;

    use super::*;
    use crate::db::Db;

    /// 持有构造 ToolContext 所需的所有权对象(短生命周期,仅测试用)。
    struct TestCtx {
        _tmp: tempfile::TempDir,
        dc: Context,
        db: Db,
        data_dir: std::path::PathBuf,
    }

    impl TestCtx {
        async fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let mut accounts =
                deltachat::accounts::Accounts::new(tmp.path().join("accounts"), true)
                    .await
                    .unwrap();
            let id = accounts.add_account().await.unwrap();
            let dc = accounts.get_account(id).unwrap();
            let db = Db::new(tmp.path().join("app.db")).await.unwrap();
            let data_dir = tmp.path().to_path_buf();
            Self {
                _tmp: tmp,
                dc,
                db,
                data_dir,
            }
        }

        fn tool_ctx(&self) -> ToolContext<'_> {
            ToolContext {
                dc: &self.dc,
                db: &self.db,
                bot_id: 1,
                chat_id: ChatId::new(123),
                data_dir: &self.data_dir,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_weather_requires_location() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let err = GetWeatherTool::new()
            .execute(serde_json::json!({}), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("请提供"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_fetch_url_rejects_scheme() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let err = FetchUrlTool::new()
            .execute(serde_json::json!({ "url": "ftp://x" }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("http"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_web_search_requires_query() {
        let owned = TestCtx::new().await;
        let ctx = owned.tool_ctx();
        let err = WebSearchTool::new()
            .execute(serde_json::json!({ "query": "   " }), &ctx)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("关键词"));
    }

    #[test]
    fn test_tool_meta() {
        let tools: [Box<dyn Tool>; 3] = [
            Box::new(GetWeatherTool::new()),
            Box::new(FetchUrlTool::new()),
            Box::new(WebSearchTool::new()),
        ];
        for t in tools {
            assert!(!t.name().is_empty());
            assert!(!t.description().is_empty());
            assert_eq!(t.parameters()["type"], "object");
        }
    }

    #[test]
    fn test_strip_html_and_collapse() {
        assert_eq!(strip_html("<b>hi</b>"), "hi");
        assert_eq!(collapse_ws("  hello \n\n  world\t!"), "hello world !");
    }
}
