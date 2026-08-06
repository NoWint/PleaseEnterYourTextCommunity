use serde_json::{json, Value};

use crate::error::AppResult;

/// PEYT 信封协议 (见 docs/superpowers/specs/2026-08-04-pure-json-envelope-design.md)
///
/// 载体: view_type=Text 的普通消息, 正文就是纯 JSON, 无前缀。
/// 结构:
///   {
///     "type": "text",        // 注册表判别符(聊天消息类型), 未知则显示原文
///     "id": "<uuid>",        // 发送端幂等键, 防重试/多端重复处理
///     "payload": { "text": "你好" }  // 类型专属载荷; 所有 type 都有 text 字段填消息体正文
///   }
/// 无 version / 无 from: 兼容性靠 payload 强校验, 发送者取消息 from_id。
/// 无 timestamp: core 的 msgs.timestamp 已提供, 信封不重复携带。
/// 字段全名风格(不缩写)——消息会出现在聊天流里,可读性优先。

/// 构建信封字符串: 纯 JSON。
pub fn build_envelope(type_: &str, payload: Value) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let env = json!({
        "type": type_,
        "id": id,
        "payload": payload,
    });
    Ok(env.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_structure() {
        let s = build_envelope("text", json!({"text": "你好"})).unwrap();
        // 纯 JSON, 无前缀
        assert!(s.starts_with('{'));
        let json: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(json["type"], "text");
        assert!(json["id"].as_str().unwrap().len() == 36); // uuid
        assert_eq!(json["payload"]["text"], "你好");
        // 无 version / from / timestamp 字段
        assert!(json.get("version").is_none());
        assert!(json.get("from").is_none());
        assert!(json.get("timestamp").is_none());
    }

    #[test]
    fn envelope_text_with_markdown() {
        let s = build_envelope("text", json!({"text": "**hi**", "markdown": true})).unwrap();
        let json: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(json["payload"]["markdown"], true);
        assert_eq!(json["payload"]["text"], "**hi**");
    }
}
