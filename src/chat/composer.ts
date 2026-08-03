import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { appendOptimisticMessage } from './chatView.js';
import { iconSvg } from '../components/icon.js';
import type { MsgDto, MemberDto, ChannelDto } from '../types.js';

// 乐观更新临时消息类型 — message.js 读取这些字段渲染发送中状态。
// MsgDto 没有 is_out/_state/file_bytes/width/height/download_state/subject 等字段,
// 因此定义本地 TmpMsg 完整描述临时消息形状,调用 appendOptimisticMessage 时再 cast 为 MsgDto。
interface TmpMsg {
  msg_id: string;
  from_id: number;
  from_name: string;
  text: string;
  ts: number;
  is_out: boolean;
  _state: 'sending' | 'failed';
  quote_from: string | null;
  quote_text: string | null;
  view_type: string;
  file: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_bytes: number | null;
  width: number | null;
  height: number | null;
  download_state: string;
  subject: string | null;
}

// @提及 / #频道引用建议面板状态
// mentionList: 当前显示的建议 DOM 元素(null 表示未显示)
// mentionItems: 当前建议项数组(成员名或频道名)
// mentionKind: '@' 成员建议 / '#' 频道建议
// mentionSelectedIndex: 当前选中项索引(键盘导航)
// mentionQueryStart: 在 textarea 中 @ 或 # 字符的位置,用于替换插入
let mentionList: HTMLElement | null = null;
let mentionItems: Array<{ name: string; type: 'member' | 'channel' }> = [];
let mentionKind: '@' | '#' | null = null;
let mentionSelectedIndex = 0;
let mentionQueryStart = -1;

export function renderComposer(chatId: number, onSent: () => void): void {
  const area = document.getElementById('composer-area');
  if (!area) return;
  // F5:切换 chat 时清理可能残留的 @提及/#频道建议面板 (模块级 mentionList),
  // 避免上一个聊天的建议列表残留在新聊天界面。
  closeMentionList();
  // reply 预览条(若 composer-area.dataset.replyTo 设置)
  let replyPreview = '';
  if (area.dataset.replyTo) {
    const replyMsg = state.messages.find((m) => String(m.msg_id) === String(area.dataset.replyTo));
    if (replyMsg) {
      replyPreview = `
        <div class="reply-preview" id="reply-preview">
          <div class="reply-preview-icon">${iconSvg('reply', { width: 14, height: 14 })}</div>
          <div class="reply-preview-body">
            <div class="reply-preview-name">回复 ${escapeHtml(replyMsg.from_name)}</div>
            <div class="reply-preview-text">${escapeHtml((replyMsg.text || '').slice(0, 40))}</div>
          </div>
          <span class="rp-cancel" id="rp-cancel" title="取消回复">${iconSvg('x', { width: 14, height: 14 })}</span>
        </div>
      `;
    }
  }
  area.innerHTML = `
    <div class="composer">
      ${replyPreview}
      <div class="composer-row">
        <textarea id="composer-input" placeholder="发消息到频道... (@提及 / #频道)" rows="1"></textarea>
        <button type="button" class="composer-send" id="composer-send" title="发送" disabled>${iconSvg('arrow-up', { width: 18, height: 18, strokeWidth: 2.2 })}</button>
      </div>
    </div>
  `;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const sendBtn = document.getElementById('composer-send') as HTMLButtonElement | null;
  // 发送按钮:空输入禁用,有内容点亮 (iMessage 式,与 Enter 发送等价)
  const updateSendState = () => {
    if (sendBtn) sendBtn.disabled = !input.value.trim();
  };
  updateSendState();
  sendBtn?.addEventListener('click', async () => {
    if (!input.value.trim()) return;
    await send(chatId, input, area, onSent);
    updateSendState();
  });
  // reply cancel
  const rpCancel = document.getElementById('rp-cancel');
  if (rpCancel) {
    rpCancel.onclick = () => {
      delete area.dataset.replyTo;
      renderComposer(chatId, onSent);
    };
  }
  // 自适应高度 + @提及/#频道检测 + 发送按钮点亮
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    handleMentionInput(input);
    updateSendState();
  };
  // keydown — 含 @提及/#频道导航(上下/Enter/Esc)和发送逻辑
  input.onkeydown = async (e) => {
    // 建议面板打开时优先处理导航
    if (mentionList) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionItems.length;
        updateMentionSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionItems.length) % mentionItems.length;
        updateMentionSelection();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        insertSelectedMention(input);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionList();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        insertSelectedMention(input);
        return;
      }
    }
    // 发送
    const isReplying = !!area.dataset.replyTo;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // Cmd/Ctrl+Enter 始终发送（含回复）
      e.preventDefault();
      await send(chatId, input, area, onSent);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (isReplying) {
        // 回复中：普通 Enter 换行，不发送
        insertNewline(input);
      } else {
        e.preventDefault();
        await send(chatId, input, area, onSent);
      }
    } else if (e.key === 'Escape') {
      if (area.dataset.replyTo) {
        delete area.dataset.replyTo;
        renderComposer(chatId, onSent);
      }
    }
  };
  input.focus();
}

