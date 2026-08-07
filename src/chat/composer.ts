import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { appendOptimisticMessage } from './chatView.js';
import { iconSvg } from '../components/icon.js';
import { escapeHtml, escapeAttr } from '../components/escape.js';
import { showDropdown } from '../components/dropdown.js';
import type { MsgDto, MemberDto, ChannelDto } from '../types.js';

// 乐观更新临时消息类型 — message.js 读取这些字段渲染发送中状态。
// MsgDto 没有 is_out/_state/file_bytes/width/height/download_state/subject 等字段,
// 因此定义本地 TmpMsg 完整描述临时消息形状,调用 appendOptimisticMessage 时再 cast 为 MsgDto。
interface TmpMsg {
  msg_id: string;
  from_id: number;
  from_name: string;
  from_avatar: string | null;
  from_color: number | null;
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

// 输入框两种模式(微信):
// - 收起:单行自动增高,Enter 发送,Ctrl+Enter 换行
// - 展开:大 textarea(顶部可拖拽调高),Enter 换行,Ctrl+Enter 发送
let expanded = false;
const PLACEHOLDER_COLLAPSED = '发消息到频道... (@提及 / #频道)';
const PLACEHOLDER_EXPANDED = 'Enter 换行,Ctrl+Enter 发送';


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
  // md 开关:默认开,localStorage 持久化
  const MD_KEY = 'peyt.md.enabled';
  const getMdEnabled = (): boolean => localStorage.getItem(MD_KEY) !== '0';
  const setMdEnabled = (v: boolean): void => localStorage.setItem(MD_KEY, v ? '1' : '0');
  let mdEnabled = getMdEnabled();
  // 微信式输入框:上部 textarea 区(融入背景 + 右上角展开)+ 下部工具条
  // (左侧图标组,右侧录音圆形 + 翠绿胶囊「发送」)。
  area.innerHTML = `
    <div class="composer">
      <div class="composer-resize" id="composer-resize" title="拖拽调整高度" aria-hidden="true"></div>
      ${replyPreview}
      <div class="composer-main">
        <textarea id="composer-input" placeholder="${PLACEHOLDER_COLLAPSED}" rows="1"></textarea>
        <button type="button" class="composer-expand" id="composer-expand" aria-label="展开输入框">
          ${iconSvg('chevrons-up-down', { width: 14, height: 14 })}
          <span class="composer-tooltip">展开输入框,Enter 换行,Ctrl+Enter 发送</span>
        </button>
      </div>
      <div class="composer-toolbar">
        <div class="composer-tools">
          <button type="button" class="composer-tool" id="composer-attach" title="添加">${iconSvg('plus', { width: 18, height: 18 })}</button>
          <label class="composer-md-toggle" title="Markdown 渲染">
            <span class="composer-md-label">Markdown</span>
            <span class="toggle-switch">
              <input type="checkbox" id="composer-md" ${mdEnabled ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </span>
          </label>
        </div>
        <div class="composer-actions">
          <span class="composer-mic-timer" id="composer-mic-timer"></span>
          <button type="button" class="composer-mic" id="composer-mic" title="录音">${iconSvg('mic', { width: 16, height: 16 })}</button>
          <button type="button" class="composer-send" id="composer-send" title="发送" disabled>${iconSvg('send', { width: 18, height: 18 })}</button>
        </div>
      </div>
    </div>
  `;
  const input = document.getElementById('composer-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const composerEl = area.querySelector('.composer') as HTMLElement | null;
  // 消息区底部留白随输入框高度变化:composer 尺寸变化 → 更新 messages 的
  // padding-bottom。用 CSS 变量 + 监听 composer 高度(ResizeObserver)驱动,
  // 展开/拖拽调高时消息区底部自动让出对应空间。
  const syncComposerHeight = (): void => {
    const messagesEl = document.getElementById('messages');
    if (!messagesEl || !composerEl) return;
    const h = composerEl.getBoundingClientRect().height;
    messagesEl.style.setProperty('--composer-h', `${Math.ceil(h)}px`);
  };
  const composerRO = new ResizeObserver(() => syncComposerHeight());
  if (composerEl) composerRO.observe(composerEl);
  syncComposerHeight();
  // 发送按钮:空输入禁用,有内容点亮 (微信式,与 Enter 发送等价)
  const sendBtn = document.getElementById('composer-send') as HTMLButtonElement | null;
  const updateSendState = () => {
    if (sendBtn) sendBtn.disabled = !input.value.trim();
  };
  updateSendState();
  sendBtn?.addEventListener('click', async () => {
    if (!input.value.trim()) return;
    await send(chatId, input, area, onSent);
    updateSendState();
  });
  // 展开按钮:切换两种模式(收起=单行 Enter 发送;展开=大 textarea Enter 换行)。
  // CSS 类 .expanded 驱动高度/指示器显隐/placeholder/键盘语义。
  const expandBtn = document.getElementById('composer-expand') as HTMLButtonElement | null;
  const applyExpanded = (next: boolean): void => {
    // 仅当模式真实变化才弹 toast(展开按钮/拖拽进入/拖回单行才弹,重渲染不重复)
    const changed = expanded !== next;
    expanded = next;
    composerEl?.classList.toggle('expanded', expanded);
    input.placeholder = expanded ? PLACEHOLDER_EXPANDED : PLACEHOLDER_COLLAPSED;
    if (changed) {
      showToast(expanded ? '已切换:Enter 换行 · Ctrl+Enter 发送' : '已切换:Enter 发送 · Ctrl+Enter 换行');
    }
    // 模式切换:收起 → 单行;展开 → 重置为默认大高度(用户可用顶部指示器再拖)
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    input.focus();
  };
  expandBtn?.addEventListener('click', () => {
    applyExpanded(!expanded);
  });
  // 顶部 resize 指示器:常驻热区(收起模式悬停浮现细条)。pointerdown 未展开 → 立即展开
  // (含键盘语义,与右上角展开按钮一致;展开后回填当前高度保持无缝衔接),
  // 随后拖拽纵向调高 [40, 320]px(Apple §2:1:1 跟随)。拖回单行高度松手自动切回收起模式。
  const resizeHandle = document.getElementById('composer-resize') as HTMLElement | null;
  resizeHandle?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!expanded) {
      const prevH = input.getBoundingClientRect().height;
      applyExpanded(true);
      // applyExpanded 重置为默认高度 → 回填拖拽起点,保持无缝
      input.style.height = Math.max(prevH, 88) + 'px';
    }
    const startY = e.clientY;
    const startH = input.getBoundingClientRect().height;
    let collapsePending = false;
    const onMove = (ev: PointerEvent): void => {
      const delta = ev.clientY - startY; // 向上拖 = 负增量 = 增高
      const h = Math.min(320, Math.max(40, startH - delta));
      input.style.height = h + 'px';
      // 拖到单行高度 → 标记待切回(松手时生效,实时无跳变)
      collapsePending = h <= 46;
      // 输入框变高 → 消息区底部让位,若在底部则同步上顶,保持最新消息可见
      const messagesEl = document.getElementById('messages');
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    };
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (collapsePending) applyExpanded(false); // 拖回单行 → 自动收起(含 toast)
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  // 重渲染(回复发送/取消)后让 DOM 与模块级 expanded 保持一致
  applyExpanded(expanded);
  // 附件(加号)按钮:点开菜单 popup,目前只做「附件上传」。
  // 附件上传:打开文件选择 → base64 → send_attachment(media 信封)。
  const attachBtn = document.getElementById('composer-attach') as HTMLButtonElement | null;
  if (attachBtn) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (f) void sendAttachment(chatId, f, onSent);
    });
    attachBtn.parentElement?.appendChild(fileInput);
    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 菜单向上弹(composer 在屏幕底部,向下会超出视口)
      showDropdown(attachBtn, [
        {
          label: '附件上传',
          icon: 'paperclip',
          action: () => fileInput.click(),
        },
      ], { position: 'top-left' });
    });
  }
  // md 开关:仅控制本条消息发送的 markdown 字段(不碰引用块渲染)
  const mdToggle = document.getElementById('composer-md') as HTMLInputElement | null;
  const mdWrap = composerEl?.querySelector('.composer-md-toggle');
  mdToggle?.addEventListener('change', () => {
    mdEnabled = mdToggle.checked;
    setMdEnabled(mdEnabled);
    mdWrap?.classList.remove('md-hint');
  });
  // 关闭时检测 md 语法 → 呼吸灯提示(手动开启才熄灭,不自动改)
  const MD_RE = /#{1,6}\s|\*\*|`{1,3}|^\s*[-*>|]\s|\[.+\]\(.+\)/m;
  input.addEventListener('input', () => {
    if (mdEnabled || !mdToggle) return;
    const hasMd = MD_RE.test(input.value);
    mdWrap?.classList.toggle('md-hint', hasMd);
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
  // 自适应高度 + @提及/#频道检测 + 草稿保存
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
    // 中文输入法组合中:Enter 用于上屏候选字,不触发发送/换行/选建议项
    const composing = e.isComposing || e.keyCode === 229;
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
      if (e.key === 'Enter' && !composing && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
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
    // 键盘语义随模式切换(建议面板打开时 Enter 已被上方分支拦截):
    // - 收起:Enter 发送,Ctrl/Cmd+Enter 换行
    // - 展开:Enter 换行,Ctrl/Cmd+Enter 发送
    if (e.key === 'Enter' && !composing && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (expanded) {
        insertNewline(input);
      } else {
        await send(chatId, input, area, onSent);
      }
    } else if (e.key === 'Enter' && !composing && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (expanded) {
        await send(chatId, input, area, onSent);
      } else {
        insertNewline(input);
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
  // 录音态 UI:mic 变红(pulse 动画)+ 计时(Apple 录音态特征)
  micBtn.classList.add('recording');
  micBtn.title = '停止录音';
  if (elapsedEl) {
    elapsedEl.classList.add('recording');
    elapsedEl.textContent = `0:00`;
  }
  rec.timer = window.setInterval(() => {
    if (elapsedEl) elapsedEl.textContent = formatRecordTime(Date.now() - rec.startTime);
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
    rec.micBtn.classList.remove('recording');
    rec.micBtn.title = '录音';
  }
  if (rec.elapsedEl) {
    rec.elapsedEl.classList.remove('recording');
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

// 发送附件:File → base64 → send_attachment(media 信封)。带乐观更新(发送中)。
async function sendAttachment(chatId: number, file: File, onSent: () => void): Promise<void> {
  const tmpId = `tmp_att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // 乐观临时消息:附件卡片展示发送中。file 用 blob URL 预览,等待 onSent 全量刷新替换。
  const blobUrl = URL.createObjectURL(file);
  const viewType = file.type.startsWith('image/') ? 'Image'
    : file.type.startsWith('audio/') ? 'Audio'
    : file.type.startsWith('video/') ? 'Video'
    : 'File';
  const tmpMsg = {
    msg_id: tmpId,
    from_id: 1,
    from_name: state.self?.name || '我',
    from_avatar: null,
    from_color: null,
    text: file.name,
    ts: Math.floor(Date.now() / 1000),
    is_out: true,
    _state: 'sending' as const,
    quote_from: null,
    quote_text: null,
    view_type: viewType,
    file: blobUrl,
    file_name: file.name,
    file_mime: file.type,
    file_bytes: file.size,
    width: null,
    height: null,
    download_state: 'Done',
    subject: null,
    is_info: false,
  };
  appendOptimisticMessage(tmpMsg as unknown as MsgDto);
  try {
    const base64 = await blobToBase64(file);
    await call('send_attachment', { chatId, base64, filename: file.name, mime: file.type });
    URL.revokeObjectURL(blobUrl);
    if (onSent) await onSent();
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    showToast('发送附件失败: ' + (e instanceof Error ? e.message : String(e)));
  }
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
  // md 开关状态从 localStorage 读(发送时取最新,跨重渲染一致)
  const mdOn = localStorage.getItem('peyt.md.enabled') !== '0';
  // 乐观更新:插入临时消息。md 开 → 临时消息也包信封(markdown:true),避免气泡闪 md 原文
  const tmpId = `tmp_${Date.now()}`;
  const optText = mdOn ? JSON.stringify({ type: 'text', id: `tmp_${Date.now()}`, payload: { text, markdown: true } }) : text;
  const tmpMsg: TmpMsg = {
    msg_id: tmpId,
    from_id: state.self?.id || 0,
    from_name: state.self?.name || '我',
    from_avatar: state.self?.avatar || null,
    from_color: state.self?.color || null,
    text: optText,
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
      await call('send_reply', { chatId, text, quoteMsgId: Number(replyTo), markdown: mdOn });
      delete area.dataset.replyTo;
    } else {
      await call('send_text', { chatId, text, markdown: mdOn });
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
