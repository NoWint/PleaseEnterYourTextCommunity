import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { appendOptimisticMessage } from './chatView.js';
import { iconSvg } from '../components/icon.js';
import { escapeHtml, escapeAttr } from '../components/escape.js';
import { showDropdown } from '../components/dropdown.js';
import { serializeComposer } from './serialize.js';
import { caretRect, textBeforeCaret, getCaretPoint, setCaretPoint } from './caret.js';
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

// @提及 / #频道引用 / /命令 建议面板状态
// mentionList: 当前显示的建议 DOM 元素(null 表示未显示)
// mentionItems: 当前建议项数组(成员名/频道名/命令名)
// mentionKind: '@' 成员建议 / '#' 频道建议 / '/' 命令建议
// mentionSelectedIndex: 当前选中项索引(键盘导航)
let mentionList: HTMLElement | null = null;
let mentionItems: Array<{ name: string; type: 'member' | 'channel' | 'command'; description?: string }> = [];
let mentionKind: '@' | '#' | '/' | null = null;
let mentionSelectedIndex = 0;
// / 命令候选:内置静态表 + 后端 list_commands(模块加载时拉一次)+ 前端插件命令
const BUILTIN_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'whoami', description: '查看 Bot 身份与所属工作区' },
  { name: 'roll', description: '随机 1-N(默认 100)' },
  { name: 'summarize', description: '总结最近消息' },
  { name: 'ask', description: '向知识库提问' },
];
let remoteCommands: Array<{ name: string; description: string }> = [];
void call<Array<{ name: string; description: string }>>('list_commands').then((list) => {
  if (Array.isArray(list)) remoteCommands = list;
}).catch(() => {});
// 草稿:输入防抖保存计时器(500ms 后写入后端)
let draftTimer: ReturnType<typeof setTimeout> | null = null;

// 输入框两种模式(微信):
// - 收起:单行自动增高,统一 Enter 发送,Shift+Enter 换行
// - 展开:固定可拖拽高度,统一 Enter 发送,Shift+Enter 换行
let expanded = false;
const PLACEHOLDER = '发消息到频道... (@提及 / #频道)';


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
        <div id="composer-input" class="composer-input" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="${PLACEHOLDER}"></div>
        <button type="button" class="composer-expand" id="composer-expand" aria-label="展开输入框">
          ${iconSvg('chevrons-up-down', { width: 14, height: 14 })}
          <span class="composer-tooltip">展开输入框,Enter 换行,Ctrl+Enter 发送</span>
        </button>
      </div>
      <div class="composer-toolbar">
        <div class="composer-tools">
          <button type="button" class="composer-tool" id="composer-attach" title="添加">${iconSvg('plus', { width: 20, height: 20 })}</button>
          <button type="button" class="composer-tool" id="composer-handwrite" title="手写">${iconSvg('edit', { width: 18, height: 18 })}</button>
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
  const input = document.getElementById('composer-input') as HTMLElement | null;
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
    if (sendBtn) sendBtn.disabled = isEmptyInput(input);
  };
  updateSendState();
  sendBtn?.addEventListener('click', async () => {
    if (isEmptyInput(input)) return;
    await send(chatId, input, area, onSent);
    updateSendState();
  });
  // 展开按钮:切换两种模式(收起=单行自动增高;展开=固定可拖拽高度)。
  // CSS 类 .expanded 驱动高度/指示器显隐/data-placeholder/键盘语义。
  const expandBtn = document.getElementById('composer-expand') as HTMLButtonElement | null;
  const applyExpanded = (next: boolean): void => {
    // 仅当模式真实变化才弹 toast(展开按钮/拖拽进入/拖回单行才弹,重渲染不重复)
    const changed = expanded !== next;
    expanded = next;
    composerEl?.classList.toggle('expanded', expanded);
    input.dataset.placeholder = PLACEHOLDER;
    if (changed) {
      showToast(expanded ? '已切换:展开输入' : '已切换:单行输入');
    }
    // 模式切换:收起 → 单行自动增高;展开 → 默认大高度(用户可用顶部指示器再拖)
    if (!expanded) {
      autoResize(input);
    } else {
      input.style.height = '88px';
    }
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
    // 手写(iMessage Digital Touch):触控板/鼠标书写 → 录制 MP4 发送
    const hwBtn = document.getElementById('composer-handwrite');
    hwBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      void import('../utils/handwriting.js').then((m) => m.openHandwritingPanel(chatId, onSent));
    });
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
    const hasMd = MD_RE.test(serializeComposer(input));
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
    // 清空后浏览器常残留 <br>,会挡住 :empty 占位符 → 无文本时重置为纯空
    if (input.textContent === '' && input.innerHTML !== '') input.textContent = '';
    autoResize(input);
    handleMentionInput(input);
    updateSendState();
    // 草稿:输入防抖 500ms 保存(空文本=清除)
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      void call('set_draft', { chatId, text: serializeComposer(input) });
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
    // 整块删除:光标紧邻 tag 时,Backspace/Delete 删整个 span
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (deleteAdjacentTag(input, e.key === 'Backspace' ? 'before' : 'after')) {
        e.preventDefault();
        autoResize(input);
        return;
      }
    }
    // 统一 Enter 发送,Shift+Enter 换行(用户已定),Ctrl/Cmd+Enter 也发送。
    // 建议面板打开时 Enter 已被上方分支拦截为选中建议项。
    if (e.key === 'Enter' && !composing && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      await send(chatId, input, area, onSent);
      return;
    }
    if (e.key === 'Enter' && !composing && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      await send(chatId, input, area, onSent);
      return;
    }
    if (e.key === 'Enter' && !composing && e.shiftKey) {
      e.preventDefault();
      insertTextAtCaret(input, '\n');
      return;
    }
    if (e.key === 'Escape') {
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
      input.textContent = draft;
      autoResize(input);
      updateSendState();
    }
  } catch {}
  input.focus();
}

