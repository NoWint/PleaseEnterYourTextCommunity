import { call, transformBlobURL } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { showDropdown, type DropdownItem } from '../components/dropdown.js';
import { showInlineConfirm } from '../components/inlineConfirm.js';
import { iconSvg } from '../components/icon.js';
import hljs from 'highlight.js/lib/core';
import rust from 'highlight.js/lib/languages/rust';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import type { MsgDto, MsgState } from '../types.js';

hljs.registerLanguage('rust', rust);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('json', json);

// RenderableMsg extends MsgDto with optimistic-message fields (is_out/_state/file_bytes)
// used by composer.ts temporary messages. These fields don't exist on real backend MsgDto
// but are present at runtime via `as unknown as MsgDto` cast in composer.ts.
// Note: pinned 状态改由模块级 pinnedMsgIds 集合管理 (见下方),不再挂在 RenderableMsg 上。
interface RenderableMsg extends MsgDto {
  is_out?: boolean;
  _state?: string;
  file_bytes?: number | null;
}

interface Reaction {
  emoji: string;
  count: number;
}

// 反应 = 原生 emoji (Delta Chat 互通)。常用快捷栏 + 完整面板。
const reactionQuick: string[] = ['👍', '❤️', '😂', '😮', '😢', '😭', '🔥'];
// 完整面板:精选常用 emoji (覆盖情绪/动作/符号/动物),零依赖内嵌。
const reactionPanel: string[] = [
  '👍', '❤️', '😂', '😮', '😢', '😭', '🔥', '🎉',
  '👏', '🙏', '💯', '✨', '😍', '🤔', '😴', '🤯',
  '😅', '🥳', '😎', '🥺', '😤', '🤝', '💪', '👀',
  '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿',
  '❤️‍🔥', '💖', '💔', '✅', '❌', '⚠️', '❗', '❓',
  '⭐', '🌟', '☀️', '🌙', '☕', '🍻', '🎁', '🏆',
];

// Module-level reactions cache: avoids repeated get_reactions IPC on virtualization re-render.
// key = msgId, value = reactions array. Updated by shell.js refreshMsgReactions,
// cleared on channel switch by clearReactionsCache().
const reactionsCache = new Map<number, Reaction[]>();

export function updateReactionsCache(msgId: number, reactions: Reaction[]): void {
  reactionsCache.set(msgId, reactions);
}

export function clearReactionsCache(): void {
  reactionsCache.clear();
}

// 模块级 pinned msg_id 集合:右键菜单据此显示 "取消置顶/置顶"。
// 由 chatView.ts 加载频道 pins 时回填 (updatePinnedCache),
// 切换频道时清理 (clearPinnedCache),togglePin 时本地 toggle。
const pinnedMsgIds = new Set<number>();

export function updatePinnedCache(ids: number[]): void {
  pinnedMsgIds.clear();
  for (const id of ids) pinnedMsgIds.add(id);
}

export function clearPinnedCache(): void {
  pinnedMsgIds.clear();
}

