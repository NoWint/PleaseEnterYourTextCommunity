// 标签白名单解析(spec §6):AI 输出里的类 XML 标签只放行 <message>/<user>/<time>(单双引号均可),
// 其余一律保持转义。防注入顺序:先整体 escapeHtml,再在转义文本上白名单解包,
// 标签参数值再次 escapeHtml。模糊跳转数据(data-ref/data-user/data-time)由调用方消费。
import { escapeHtml } from '../components/escape.js';
import type { WindowMsg } from './summaryContext.js';
import type { MemberDto } from '../types.js';
import { state } from '../state.js';
import { resolveMessageText } from './envelope.js';

export interface MsgRef {
  type: 'message' | 'user' | 'time';
  value: string;
}

// 原文本上的标签形态:兼容带引号(<message='52'>/<user="张三">)与无引号(<message=52>/<user=张三>)。
// 值扫描到右尖括号前,剥最外层同型包裹引号 —— 值内可含异引号/撇号(如 <user='NoWint'sBot'>)。
// 安全:值经 escapeHtml 转义;含 `>` 才可能误匹配,AI 正常输出可控。
const TAG_SRC = /<(message|user|time)=([^>\n]*?)>/g;

/** 剥最外层同型包裹引号:<user='张三'> → 张三;裸值原样。 */
function stripQuotes(v: string): string {
  const s = v.trim();
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) return s.slice(1, -1);
  }
  return s;
}

/** 查消息原文(id → 文本,截断 40 字)。找不到 → null。 */
function msgText(id: string): string | null {
  const mid = Number(id);
  if (Number.isNaN(mid)) return null;
  const m = state.messages.find((x) => x.msg_id === mid);
  if (!m) return null;
  const text = resolveMessageText(m.text).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

/** user chip HTML:左侧头像 img 占位(data-avatar-name 供异步水合)+ 名字。 */
export function userChipHtml(name: string, escaped: string): string {
  // 头像 + 名字,无 @ 前缀
  return `<span class="mention-chip" data-user-ref="${escaped}"><img class="mention-avatar" alt="" data-avatar-name="${escapeHtml(name)}">${escaped}</span>`;
}

/** time chip HTML:内联 clock SVG + 显示时间(颜色由 .mention-chip-time CSS 区分)。 */
export function timeChipHtml(value: string, escaped: string): string {
  return `<span class="mention-chip mention-chip-time" data-time-ref="${escaped}"><svg class="mention-time-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12Z"/><path d="M12 6.5L12 12L15 15"/></svg>${escapeHtml(displayTime(value))}</span>`;
}

/**
 * 异步水合 mention-chip 头像:遍历 root 内 data-user-ref chip 的 .mention-avatar,
 * 按名字查当前会话成员头像 → transformBlobURL 转 asset URL → 设 img src。
 * 无头像/失败 → 移除 img(纯文本 chip)。幂等。
 */
export async function hydrateMentionAvatars(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('.mention-avatar'));
  if (imgs.length === 0) return;
  const { transformBlobURL } = await import('../api.js');
  for (const img of imgs) {
    const name = img.dataset.avatarName;
    if (!name) { img.remove(); continue; }
    // 「我」→ 当前用户 self;「你」→ 单聊对方(非 self 成员)
    let avatar: string | null | undefined;
    if (name === '我') avatar = state.self?.avatar;
    else if (name === '你') avatar = state.currentMembers?.find((m) => !m.is_self)?.avatar;
    else avatar = state.currentMembers?.find((m) => m.name === name)?.avatar;
    if (!avatar) { img.remove(); continue; }
    try {
      const url = await transformBlobURL(avatar);
      if (url) { img.src = url; } else { img.remove(); }
    } catch { img.remove(); }
  }
}

// 转义后文本上的白名单匹配:escapeHtml 后标签形如 &lt;message=&#39;…&#39;&gt;
// (&#39;=单引号, &quot;=双引号, 裸值无引号)。值扫描到 &gt; 前(值内可含 &amp;/&#39;/&quot; 实体,
// 即原值含撇号/引号/& 的都可匹配)。剥最外层同型引号实体。
const TAG_ESCAPED = /&lt;(message|user|time)=([^>\n]*?)&gt;/g;

