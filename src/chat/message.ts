import { call, transformBlobURL } from '../api.js';
import { resolveMessageText, tryParseEnvelope, envelopeMarkdown, envelopeTheme } from '../utils/envelope.js';
import { parseHandwriting, renderHandwritingCard, bindHandwritingCards } from '../utils/handwriting.js';
import { renderMarkdown } from '../utils/markdown.js';
import { msgThemeAttrs, registerSenderTheme, themeForSender } from '../msgTheme.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { ui } from '../components/ui.js';
import { showDropdown, type DropdownItem } from '../components/dropdown.js';
import { showInlineConfirm } from '../components/inlineConfirm.js';
import { renderVoicePlayer, bindVoicePlayer } from '../components/voicePlayer.js';
import { renderWebxdcCard, bindWebxdcCard } from '../components/webxdc.js';
import { iconSvg } from '../components/icon.js';
import { escapeHtml, escapeAttr } from '../components/escape.js';
import hljs from 'highlight.js/lib/core';
import rust from 'highlight.js/lib/languages/rust';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import type { ChatListItem, MsgDto, MsgState, VcardContactDto } from '../types.js';

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
  _state?: string;
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

// 已读计数缓存:msgId → 已读人数。
// 打开会话时 chatView 批量拉取填充;shell 收到 MsgReadCountChanged 时单条更新。
const readCountMap = new Map<number, number>();
export function setReadCounts(ids: number[], counts: number[]): void {
  for (let i = 0; i < ids.length; i++) readCountMap.set(ids[i], counts[i] ?? 0);
}
export function setReadCount(msgId: number, count: number): void {
  readCountMap.set(msgId, count);
}
export function getReadCount(msgId: number): number {
  return readCountMap.get(msgId) ?? 0;
}

// 已读系统本土化:消息状态用文字而非 check/双勾图标。
// 单聊:发送中/已送达/已读/失败;群聊:已读态显示「N 人已读」(isGroup)。
// shell.ts updateMsgState 与 message.ts renderMessage 共用。
export function stateLabel(s: MsgState, isGroup?: boolean, readCount?: number): string {
  switch (s) {
    case 'pending': return '发送中';
    case 'delivered': return '已送达';
    case 'read': return isGroup ? `${readCount ?? 0} 人已读` : '已读';
    case 'failed': return '失败';
    // 乐观消息(发送中)没有 state 字段,fallback 到发送中
    default: return '发送中';
  }
}