// Task 8: message send state icon (仿 WhatsApp 单勾/双勾/时钟)。
// 返回图标 SVG;shell.ts updateMsgState 用 innerHTML 更新。
export function stateLabel(s: MsgState): string {
  const ico = (name: 'check' | 'check-check' | 'clock' | 'alert-circle') =>
    iconSvg(name, { width: 14, height: 14, strokeWidth: 2 });
  switch (s) {
    case 'pending': return ico('clock');
    case 'delivered': return ico('check');
    case 'read': return ico('check-check');
    case 'failed': return ico('alert-circle');
    // 乐观消息(发送中)没有 state 字段,fallback 到 pending(时钟)
    default: return ico('clock');
  }
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Contact::get_color() returns u32; convert to #rrggbb. null/undefined → default.
function colorHex(c: number | null | undefined): string {
  if (c == null) return 'var(--border-strong)';
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

function getRoleName(contactId: number): string {
  // SP2 simplified: state.roles has workspace-level role definitions, no contact→role mapping.
  // Fallback "member"; core marker: self or from_id === 1 shows "core".
  if (contactId === 1 || (state.self && contactId === state.self.id)) return 'core';
  return 'member';
}

// 会话组位置:solo 单条 / first 组首 / middle 组中 / last 组尾。
// 决定气泡头像侧的小圆角位置与折叠间距。
export type GroupRole = 'solo' | 'first' | 'middle' | 'last';

export async function renderMessage(m: MsgDto, groupRole: GroupRole = 'solo'): Promise<string> {
  const msg = m as RenderableMsg;
  // 自己发的消息:乐观消息用 is_out 字段,真实消息按 from_id 等于自我推断
  const isOut = msg.is_out ?? (state.self ? msg.from_id === state.self.id : false);
  const stateClass = msg._state ? ` ${msg._state}` : '';
  // 组中/组尾 = 同人连续 → 折叠紧凑;组首/solo 展开显示名字
  const collapsed = groupRole === 'middle' || groupRole === 'last';
  const collapsedCls = collapsed ? ' collapsed' : '';
  const groupCls = ` msg-group-${groupRole}`;
  const roleName = !isOut && msg.from_id ? getRoleName(msg.from_id) : '';
  const roleTag = roleName ? `<span class="msg-role">${escapeHtml(roleName)}</span>` : '';
  // Reply mark: ↩ replaced with reply SVG icon per Task 14 brief step 1.6
  const replyIcon = iconSvg('reply', { width: 12, height: 12 });
  const replyMark = msg.quote_from
    ? `<span class="msg-reply-mark">${replyIcon} reply to ${escapeHtml(msg.quote_from)}</span>`
    : '';
  const quoteBlock = msg.quote_text
    ? `<div class="msg-quote">
        <span class="msg-quote-name">${escapeHtml(msg.quote_from || '')}</span>
        <span class="msg-quote-text">${escapeHtml(msg.quote_text.slice(0, 80))}</span>
      </div>`
    : '';
  const textHtml = renderText(msg.text);
  // Task 13: sender avatar — lookup member by from_id in state.currentMembers.
  // Fallback: first letter + default background var(--border-strong).
  const member = state.currentMembers?.find((mm) => mm.contact_id === msg.from_id);
  const avatarUrl = member?.avatar ? await transformBlobURL(member.avatar) : null;
  const bg = colorHex(member?.color);
  const letter = (msg.from_name || '?').charAt(0).toUpperCase() || '?';
  const avatarHtml = avatarUrl
    ? `<img src="${escapeHtml(avatarUrl)}" class="msg-avatar" alt="" />`
    : `<div class="msg-avatar" style="background:${bg}">${escapeHtml(letter)}</div>`;
  // Attachment rendering (view_type != Text)
  // Uses transformBlobURL (with module-level cache) to avoid repeated IPC on virtualization re-render.
  let attachmentHtml = '';
  if (msg.view_type && msg.view_type !== 'Text' && msg.file) {
    let assetUrl = '';
    try {
      assetUrl = await transformBlobURL(msg.file);
    } catch {
      assetUrl = '';
    }
    if (!assetUrl) {
      attachmentHtml = `<div class="msg-attachment file">
          <div class="file-icon">${iconSvg('file-text', { width: 16, height: 16, strokeWidth: 1.8 })}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(msg.file_name || 'file')}</div>
            <div class="file-meta">附件加载失败</div>
          </div>
        </div>`;
    } else {
      switch (msg.view_type) {
        case 'Image':
        case 'Gif':
        case 'Sticker':
          attachmentHtml = `<div class="msg-attachment img" data-asset="${escapeAttr(assetUrl)}">
          <img src="${escapeAttr(assetUrl)}" alt="${escapeAttr(msg.file_name || 'image')}" data-full="${escapeAttr(assetUrl)}" />
        </div>`;
          break;
        case 'File':
          attachmentHtml = `<div class="msg-attachment file" data-download="${escapeAttr(assetUrl)}">
          <div class="file-icon">${iconSvg('file-text', { width: 16, height: 16, strokeWidth: 1.8 })}</div>
          <div class="file-info">
            <div class="file-name">${escapeHtml(msg.file_name || 'file')}</div>
            <div class="file-meta">${formatBytes(msg.file_bytes)} · 点击下载</div>
          </div>
        </div>`;
          break;
        case 'Audio':
        case 'Voice':
          attachmentHtml = `<div class="msg-attachment audio">
          <audio controls src="${escapeAttr(assetUrl)}"></audio>
        </div>`;
          break;
        case 'Video':
          attachmentHtml = `<div class="msg-attachment video">
          <video controls src="${escapeAttr(assetUrl)}"></video>
        </div>`;
          break;
      }
    }
  }
  const reactionsHtml = await renderReactions(msg.msg_id);
  // Task 14: hover action bar (replaces old text buttons pin/reply/react/del/card).
  // Shown on message hover via CSS opacity transition. Buttons: react/reply/pin/more.
  const hoverActionsHtml = `
    <div class="msg-hover-actions">
      <button class="msg-action-btn" data-action="react" data-msg="${msg.msg_id}" title="反应">${iconSvg('smile', { width: 16, height: 16 })}</button>
      <button class="msg-action-btn" data-action="reply" data-msg="${msg.msg_id}" title="回复">${iconSvg('reply', { width: 16, height: 16 })}</button>
      <button class="msg-action-btn" data-action="pin" data-msg="${msg.msg_id}" title="置顶">${iconSvg('pin', { width: 16, height: 16 })}</button>
      <button class="msg-action-btn" data-action="more" data-msg="${msg.msg_id}" title="更多">${iconSvg('more-horizontal', { width: 16, height: 16 })}</button>
    </div>
  `;
  // Reaction picker (embedded, toggled by react button). 常用 emoji + 更多按钮。
  const pickerHtml = [
    ...reactionQuick.map((e) => `<span class="msg-reaction-pick" data-emoji="${e}" title="${e}">${e}</span>`),
    `<span class="msg-reaction-more" id="more-${msg.msg_id}" title="更多表情">${iconSvg('smile-plus', { width: 18, height: 18, strokeWidth: 1.8 })}</span>`,
  ].join('');
  // Task 8: outgoing messages show send state; failed messages show resend button.
  const stateHtml = isOut
    ? `<span class="msg-state state-${msg.state || 'pending'}" data-msg-state="${msg.msg_id}">${stateLabel(msg.state)}</span>`
    : '';
  const resendBtn = isOut && msg.state === 'failed'
    ? `<span class="msg-resend" data-msg-id="${msg.msg_id}">重发</span>`
    : '';
  const isOutAttr = isOut ? ' data-is-out="1"' : '';
  // 折叠时:头像隐藏(气泡式紧凑流),名字隐藏;名字/时间都放进气泡 meta 行
  const avatarDisplay = collapsed ? '' : avatarHtml;
  const nameDisplay = collapsed
    ? ''
    : `<span class="msg-name">${escapeHtml(msg.from_name)}</span>`;
  // delta 式 footer:展开/折叠都在气泡底部显示时间戳+状态图标(右侧)
  const footerHtml = `
    <footer class="msg-footer">
      <span class="msg-time">${formatTs(msg.ts)}</span>
      ${stateHtml}
      ${resendBtn}
    </footer>
  `;
  const bubble = `
    <div class="msg-bubble">
      ${hoverActionsHtml}
      <div class="msg-meta">
        ${nameDisplay}
        ${roleTag}${replyMark}
      </div>
      ${quoteBlock}
      <div class="msg-text">${textHtml}</div>
      ${attachmentHtml}
      ${reactionsHtml}
      ${footerHtml}
      <div class="msg-reaction-picker" id="rp-${msg.msg_id}">
        ${pickerHtml}
      </div>
    </div>
  `;
  return `
    <div class="msg${collapsedCls}${groupCls}${stateClass}" data-msg="${msg.msg_id}"${isOutAttr} style="position:relative">
      <div class="msg-row">
        ${avatarDisplay}
        ${bubble}
      </div>
    </div>
  `;
}

// Emoji 放大 (仿 delta MessageBody):纯 emoji 且 ≤8 个 → 按数量分级放大。
// 用 \p{Extended_Pictographic} 正则匹配 emoji 序列计数(无需 Intl.Segmenter)。
const EMOJI_MAX_COUNT = 8;

// 检测字符串是否只含 emoji(无文本/链接/空白外字符),返回 emoji 个数或 null
function countEmojisIfOnlyEmoji(str: string): number | null {
  const trimmed = str.trim();
  if (trimmed.length === 0) return null;
  // 快速排除含普通字母/数字的情况
  if (/[A-Za-z0-9一-鿿]/.test(trimmed)) return null;
  // 匹配单个 emoji 或 ZWJ 连接序列(👨‍👩‍👧 整体算 1 个;🎉🎉🎉 各算 1 个)。
  // 仅用 ‍(ZWJ)连接,避免贪婪吞掉无 ZWJ 的连续 emoji。
  const emojiRegex = /\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic})*(?:\p{Emoji_Modifier})?/gu;
  let count = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = emojiRegex.exec(trimmed)) !== null) {
    // 匹配之间有非空白字符 → 非纯 emoji
    if (trimmed.slice(lastIndex, match.index).trim().length > 0) return null;
    lastIndex = match.index + match[0].length;
    count++;
  }
  // 末尾残留非空白 → 非纯 emoji
  if (trimmed.slice(lastIndex).trim().length > 0) return null;
  return count > 0 ? count : null;
}

