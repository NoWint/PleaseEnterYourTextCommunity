//! 摘要队列(双车道):bubble 一句话摘要 / detail 结构化分析(§4)。
//!
//! 执行流程:读设置 → 组装 prompt(§4.5)→ build_llm_config → 按来源
//! (api/local)complete → 一次 emit `summary-event`。
//! **流式简化**:本期不做逐 token SSE 流式(复杂度高),拿到完整结果后一次
//! emit `{status:'done', result}`;流式留待迭代 2。
//!
//! 去重:同 chat 同 lane 进行中 → 新入队直接丢弃(§10.5)。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use tauri::Emitter;

use crate::llm::ChatMessage;

use super::local::LocalRunner;
use super::settings::SettingsStore;

// ---------- prompt 常量(§4.5.2 / §4.5.3) ----------

/// bubble 车道 system(一句话短摘要,≤60 字,无标签)。
const SYS_BUBBLE: &str = "你是聊天主题总结助手。根据给定的聊天记录,用一句话概括最近聊的主题。\
要求:一句话,不超过 60 字,直接输出,不要任何前缀后缀,不要使用 <message> 或 <user> 标签";

/// detail 车道 summary 类型 system(一段话 + XML 行内引用)。
const SYS_DETAIL_SUMMARY: &str = "你是聊天内容分析助手。根据聊天记录,用一段话总结最近聊的内容。\
要求:一段话(2-4 句),用 <message='...'> 引用具体消息,用 <user='...'> 引用发言人,直接输出总结";

/// 其它分析类型 system 模板(JSON 输出约束 + 各自 schema)。
const SYS_DETAIL_JSON_TEMPLATE: &str =
    "你是聊天内容分析助手。根据聊天记录分析{label}。只输出 JSON,不要解释,格式参考:{schema}";

const ASK_BUBBLE: &str = "请用一句话概括最近聊的主题:";
const ASK_DETAIL_SUMMARY: &str = "请用一段话总结:";
const ASK_DETAIL_JSON: &str = "请分析最近聊的内容,按要求的格式输出:";

