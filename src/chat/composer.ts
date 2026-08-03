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
// 草稿:输入防抖保存计时器(500ms 后写入后端)
let draftTimer: ReturnType<typeof setTimeout> | null = null;

export async function renderComposer(chatId: number, onSent: () => void): Promise<void> {
  const area = document.getElementById('composer-area');
  if (!area) return;
  // F5:切换 chat 时清理可能残留的 @提及/#频道建议面板 (模块级 mentionList),
  // 避免上一个聊天的建议列表残留在新聊天界面。
  closeMentionList();
  // 重渲染 composer 时停止并丢弃进行中的录音(释放麦克风),避免残留活跃录音
  cleanupVoiceRecorder();
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
        <span class="composer-mic-timer" id="composer-mic-timer" style="display:none; align-self:center; font-size:var(--font-scale-secondary); font-variant-numeric:tabular-nums; color:var(--danger); white-space:nowrap;"></span>
        <button type="button" class="composer-mic" id="composer-mic" title="录音" style="flex-shrink:0; width:36px; height:36px; display:flex; align-items:center; justify-content:center; border:1px solid var(--border-strong); border-radius:50%; cursor:pointer; background:var(--capsule); color:var(--text-mute); transition:color 120ms, background 120ms;">${iconSvg('volume-2', { width: 18, height: 18 })}</button>
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
  // 录音按钮:点击开始 MediaRecorder 录音,再点停止发送 (Voice viewtype)
  initVoiceRecorder(chatId, onSent);
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
    // 草稿:输入防抖 500ms 保存(空文本=清除)
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      void call('set_draft', { chatId, text: input.value });
    }, 500);
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
  // 草稿:恢复上次未发送的输入(后端 get_draft),再聚焦
  try {
    const draft = await call<string | null>('get_draft', { chatId });
    if (draft) {
      input.value = draft;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      updateSendState();
    }
  } catch {}
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

// ── 录音 (Voice viewtype) ──────────────────────────────────────────────
// 点击 mic 开始 MediaRecorder 录音,再点停止 → blob → base64 → send_voice。
// 录音中 mic 变红 + 显示计时(🔴 m:ss);停止后自动发送,无取消按钮(YAGNI)。
// 模块级 activeVoiceRecorder 供 composer 重渲染时清理,避免遗留活跃录音/麦克风占用。
interface ActiveVoiceRecorder {
  mediaRecorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  timer: number | null; // window.setInterval 返回 number (node types 下全局 setInterval 返回 Timeout)
  elapsedEl: HTMLElement | null;
  micBtn: HTMLButtonElement | null;
  startTime: number;
  sendOnStop: boolean;
}
let activeVoiceRecorder: ActiveVoiceRecorder | null = null;

function initVoiceRecorder(chatId: number, onSent: () => void): void {
  const micBtn = document.getElementById('composer-mic') as HTMLButtonElement | null;
  if (!micBtn) return;
  const elapsedEl = document.getElementById('composer-mic-timer') as HTMLElement | null;
  micBtn.addEventListener('click', () => {
    if (activeVoiceRecorder) {
      // 正在录音 → 再点停止,onstop 后发送
      activeVoiceRecorder.sendOnStop = true;
      activeVoiceRecorder.mediaRecorder.stop();
    } else {
      void startVoiceRecording(chatId, onSent, micBtn, elapsedEl);
    }
  });
}

async function startVoiceRecording(
  chatId: number,
  onSent: () => void,
  micBtn: HTMLButtonElement,
  elapsedEl: HTMLElement | null,
): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showToast('无法访问麦克风: ' + (e instanceof Error ? e.message : String(e)));
    return;
  }
  let mediaRecorder: MediaRecorder;
  try {
    mediaRecorder = new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    showToast('此环境不支持录音: ' + (e instanceof Error ? e.message : String(e)));
    return;
  }
  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const rec: ActiveVoiceRecorder = {
    mediaRecorder,
    stream,
    chunks,
    timer: null,
    elapsedEl,
    micBtn,
    startTime: Date.now(),
    sendOnStop: false,
  };
  mediaRecorder.onstop = () => {
    // 释放麦克风 + 恢复按钮 UI(先于发送,尽快释放资源)
    clearInterval(rec.timer ?? undefined);
    stream.getTracks().forEach((t) => t.stop());
    activeVoiceRecorder = null;
    restoreMicUI(rec);
    if (rec.sendOnStop) {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      void sendVoice(chatId, blob, onSent);
    }
  };
  mediaRecorder.start();
  // 录音态 UI:mic 变红 + 显示计时
  micBtn.style.color = 'var(--danger)';
  micBtn.title = '停止录音';
  if (elapsedEl) {
    elapsedEl.style.display = 'inline';
    elapsedEl.textContent = '🔴 0:00';
  }
  rec.timer = window.setInterval(() => {
    if (elapsedEl) elapsedEl.textContent = `🔴 ${formatRecordTime(Date.now() - rec.startTime)}`;
  }, 1000);
  activeVoiceRecorder = rec;
}

// 停止并丢弃当前录音(composer 重渲染或切页时调用,释放麦克风)
export function cleanupVoiceRecorder(): void {
  const rec = activeVoiceRecorder;
  if (!rec) return;
  activeVoiceRecorder = null;
  rec.sendOnStop = false; // 丢弃,不发送
  try { rec.mediaRecorder.stop(); } catch {}
  clearInterval(rec.timer ?? undefined);
  rec.stream.getTracks().forEach((t) => t.stop());
  restoreMicUI(rec);
}

// 恢复 mic 按钮与计时 span 到非录音态
function restoreMicUI(rec: ActiveVoiceRecorder): void {
  if (rec.micBtn) {
    rec.micBtn.style.color = '';
    rec.micBtn.title = '录音';
  }
  if (rec.elapsedEl) {
    rec.elapsedEl.style.display = 'none';
    rec.elapsedEl.textContent = '';
  }
}

// 录音时长 m:ss(如 0:05)
function formatRecordTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 发送语音:blob → base64 → send_voice
async function sendVoice(chatId: number, blob: Blob, onSent: () => void): Promise<void> {
  try {
    const base64 = await blobToBase64(blob);
    await call('send_voice', { chatId, base64 });
    if (onSent) await onSent();
  } catch (e) {
    showToast('发送语音失败: ' + (e instanceof Error ? e.message : String(e)));
  }
}

// Blob → base64 (分块避免大文件 spread 爆栈;几秒录音量级安全)
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000; // 32KB/块
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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
      // 草稿:命令输入同样清空后端草稿,避免旧文本残留
      try { await call('set_draft', { chatId, text: '' }); } catch {}
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
    } else {
      await call('send_text', { chatId, text });
    }
    // 草稿:发送成功即清除后端草稿。回复路径在清除完成后再重新渲染,
    // 避免 get_draft 与 set_draft 竞态导致恢复出旧的未发送文本。
    try { await call('set_draft', { chatId, text: '' }); } catch {}
    if (replyTo) {
      renderComposer(chatId, onSent);
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