function emojiSizeClass(count: number): string | null {
  if (count > 8) return null;
  if (count > 6) return 'small';
  if (count > 4) return 'medium';
  if (count > 2) return 'large';
  return 'jumbo';
}

// Render message text with code block highlighting (hljs) and @mention highlighting.
// Code blocks: ```lang\ncode``` → <div class="msg-code">highlighted</div>
// Mentions: @self or @roleName → highlighted span
// 普通文本段:escapeHtml 不转义换行,HTML 会折叠成空格 → 手动把 \n 换成 <br>,否则多行消息挤成一行。
function renderText(text: string): string {
  // Emoji 放大:纯 emoji 且无代码块时分级
  if (!text.includes('```')) {
    const emojiCount = countEmojisIfOnlyEmoji(text);
    if (emojiCount != null && emojiCount <= EMOJI_MAX_COUNT) {
      const cls = emojiSizeClass(emojiCount);
      if (cls) {
        return `<span class="emoji-container ${cls}">${escapeHtml(text.trim())}</span>`;
      }
    }
  }
  const parts: string[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const inline = (s: string) => highlightMentions(escapeHtml(s)).replace(/\r?\n/g, '<br>');
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(inline(text.slice(last, match.index)));
    const lang = match[1];
    const code = match[2];
    let highlighted: string;
    try {
      highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : escapeHtml(code);
    } catch {
      highlighted = escapeHtml(code);
    }
    parts.push(`<div class="msg-code">${highlighted}</div>`);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(inline(text.slice(last)));
  return parts.join('');
}

// Highlight @mentions of self name or role names with active background.
function highlightMentions(html: string): string {
  const myName = state.self?.name || '';
  const roleNames = (state.roles || []).map((r) => r.name).filter(Boolean);
  const targets = [myName, ...roleNames].filter(Boolean).map(escapeRegex);
  if (targets.length === 0) return html;
  const re = new RegExp(`@(${targets.join('|')})`, 'g');
  return html.replace(re, '<span class="msg-mention">@$1</span>');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// renderReactions: check module-level cache first, fetch via IPC on miss and backfill cache.
// Virtualization re-render can trigger 30+ messages, cache avoids per-message IPC.
async function renderReactions(msgId: number): Promise<string> {
  if (reactionsCache.has(msgId)) {
    const reactions = reactionsCache.get(msgId)!;
    const html = renderReactionsHtml(reactions, msgId);
    return html ? `<div class="msg-reactions">${html}</div>` : '';
  }
  try {
    const reactions = await call<Reaction[]>('get_reactions', { msgId });
    reactionsCache.set(msgId, reactions);
    const html = renderReactionsHtml(reactions, msgId);
    return html ? `<div class="msg-reactions">${html}</div>` : '';
  } catch {
    return '';
  }
}

// Task 8: pure function extracted for shell.js refreshMsgReactions to reuse
// (avoids full message re-render on reaction change).
// Input: get_reactions return array. Output: inner capsules HTML (without .msg-reactions wrapper).
export function renderReactionsHtml(reactions: Reaction[] | null, msgId: number): string {
  if (!reactions || reactions.length === 0) return '';
  return reactions.map((r) => renderReactionCapsule(r, msgId)).join('');
}

// 单个反应胶囊 HTML。refreshMsgReactions 用它对已有胶囊做 diff 更新:
// 已存在的胶囊只改计数不重建,避免重播 reaction-pop-in 动画 → 反应闪烁。
export function renderReactionCapsule(r: Reaction, msgId: number): string {
  const count = r.count > 1 ? `<span class="msg-reaction-count">${r.count}</span>` : '';
  return `<span class="msg-reaction" data-msg="${msgId}" data-emoji="${escapeAttr(r.emoji)}">${escapeHtml(r.emoji.trim())}${count}</span>`;
}
export function bindMessageActions(container: HTMLElement): void {
  // Reaction toggle (click existing reaction capsule)
  container.querySelectorAll<HTMLElement>('.msg-reaction').forEach((el) => {
    el.addEventListener('click', async () => {
      const msgId = Number(el.dataset.msg);
      const emoji = el.dataset.emoji;
      if (!emoji) return;
      try {
        await call('send_reaction', { chatId: state.currentChatId, msgId, emoji });
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    });
  });

  // Task 14: hover action buttons — react/reply/pin/more
  container.querySelectorAll<HTMLElement>('.msg-action-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const msgIdStr = btn.dataset.msg;
      if (!msgIdStr) return;
      if (action === 'react') {
        // 显式调出反应弹窗(点击切换),移出消息时关闭
        toggleReactionPicker(msgIdStr);
      } else if (action === 'reply') {
        dispatchReply(Number(msgIdStr));
      } else if (action === 'pin') {
        void togglePin(Number(msgIdStr));
      } else if (action === 'more') {
        const isOut = btn.closest<HTMLElement>('.msg')?.dataset.isOut === '1';
        showMoreMenu(btn, msgIdStr, isOut);
      }
    });
  });

  // Reaction picker options (emoji;点击发对应反应)
  container.querySelectorAll<HTMLElement>('.msg-reaction-pick').forEach((s) => {
    s.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const emoji = s.dataset.emoji;
      if (!emoji) return;
      const picker = s.parentElement;
      if (!picker) return;
      const msgIdStr = picker.id.replace('rp-', '');
      await sendReaction(msgIdStr, emoji);
    });
  });

  // 更多表情:弹出完整 emoji 面板
  container.querySelectorAll<HTMLElement>('.msg-reaction-more').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const picker = btn.closest<HTMLElement>('.msg-reaction-picker');
      if (!picker) return;
      const msgIdStr = picker.id.replace('rp-', '');
      openReactionPanel(picker, msgIdStr);
    });
  });

  // Task 8: resend failed message (is_out + state=failed only)
  container.querySelectorAll<HTMLElement>('.msg-resend').forEach((el) => {
    el.addEventListener('click', async () => {
      const msgId = Number(el.dataset.msgId);
      const msg = state.messages.find((mm) => mm.msg_id === msgId);
      if (msg) {
        try {
          await call('send_text', { chatId: state.currentChatId, text: msg.text });
          // Remove old failed message row + clear from state.messages
          const msgEl = document.querySelector(`[data-msg="${msgId}"]`);
          if (msgEl) msgEl.remove();
          state.messages = state.messages.filter((mm) => mm.msg_id !== msgId);
        } catch (err) {
          showToast('重发失败: ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    });
  });

  // Image click to fullscreen (overlay)
  container.querySelectorAll<HTMLElement>('.msg-attachment img[data-full]').forEach((img) => {
    img.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay img-fullscreen-overlay';
      overlay.style.display = 'flex';
      const full = img.dataset.full || '';
      overlay.innerHTML = `<img src="${escapeAttr(full)}" class="img-fullscreen-img" />`;
      overlay.addEventListener('click', () => {
        overlay.classList.add('closing');
        setTimeout(() => overlay.remove(), 160);
      });
      document.body.appendChild(overlay);
    });
  });

  // File download (create <a download> trigger)
  container.querySelectorAll<HTMLElement>('.msg-attachment.file[data-download]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = el.dataset.download || '';
      a.download = '';
      a.click();
    });
  });

  // Task 14: right-click context menu using showDropdown.
  // Items: copy/save/reply/pin/convert card/forward/delete(is_out only).
  container.querySelectorAll<HTMLElement>('.msg').forEach((el) => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const msgIdStr = el.dataset.msg || '';
      const msgId = Number(msgIdStr);
      const msg = state.messages.find((mm) => String(mm.msg_id) === msgIdStr) as RenderableMsg | undefined;
      const isOut = el.dataset.isOut === '1';
      showContextMenuAt(e.clientX, e.clientY, msgIdStr, msgId, msg, isOut);
    });
  });

}

