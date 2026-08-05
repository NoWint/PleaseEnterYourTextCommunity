// AI 输出标签解析:白名单只放行 <message> / <user>, 先整体转义再白名单解包,防注入。
// 参数值也转义。message 走模糊匹配(1 条直接跳 / 多条列表 / 0 条 toast)。
import { escapeHtml } from '../components/escape.js';
import type { WindowMsg } from './summaryContext.js';

export type TagType = 'text' | 'message' | 'user';
export interface ParsedSegment {
  type: TagType;
  value: string;   // message/user 的参数值;text 为已转义内容
}

const TAG_RE = /<(message|user)='([^']*)'>/g;

/** 解析标签:只放行 <message='..'> / <user='..'>, 其余 <...> 形状整体转义。 */
export function parseTags(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text))) {
    if (m.index > last) segments.push({ type: 'text', value: escapeHtml(text.slice(last, m.index)) });
    segments.push({ type: m[1] === 'message' ? 'message' : 'user', value: escapeHtml(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', value: escapeHtml(text.slice(last)) });
  // 任何残留的 <xxx> 形状都在 text 段里被 escapeHtml 转义了(天然安全)
  return segments;
}

/** 渲染成受控 HTML。onRef 点击 <message> 时回调(跳转原文)。 */
export function renderParsed(segments: ParsedSegment[], onRef: (id: string) => void): string {
  return segments
    .map((s) => {
      if (s.type === 'message') return `<a class="mention-chip" data-msg-ref="${s.value}">@消息 ${s.value}</a>`;
      if (s.type === 'user') return `<span class="mention-chip" data-user-ref="${s.value}">@${s.value}</span>`;
      return s.value;
    })
    .join('');
}

/** 相关度分:精确 id=100, 内容含=3, sender 含=2, id 子串=1。 */
function score(w: WindowMsg, q: string): number {
  if (String(w.id) === q) return 100;
  let s = 0;
  if (w.text.includes(q)) s += 3;
  if (w.sender.includes(q)) s += 2;
  if (String(w.id).includes(q)) s += 1;
  return s;
}

/** 模糊匹配:精确 id 优先,否则按相关度取 Top3(限当前会话窗口)。 */
export function fuzzyFindMessage(win: WindowMsg[], query: string): WindowMsg[] {
  const q = query.trim();
  if (!q) return [];
  const scored = win
    .map((w) => ({ w, s: score(w, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, 3).map((x) => x.w);
}