/** 剥转义文本外层同型引号实体:&#39;…&#39;(5字符) | &quot;…&quot;(6字符) → 内层;裸值原样。 */
function stripEscapedQuotes(v: string): string {
  const s = v.trim();
  if (s.startsWith('&#39;') && s.endsWith('&#39;') && s.length >= 10) return s.slice(5, -5);
  if (s.startsWith('&quot;') && s.endsWith('&quot;') && s.length >= 12) return s.slice(6, -6);
  return s;
}

/**
 * 解析时间值 → 显示标签。支持 14:30 / 2026-08-05 / 2026-08-05 14:30(可带 T)。
 * 只处理数字/冒号/连字符/空格 —— 转义实体不会命中,非法值原样返回。
 * 对转义后的值(<time='..'> 经 parseSafeTags/parseTags 时值已 escapeHtml)同样安全。
 */
export function displayTime(v: string): string {
  const t = v.trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  if (full) {
    const [, y, mo, d, h, mi] = full;
    return h ? `${mo}-${d} ${String(h).padStart(2, '0')}:${mi}` : `${mo}-${d}`;
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) return `${String(Number(hm[1])).padStart(2, '0')}:${hm[2]}`;
  return v;
}

/** 转义整段输入并把白名单标签替换成受控 HTML;其它 <tag> 保持转义状态。 */
export function parseSafeTags(input: string): string {
  const escaped = escapeHtml(input);
  return escaped.replace(TAG_ESCAPED, (_full, kind: string, rawValue: string) => {
    // 值已是转义后文本(整体已 escapeHtml),剥外层引号实体即可,不再二次转义。
    // 值内 &#39; 等实体是合法转义,渲染时浏览器解码成原始字符。
    const value = stripEscapedQuotes(rawValue);
    if (kind === 'message') return `<span class="ref-msg mention-chip-msg" data-ref="${value}">${escapeHtml(msgText(value) ?? `消息 ${value}`)}</span>`;
    if (kind === 'time') {
      // 时间显示只涉及数字/冒号/连字符,实体不影响;文本再 escapeHtml 一次无害(双转义)。
      return timeChipHtml(value, value);
    }
    return userChipHtml(value, value);
  });
}

/** 提取所有白名单标签引用(原始文本,转义前解析)。 */
export function extractRefs(input: string): MsgRef[] {
  const refs: MsgRef[] = [];
  for (const m of input.matchAll(TAG_SRC)) {
    refs.push({ type: m[1] as MsgRef['type'], value: stripQuotes(m[2]) });
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

export type TagType = 'text' | 'message' | 'user' | 'time';
export interface ParsedSegment {
  type: TagType;
  value: string;   // message/user 的参数值;text 为已转义内容
}

// 兼容带引号(<message='52'>/<user="张三">)与无引号(<message=52>)两种 AI 输出。
// 值扫描到右尖括号前,剥最外层同型引号 —— 值内可含异引号/撇号(如 <user='NoWint'sBot'>)。
const TAG_RE = /<(message|user|time)=([^>\n]*?)>/g;

/** 解析标签:只放行 <message=..> / <user=..> / <time=..>(值可带引号或裸,可含撇号),其余 <...> 整体转义。 */
export function parseTags(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text))) {
    if (m.index > last) segments.push({ type: 'text', value: escapeHtml(text.slice(last, m.index)) });
    const kind = m[1] === 'message' ? 'message' : m[1] === 'time' ? 'time' : 'user';
    // 存原始值(renderParsed 渲染时再转义)——message/time/user 的 data 属性与原文查询都需原始
    segments.push({ type: kind, value: stripQuotes(m[2]) });
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
      if (s.type === 'message') return `<a class="mention-chip mention-chip-msg" data-msg-ref="${escapeHtml(s.value)}">${escapeHtml(msgText(s.value) ?? `消息 ${s.value}`)}</a>`;
      if (s.type === 'time') return timeChipHtml(s.value, escapeHtml(s.value));
      if (s.type === 'user') return userChipHtml(s.value, escapeHtml(s.value));
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