/** 在光标处插入换行并自适应高度（回复多行输入用）。 */
function insertNewline(input: HTMLTextAreaElement): void {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.slice(0, start) + '\n' + input.value.slice(end);
  const pos = start + 1;
  input.selectionStart = pos;
  input.selectionEnd = pos;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// 检测 textarea 中光标前的 @xxx / #xxx 模式,弹出对应建议列表
function handleMentionInput(input: HTMLTextAreaElement): void {
  const text = input.value;
  const cursorPos = input.selectionStart;
  const beforeCursor = text.slice(0, cursorPos);
  // @ 提及:匹配光标前最近的 @ 后跟(可能为空的)标识符
  const atMatch = beforeCursor.match(/@(\w*)$/);
  if (atMatch) {
    const query = atMatch[1].toLowerCase();
    const members = state.currentMembers.filter((m) => m.name.toLowerCase().includes(query));
    if (members.length > 0) {
      const atPos = cursorPos - atMatch[0].length;
      showMentionList(
        members.map((m) => ({ name: m.name, type: 'member' as const })),
        '@',
        atPos,
        input,
      );
    } else {
      closeMentionList();
    }
    return;
  }
  // # 频道引用:匹配光标前最近的 # 后跟(可能为空的)标识符
  const hashMatch = beforeCursor.match(/#(\w*)$/);
  if (hashMatch) {
    const query = hashMatch[1].toLowerCase();
    const channels = state.channels.filter((c: ChannelDto) => c.name.toLowerCase().includes(query));
    if (channels.length > 0) {
      const hashPos = cursorPos - hashMatch[0].length;
      showMentionList(
        channels.map((c) => ({ name: c.name, type: 'channel' as const })),
        '#',
        hashPos,
        input,
      );
    } else {
      closeMentionList();
    }
    return;
  }
  closeMentionList();
}

// 渲染建议列表(成员或频道),定位到 textarea 下方
function showMentionList(
  items: Array<{ name: string; type: 'member' | 'channel' }>,
  kind: '@' | '#',
  queryStart: number,
  input: HTMLTextAreaElement,
): void {
  closeMentionList();
  mentionItems = items;
  mentionKind = kind;
  mentionSelectedIndex = 0;
  mentionQueryStart = queryStart;
  mentionList = document.createElement('div');
  mentionList.className = 'mention-list';
  // 入场:轻微上浮 + 淡入(材料感),transform-origin 锚定到输入框方向
  mentionList.style.transformOrigin = 'left bottom';
  mentionList.style.animation = 'mention-pop 140ms ease-out';
  mentionList.innerHTML = items
    .map((item, i) => {
      const prefix = item.type === 'channel' ? '#' : '@';
      return `<div class="mention-item ${i === 0 ? 'selected' : ''}" data-index="${i}" data-name="${escapeAttr(item.name)}">
        <span class="mention-prefix">${prefix}</span>
        <span class="mention-name">${escapeHtml(item.name)}</span>
      </div>`;
    })
    .join('');
  // 定位:textarea 下方,左对齐
  const rect = input.getBoundingClientRect();
  mentionList.style.position = 'fixed';
  mentionList.style.left = `${rect.left}px`;
  mentionList.style.top = `${rect.top - Math.min(items.length, 6) * 28 - 4}px`;
  mentionList.style.zIndex = '200';
  document.body.appendChild(mentionList);
  // 点击选择
  mentionList.querySelectorAll<HTMLElement>('.mention-item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.index);
      mentionSelectedIndex = idx;
      insertSelectedMention(input);
    });
    // hover 更新选中
    el.addEventListener('mouseenter', () => {
      const idx = Number(el.dataset.index);
      mentionSelectedIndex = idx;
      updateMentionSelection();
    });
  });
}

