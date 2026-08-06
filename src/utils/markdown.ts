// Markdown 渲染(带可点击标签插入)。
// 流程:AI 输出的 `<user='xx'>` / `<message='xx'>` 先替换成占位 token,
// 避免 markdown 把尖括号当 HTML 标签;marked 渲染后白名单清洗 HTML,
// 再把占位 token 替换成可点击 chip(客户端点击 → 名片/定位原文)。
import { marked } from 'marked';
import { escapeHtml } from '../components/escape.js';
import { displayTime } from './tagParser.js';
import { state } from '../state.js';
import { resolveMessageText } from './envelope.js';

/** 占位 token 前缀(避免与真实内容冲突:含非 ASCII 括号,正常文本几乎不会出现)。 */
const U_PREFIX = '⟦U:'; // ⟦U:
const M_PREFIX = '⟦M:'; // ⟦M:
const T_PREFIX = '⟦T:'; // ⟦T:

/** 剥最外层同型包裹引号:<user='张三'> → 张三;裸值原样。 */
function stripQuote(v: string): string {
  const s = v.trim();
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) return s.slice(1, -1);
  }
  return s;
}
const SUFFIX = '⟧';      // ⟧

/** 白名单标签:markdown 允许的块/行内元素,其余(script/iframe/img 等)剥掉。 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'a', 'span',
]);

/**
 * 把 AI 文本中的 <user='..'> / <message='..'> 替换成占位 token。
 * 返回 { text, tags } —— tags 记录 token → 真实标签值,渲染后回填。
 */
type TagKind = 'user' | 'message' | 'time';

function placeholderTags(text: string): { text: string; tags: Map<string, { kind: TagKind; value: string }> } {
  const tags = new Map<string, { kind: TagKind; value: string }>();
  let n = 0;
  // 兼容带引号(<message='52'>/<user="张三">/<time='14:30'>)与无引号(<message=52>)两种 AI 输出,
  // 与 tagParser 的 TAG_RE 对齐 —— 否则无引号标签会被 sanitizeHtml 剥成纯文本而非 chip。
  // 值扫描到右尖括号前,剥最外层同型引号 —— 值内可含撇号(如 <user='NoWint'sBot'>)。
  const out = text.replace(/<(user|message|time)=([^>\n]*?)>/g, (_m, kind: string, raw: string) => {
    const val = stripQuote(raw);
    if (!val) return _m; // 空值不替换
    const prefix = kind === 'user' ? U_PREFIX : kind === 'time' ? T_PREFIX : M_PREFIX;
    const tok = `${prefix}${n++}${SUFFIX}`;
    tags.set(tok, { kind: kind as TagKind, value: val });
    return tok;
  });
  return { text: out, tags };
}

/**
 * 白名单清洗 marked 输出的 HTML:递归遍历 DOM,只保留白名单标签 + 安全属性,
 * 剥掉 on* 事件属性和危险 URL(javascript:)。返回清洗后的 HTML 字符串。
 */
function sanitizeHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walk = (node: Node): void => {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        const tag = el.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          // 非白名单标签:保留文本内容,剥掉标签本身
          el.replaceWith(document.createTextNode(el.textContent ?? ''));
          continue;
        }
        // 只保留安全属性
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
          if (name === 'href' || name === 'src') {
            // 剥控制字符(\\t\\n\\r\\f 空格可绕过 startsWith 判断),仅放行 http/https
            const v = (attr.value || '').replace(/[\t\n\r\f ]/g, '');
            let ok = false;
            try {
              const u = new URL(v);
              ok = u.protocol === 'http:' || u.protocol === 'https:';
            } catch { ok = false; }
            if (!ok) { el.removeAttribute(attr.name); continue; }
          }
          if (!['href', 'target', 'rel'].includes(name) && !['class'].includes(name)) {
            el.removeAttribute(attr.name);
          }
        }
        if (tag === 'a') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
        walk(el);
      }
    }
  };
  walk(template);
  return template.innerHTML;
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

/** 把占位 token 替换成可点击 chip。 */
function restoreTags(html: string, tags: Map<string, { kind: TagKind; value: string }>): string {
  let out = html;
  for (const [tok, t] of tags) {
    const chip = t.kind === 'message'
      // 显示原文(不同颜色区分),找不到才回退「消息 XXX」
      ? `<a class="mention-chip mention-chip-msg" data-msg-ref="${escapeHtml(t.value)}">${escapeHtml(msgText(t.value) ?? `消息 ${t.value}`)}</a>`
      : t.kind === 'time'
        ? `<span class="mention-chip" data-time-ref="${escapeHtml(t.value)}">🕐 ${escapeHtml(displayTime(t.value))}</span>`
        : `<span class="mention-chip" data-user-ref="${escapeHtml(t.value)}">@${escapeHtml(t.value)}</span>`;
    out = out.split(tok).join(chip);
  }
  return out;
}

/**
 * 渲染 markdown(含可点击标签)。入口函数。
 * - 标签先占位 → marked → 白名单清洗 → 占位还原成 chip
 * - marked 输出里若出现占位 token 被转义的情况(如 <pre> 内),split 仍能还原
 */
export function renderMarkdown(md: string): string {
  const { text, tags } = placeholderTags(md);
  let html: string;
  try {
    // breaks:true → 单个换行渲染为 <br>(AI 输出常含单换行,需实时换行显示)
    html = marked.parse(text, { async: false, breaks: true }) as string;
  } catch {
    // marked 失败 → 退化为纯文本转义(不崩)
    return escapeHtml(md);
  }
  const clean = sanitizeHtml(html);
  return restoreTags(clean, tags);
}