// contenteditable 取值:序列化为纯文本(替代 input.value)
function getInputText(el: HTMLElement): string {
  return serializeComposer(el);
}
// 自适应高度(收起模式):auto → min(scrollHeight, 120)
function autoResize(el: HTMLElement): void {
  if (expanded) return; // 展开模式高度锁定,不自动增高
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
// 清空(替代 input.value = '')
function clearInput(el: HTMLElement): void {
  el.textContent = '';
  autoResize(el);
  el.focus();
}
// 在光标处插入文本(替代 insertNewline)
function insertTextAtCaret(el: HTMLElement, text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { el.textContent = (el.textContent ?? '') + text; return; }
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const node = document.createTextNode(text);
  r.insertNode(node);
  r.setStartAfter(node);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  autoResize(el);
}
// 输入内容是否为空
function isEmptyInput(el: HTMLElement): boolean {
  return serializeComposer(el).length === 0;
}

// 检测 contenteditable 中光标前的 @xxx / #xxx 模式,弹出对应建议列表
function handleMentionInput(input: HTMLElement): void {
  const text = textBeforeCaret(input);
  // @ 提及:匹配光标前最近的 @ 后跟(可能为空的)标识符
  const atMatch = text.match(/@(\w*)$/);
  if (atMatch) {
    const query = atMatch[1].toLowerCase();
    const members = state.currentMembers.filter((m) => m.name.toLowerCase().includes(query));
    if (members.length > 0) {
      showMentionList(
        members.map((m) => ({ name: m.name, type: 'member' as const })),
        '@',
        input,
      );
    } else {
      closeMentionList();
    }
    return;
  }
  // # 频道引用:匹配光标前最近的 # 后跟(可能为空的)标识符
  const hashMatch = text.match(/#(\w*)$/);
  if (hashMatch) {
    const query = hashMatch[1].toLowerCase();
    const channels = state.channels.filter((c: ChannelDto) => c.name.toLowerCase().includes(query));
    if (channels.length > 0) {
      showMentionList(
        channels.map((c) => ({ name: c.name, type: 'channel' as const })),
        '#',
        input,
      );
    } else {
      closeMentionList();
    }
    return;
  }
  // / 命令:匹配光标前最近的 / 后跟(可能为空的)标识符
  const slashMatch = text.match(/\/(\w*)$/);
  if (slashMatch) {
    const query = slashMatch[1].toLowerCase();
    const cmds = commandSuggestions(query);
    if (cmds.length > 0) {
      showMentionList(cmds, '/', input);
    } else {
      closeMentionList();
    }
    return;
  }
  closeMentionList();
}

// 命令候选:内置静态表 + 后端 list_commands + 插件命令(内置优先,名称去重)
function commandSuggestions(query: string): Array<{ name: string; type: 'command'; description: string }> {
  const pluginMeta = window.__peytchat_commands_meta || {};
  const pluginNames = Object.keys(window.__peytchat_commands || {});
  const merged = new Map<string, string>();
  for (const c of [...remoteCommands, ...BUILTIN_COMMANDS]) {
    if (!merged.has(c.name)) merged.set(c.name, c.description);
  }
  for (const n of pluginNames) {
    if (!merged.has(n)) merged.set(n, pluginMeta[n] || '插件命令');
  }
  return [...merged.entries()]
    .filter(([name]) => name.toLowerCase().includes(query))
    .map(([name, description]) => ({ name, type: 'command' as const, description }));
}

// 渲染建议列表(成员/频道/命令),锚定到光标处
function showMentionList(
  items: Array<{ name: string; type: 'member' | 'channel' | 'command'; description?: string }>,
  kind: '@' | '#' | '/',
  input: HTMLElement,
): void {
  closeMentionList();
  mentionItems = items;
  mentionKind = kind;
  mentionSelectedIndex = 0;
  mentionList = document.createElement('div');
  mentionList.className = 'mention-list';
  // 入场:轻微上浮 + 淡入(材料感),transform-origin 锚定到光标方向
  mentionList.style.transformOrigin = 'left bottom';
  mentionList.style.animation = 'mention-pop 140ms ease-out';
  mentionList.innerHTML = items
    .map((item, i) => {
      const prefix = item.type === 'command' ? '/' : item.type === 'channel' ? '#' : '@';
      const desc = item.description
        ? `<span class="mention-desc">${escapeHtml(item.description)}</span>`
        : '';
      return `<div class="mention-item ${i === 0 ? 'selected' : ''}" data-index="${i}" data-name="${escapeAttr(item.name)}">
        <span class="mention-prefix">${prefix}</span>
        <span class="mention-name">${escapeHtml(item.name)}</span>
        ${desc}
      </div>`;
    })
    .join('');
  // 定位:锚定光标处 rect,列表上浮到光标上方
  const rect = caretRect(input);
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

// 插入选中的建议项(键盘 Enter/Tab 与点击共用):删除已输入的 @query/#query//query,
// 再插入彩色 tag span。(点击建议项可能使输入框失焦,先重新聚焦并恢复光标)
function insertSelectedMention(input: HTMLElement): void {
  if (!mentionList || mentionItems.length === 0 || mentionKind == null) {
    closeMentionList();
    return;
  }
  const item = mentionItems[mentionSelectedIndex];
  if (!item) {
    closeMentionList();
    return;
  }
  // 点击建议项可能 blur → 重新聚焦,把光标放回内容末尾(或上次位置)
  if (document.activeElement !== input) {
    input.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(input);
    r.collapse(false);
    if (sel) { sel.removeAllRanges(); sel.addRange(r); }
  }
  insertTag(input, mentionKind, item.name);
}

// 插入彩色 tag span,光标移到 tag 后;kind: '@'|'#'|'/'
// (先删除已输入的 @query/#query//query,再插 contenteditable=false 的 span +
//  一个普通空格,空格必须在 span 外,serializeComposer 依赖它拼出 "@name "。)
function insertTag(input: HTMLElement, kind: '@' | '#' | '/', name: string): void {
  // 复用 insertSelectedMention 的查询文本删除逻辑(元素边界光标经 walk-down 处理)
  const before = textBeforeCaret(input);
  const re = new RegExp(`\\${kind}(\\w*)$`);
  const m = before.match(re);
  if (m) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      let node = range.startContainer;
      let offset = range.startOffset;
      if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
        let child = node.lastChild;
        while (child) {
          if (child.nodeType === Node.TEXT_NODE) { node = child; offset = (child.textContent ?? '').length; break; }
          if (child.lastChild) { child = child.lastChild; continue; }
          break;
        }
      }
      const back = m[0].length;
      try {
        if (node.nodeType === Node.TEXT_NODE && offset >= back) {
          range.setStart(node, offset - back);
          range.deleteContents();
        }
      } catch { /* 跨节点起点则跳过删除 */ }
    }
  }
  // 创建 tag span(contenteditable=false → 整块不可编辑)
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0);
  const span = document.createElement('span');
  span.className = `mention-tag tag-${kind === '@' ? 'member' : kind === '#' ? 'channel' : 'command'}`;
  span.contentEditable = 'false';
  span.dataset.kind = kind === '@' ? 'member' : kind === '#' ? 'channel' : 'command';
  span.dataset.name = name;
  span.textContent = kind + name;
  r.deleteContents();
  r.insertNode(span);
  // 光标移到 tag 后,补一个【普通空格】作为可编辑文本节点(contract:空格必须在 span 外,用   而非 nbsp)
  const space = document.createTextNode(' ');
  r.setStartAfter(span);
  r.insertNode(space);
  r.setStartAfter(space);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  autoResize(input);
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
}

