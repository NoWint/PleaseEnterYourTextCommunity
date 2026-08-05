// 标签白名单解析(spec §6):AI 输出里的类 XML 标签只放行 <message>/<user>(单双引号均可),
// 其余一律保持转义。防注入顺序:先整体 escapeHtml,再在转义文本上白名单解包,
// 标签参数值再次 escapeHtml。模糊跳转数据(data-ref/data-user)由调用方消费。
import { escapeHtml } from '../components/escape.js';

export interface MsgRef {
  type: 'message' | 'user';
  value: string;
}

// 原文本上的标签形态:<message='...'> / <user="...">(值内不换行,值内引号视为注入 → 不解包)
const TAG_SRC = /<(message|user)=(['"])([^'"]*)\2>/g;

// 转义后文本上的白名单匹配:escapeHtml 后标签形如 &lt;message=&#39;…&#39;&gt;
// (&#39;=单引号, &quot;=双引号)。值内禁止出现实体序列本身(escapeHtml 已把 & < > " '
// 全转义;值内出现 &lt;/&gt;/&#39;/&quot; 说明原值含危险字符 → 保持转义不解包)。
// 闭合引号用 \2 回引用:必须与开头引号同类型,防止值内引号伪造闭合。
const TAG_ESCAPED =
  /&lt;(message|user)=(&#39;|&quot;)((?:[^&]|&(?!gt;|lt;|#39;|quot;))*?)\2&gt;/g;

/** 转义整段输入并把白名单标签替换成受控 HTML;其它 <tag> 保持转义状态。 */
export function parseSafeTags(input: string): string {
  const escaped = escapeHtml(input);
  return escaped.replace(TAG_ESCAPED, (_full, kind: string, _quote: string, rawValue: string) => {
    const value = escapeHtml(rawValue);
    return kind === 'message'
      ? `<span class="ref-msg" data-ref="${value}">引用</span>`
      : `<span class="ref-user" data-user="${value}">@${value}</span>`;
  });
}

/** 提取所有白名单标签引用(原始文本,转义前解析)。 */
export function extractRefs(input: string): MsgRef[] {
  const refs: MsgRef[] = [];
  for (const m of input.matchAll(TAG_SRC)) {
    refs.push({ type: m[1] as MsgRef['type'], value: m[3] });
  }
  return refs;
}

/** 单条消息的可搜索文本:信封 payload.text 优先,回落 m.text。 */
function searchableText(m: any): string {
  if (m && typeof m.payload === 'object' && typeof m.payload.text === 'string') return m.payload.text;
  return typeof m?.text === 'string' ? m.text : '';
}

function scoreMessage(q: string, m: any): number {
  const fields = [String(m.msg_id ?? ''), String(m.from_name ?? ''), searchableText(m), String(m.file_name ?? '')];
  let score = 0;
  for (const f of fields) {
    const fl = f.toLowerCase();
    if (fl === q) score += 100;
    else if (fl.includes(q)) score += 10;
  }
  return score;
}

/**
 * 模糊匹配消息:query 为纯数字 → 按 msg_id 精确匹配优先;
 * 否则在 messages 里对 from_name/payload.text/file_name 子串打分排序,按相关性取 Top(默认 3)。
 * 0 条返回 []。
 */
export function fuzzyMatchMessages(query: string, messages: any[], limit = 3): any[] {
  if (!query || !Array.isArray(messages)) return [];
  const q = query.trim().toLowerCase();
  if (!q || messages.length === 0) return [];
  if (/^\d+$/.test(q)) {
    const byId = messages.filter((m) => m && String(m.msg_id) === q);
    if (byId.length > 0) return byId.slice(0, limit);
  }
  const hits: Array<{ m: any; score: number }> = [];
  for (const m of messages) {
    if (!m) continue;
    const score = scoreMessage(q, m);
    if (score > 0) hits.push({ m, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((h) => h.m);
}
