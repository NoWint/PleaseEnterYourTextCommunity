import { call } from '../api.js';
import { state } from '../state.js';
import { renderMessage, bindMessageActions, clearReactionsCache, clearPinnedCache, updatePinnedCache } from './message.js';
import { renderComposer } from './composer.js';
import { renderRightDrawer } from '../shell/rightDrawer.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { iconSvg } from '../components/icon.js';
import type { MsgDto, RoleDto, MemberDto, ChannelDto, ChatListItem, AppState } from '../types.js';

interface ChatInfo {
  members: MemberDto[];
}

interface ChannelPin {
  msg_id: number;
  channel_chat_id: number;
}

interface ReplyEventDetail {
  msgId: number;
}

// shell.js (未迁移) 仍读 state.homeMode 等 legacy 字段,state.ts 未声明。
// 用此 cast 保留原 chatView.js 行为(进入 chat 时 homeMode=false),shell.js 迁移后可移除。
type LegacyState = AppState & { homeMode?: boolean };

let loadingEarlier = false;

// Task 12: 当前 chat 的未读消息数,用于在 renderVisibleMessages 中插入"新消息"分隔线。
// 在 renderChatView 中拉取一次(mark_chat_noticed 之前),供后续虚拟化重渲染复用。
// 若拉取失败或为 0,则不渲染分隔线。
let currentChatUnread = 0;

// Task 11: 消息虚拟化常量。
// ITEM_HEIGHT 是估算值(约 60px),实际消息高度不一(含附件/代码块会更高),
// spacer 用此估算值,滚动条位置约略正确但非像素级精准 — SP4 可接受,后续可改实测高度。
const ITEM_HEIGHT = 60;
const BUFFER = 20; // 上下各 buffer 20 条
const VIEWPORT = 30; // 可视区约 30 条

