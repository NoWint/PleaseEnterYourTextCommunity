// 主题总结命令层:状态读写 / 下载 / 入队。SummaryService 作为 managed resource。
use std::sync::Arc;
use tauri::State;
use tauri::Emitter;
use crate::error::{AppError, AppResult};
use crate::llm::ChatMessage;
use crate::summary::queue::{Lane, SummaryJob, SummaryQueue};
use crate::summary::downloader::{DownloadWhat, Downloader, ModelSize};

pub struct SummaryService {
    pub queue: Arc<SummaryQueue>,
    pub downloader: Downloader,
    pub db: Arc<crate::db::Db>, // 偏好/状态/摘要缓存持久化(peytchat.db)
}

impl SummaryService {
    pub async fn new(app: tauri::AppHandle, data_dir: std::path::PathBuf, runner: Arc<crate::summary::runner::LocalRunner>, default_model: std::path::PathBuf, db: Arc<crate::db::Db>) -> Arc<Self> {
        let models_dir = data_dir.join("models");
        let svc = Arc::new(Self {
            queue: SummaryQueue::new(app.clone(), runner, default_model),
            downloader: Downloader::new(models_dir, app),
            db,
        });
        // 常驻 worker 循环:取任务→跑;空闲 10 分钟回收引擎进程(§10.4)
        // 引擎子进程随应用退出自行结束;下次启动 ensure_running 自愈.
        {
            let queue = svc.queue.clone();
            tokio::spawn(async move {
                let mut last_active = std::time::Instant::now();
                loop {
                    if let Some(job) = queue.next_job().await {
                        last_active = std::time::Instant::now();
                        queue.run_job(job).await;
                    } else {
                        if last_active.elapsed() >= std::time::Duration::from_secs(600) {
                            queue.runner.stop_if_idle().await;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            });
        }
        // 启动水合:从 summary_settings 恢复 api 配置与模型档位(重启后不静默退回本地/0.5b)
        if let Ok(row) = svc.db.get_summary_settings().await {
            if let (Some(b), Some(k), Some(m)) = (row.api_base_url.as_ref(), row.api_key.as_ref(), row.api_model.as_ref()) {
                let cfg: crate::dto::LlmConfig = crate::dto::LlmConfigInput {
                    system_prompt: None,
                    base_url: Some(b.clone()),
                    api_key: Some(k.clone()),
                    model: Some(m.clone()),
                    provider: Some("openai".into()),
                }
                .into();
                *svc.queue.api_cfg.lock().await = Some(cfg);
            }
            if row.model_size == "1.5b" {
                let p = svc.downloader.model_path(crate::summary::downloader::ModelSize::B15);
                svc.queue.set_current_model(p).await;
            }
        }
        svc
    }

    /// 构造 ChatMessage:system 按 lane/kind 选 prompt,user 为前端已组装好的窗口行。
    /// 注意:ChatMessage 有 4 字段(llm.rs:49),tool_calls/tool_call_id 必填。
    pub fn build_messages(prompt: &str, lane: &str, kind: &str) -> Vec<ChatMessage> {
        vec![
            ChatMessage { role: "system".into(), content: system_prompt(lane, kind).to_string(), tool_calls: vec![], tool_call_id: None },
            ChatMessage { role: "user".into(), content: prompt.to_string(), tool_calls: vec![], tool_call_id: None },
        ]
    }
}

/// 按车道/分析类型选 system prompt。bubble 纯文本;detail 各类 JSON/XML 约束。
pub fn system_prompt(lane: &str, kind: &str) -> &'static str {
    match (lane, kind) {
        ("bubble", _) => "你是聊天主题总结助手。用一句话(≤60字)概括最近聊的主题,直接输出,不要任何前缀后缀,不要使用 <message> 或 <user> 标签。",
        ("detail", "summary") => "你是聊天内容分析助手。根据聊天记录用一段话(2-4句)总结最近聊的内容,用 <message='...'> 引用具体消息(消息id或内容片段),用 <user='...'> 引用发言人名字,直接输出总结,不要前缀。",
        ("detail", "action_items") => "提取聊天中的行动项/待办事项,只输出 JSON 对象 {\"items\":[{\"text\":\"...\",\"assignee\":\"...\",\"due\":\"...\",\"ref\":数字}]},不要输出任何其它文本。",
        ("detail", "resources") => "聚合聊天中提到的链接和文件,只输出 JSON {\"links\":[{\"url\":\"...\",\"title\":\"...\",\"sender\":\"...\",\"ref\":数字}],\"files\":[{\"name\":\"...\",\"ref\":数字}]},不要其它文本。",
        ("detail", "open_questions") => "找出聊天中悬而未决的问题(提问后无人明确回答),只输出 JSON {\"questions\":[{\"text\":\"...\",\"asked_by\":\"...\",\"ref\":数字}]},不要其它文本。",
        ("detail", "timeline") => "把聊天按话题演变划分为若干阶段,只输出 JSON {\"phases\":[{\"period\":\"...\",\"topic\":\"...\",\"key_messages\":[数字]}]},不要其它文本。",
        ("detail", "decisions") => "提取聊天中做出的决策及理由,只输出 JSON {\"decisions\":[{\"title\":\"...\",\"by\":\"...\",\"rationale\":\"...\",\"ref\":数字}]},不要其它文本。",
        _ => "你是聊天内容分析助手,根据聊天记录输出分析结果。",
    }
}

/// 读全量偏好/状态(一次拉回前端内存缓存)。SQL 无行 → 默认值。
#[tauri::command]
pub async fn summary_get_state(svc: State<'_, Arc<SummaryService>>) -> AppResult<serde_json::Value> {
    let row = svc.db.get_summary_settings().await?;
    let engine_ok = svc.queue.runner.engine_path.exists();
    let model_ok = svc.queue.current_model.lock().await.exists();
    Ok(serde_json::json!({
        "mode": row.mode, "source": row.source, "modelSize": row.model_size, "contextN": row.context_n,
        "engineVersion": row.engine_version, "modelSha256": row.model_sha256,
        "apiConfigured": row.api_base_url.is_some() && row.api_key.is_some() && row.api_model.is_some(),
        "apiBaseUrl": row.api_base_url, "apiKey": row.api_key, "apiModel": row.api_model,
        "engineDownloaded": engine_ok,
        "modelDownloaded": model_ok,
    }))
}

/// 增量 upsert 偏好 + 引擎/模型状态(全部进 summary_settings 表)。
#[tauri::command]
pub async fn summary_save_prefs(
    svc: State<'_, Arc<SummaryService>>,
    mode: Option<String>, source: Option<String>, model_size: Option<String>, context_n: Option<u32>,
) -> AppResult<()> {
    let prev = svc.db.get_summary_settings().await?;
    let next_size = model_size.clone().unwrap_or_else(|| prev.model_size.clone());
    let next = crate::db::SummarySettingsPatch {
        mode: mode.unwrap_or(prev.mode),
        source: source.unwrap_or(prev.source),
        model_size: next_size.clone(),
        context_n: context_n.unwrap_or(prev.context_n),
    };
    svc.db.set_summary_settings(&next).await?;
    // 档位切换 → 队列切换到对应模型文件
    if next_size != prev.model_size {
        let size_enum = crate::summary::downloader::ModelSize::from_str_size(&next_size);
        let model_path = svc.downloader.model_path(size_enum);
        svc.queue.set_current_model(model_path).await;
    }
    Ok(())
}

/// 设置 API 凭据(存 summary_settings.api_* 列)。
#[tauri::command]
pub async fn summary_set_api(svc: State<'_, Arc<SummaryService>>, base_url: String, api_key: String, model: String) -> AppResult<()> {
    let cfg: crate::dto::LlmConfig = crate::dto::LlmConfigInput {
        system_prompt: None,
        base_url: Some(base_url.clone()),
        api_key: Some(api_key.clone()),
        model: Some(model.clone()),
        provider: Some("openai".into()),
    }
    .into();
    *svc.queue.api_cfg.lock().await = Some(cfg);
    svc.db.set_summary_api(Some(&base_url), Some(&api_key), Some(&model)).await?;
    Ok(())
}

#[tauri::command]
pub async fn summary_clear_api(svc: State<'_, Arc<SummaryService>>) -> AppResult<()> {
    *svc.queue.api_cfg.lock().await = None;
    svc.db.set_summary_api(None, None, None).await?;
    Ok(())
}

/// 读会话摘要缓存(上次分析结果)。无缓存 → null。
#[tauri::command]
pub async fn summary_load_cache(svc: State<'_, Arc<SummaryService>>, chat_id: u64, kind: String) -> AppResult<Option<String>> {
    svc.db.get_summary_cache(chat_id, &kind).await
}

/// 写会话摘要缓存(done 后落盘,重启恢复)。
#[tauri::command]
pub async fn summary_save_cache(svc: State<'_, Arc<SummaryService>>, chat_id: u64, kind: String, text: String) -> AppResult<()> {
    svc.db.upsert_summary_cache(chat_id, &kind, &text).await?;
    Ok(())
}

/// 列出模型:调 OpenAI 兼容 /models 端点(base_url + api_key),返回模型 id 列表。
/// DeepSeek(https://api.deepseek.com)与多数 OpenAI 兼容服务都支持。
#[tauri::command]
pub async fn summary_list_models(svc: State<'_, Arc<SummaryService>>, base_url: String, api_key: String) -> AppResult<Vec<String>> {
    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/models");
    let resp = svc.downloader.http
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| AppError::Core(format!("list_models: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Core(format!("list_models: HTTP {status}")));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| AppError::Core(format!("list_models parse: {e}")))?;
    // OpenAI 兼容响应:{data:[{id:"...",...}]}
    let ids = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ids)
}

#[tauri::command]
pub async fn summary_download(svc: State<'_, Arc<SummaryService>>, what: String, size: Option<String>) -> AppResult<()> {
    let target = match what.as_str() {
        "engine" => DownloadWhat::Engine,
        "model" => DownloadWhat::Model(ModelSize::from_str_size(size.as_deref().unwrap_or("0.5b"))),
        _ => return Err(AppError::Core("unknown download target".into())),
    };
    let app = svc.downloader.app.clone();
    let queue = svc.queue.clone(); // Arc<SummaryQueue>
    let dl = svc.downloader.clone_dl();
    let db = svc.db.clone();
    tokio::spawn(async move {
        match dl.download(target).await {
            Ok((path, sha)) => {
                // 模型下载完成 → 队列切到该档位(downloader 内部已 emit done)
                if let DownloadWhat::Model(_) = target {
                    queue.set_current_model(path).await;
                }
                // 版本/哈希落库(引擎与模型共用同一 engine_tag)
                let _ = db.set_summary_version_hash(&dl.engine_tag, &sha).await;
            }
            Err(e) => {
                // 失败发 error 事件,前端显示失败原因
                let _ = app.emit("download-progress", &serde_json::json!({
                    "status": "error", "message": e.to_string(),
                }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn summary_enqueue(
    svc: State<'_, Arc<SummaryService>>,
    chat_id: u64,
    lane: String,
    kind: String,
    prompt: String,
) -> AppResult<()> {
    // prompt = 前端 formatWindowLines 已组装好的行(含绝对时间 + 可选上次分析块),后端不重格式化
    let messages = SummaryService::build_messages(&prompt, &lane, &kind);
    let job = SummaryJob {
        chat_id,
        lane: if lane == "bubble" { Lane::Bubble } else { Lane::Detail },
        kind,
        messages,
        timeout: if lane == "bubble" { std::time::Duration::from_secs(60) } else { std::time::Duration::from_secs(120) },
    };
    svc.queue.enqueue(job).await?;
    Ok(())
}