// 光标前后是否紧邻 mention-tag;是则删除该 tag 并返回 true
function deleteAdjacentTag(input: HTMLElement, dir: 'before' | 'after'): boolean {
  const pt = getCaretPoint();
  if (!pt) return false;
  const { node, offset } = pt;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (dir === 'before' && offset === 0) {
      const prev = previousElementSiblingSkipSpaces(node);
      if (prev && prev.classList.contains('mention-tag')) { prev.remove(); return true; }
    }
    if (dir === 'after' && offset === text.length) {
      const next = nextElementSiblingSkipSpaces(node);
      if (next && next.classList.contains('mention-tag')) { next.remove(); return true; }
    }
    return false;
  }
  const child = node.childNodes[offset];
  if (child && (child as HTMLElement).classList?.contains?.('mention-tag')) {
    (child as HTMLElement).remove();
    return true;
  }
  return false;
}

function previousElementSiblingSkipSpaces(node: Node): HTMLElement | null {
  let n: Node | null = node.previousSibling;
  while (n && n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()) n = n.previousSibling;
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : null;
}
function nextElementSiblingSkipSpaces(node: Node): HTMLElement | null {
  let n: Node | null = node.nextSibling;
  while (n && n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()) n = n.nextSibling;
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : null;
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

async function send(chatId: number, input: HTMLElement, area: HTMLElement, onSent: () => void): Promise<void> {
  const text = serializeComposer(input);
  if (!text) return;

  // Slash 命令分发 — 由插件通过 api.onCommand 注册，如 /ai、/setkey
  if (text.startsWith('/')) {
    const sp = text.indexOf(' ');
    const cmd = sp === -1 ? text.slice(1) : text.slice(1, sp);
    const args = sp === -1 ? '' : text.slice(sp + 1).trim();
    const handler = window.__peytchat_commands?.[cmd];
    if (handler) {
      clearInput(input);
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
  clearInput(input);
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
        input.textContent = text;
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