export async function renderChatView(chatId: number): Promise<void> {
  const main = document.getElementById('chat-main');
  if (!main) return;
  // Task 9: 同频道且已有消息且 DOM 已渲染 → 跳过全量重渲染,
  // 保留分页状态(state.messages / messagesOldestId / noMoreMsgs)和 scroll 位置。
  // 新消息由 appendNewMessages 增量追加。
  //
  // 修复:原实现检查 state.currentChatId === chatId,但 channelTree.js 点击时
  // 会先设置 state.currentChatId = id 再调 renderChatView(id),导致永远命中跳过逻辑。
  // 改为检查 DOM 上记录的"最后渲染的 chatId",与 state.currentChatId 解耦。
  const renderedChatId = main.dataset.renderedChatId;
  if (
    renderedChatId === String(chatId) &&
    state.messages.length > 0 &&
    document.getElementById('messages')
  ) {
    return;
  }
  // 切换到不同频道时才重置分页状态(避免每次调用都清空已加载的历史)
  if (state.currentChatId !== chatId) {
    state.messages = [];
    state.messagesOldestId = null;
    state.noMoreMsgs = false;
    // 修复:切换频道时清空 reactions 缓存,避免显示上一个频道的 reactions
    clearReactionsCache();
    // F3:切换频道时清空 pinned 缓存,避免右键菜单显示上一个频道的置顶状态
    clearPinnedCache();
  }
  state.currentChatId = chatId;
  (state as LegacyState).homeMode = false;
  main.dataset.renderedChatId = String(chatId);
  // 加载态
  main.innerHTML = `<div class="spinner"><span></span></div>`;
  try {
    // 拉 roles(用于 role tag 和 @mention)
    if (state.currentWsId != null) {
      try {
        state.roles = await call<RoleDto[]>('list_roles', { workspaceId: state.currentWsId });
      } catch {}
    }
    // 拉频道信息(topic + pins)
    let topic = '';
    let pinCount = 0;
    try { topic = (await call<string>('get_channel_topic', { chatId })) || ''; } catch {}
    try {
      const pins = await call<ChannelPin[]>('get_channel_pins', { chatId });
      pinCount = pins.length;
      // F3:回填 pinned msg_id 集合,供右键菜单显示真实置顶状态
      updatePinnedCache(pins.map((p) => p.msg_id));
    } catch {}
    // Task 13: 拉取 chat_info 并把 members 存入 state.currentMembers,
    // 供 message.js 查找发送者的 avatar/color。失败时清空,避免显示上一个频道的成员。
    try {
      const info = await call<ChatInfo>('get_chat_info', { chatId });
      state.currentMembers = info.members || [];
    } catch {
      state.currentMembers = [];
    }
    // 渲染骨架(含 Task 13 头部按钮:members / pin,触发 detail panel)
    const headerActions = `
      <div class="chat-header-actions">
        <button class="chat-header-btn ${state.detailPanelOpen && state.detailTab === 'members' ? 'active' : ''}" data-action="members" title="成员">
          ${iconSvg('users', { width: 18, height: 18 })}
        </button>
        <button class="chat-header-btn ${state.detailPanelOpen && state.detailTab === 'pin' ? 'active' : ''}" data-action="pin" title="置顶 · ${pinCount}">
          ${iconSvg('pin', { width: 18, height: 18 })}
        </button>
      </div>
    `;
    // 成员数标签:state.currentMembers 来自上面 get_chat_info,失败为空则隐藏
    const memberCount = state.currentMembers?.length || 0;
    const membersTag = memberCount > 0
      ? `<span class="ch-members">${memberCount} 成员</span>`
      : '';
    main.innerHTML = `
      <div class="chat-header">
        <div>
          <span class="ch-title">${escapeHtml(channelName(chatId))}</span>
          ${membersTag}
          <span class="ch-topic">${escapeHtml(topic)}</span>
        </div>
        ${headerActions}
      </div>
      <div class="messages" id="messages"></div>
      <div id="composer-area"></div>
    `;
    // Task 13: 头部按钮 — 切换 detail panel(members/pin)。
    // 同 tab 已展开 → 折叠;否则展开并切到该 tab。同时确保 rightDrawerOpen=true 让抽屉可见。
    const headerEl = main.querySelector<HTMLElement>('.chat-header-actions');
    if (headerEl) {
      headerEl.querySelectorAll<HTMLButtonElement>('.chat-header-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          const tab = action as 'members' | 'pin';
          // 仅在抽屉已展开且停留在同一 tab 时才切换关闭;否则打开对应 tab。
          // 避免启动时 detailPanelOpen=true 但 rightDrawerOpen=false 导致首次点击反而收起。
          if (state.detailPanelOpen && state.detailTab === tab && state.rightDrawerOpen) {
            state.detailPanelOpen = false;
          } else {
            state.detailPanelOpen = true;
            state.detailTab = tab;
            state.rightDrawerOpen = true;
          }
          saveState();
          renderRightDrawer();
        });
      });
    }
    // 分页状态已在函数开头按频道切换判断重置,此处不再重复
    // Task 12: 在 mark_chat_noticed 之前拉取 unread count,
    // 否则 unread 已被清零。失败时为 0,不渲染分隔线。
    try {
      const chats = await call<ChatListItem[]>('get_chatlist');
      const chat = chats.find((c) => c.chat_id === chatId);
      currentChatUnread = chat?.unread || 0;
    } catch {
      currentChatUnread = 0;
    }
    await refreshMessages(chatId);
    renderComposer(chatId, () => refreshMessages(chatId));
    bindScrollListener(chatId);
    try { await call('mark_chat_noticed', { chatId }); } catch {}
    saveState();
    // 监听 message.js reply 按钮 dispatch 的事件
    if (!main.dataset.replyListenerBound) {
      main.dataset.replyListenerBound = 'true';
      main.addEventListener('composer:set-reply', (e: Event) => {
        const detail = (e as CustomEvent<ReplyEventDetail>).detail;
        const msgId = detail.msgId;
        const area = document.getElementById('composer-area');
        if (area) {
          area.dataset.replyTo = String(msgId);
          if (state.currentChatId != null) {
            renderComposer(state.currentChatId, () => refreshMessages(state.currentChatId!));
          }
        }
      });
    }
  } catch (e) {
    main.innerHTML = `<div class="guide-card">加载失败:${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    showToast(e instanceof Error ? e.message : String(e));
  }
}

// Task 9: 增量追加新消息,避免全量重渲染丢失 scroll 位置和已加载的历史。
// 由 shell.js refreshCurrentChat 在收到实时事件(MsgsChanged / IncomingMsg)时调用。
// renderMessage 已在文件顶部静态导入,此处直接复用(无需 require / 动态 import)。
// Task 11: 改为 push 到 state.messages 后调 renderVisibleMessages 重算可视区,
// 不再直接 append DOM(否则新节点会接到 bottom spacer 之后,破坏虚拟化布局)。
export async function appendNewMessages(chatId: number): Promise<void> {
  if (state.currentChatId !== chatId) return;
  const box = document.getElementById('messages');
  if (!box) return; // 频道未渲染,跳过(下次 renderChatView 会全量拉取)
  try {
    // 只拉取最新的 50 条,找出 state.messages 里没有的新消息
    const msgs = await call<MsgDto[]>('get_chat_msgs', { chatId, beforeMsgId: null });
    const existingIds = new Set(state.messages.map((m) => m.msg_id));
    const newMsgs = msgs.filter((m) => !existingIds.has(m.msg_id));
    if (newMsgs.length === 0) return;
    // 记录追加前是否在底部,用于决定是否自动滚到新消息
    const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 50;
    state.messages.push(...newMsgs);
    if (wasAtBottom) {
      // 用户在底部 → 渲染新的底部范围(含新消息),并滚到底
      const end = state.messages.length;
      const start = Math.max(0, end - VIEWPORT - 2 * BUFFER);
      await renderVisibleMessages(box, start, end);
      box.scrollTop = box.scrollHeight;
      // 用户看到了新消息 → 标记已读并触发 MDN,让发送方(delta)显示已读
      try { await call('mark_chat_noticed', { chatId }); } catch {}
    } else {
      // 用户滚在上方 → 仅刷新 spacers / 可视区(scrollTop 未变,可视范围不变)
      const range = getVisibleRange(box.scrollTop, box.clientHeight, ITEM_HEIGHT);
      await renderVisibleMessages(box, range.start, range.end);
    }
  } catch (e) {
    console.error('appendNewMessages failed:', e);
  }
}

async function refreshMessages(chatId: number): Promise<void> {
  let msgs: MsgDto[] = [];
  try {
    msgs = await call<MsgDto[]>('get_chat_msgs', { chatId, beforeMsgId: null });
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
    return;
  }
  state.messages = msgs;
  state.messagesOldestId = msgs.length > 0 ? msgs[0].msg_id : null;
  state.noMoreMsgs = false;
  const box = document.getElementById('messages');
  if (!box) return;
  if (msgs.length === 0) {
    box.innerHTML = `<div class="guide-card">这个频道还没有消息,发第一条吧</div>`;
    return;
  }
  // Task 11: 虚拟化渲染 — 初始展示底部(最新消息)范围,spacers 撑住总高度,
  // bindMessageActions 由 renderVisibleMessages 内部对 temp 容器调用。
  const end = msgs.length;
  const start = Math.max(0, end - VIEWPORT - 2 * BUFFER);
  await renderVisibleMessages(box, start, end);
  box.scrollTop = box.scrollHeight;
}

async function loadEarlier(chatId: number): Promise<void> {
  if (loadingEarlier) return;
  if (state.messagesOldestId == null || state.noMoreMsgs) return;
  loadingEarlier = true;
  let older: MsgDto[] = [];
  try {
    older = await call<MsgDto[]>('get_chat_msgs', { chatId, beforeMsgId: state.messagesOldestId });
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
    loadingEarlier = false;
    return;
  }
  if (state.currentChatId !== chatId) {
    loadingEarlier = false;
    return;
  }
  if (older.length === 0) {
    state.noMoreMsgs = true;
    loadingEarlier = false;
    return;
  }
  const box = document.getElementById('messages');
  if (!box) {
    loadingEarlier = false;
    return;
  }
  const prevTop = box.scrollTop;
  const prevCount = state.messages.length;
  state.messages = [...older, ...state.messages];
  state.messagesOldestId = older[0].msg_id;
  state.noMoreMsgs = older.length < 50;
  // Task 11: 虚拟化下用估算 ITEM_HEIGHT 维持 scroll 位置。
  // prepended N 条 → 用户原看消息下移 N 条 → 新 scrollTop ≈ prevTop + N*ITEM_HEIGHT。
  // 先按目标 scrollTop 算可视范围,渲染后再赋值(避免浏览器按旧 scrollHeight 钳位)。
  const addedCount = state.messages.length - prevCount;
  const targetScrollTop = prevTop + addedCount * ITEM_HEIGHT;
  const range = getVisibleRange(targetScrollTop, box.clientHeight, ITEM_HEIGHT);
  await renderVisibleMessages(box, range.start, range.end);
  box.scrollTop = targetScrollTop;
  loadingEarlier = false;
}

// Task 11: 虚拟化 — 只渲染 scrollTop ± (BUFFER + VIEWPORT/2) 范围的消息,
// 上下用 spacer div 撑住总高度(估算 ITEM_HEIGHT),保持滚动条约略正确。
function getVisibleRange(scrollTop: number, clientHeight: number, itemHeight: number): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - BUFFER);
  const end = Math.min(state.messages.length, start + VIEWPORT + 2 * BUFFER);
  return { start, end };
}

// Task 11: 渲染 [start, end) 范围消息 + 上下 spacer。
// renderMessage 返回 HTML 字符串(Task 9 已确认),沿用 temp-container 解析模式 +
// 仅对本次渲染节点调用 bindMessageActions(box 清空后旧绑定随节点销毁,无需重复绑定)。
// 日期分隔线:若 visible 首条日期与上一条(state.messages[start-1])不同,补一条顶部 divider。
// Task 12: 若未读分隔位置(dividerIndex = state.messages.length - currentChatUnread)
// 落在 [start, end) 内,在对应消息前插入"新消息"分隔线。divider 不计入 visible 消息计数,
// 是消息之间的额外 DOM 元素。若 dividerIndex 在可视范围外则跳过(用户滚动到时再出现)。
//
// Task 14 修复:原实现在 await renderMessage 之前就 `box.innerHTML = ""`,
// 浏览器在 await 期间绘制空容器 + 仅 spacerTop → 用户看到闪烁;
// 且清空后 scrollTop 被钳位为 0,新内容渲染后未恢复 → 跳到最早消息。
// 现改为:先在 off-DOM temp 中构建完整内容(含 awaits),再同步原子替换 box 子节点,
// 并在替换前后保存/恢复 scrollTop。
async function renderVisibleMessages(box: HTMLElement, start: number, end: number): Promise<void> {
  const visible = state.messages.slice(start, end);
  const savedScrollTop = box.scrollTop;

  // 增量更新:按 data-msg 复用已存在节点,只新建缺失的,越界的随整体替换移除。
  // 滚动时大多数消息已在 DOM,复用避免重建 → 消除闪动 (apple-design §11)。
  const existing = new Map<number, HTMLElement>();
  for (const el of Array.from(box.children)) {
    const msgId = (el as HTMLElement).dataset?.msg;
    if (msgId) existing.set(Number(msgId), el as HTMLElement);
  }

  const dividerIndex = (currentChatUnread > 0 && state.messages.length >= currentChatUnread)
    ? state.messages.length - currentChatUnread
    : -1;

  // 在 off-DOM temp 组装新序列:spacerTop + 分隔线 + 消息节点(spacerBottom 末尾)。
  // 已存在的消息节点直接移动(不重建),缺失的新建。
  const temp = document.createElement('div');
  const spacerTop = document.createElement('div');
  spacerTop.style.height = (start * ITEM_HEIGHT) + 'px';
  temp.appendChild(spacerTop);

  let prevDate: string | null = null;
  if (start > 0 && state.messages.length > 0) {
    prevDate = formatDate(new Date(state.messages[start - 1].ts * 1000));
  }

  for (let i = 0; i < visible.length; i++) {
    const absIdx = start + i;
    const m = visible[i];
    if (absIdx === dividerIndex) {
      const d = document.createElement('div');
      d.className = 'msg-unread-divider';
      d.innerHTML = `<span class="divider-line"></span><span class="divider-label">新消息</span><span class="divider-line"></span>`;
      temp.appendChild(d);
    }
    const dateStr = formatDate(new Date(m.ts * 1000));
    if (dateStr !== prevDate) {
      const d = document.createElement('div');
      d.className = 'msg-date-divider';
      d.textContent = dateStr;
      temp.appendChild(d);
      prevDate = dateStr;
    }
    const existingEl = existing.get(m.msg_id);
    if (existingEl) {
      // 复用已存在节点:移动而非重建,消除滚动闪动
      temp.appendChild(existingEl);
    } else {
      const isPending = m.state === 'pending' || m.state === 'failed';
      const prevIsSame = (visible[i - 1]?.from_id === m.from_id) && !isPending
        && (visible[i - 1]?.state !== 'pending' && visible[i - 1]?.state !== 'failed')
        && formatDate(new Date((visible[i - 1]?.ts ?? 0) * 1000)) === dateStr
        && (absIdx - 1) !== dividerIndex;
      const nextIsSame = (visible[i + 1]?.from_id === m.from_id) && !isPending
        && (visible[i + 1]?.state !== 'pending' && visible[i + 1]?.state !== 'failed')
        && formatDate(new Date((visible[i + 1]?.ts ?? 0) * 1000)) === dateStr
        && (absIdx + 1) !== dividerIndex;
      const role: 'solo' | 'first' | 'middle' | 'last' =
        !prevIsSame && !nextIsSame ? 'solo'
        : !prevIsSame && nextIsSame ? 'first'
        : prevIsSame && !nextIsSame ? 'last'
        : 'middle';
      const frag = document.createElement('div');
      frag.innerHTML = await renderMessage(m, role);
      const node = frag.firstElementChild as HTMLElement;
      if (node) {
        bindMessageActions(frag);
        // 新建消息:入场动画(pop-in)。滚动复用的节点不带此类,不重复动画。
        node.classList.add('msg-enter');
        temp.appendChild(node);
      }
    }
  }

  const spacerBottom = document.createElement('div');
  spacerBottom.style.height = ((state.messages.length - end) * ITEM_HEIGHT) + 'px';
  temp.appendChild(spacerBottom);

  // 原子替换:temp 新序列整体替换 box 内容(同一 tick,浏览器只绘制一次)
  box.innerHTML = '';
  while (temp.firstChild) box.appendChild(temp.firstChild);

  if (box.scrollTop !== savedScrollTop) {
    box.scrollTop = savedScrollTop;
  }
}

function formatDate(d: Date): string {
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 修复:composer.js 乐观更新时不能直接 insertAdjacentHTML 到 #messages,
// 因为虚拟化下 #messages 的最后一个子元素是 spacerBottom,append 会把临时消息
// 插到 spacerBottom 之后(不可见或位置错误)。
// 改为:composer 调用此函数,push 到 state.messages 后触发虚拟化重渲染底部范围。
export function appendOptimisticMessage(tmpMsg: MsgDto): void {
  const box = document.getElementById('messages');
  if (!box) return;
  state.messages.push(tmpMsg);
  // 渲染新的底部范围(含新消息),并滚到底
  const end = state.messages.length;
  const start = Math.max(0, end - VIEWPORT - 2 * BUFFER);
  void renderVisibleMessages(box, start, end).then(() => {
    box.scrollTop = box.scrollHeight;
  });
}

// 重渲染当前可视区(读最新 reactionsCache/状态),用于反应/消息状态实时更新。
export function refreshVisibleMessages(): void {
  const box = document.getElementById('messages');
  if (!box || state.messages.length === 0) return;
  const range = getVisibleRange(box.scrollTop, box.clientHeight, ITEM_HEIGHT);
  void renderVisibleMessages(box, range.start, range.end);
}

function bindScrollListener(chatId: number): void {
  const box = document.getElementById('messages');
  if (!box) return;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  box.addEventListener('scroll', () => {
    // 顶部触发分页(loadEarlier 内部有 loadingEarlier / noMoreMsgs 守卫)
    if (box.scrollTop === 0) {
      void loadEarlier(chatId);
    }
    // Task 11: 100ms debounce 重算可视区。fire-and-forget,错误吞掉避免 unhandledrejection。
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const range = getVisibleRange(box.scrollTop, box.clientHeight, ITEM_HEIGHT);
      renderVisibleMessages(box, range.start, range.end).catch(() => {});
    }, 100);
  });
}

function channelName(chatId: number): string {
  const ch = state.channels.find((c: ChannelDto) => c.chat_id === chatId);
  return ch ? ch.name : `#${chatId}`;
}

function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
