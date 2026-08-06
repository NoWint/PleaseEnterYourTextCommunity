// 纯 JSON 信封协议解析(见 docs/superpowers/specs/2026-08-04-pure-json-envelope-design.md)
// 信封是 view_type=Text 的普通消息, 正文就是纯 JSON:
//   { "type": <string>, "id": <uuid>, "payload": { "text": <string>, ... } }
// 约定: 所有 type 的 payload 都带 text 字段, 填充消息体正文。
// 识别靠形状启发式: 解析成功 + type/id/payload 三字段齐全 → 信封; 否则 → 普通文本。

export interface Envelope {
  type: string;
  id: string;
  payload: Record<string, unknown> & { text?: unknown };
}

/** 尝试解析信封。非信封 / 结构不合法 → null(调用方显示原文)。 */
export function tryParseEnvelope(text: string): Envelope | null {
  if (!text || text[0] !== '{') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const e = obj as Record<string, unknown>;
  if (typeof e.type !== 'string') return null;
  if (typeof e.id !== 'string') return null;
  if (typeof e.payload !== 'object' || e.payload === null) return null;
  return {
    type: e.type,
    id: e.id,
    payload: e.payload as Envelope['payload'],
  };
}

/** 取信封正文文本(payload.text)。缺失或非字符串 → null。 */
export function envelopeText(env: Envelope): string | null {
  const t = env.payload.text;
  return typeof t === 'string' ? t : null;
}

/** 取信封 md 标记:payload.markdown === true 才 true(布尔严格校验)。 */
export function envelopeMarkdown(env: Envelope): boolean {
  return env.payload.markdown === true;
}

/** 还原消息正文: 是信封 → payload.text; 否则 → 原文。 */
export function resolveMessageText(text: string): string {
  const env = tryParseEnvelope(text);
  if (!env) return text;
  return envelopeText(env) ?? text;
}
