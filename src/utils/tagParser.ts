// 标签白名单解析(spec §6):AI 输出里的类 XML 标签只放行 <message>/<user>(单双引号均可),
// 其余一律保持转义。防注入顺序:先整体 escapeHtml,再在转义文本上白名单解包,
// 标签参数值再次 escapeHtml。模糊跳转数据(data-ref/data-user)由调用方消费。
import { escapeHtml } from '../components/escape.js';
import type { WindowMsg } from './summaryContext.js';
import type { MemberDto } from '../types.js';

export interface MsgRef {
  type: 'message' | 'user';
  value: string;
}

// 原文本上的标签形态:兼容带引号(<message='52'>/<user="张三">)与无引号(<message=52>/<user=张三>)。
// 值:可选单/双引号包裹,或裸值(不含引号/空白/右尖括号)。值内引号视为注入 → 不解包。
const TAG_SRC = /<(message|user)=['"]?([^'"\s>]+)['"]?>/g;

// 转义后文本上的白名单匹配:escapeHtml 后标签形如 &lt;message=&#39;…&#39;&gt;
// (&#39;=单引号, &quot;=双引号, 裸值无引号)。值内禁止出现实体序列本身(escapeHtml 已把 & < > " '
// 全转义;值内出现 &lt;/&gt;/&#39;/&quot; 说明原值含危险字符 → 保持转义不解包)。
// 可选引号 + 裸值:&#39;…&#39; | &quot;…&quot; | 裸值(不含实体/空格/&gt;)。
const TAG_ESCAPED =
  /&lt;(message|user)=(&#39;|&quot;)?((?:[^&]|&(?!gt;|lt;|#39;|quot;))+?)\2?&gt;/g;

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
    refs.push({ type: m[1] as MsgRef['type'], value: m[2] });
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

// ── 旧版气泡标签解析(56d9a86 保留,供 summaryBubble 的 parseTags/renderParsed)──
// 与上方 parseSafeTags 并存:上方走「先转义再白名单解包」的安全路径,返回 HTML;
// 下方返回受控片段数组,由 renderParsed 渲染成 mention-chip。两者互不干扰。

export type TagType = 'text' | 'message' | 'user';
export interface ParsedSegment {
  type: TagType;
  value: string;   // message/user 的参数值;text 为已转义内容
}

// 兼容带引号(<message='52'>/<user="张三">)与无引号(<message=52>)两种 AI 输出。
// 值:可选单/双引号包裹,或裸值(不含引号/空白/右尖括号)。
const TAG_RE = /<(message|user)=['"]?([^'"\s>]+)['"]?>/g;

/** 解析标签:只放行 <message=..> / <user=..>(值可带引号或裸),其余 <...> 整体转义。 */
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

/** 渲染成受控 HTML。⚠️ segments 必须来自 parseTags(值已预转义),勿手工构造。 */
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

// ── 成员模糊匹配(AI <user> 标签点击兜底)──
// AI 常输出不带空格/缩写/错字的名字,精确匹配找不到 → 按名字/地址相关度打分,
// 返回排序候选;调用方决定单名片(1 人)还是列表(多人)。

/** 成员命中:member + 相关度分。 */
export interface MemberHit {
  member: MemberDto;
  score: number;
}

function memberScore(m: MemberDto, q: string): number {
  const name = m.name.toLowerCase();
  const addr = m.addr.toLowerCase();
  if (name === q) return 100;      // 精确名
  if (name.includes(q)) return 70; // 名字包含
  if (addr === q) return 90;       // 精确地址
  if (addr.includes(q)) return 60; // 地址包含
  // 名字内每个字都出现在 q 里(错字/乱序兜底):如「张三丰」→ q「张丰」
  const qChars = new Set(q.split(''));
  let matched = 0;
  for (const c of name) if (qChars.has(c)) matched++;
  if (matched > 0) return 20 + Math.min(30, matched * 5); // 部分字符命中
  return 0;
}

/**
 * 成员模糊匹配:按名字/地址相关度排序,过滤 score>0。
 * 精确(100)单独列出供调用方直接弹名片;否则返回 TopN 候选列表。
 */
export function fuzzyMatchMembers(query: string, members: MemberDto[], limit = 5): MemberHit[] {
  const q = query.trim().toLowerCase();
  if (!q || !Array.isArray(members)) return [];
  return members
    .map((member) => ({ member, score: memberScore(member, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