// Toggle reaction picker visibility for a message (close others first)
// 发送反应 (react 快捷按钮 / picker 选项共用)
async function sendReaction(msgIdStr: string, emoji: string): Promise<void> {
  // 乐观消息(tmp_ 前缀)尚无真实 msg_id,后端无法发反应,直接提示
  if (msgIdStr.startsWith('tmp_')) {
    showToast('消息发送中,稍后可回应');
    return;
  }
  try {
    await call('send_reaction', { chatId: state.currentChatId, msgId: Number(msgIdStr), emoji });
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

// Toggle reaction picker visibility for a message (close others first)
function toggleReactionPicker(msgIdStr: string): void {
  const picker = document.getElementById(`rp-${msgIdStr}`);
  if (!picker) return;
  document.querySelectorAll('.msg-reaction-picker.show').forEach((p) => {
    if (p !== picker) p.classList.remove('show');
  });
  picker.classList.toggle('show');
  // 光标移出消息时关闭
  const msgEl = picker.closest<HTMLElement>('.msg');
  msgEl?.addEventListener('mouseleave', () => picker.classList.remove('show'), { once: true });
}

// 弹出完整 emoji 面板:点击"更多"时在 picker 上方显示 reactionPanel 网格。
// 每次点击重建,保证与其他弹层状态一致。
function openReactionPanel(picker: HTMLElement, msgIdStr: string): void {
  document.querySelectorAll('.msg-reaction-panel').forEach((el) => el.remove());
  const panel = document.createElement('div');
  panel.className = 'msg-reaction-panel';
  panel.innerHTML = reactionPanel
    .map((e) => `<span class="msg-reaction-pick" data-emoji="${escapeAttr(e)}" title="${e}">${e}</span>`)
    .join('');
  panel.addEventListener('click', async (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('.msg-reaction-pick');
    if (!target) return;
    const emoji = target.dataset.emoji;
    if (!emoji) return;
    await sendReaction(msgIdStr, emoji);
    panel.remove();
  });
  picker.appendChild(panel);
}

// Dispatch composer:set-reply event for chatView to render reply preview
function dispatchReply(msgId: number): void {
  const main = document.getElementById('chat-main');
  if (main) {
    main.dispatchEvent(new CustomEvent('composer:set-reply', { detail: { msgId } }));
  }
}

// Toggle message pin via backend
async function togglePin(msgId: number): Promise<void> {
  try {
    await call('toggle_pin', { workspaceId: state.currentWsId, chatId: state.currentChatId, msgId });
    // 本地 toggle 缓存,使下次右键菜单显示正确状态 (无需重新拉取 pins)
    const wasPinned = pinnedMsgIds.has(msgId);
    if (wasPinned) {
      pinnedMsgIds.delete(msgId);
      showToast('已取消置顶');
    } else {
      pinnedMsgIds.add(msgId);
      showToast('已置顶');
    }
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  }
}

// "More" dropdown menu (opened from hover "more" button): convert card / forward / delete
function showMoreMenu(btn: HTMLElement, msgIdStr: string, isOut: boolean): void {
  const msgId = Number(msgIdStr);
  const items: DropdownItem[] = [
    {
      label: '转 Card',
      icon: 'layout-grid',
      action: () => void convertToCard(msgId),
    },
    {
      label: '转发',
      icon: 'forward',
      action: () => showToast('转发(开发中)'),
    },
  ];
  if (isOut) {
    items.push({
      label: '删除',
      icon: 'trash',
      danger: true,
      action: () => inlineDeleteMsg(msgIdStr),
    });
  }
  showDropdown(btn, items, { position: 'bottom-right' });
}

// Right-click context menu at (x, y). Uses showDropdown with a temporary anchor element
// positioned at the click coordinates.
function showContextMenuAt(
  x: number,
  y: number,
  msgIdStr: string,
  msgId: number,
  msg: RenderableMsg | undefined,
  isOut: boolean,
): void {
  // Temporary 1x1 anchor at click position for showDropdown positioning
  const anchor = document.createElement('div');
  anchor.style.position = 'fixed';
  anchor.style.left = `${x}px`;
  anchor.style.top = `${y}px`;
  anchor.style.width = '1px';
  anchor.style.height = '1px';
  anchor.style.pointerEvents = 'none';
  document.body.appendChild(anchor);

  const items: DropdownItem[] = [];
  if (msg?.text) {
    items.push({
      label: '复制文本',
      icon: 'copy',
      action: () => {
        try {
          void navigator.clipboard?.writeText(msg.text);
          showToast('已复制');
        } catch {
          showToast('复制失败');
        }
      },
    });
  }
  items.push({
    label: '保存消息',
    icon: 'bookmark',
    action: async () => {
      try {
        await call('save_msg', { msgId });
        showToast('已保存');
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    },
  });
  items.push({
    label: '回复',
    icon: 'reply',
    action: () => dispatchReply(msgId),
  });
  items.push({
    label: pinnedMsgIds.has(msgId) ? '取消置顶' : '置顶',
    icon: 'pin',
    action: () => void togglePin(msgId),
  });
  items.push({
    label: '转 Card',
    icon: 'layout-grid',
    action: () => void convertToCard(msgId),
  });
  items.push({
    label: '转发',
    icon: 'forward',
    action: () => showToast('转发(开发中)'),
  });
  if (isOut) {
    items.push({
      label: '删除',
      icon: 'trash',
      danger: true,
      action: () => inlineDeleteMsg(msgIdStr),
    });
  }
  showDropdown(anchor, items, { position: 'bottom-left', onClose: () => anchor.remove() });
}

// Convert message to card via backend. Title passed as null (uses message text per backend).
// 零弹窗 constraint: no prompt() for custom title.
async function convertToCard(msgId: number): Promise<void> {
  try {
    await call('message_to_card', {
      msgId,
      workspaceId: state.currentWsId,
      chatId: state.currentChatId,
      type_: 'task',
      title: null,
    });
    showToast('已转为 Card');
  } catch (e) {
    showToast('转换失败: ' + (e instanceof Error ? e.message : String(e)));
  }
}

// Task 14: inline delete confirmation (replaces confirm() popup).
// Uses showInlineConfirm for zero-popup UX. Removes element immediately on confirm
// to avoid flash after innerHTML restore; backend deletion runs async.
function inlineDeleteMsg(msgIdStr: string): void {
  const el = document.querySelector(`[data-msg="${msgIdStr}"]`);
  if (!el) return;
  const msgId = Number(msgIdStr);
  showInlineConfirm(el as HTMLElement, {
    message: '确认删除此消息?',
    confirmLabel: '删除',
    onConfirm: async () => {
      // Remove element immediately (showInlineConfirm already restored innerHTML before onConfirm)
      el.remove();
      state.messages = state.messages.filter((mm) => String(mm.msg_id) !== msgIdStr);
      try {
        await call('delete_msg', { msgId });
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    },
    onUndo: async () => {
      showToast('撤销删除(开发中)');
    },
  });
}

// 相对时间 (仿 delta formatRelativeTime):今天→X小时/X分钟/刚刚;昨天→昨天;
// 周内→星期几;同月→月日;跨年→年月日。用于消息 meta 行的时间戳。
function formatTs(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (sameDay) {
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    const h = Math.floor(diffMin / 60);
    if (h < 24) return `${h}小时前`;
    // 跨天但日期相同(极端时区),回落 HH:mm
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  if (isYesterday) return '昨天';
  // 同一年 → 月/日 + 时间
  if (d.getFullYear() === now.getFullYear()) {
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return `${m}/${day}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function escapeHtml(s: unknown): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: unknown): string {
  return escapeHtml(s);
}
