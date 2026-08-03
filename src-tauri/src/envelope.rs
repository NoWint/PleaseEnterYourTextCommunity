use serde_json::{json, Value};

use crate::error::AppResult;

/// PEYT 信封协议 (见 docs/superpowers/specs/2026-08-02-peyt-envelope-protocol-design.md)
///
/// 载体: view_type=Text 的普通消息, 正文以 [PEYT] 前缀开头, 后接 JSON 信封。
/// 结构:
///   [PEYT]{
///     "version": 1,
///     "type": "card.create",
///     "id": "<uuid>",          // 发送端幂等键, 防重试/多端重复处理
///     "timestamp": <unix_ts>,  // 发送端单调时钟, 冲突消解
///     "from": { "app":"peyt", "ver":"<kind>@<ver>", "kind":"desktop" },
///     "payload": { ... }       // 类型专属载荷
///   }
/// 字段全名风格(不缩写)——消息会出现在聊天流里,可读性优先。

pub const PEYT_PREFIX: &str = "[PEYT]";
pub const ENVELOPE_VERSION: i64 = 1;

/// 构建信封字符串: `[PEYT]` + JSON。
pub fn build_envelope(type_: &str, payload: Value) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp();
    let kind = platform_kind();
    let env = json!({
        "version": ENVELOPE_VERSION,
        "type": type_,
        "id": id,
        "timestamp": timestamp,
        "from": {
            "app": "peyt",
            "ver": format!("{kind}@{}", env!("CARGO_PKG_VERSION")),
            "kind": kind,
        },
        "payload": payload,
    });
    Ok(format!("{PEYT_PREFIX}{env}"))
}

/// 平台标识: desktop (win/mac/linux 归入桌面端, 移动端/其他归入对应名)。
fn platform_kind() -> &'static str {
    match std::env::consts::OS {
        "windows" | "macos" | "linux" => "desktop",
        "android" => "android",
        "ios" => "ios",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_structure() {
        let s = build_envelope("card.create", json!({"id": 1, "title": "t"})).unwrap();
        assert!(s.starts_with(PEYT_PREFIX));
        let json: Value = serde_json::from_str(&s[PEYT_PREFIX.len()..]).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["type"], "card.create");
        assert!(json["id"].as_str().unwrap().len() == 36); // uuid
        assert!(json["timestamp"].as_i64().unwrap() > 0);
        assert_eq!(json["from"]["app"], "peyt");
        assert_eq!(json["payload"]["id"], 1);
        assert_eq!(json["payload"]["title"], "t");
    }
}
