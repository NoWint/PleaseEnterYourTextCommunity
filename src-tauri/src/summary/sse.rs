// OpenAI 兼容 SSE 流式解析:data: {...} 行,choices[0].delta.content 累加,data: [DONE] 结束。
// 本地 llama-server 与 API 模式同格式,一个解析器两种复用。

pub struct SseDelta {
    pub text: String, // 本次增量文本(空 = 事件/元数据行,跳过)
    pub done: bool,   // data: [DONE]
}

pub fn parse_sse_line(line: &str) -> Option<SseDelta> {
    let line = line.trim();
    let Some(data) = line.strip_prefix("data:") else { return None; };
    let data = data.trim();
    if data == "[DONE]" { return Some(SseDelta { text: String::new(), done: true }); }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let delta = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|ch| ch.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    Some(SseDelta { text: delta.to_string(), done: false })
}

/// 从字节流分帧出 SSE 事件文本。返回 String(已完成的一段 data)。
/// 先把 \r 字节归一化掉(CRLF 服务器用 \r\n\r\n 分帧,直接按 \n\n 会静默丢流),
/// 再按 \n\n 切事件;消费已完整的事件返回,残留留在 buf。
pub fn extract_sse_text(buf: &mut Vec<u8>) -> Option<String> {
    buf.retain(|&b| b != b'\r'); // 归一化 CRLF → LF(幂等,可对残留重复调用)
    let pos = buf.windows(2).position(|w| w == b"\n\n")?;
    let ev = String::from_utf8_lossy(&buf[..pos]).to_string();
    buf.drain(..pos + 2);
    Some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_content_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"今天"}}]}"#;
        let d = parse_sse_line(line).unwrap();
        assert_eq!(d.text, "今天");
        assert!(!d.done);
    }

    #[test]
    fn parse_done() {
        let d = parse_sse_line("data: [DONE]").unwrap();
        assert!(d.done);
    }

    #[test]
    fn skip_metadata() {
        assert!(parse_sse_line("data: [DONE]").unwrap().done);
        assert!(parse_sse_line(": ping").is_none());
        // 非 [DONE] 且非 JSON 的行 → None
        assert!(parse_sse_line("data: garbage").is_none());
    }

    #[test]
    fn extract_events() {
        let mut buf = b"data: {\"choices\":[]}\n\ndata: {\"x\":1}\n\n".to_vec();
        let first = extract_sse_text(&mut buf).unwrap();
        assert!(first.contains("choices"));
        assert!(!buf.is_empty());
    }

    #[test]
    fn extract_events_crlf() {
        // CRLF 服务器(\r\n\r\n 分帧)也能正确切事件,不静默丢流
        let mut buf = b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n".to_vec();
        let first = extract_sse_text(&mut buf).unwrap();
        assert!(first.contains("hi"));
        let second = extract_sse_text(&mut buf).unwrap();
        assert!(second.contains("[DONE]"));
        assert!(buf.is_empty());
    }

    #[test]
    fn extract_events_mixed_lf_crlf() {
        // 同一流内 LF 与 CRLF 混杂(部分 chunk 已归一化)
        let mut buf = b"data: {\"choices\":[]}\n\ndata: {\"x\":1}\r\n\r\n".to_vec();
        let first = extract_sse_text(&mut buf).unwrap();
        assert!(first.contains("choices"));
        let second = extract_sse_text(&mut buf).unwrap();
        assert!(second.contains("x"));
        assert!(buf.is_empty());
    }
}