/// 结构化分析类型 → (中文名, 输出 JSON schema)(§9.5 / §4.5.3)。
fn detail_schema(kind: &str) -> Option<(&'static str, &'static str)> {
    let (label, schema) = match kind {
        "action_items" => (
            "待办事项",
            r#"{"items":[{"text":"","assignee":"","due":""}]}"#,
        ),
        "decisions" => (
            "决策记录",
            r#"{"decisions":[{"title":"","made_when":"","by":""}]}"#,
        ),
        "timeline" => (
            "话题时间线",
            r#"{"phases":[{"period":"","topic":"","key_messages":[]}]}"#,
        ),
        "participation" => ("参与情况", r#"{"active_members":[],"busy_period":""}"#),
        "open_questions" => (
            "未解决问题",
            r#"{"questions":[{"text":"","asked_by":"","unanswered_since":""}]}"#,
        ),
        "mood" => (
            "情绪氛围",
            r#"{"overall":"","score":0,"emoji":"","summary":"","highlights":[{"text":"","emoji":""}]}"#,
        ),
        _ => return None,
    };
    Some((label, schema))
}

/// 组装 prompt(system + user 两条消息,纯函数,可单测)。
///
/// - bubble:system=一句话概括约束;user=历史上下文 + 最近记录 + 「请用一句话概括…」;
/// - detail+summary:system=一段话 + `<message>`/`<user>` 引用;user 以「请用一段话总结:」收尾;
/// - detail+其它 kind:system=JSON schema 约束;user 以「请按格式输出:」收尾;
/// - 未知 kind 退化为 summary;prev 为空时省略「历史上下文」块。
pub fn build_prompt(
    lane: &str,
    kind: Option<&str>,
    lines: &[String],
    prev: Option<&str>,
) -> Vec<ChatMessage> {
    let (system, ask) = if lane == "bubble" {
        (SYS_BUBBLE.to_string(), ASK_BUBBLE)
    } else if let Some(k) = kind {
        match detail_schema(k) {
            Some((label, schema)) => (
                SYS_DETAIL_JSON_TEMPLATE
                    .replace("{label}", label)
                    .replace("{schema}", schema),
                ASK_DETAIL_JSON,
            ),
            None => (SYS_DETAIL_SUMMARY.to_string(), ASK_DETAIL_SUMMARY),
        }
    } else {
        (SYS_DETAIL_SUMMARY.to_string(), ASK_DETAIL_SUMMARY)
    };

    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = prev.map(str::trim).filter(|p| !p.is_empty()) {
        parts.push(format!("历史上下文:\n{p}"));
    }
    let lines_block = lines.join("\n");
    parts.push(format!("最近聊天记录:\n{lines_block}"));
    let user = format!("{}\n\n{ask}", parts.join("\n\n"));

    vec![
        ChatMessage { role: "system".into(), content: system, ..Default::default() },
        ChatMessage { role: "user".into(), content: user, ..Default::default() },
    ]
}

/// 一次摘要请求(bubble 或 detail 车道)。
pub struct SummaryRequest {
    pub chat_id: u32,
    /// 'bubble' | 'detail'
    pub lane: String,
    /// detail 车道分析类型:summary/action_items/decisions/timeline/participation/open_questions
    pub kind: Option<String>,
    /// 前端组装的窗口行:`[id=42] 张三 [2026-08-05 09:02]: 下午三点开会`
    pub lines: Vec<String>,
    pub prev_analysis: Option<String>,
}

/// 引擎运行时状态(队列维护,供集成者读取/展示)。
#[derive(Debug, Clone, Default)]
pub struct EngineState {
    pub engine_ready: bool,
    pub model_path: Option<PathBuf>,
    pub last_used: i64,
    pub child_running: bool,
}

/// 摘要队列:本地串行 + API 并发由调用方控制;每 chat 每 lane 保留最新。
pub struct SummaryQueue {
    handle: tauri::AppHandle,
    local: Arc<LocalRunner>,
    settings: Arc<SettingsStore>,
    engine_state: Arc<StdMutex<EngineState>>,
    /// 进行中标记 (chat_id, lane) → 是否执行中;进行中再入队 → 直接丢弃。
    in_flight: Arc<StdMutex<HashMap<(u32, String), bool>>>,
}

impl SummaryQueue {
    pub fn new(
        handle: tauri::AppHandle,
        local: Arc<LocalRunner>,
        settings: Arc<SettingsStore>,
    ) -> Self {
        Self {
            handle,
            local,
            settings,
            engine_state: Arc::new(StdMutex::new(EngineState::default())),
            in_flight: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// 当前引擎状态快照。
    pub fn engine_state(&self) -> EngineState {
        self.engine_state.lock().unwrap().clone()
    }

    /// 入队:同 chat 同 lane 进行中 → 丢弃新任务;否则 spawn 后台执行。
    pub fn enqueue(&self, req: SummaryRequest) {
        let key = (req.chat_id, req.lane.clone());
        {
            let mut in_flight = self.in_flight.lock().unwrap();
            if in_flight.contains_key(&key) {
                log::debug!(
                    "intelligence queue: 丢弃重复任务 chat={} lane={}",
                    key.0,
                    key.1
                );
                return;
            }
            in_flight.insert(key.clone(), true);
        }
        let handle = self.handle.clone();
        let local = self.local.clone();
        let settings = self.settings.clone();
        let engine_state = self.engine_state.clone();
        let in_flight = self.in_flight.clone();
        tauri::async_runtime::spawn(async move {
            run_summary(handle, local, settings, engine_state, req).await;
            in_flight.lock().unwrap().remove(&key);
        });
    }
}

/// 执行一次摘要任务(事件已在此处全部 emit,返回即完成)。
async fn run_summary(
    handle: tauri::AppHandle,
    local: Arc<LocalRunner>,
    settings: Arc<SettingsStore>,
    engine_state: Arc<StdMutex<EngineState>>,
    req: SummaryRequest,
) {
    // 1. 模式检查
    let dto = match settings.get().await {
        Ok(d) => d,
        Err(e) => return emit_error(&handle, &req, "internal", &e.to_string()),
    };
    if dto.mode != "llm" {
        return emit_error(&handle, &req, "llm_not_configured", "智能运行时未开启 LLM 模式");
    }
    // 2. 空窗口
    if req.lines.is_empty() {
        return emit_error(&handle, &req, "window_empty", "输入窗口为空,无可总结内容");
    }
    // 3. prompt + 配置
    let messages =
        build_prompt(&req.lane, req.kind.as_deref(), &req.lines, req.prev_analysis.as_deref());
    let cfg = match settings.build_llm_config().await {
        Ok(c) => c,
        Err(e) => {
            return emit_error(&handle, &req, crate::intelligence::error_code(&e), &e.to_string())
        }
    };
    // 4. 分来源执行
    let result = match dto.source.as_str() {
        "local" => {
            let model_path = local.model_path(&dto.model_tier);
            if let Err(e) = local.ensure_ready(&model_path).await {
                *engine_state.lock().unwrap() = EngineState {
                    engine_ready: false,
                    model_path: None,
                    last_used: local.last_used(),
                    child_running: local.is_running(),
                };
                return emit_error(
                    &handle,
                    &req,
                    crate::intelligence::error_code(&e),
                    &e.to_string(),
                );
            }
            *engine_state.lock().unwrap() = EngineState {
                engine_ready: true,
                model_path: Some(model_path),
                last_used: local.last_used(),
                child_running: local.is_running(),
            };
            local.complete(&cfg, messages).await
        }
        _ => super::api::complete(&cfg, messages).await,
    };
    // 5. 非流式:一次 emit done(流式留待迭代 2)
    match result {
        Ok(text) => {
            let _ = handle.emit(
                "summary-event",
                serde_json::json!({
                    "chatId": req.chat_id,
                    "lane": req.lane,
                    "kind": req.kind,
                    "status": "done",
                    "result": text,
                }),
            );
        }
        Err(e) => emit_error(&handle, &req, crate::intelligence::error_code(&e), &e.to_string()),
    }
}

/// 统一错误事件:`{status:'error', error:{code, message}}`(§10.1)。
fn emit_error(handle: &tauri::AppHandle, req: &SummaryRequest, code: &str, message: &str) {
    let _ = handle.emit(
        "summary-event",
        serde_json::json!({
            "chatId": req.chat_id,
            "lane": req.lane,
            "kind": req.kind,
            "status": "error",
            "error": { "code": code, "message": message },
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_prompt_bubble() {
        let lines = vec![
            "[id=1] 张三 [2026-08-05 09:00]: 下午三点开会".into(),
            "[id=2] 李四 [2026-08-05 09:01]: 收到,带电脑".into(),
        ];
        let msgs = build_prompt("bubble", None, &lines, Some("上次分析摘要"));
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "system");
        assert!(msgs[0].content.contains("一句话概括"));
        assert!(msgs[0].content.contains("60 字"));
        assert!(msgs[0].content.contains("<message>"));
        assert_eq!(msgs[1].role, "user");
        assert!(msgs[1].content.contains("历史上下文:\n上次分析摘要"));
        assert!(msgs[1].content.contains("[id=1] 张三 [2026-08-05 09:00]: 下午三点开会"));
        assert!(msgs[1].content.contains("[id=2] 李四 [2026-08-05 09:01]: 收到,带电脑"));
        assert!(msgs[1].content.contains(ASK_BUBBLE));
    }

    #[test]
    fn test_build_prompt_bubble_no_prev() {
        let msgs = build_prompt("bubble", None, &["[id=1] 张三: 你好".into()], None);
        assert!(!msgs[1].content.contains("历史上下文"));
        assert!(msgs[1].content.contains("最近聊天记录"));
    }

    #[test]
    fn test_build_prompt_detail_summary() {
        let msgs = build_prompt("detail", Some("summary"), &["[id=1] 张三: 你好".into()], None);
        assert!(msgs[0].content.contains("一段话(2-4 句)"));
        assert!(msgs[0].content.contains("<message='...'>"));
        assert!(msgs[0].content.contains("<user='...'>"));
        assert!(msgs[1].content.contains(ASK_DETAIL_SUMMARY));
    }

    #[test]
    fn test_build_prompt_detail_json_kinds() {
        for (kind, fragment) in [
            ("action_items", r#""items""#),
            ("decisions", r#""decisions""#),
            ("timeline", r#""phases""#),
            ("participation", r#""active_members""#),
            ("open_questions", r#""questions""#),
            ("mood", r#""overall""#),
        ] {
            let msgs = build_prompt("detail", Some(kind), &["[id=1] 张三: 你好".into()], None);
            assert!(msgs[0].content.contains("只输出 JSON"), "{kind}");
            assert!(msgs[0].content.contains(fragment), "{kind}");
            assert!(!msgs[0].content.contains("一段话(2-4 句)"), "{kind}");
            assert!(msgs[1].content.contains(ASK_DETAIL_JSON), "{kind}");
        }
    }

    #[test]
    fn test_build_prompt_detail_unknown_kind_falls_back_to_summary() {
        let msgs = build_prompt("detail", Some("weird"), &["x".into()], None);
        assert!(msgs[0].content.contains("一段话(2-4 句)"));
    }

    #[test]
    fn test_build_prompt_detail_without_kind() {
        let msgs = build_prompt("detail", None, &["x".into()], None);
        assert!(msgs[0].content.contains("一段话(2-4 句)"));
    }

    #[test]
    fn test_build_prompt_empty_lines() {
        let msgs = build_prompt("bubble", None, &[], None);
        assert!(msgs[1].content.contains("最近聊天记录:"));
        assert!(msgs[1].content.contains(ASK_BUBBLE));
    }
}