// 会话列表预览文本: 先解析 JSON 信封(取 payload.text), 再按「自己发出的消息」加已读前缀。
//   单聊:  已读 · 你好         群聊:  3 人已读 · 你好
//   自己发但未读/失败: 发送中 · … / 已送达 · … / 失败 · …
//   系统信息行: 无前缀(本来就该居中, 预览只显示文本)
export function chatPreviewText(c: {
  last_msg: string | null;
  is_group: boolean;
  last_msg_is_out: boolean;
  last_msg_state: string;
  last_msg_read_count: number;
  last_msg_is_info: boolean;
}): string {
  const text = c.last_msg ? resolveMessageText(c.last_msg) : '';
  if (!text) return '';
  // 手写消息:会话列表只显示「手写」,不显示信封 JSON/文件名
  if (c.last_msg) {
    const env = tryParseEnvelope(c.last_msg);
    if (env && env.type === 'handwriting') {
      return c.last_msg_is_out && !c.last_msg_is_info
        ? `${stateLabel(c.last_msg_state as MsgState, c.is_group, c.last_msg_read_count)} · 手写`
        : '手写';
    }
  }
  if (c.last_msg_is_out && !c.last_msg_is_info) {
    // 草稿:显示 [草稿]XXX(无「· 状态」前缀)
    if (c.last_msg_state === 'draft') return `[草稿]${text}`;
    const s = stateLabel(c.last_msg_state as MsgState, c.is_group, c.last_msg_read_count);
    return `${s} · ${text}`;
  }
  return text;
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
  // 系统消息(群成员变更/群资料变更/加密状态等,对齐 Delta MessageSystemInfo):
  // 渲染为居中胶囊信息行,无头像/名字/气泡/meta。core 的 is_info() 文本已本地化拼接
  // (如「X 加入了群组」「群组已加密」),直接展示 msg.text 即可。
  if (m.is_info) {
    return `<div class="msg-system" data-msg="${m.msg_id}"><span>${escapeHtml(m.text || '')}</span></div>`;
  }
  const msg = m as RenderableMsg;
  // 自己发的消息:乐观消息用 is_out 字段,真实消息按 from_id 等于自我推断
  const isOut = msg.is_out ?? (state.self ? msg.from_id === state.self.id : false);
  const stateClass = msg._state ? ` ${msg._state}` : '';
  // 组中/组尾 = 同人连续 → 折叠紧凑;组首/solo 展开显示名字
  const collapsed = groupRole === 'middle' || groupRole === 'last';
  const collapsedCls = collapsed ? ' collapsed' : '';
  const groupCls = ` msg-group-${groupRole}`;
  // 单聊(非群聊):气泡内不显示 role tag(role 是 workspace 概念)和顶部 username
  // (对方用户名已在聊天头显示,Delta 单聊行为)
  const isSingle = !state.currentChatIsGroup;
  const roleName = !isOut && msg.from_id && !isSingle ? getRoleName(msg.from_id) : '';
  const roleTag = roleName ? `<span class="msg-role">${escapeHtml(roleName)}</span>` : '';
  // Reply mark: 本土化 —— 「回复 用户名」。用户名可点击 → 打开发送者名片
  // (data-reply-contact 传 quote_from_id=被引用消息发送者;data-reply-name 传名字;头像经成员表反查加载)
  const replyMark = msg.quote_from
    ? `<span class="msg-reply-mark">回复 <span class="msg-reply-name" data-reply-contact="${msg.quote_from_id ?? ''}" data-reply-name="${escapeAttr(msg.quote_from)}">${escapeHtml(msg.quote_from)}</span></span>`
    : '';
  // 引用块:遵循被引用消息信封内的 markdown 字段(quote_text 即被引用消息完整信封)
  const qEnv = msg.quote_text ? tryParseEnvelope(msg.quote_text) : null;
  const qIsMd = qEnv ? envelopeMarkdown(qEnv) : false;
  const qText = msg.quote_text ? resolveMessageText(msg.quote_text).slice(0, 80) : '';
  // 用 div 承载 md 渲染(renderMarkdown 输出块元素 p/ul/pre,span 会被浏览器自动闭合破坏布局)
  const quoteBlock = msg.quote_text
    ? `<div class="msg-quote" data-quote-msg="${msg.quote_msg_id ?? ''}" title="点击跳转原文">
        <span class="msg-quote-name">${escapeHtml(msg.quote_from || '')}</span>
        <div class="msg-quote-text">${qIsMd ? renderMarkdown(qText) : escapeHtml(qText)}</div>
      </div>`
    : '';
  // 正文:信封带 markdown:true → md 渲染;否则纯文本
  const env = tryParseEnvelope(msg.text);
  const isMd = env ? envelopeMarkdown(env) : false;
  // 手写消息(type=handwriting):canvas 透明回放卡片,不渲染正文/文件名/链接
  const hwPayload = env && env.type === 'handwriting' ? parseHandwriting(env.payload) : null;
  const isHw = hwPayload !== null;
  const textHtml = isHw
    ? (hwPayload ? renderHandwritingCard(hwPayload) : '')
    : isMd
      ? renderMarkdown(resolveMessageText(msg.text))
      : renderText(resolveMessageText(msg.text));
  // 链接卡片: 正文里所有网页 URL → 消息体下方各渲染一张链接卡片(标题/描述/favicon)。
  // 先渲染壳(host + url), 预览由 hydrateLinkCard 异步水合, 避免阻塞渲染。
  // 手写消息屏蔽(信封 JSON 里的文件名/内容会被裸域名正则误判为网址)
  const linkCardHtml = isHw
    ? ''
    : extractWebUrls(resolveMessageText(msg.text))
        .map((u) => renderLinkCard(u))
        .join('');
  // 发送者头像:优先用成员头像(state.currentMembers 与资料页同源、更新鲜),
  // 消息内嵌 from_avatar 可能取自头像设置前的旧快照,导致聊天里不显示而资料页正常。
  // 再兜底 from_avatar(成员列表缺失/不匹配时)。
  const member = state.currentMembers?.find((mm) => mm.contact_id === msg.from_id);
  const msgAvatar = member?.avatar ?? msg.from_avatar ?? null;
  const avatarUrl = msgAvatar ? await transformBlobURL(msgAvatar) : null;
  const bg = colorHex(msg.from_color ?? member?.color);
  const letter = (msg.from_name || '?').charAt(0).toUpperCase() || '?';
  const avatarHtml = avatarUrl
    ? `<img src="${escapeHtml(avatarUrl)}" class="msg-avatar" alt="" data-bg="${escapeAttr(bg)}" data-letter="${escapeAttr(letter)}" data-contact="${msg.from_id || ''}" data-name="${escapeAttr(msg.from_name || '')}" />`
    : `<div class="msg-avatar" style="background:${bg}" data-contact="${msg.from_id || ''}" data-name="${escapeAttr(msg.from_name || '')}">${escapeHtml(letter)}</div>`;
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
        case 'Voice': {
          // Delta 式语音播放器(voicePlayer.ts):播放按钮 + 计时,替代原生 audio controls
          const audioElId = `voice-${msg.msg_id}`;
          attachmentHtml = `<div class="msg-attachment voice" data-voice="${audioElId}">${renderVoicePlayer(assetUrl, audioElId)}</div>`;
          break;
        }
        case 'Audio':
          attachmentHtml = `<div class="msg-attachment audio">
          <audio controls src="${escapeAttr(assetUrl)}"></audio>
        </div>`;
          break;
        case 'Webxdc':
          attachmentHtml = `<div class="msg-attachment webxdc">${renderWebxdcCard(msg)}</div>`;
          break;
        case 'Vcard':
          // Delta vCard 名片:先渲染骨架,异步拉取解析出的联系人后水合
          attachmentHtml = `<div class="msg-attachment vcard" data-vcard-msg="${msg.msg_id}">
            <div class="vcard-shell">
              <div class="vcard-avatar"><div class="ui-spinner"></div></div>
              <div class="vcard-meta">
                <div class="vcard-name">名片</div>
                <div class="vcard-addr">正在加载联系人…</div>
              </div>
            </div>
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
  // 已读系统本土化:发出的消息显示文字状态(发送中/已送达/已读/N 人已读/失败)。
  // 群聊已读态 → 可点击(弹已读 popup);单聊已读 → 也可点击(看对方读取时间)。
  const st = msg.state || 'pending';
  const isRead = st === 'read';
  const readCount = getReadCount(msg.msg_id as number);
  const stateLabelText = stateLabel(st, state.currentChatIsGroup, readCount);
  const stateClickable = isRead ? ' data-read-popup="1"' : '';
  const stateHtml = isOut
    ? `<span class="msg-state state-${st}" data-msg-state="${msg.msg_id}"${stateClickable}>${stateLabelText}</span>`
    : '';
  const resendBtn = isOut && msg.state === 'failed'
    ? `<span class="msg-resend" data-msg-id="${msg.msg_id}">重发</span>`
    : '';
  const isOutAttr = isOut ? ' data-is-out="1"' : '';
  // 消息主题(QQ 式):从信封 payload.theme 读取,注册到发送者缓存;
  // 无主题的 text 信封表示发送者未启用主题 → 清缓存(回默认)。
  // 非信封(乐观消息/旧消息)不动缓存,沿用发送者最新主题。
  const senderId = msg.from_id || (isOut && state.self ? state.self.id : 0);
  const envTheme = envelopeTheme(msg.text);
  if (envTheme) {
    registerSenderTheme(senderId, envTheme as unknown as import('../types.js').MsgTheme);
  } else if (msg.view_type === 'Text') {
    // 无主题的 text 信封 → 发送者未启用主题,清缓存回默认。
    // 仅 type==='text' 信封会清(卡片/邀请等其他信封不携带主题,不清)。
    const env = tryParseEnvelope(msg.text);
    if (env && env.type === 'text') registerSenderTheme(senderId, { id: 'default' });
  }
  const { id: themeId, style: themeStyle } = msgThemeAttrs(themeForSender(senderId));
  const themeAttrs = themeId ? ` data-msg-theme="${escapeAttr(themeId)}"` : '';
  const themeStyleAttr = themeStyle ? ` style="${escapeAttr(themeStyle)}"` : '';
  // 折叠时:头像隐藏改为由 CSS 的 .collapsed 类控制(见 styles.css .msg.collapsed .msg-avatar)——
  // 这样 applyGroupRole 只改类,头像/圆角即时同步,不会出现"类已折叠但头像还在"的错乱。
  // 头像始终渲染在 DOM,折叠/展开只切类。
  const avatarDisplay = avatarHtml;
  const nameDisplay = (collapsed || isSingle)
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
    <div class="msg-bubble"${themeAttrs}${themeStyleAttr}>
      ${hoverActionsHtml}
      <div class="msg-meta">
        ${nameDisplay}
        ${roleTag}${replyMark}
      </div>
      ${quoteBlock}
      <div class="msg-text">${textHtml}</div>
      ${linkCardHtml}
      ${attachmentHtml}
      ${reactionsHtml}
      ${footerHtml}
      <div class="msg-reaction-picker" id="rp-${msg.msg_id}">
        ${pickerHtml}
      </div>
    </div>
  `;
  return `
    <div class="msg${collapsedCls}${groupCls}${stateClass}${isHw ? ' msg-hw' : ''}" data-msg="${msg.msg_id}"${isOutAttr} style="position:relative">
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
  const inline = (s: string) => highlightMentions(autolink(s)).replace(/\r?\n/g, '<br>');
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

// 链接识别: http(s) | www.域名 | 邮箱 | 裸域名。在 escapeHtml 之前匹配,
// 再对 url/href 分别转义; 末尾剥离成对/中文标点(,。;;), 避免句号被吞进链接。
// 顺序: http(s) 优先(整条含 www/@), 邮箱次之(避免裸域名分支切到 bar.com), 裸域名最后。
const LINK_RE =
  /(https?:\/\/[^\s<"']+)|(www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s<"']*)?)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|((?:^|(?<=[\s(]))[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:\/[^\s<"']*)?)/gi;

// 自动识别文本中的链接并转成可点击 <a>。裸/www 域名补 http://, 邮箱转 mailto:。
// 早退只对「无 http/@/www/点」的纯文本生效; 含点即跑正则(裸域名需要点)。
function autolink(text: string): string {
  if (!text.includes('http') && !text.includes('@') && !text.includes('www') && !text.includes('.')) return escapeHtml(text);
  LINK_RE.lastIndex = 0;
  let last = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) out.push(escapeHtml(text.slice(last, m.index)));
    const raw = m[0].replace(/[.,;:!?，。；、!?]+$/, '');
    const [http, www, mail, bare] = [m[1], m[2], m[3], m[4]];
    let href: string;
    if (http) href = raw;
    else if (mail) href = 'mailto:' + raw;
    else href = 'http://' + raw; // www 或裸域名
    out.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="msg-link">${escapeHtml(raw)}</a>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(escapeHtml(text.slice(last)));
  return out.join('');
}

// 取正文里所有网页 URL(跳过邮箱), 用于链接卡片。裸/www 补 http://; 去重保序。
function extractWebUrls(text: string): string[] {
  if (!text || (!text.includes('http') && !text.includes('www') && !text.includes('.'))) return [];
  LINK_RE.lastIndex = 0;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    const raw = m[0].replace(/[.,;:!?，。；、!?]+$/, '');
    let url: string | null = null;
    if (m[1]) url = raw; // http(s)
    else if (m[2]) url = 'http://' + raw; // www
    else if (m[4]) url = 'http://' + raw; // 裸域名
    // m[3] 邮箱 → 跳过, 卡片只给网页
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ── 链接卡片 ──────────────────────────────────────────
const GLOBE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

interface LinkPreview {
  url: string;
  title: string;
  description: string | null;
  favicon: string | null;
}
const linkPreviewCache = new Map<string, LinkPreview>();

function renderLinkCard(url: string): string {
  const host = hostOf(url);
  return `<div class="msg-link-card" data-url="${escapeAttr(url)}">
    <div class="msg-lc-icon">${GLOBE_SVG}</div>
    <div class="msg-lc-body">
      <div class="msg-lc-title">${escapeHtml(host)}</div>
      <div class="msg-lc-desc">${escapeHtml(url)}</div>
    </div>
  </div>`;
}

// 渲染后异步水合: 抓预览(有缓存跳过), 填标题/描述/favicon。失败保持壳。
async function hydrateLinkCard(url: string, card: HTMLElement): Promise<void> {
  const cached = linkPreviewCache.get(url);
  if (cached) {
    applyLinkPreview(card, cached);
    return;
  }
  try {
    const p = await call<LinkPreview>('fetch_link_preview', { url });
    linkPreviewCache.set(url, p);
    applyLinkPreview(card, p);
  } catch {
    /* 保持壳: host + url */
  }
}

function applyLinkPreview(card: HTMLElement, p: LinkPreview): void {
  const title = card.querySelector<HTMLElement>('.msg-lc-title');
  if (title && p.title) title.textContent = p.title;
  const desc = card.querySelector<HTMLElement>('.msg-lc-desc');
  if (desc && p.description) desc.textContent = p.description;
  const icon = card.querySelector<HTMLElement>('.msg-lc-icon');
  if (icon && p.favicon) icon.innerHTML = `<img src="${escapeAttr(p.favicon)}" alt="" onerror="this.style.display='none'" />`;
}

// vCard 名片:异步拉取解析出的联系人列表,水合第一张卡(姓名/邮箱/头像)。
// 名片可能含多个联系人(群名片),此处展示第一个,其余显示计数。
// 失败保持骨架壳(不阻断消息渲染)。
const vcardCache = new Map<number, VcardContactDto[]>();
async function hydrateVcardCard(card: HTMLElement): Promise<void> {
  const msgId = Number(card.dataset.vcardMsg);
  let contacts = vcardCache.get(msgId);
  if (contacts === undefined) {
    try {
      contacts = await call<VcardContactDto[]>('get_msg_vcard', { msgId });
    } catch {
      contacts = [];
    }
    vcardCache.set(msgId, contacts);
  }
  if (!contacts || contacts.length === 0) {
    const nameEl = card.querySelector<HTMLElement>('.vcard-name');
    if (nameEl) nameEl.textContent = '名片';
    const addrEl = card.querySelector<HTMLElement>('.vcard-addr');
    if (addrEl) addrEl.textContent = '无法解析联系人';
    return;
  }
  const first = contacts[0];
  const nameEl = card.querySelector<HTMLElement>('.vcard-name');
  if (nameEl) nameEl.textContent = first.name || first.addr || '联系人';
  const addrEl = card.querySelector<HTMLElement>('.vcard-addr');
  if (addrEl) {
    const more = contacts.length > 1 ? ` +${contacts.length - 1}` : '';
    addrEl.textContent = `${first.addr}${more}`;
  }
  const avatarWrap = card.querySelector<HTMLElement>('.vcard-avatar');
  if (avatarWrap) {
    if (first.avatar_data) {
      avatarWrap.innerHTML = `<img src="${escapeAttr(first.avatar_data)}" alt="" />`;
    } else {
      const bg = 'var(--border-strong)';
      const letter = (first.name || '?').charAt(0).toUpperCase() || '?';
      avatarWrap.innerHTML = `<span style="background:${bg}">${escapeHtml(letter)}</span>`;
      avatarWrap.classList.add('letter');
    }
  }
  // 点击名片 → 打开联系人资料卡片(若该邮箱已是本机联系人则带 contactId)
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    void (async () => {
      const contactId = await resolveVcardContactId(first.addr);
      const { openContactCard } = await import('../components/contactCard.js');
      openContactCard({
        contactId,
        name: first.name || first.addr,
        addr: first.addr,
        avatar: first.avatar_data,
        anchor: card,
      });
    })();
  });
}

// 尝试把名片邮箱解析成本机联系人 ID(用于资料卡片的发消息/共有会话)。查不到返回 null。
async function resolveVcardContactId(addr: string): Promise<number | null> {
  try {
    const contacts = await call<Array<{ id: number; addr: string }>>('get_contacts');
    const hit = contacts.find((c) => c.addr.toLowerCase() === addr.toLowerCase());
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

// 打开外部链接: 网页直接跳系统浏览器; 邮箱走 mailto(二次提示)。
async function openExternal(url: string): Promise<void> {
  if (url.startsWith('mailto:')) {
    const addr = url.slice('mailto:'.length);
    ui.confirm({
      title: '发送邮件',
      message: `写信给 ${addr}?`,
      confirmLabel: '打开邮件客户端',
      onConfirm: () => call('open_external', { url }),
    });
  } else {
    await call('open_external', { url });
  }
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
  // 已读弹层:群聊点「N 人已读」→ 名单;单聊点「已读」→ 对方读取时间。
  // 绑定所有 .msg-state,点击时再判断 data-read-popup —— 消息可能在渲染后才进入
  // 已读态(updateMsgState 动态加属性),若固定按 [data-read-popup] 绑定会漏掉监听,
  // 导致后进入已读态的消息点击无响应。
  container.querySelectorAll<HTMLElement>('.msg-state').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (!el.hasAttribute('data-read-popup')) return;
      e.stopPropagation();
      const msgId = Number(el.dataset.msgState);
      void import('../components/readReceiptsPopup.js').then((m) => {
        if (state.currentChatIsGroup) m.openReadReceiptsPopup(msgId, el);
        else m.showReadTimePopup(msgId, el);
      });
    });
  });

  // 消息内链接: 点击 → 系统浏览器/邮件客户端(外部打开, 不离开应用)
  container.querySelectorAll<HTMLAnchorElement>('.msg-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = a.getAttribute('href') || '';
      if (url) void openExternal(url);
    });
  });

  // 链接卡片: 点击 → 外部打开; 渲染后异步水合预览
  container.querySelectorAll<HTMLElement>('.msg-link-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = card.dataset.url || '';
      if (url) void openExternal(url);
    });
    void hydrateLinkCard(card.dataset.url || '', card);
  });

  // vCard 名片:异步拉取解析出的联系人并水合;点击 → 打开资料卡片
  container.querySelectorAll<HTMLElement>('.msg-attachment.vcard').forEach((card) => {
    void hydrateVcardCard(card);
  });

  // 消息头像点击 → 打开该发送者的资料卡片(成员入口)
  container.querySelectorAll<HTMLElement>('.msg-avatar').forEach((av) => {
    const contactId = Number(av.dataset.contact || 0);
    const name = av.dataset.name || '';
    if (!contactId) return;
    av.style.cursor = 'pointer';
    av.addEventListener('click', (e) => {
      e.stopPropagation();
      void (async () => {
        const { openContactCard } = await import('../components/contactCard.js');
        // 从当前会话成员反查完整资料(addr/color/avatar/last_seen)
        const member = state.currentMembers?.find((m) => m.contact_id === contactId);
        openContactCard({
          contactId,
          name: member?.name || name,
          addr: member?.addr || '',
          avatar: member?.avatar,
          color: member?.color,
          lastSeen: member?.last_seen,
          anchor: av,
        });
      })();
    });
  });

  // 引用块点击 → 跳转被引用消息原文(jumpToMessage 滚动定位 + 高亮)。
  // 动态 import 避免循环依赖(chatView import message,message 反向只按需加载)。
  container.querySelectorAll<HTMLElement>('.msg-quote').forEach((q) => {
    const quoteMsgId = Number(q.dataset.quoteMsg || 0);
    if (!quoteMsgId) return;
    q.style.cursor = 'pointer';
    q.addEventListener('click', (e) => {
      e.stopPropagation();
      void import('../chat/chatView.js').then(({ jumpToMessage }) => jumpToMessage(quoteMsgId));
    });
  });

  // 「回复 XXX」用户名点击 → 打开发送者名片(带头像)。
  // 优先用当前会话成员反查完整资料(avatar/addr/color),成员表缺失时用 quote_from 名。
  container.querySelectorAll<HTMLElement>('.msg-reply-name').forEach((rn) => {
    rn.style.cursor = 'pointer';
    rn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contactId = Number(rn.dataset.replyContact || 0);
      const name = rn.dataset.replyName || '';
      const member = contactId ? state.currentMembers?.find((m) => m.contact_id === contactId) : undefined;
      void (async () => {
        const { openContactCard } = await import('../components/contactCard.js');
        openContactCard({
          // contactId = 被引用消息发送者(quote_from_id);成员表能反查到则带完整资料
          contactId: contactId || null,
          name: member?.name || name,
          addr: member?.addr || '',
          avatar: member?.avatar,
          color: member?.color,
          lastSeen: member?.last_seen,
          anchor: rn,
        });
      })();
    });
  });

  // 头像加载失败兜底:图片加载不了时换成首字母占位,避免破图
  container.querySelectorAll<HTMLImageElement>('.msg-avatar img').forEach((img) => {
    img.addEventListener('error', () => {
      const div = document.createElement('div');
      div.className = 'msg-avatar';
      div.style.background = img.dataset.bg || 'var(--border-strong)';
      div.textContent = img.dataset.letter || '?';
      img.replaceWith(div);
    });
  });

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

  // Delta 批次 3:绑定语音播放器(播放/暂停/计时)
  bindVoicePlayer(container);
  // Delta 批次 3:绑定 webxdc 卡片(启动按钮 + 信息水合)
  bindWebxdcCard(container);
  // 手写消息:自动一步步回放 + 点击重播
  bindHandwritingCards(container);

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
        setTimeout(() => overlay.remove(), 210);
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
      void showContextMenuAt(e.clientX, e.clientY, msgIdStr, msgId, msg, isOut);
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
      action: () => void openForwardDialog(msgId),
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
async function showContextMenuAt(
  x: number,
  y: number,
  msgIdStr: string,
  msgId: number,
  msg: RenderableMsg | undefined,
  isOut: boolean,
): Promise<void> {
  // 判断当前会话是否为「保存的消息」(self-talk):决定显示 取消保存/保存消息
  let isSelfTalk = false;
  try {
    const chats = await call<ChatListItem[]>('get_chatlist');
    isSelfTalk = chats.some((cc) => cc.is_self_talk && cc.chat_id === state.currentChatId);
  } catch { /* 拉取失败时保持默认保存行为 */ }

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
  items.push(isSelfTalk
    ? {
        label: '取消保存',
        icon: 'bookmark',
        action: async () => {
          try {
            await call('unsave_msg', { msgId });
            showToast('已取消保存');
          } catch (e) {
            showToast(e instanceof Error ? e.message : String(e));
          }
        },
      }
    : {
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
    label: '已读回执',
    icon: 'check-check',
    action: async () => {
      try {
        const n = await call<number>('get_message_read_receipt_count', { msgId });
        showToast(n > 0 ? `已读 ${n} 人` : '暂无已读');
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
    action: () => void openForwardDialog(msgId),
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

// 转发:弹出会话选择弹窗(排除当前会话),点击目标会话后调用 forward_msg。
async function openForwardDialog(msgId: number): Promise<void> {
  let chats: ChatListItem[] = [];
  try {
    chats = await call<ChatListItem[]>('get_chatlist');
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
    return;
  }
  const targets = chats.filter((cc) => cc.chat_id !== state.currentChatId);
  const dlg = ui.dialog({ title: '转发到', body: '<div></div>', size: 'md' });
  const bodyEl = dlg.overlay.querySelector<HTMLElement>('.ui-dialog-body');
  if (!bodyEl) return;
  if (targets.length === 0) {
    bodyEl.innerHTML = '<div style="padding:16px;color:var(--text-weak)">暂无可转发的会话</div>';
    return;
  }
  const listWrap = document.createElement('div');
  listWrap.style.maxHeight = '320px';
  listWrap.style.overflowY = 'auto';
  for (const chat of targets) {
    listWrap.appendChild(ui.listItem({
      title: chat.name,
      subtitle: chat.last_msg?.slice(0, 40) || '',
      onClick: async () => {
        dlg.close();
        try {
          await call('forward_msg', { msgId, chatId: chat.chat_id });
          showToast('已转发');
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
        }
      },
    }));
  }
  bodyEl.appendChild(listWrap);
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