// 更新建议列表选中项样式
function updateMentionSelection(): void {
  if (!mentionList) return;
  mentionList.querySelectorAll<HTMLElement>('.mention-item').forEach((el, i) => {
    el.classList.toggle('selected', i === mentionSelectedIndex);
  });
}

// 插入选中的建议项,替换 textarea 中 @query / #query 为 @name / #name + 空格
function insertSelectedMention(input: HTMLTextAreaElement): void {
  if (!mentionList || mentionItems.length === 0 || mentionKind == null || mentionQueryStart < 0) {
    closeMentionList();
    return;
  }
  const item = mentionItems[mentionSelectedIndex];
  if (!item) {
    closeMentionList();
    return;
  }
  const text = input.value;
  const cursorPos = input.selectionStart;
  const before = text.slice(0, mentionQueryStart);
  const after = text.slice(cursorPos);
  const insertText = `${mentionKind}${item.name} `;
  input.value = before + insertText + after;
  const newPos = (before + insertText).length;
  input.selectionStart = newPos;
  input.selectionEnd = newPos;
  // 自适应高度
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  closeMentionList();
  input.focus();
}

function closeMentionList(): void {
  if (mentionList) {
    mentionList.remove();
    mentionList = null;
  }
  mentionItems = [];
  mentionKind = null;
  mentionSelectedIndex = 0;
  mentionQueryStart = -1;
}

async function send(chatId: number, input: HTMLTextAreaElement, area: HTMLElement, onSent: () => void): Promise<void> {
  const text = input.value.trim();
  if (!text) return;

  // Slash 命令分发 — 由插件通过 api.onCommand 注册，如 /ai、/setkey
  if (text.startsWith('/')) {
    const sp = text.indexOf(' ');
    const cmd = sp === -1 ? text.slice(1) : text.slice(1, sp);
    const args = sp === -1 ? '' : text.slice(sp + 1).trim();
    const handler = window.__peytchat_commands?.[cmd];
    if (handler) {
      input.value = '';
      input.style.height = 'auto';
      closeMentionList();
      try {
        await handler(args, chatId);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
      if (onSent) await onSent();
      return;
    }
  }

  const replyTo = area.dataset.replyTo;
  // 乐观更新:插入临时消息
  const tmpId = `tmp_${Date.now()}`;
  const tmpMsg: TmpMsg = {
    msg_id: tmpId,
    from_id: state.self?.id || 0,
    from_name: state.self?.name || '我',
    text,
    ts: Math.floor(Date.now() / 1000),
    is_out: true,
    _state: 'sending',
    quote_from: null,
    quote_text: null,
    // 修复:补全附件字段默认值,避免 renderMessage 访问 undefined
    view_type: 'Text',
    file: null,
    file_name: null,
    file_mime: null,
    file_bytes: null,
    width: null,
    height: null,
    download_state: 'Done',
    subject: null,
  };
  // 修复:不直接 insertAdjacentHTML(虚拟化下会插到 spacerBottom 之后),
  // 改为调用 chatView.appendOptimisticMessage,通过虚拟化渲染底部范围。
  // tmpMsg 含 MsgDto 之外的字段(is_out/_state 等),message.js 依赖这些字段渲染发送状态。
  appendOptimisticMessage(tmpMsg as unknown as MsgDto);
  // 清空输入
  input.value = '';
  input.style.height = 'auto';
  closeMentionList();
  // 发送
  try {
    if (replyTo) {
      await call('send_reply', { chatId, text, quoteMsgId: Number(replyTo) });
      delete area.dataset.replyTo;
      renderComposer(chatId, onSent);
    } else {
      await call('send_text', { chatId, text });
    }
    // onSent 触发全量刷新(会替换临时消息)
    if (onSent) await onSent();
  } catch (e) {
    // 标记临时消息为 failed
    tmpMsg._state = 'failed';
    const messagesEl = document.getElementById('messages');
    const el = messagesEl?.querySelector<HTMLElement>(`[data-msg="${tmpId}"]`);
    if (el) {
      el.classList.remove('sending');
      el.classList.add('failed');
      el.onclick = async () => {
        // 点击重发
        input.value = text;
        tmpMsg._state = 'sending';
        el.classList.remove('failed');
        el.classList.add('sending');
        el.onclick = null;
        await send(chatId, input, area, onSent);
      };
    }
    showToast(e instanceof Error ? e.message : String(e));
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
