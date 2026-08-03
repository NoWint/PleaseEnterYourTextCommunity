import { call } from '../api.js';
import { state } from '../state.js';
import { renderMessage, bindMessageActions, clearReactionsCache, clearPinnedCache, updatePinnedCache, type GroupRole } from './message.js';
import { renderComposer } from './composer.js';
import { renderRightDrawer } from '../shell/rightDrawer.js';
import { saveState } from '../persist.js';
import { ui } from '../components/ui.js';
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

// appendNewMessages 并发守卫:MsgsChanged 和 IncomingMsg 会同时触发 refreshCurrentChat
// → 两个并发 appendNewMessages。若无守卫,两者读同一份 state.messages 都判定"有新消息"
// 然后都 push → 相同消息出现两条(state.messages 出现重复 msg_id → 滚动时增量渲染错乱卡顿)。
let appendInFlight = false;

// 并发守卫:递增 token。renderVisibleMessages 里 await 会让多个调用交错,
// 后发的更新看到的前置调用若已过时(stale),会覆盖 DOM。
// 每次新调用递增 renderToken 并捕获当前值,await 后仅当 token 仍是本次调用才写入 DOM。
let renderToken = 0;

// Task 12: 当前 chat 的未读消息数,用于在 renderVisibleMessages 中插入"新消息"分隔线。
// 在 renderChatView 中拉取一次(mark_chat_noticed 之前),供后续虚拟化重渲染复用。
// 若拉取失败或为 0,则不渲染分隔线。
let currentChatUnread = 0;

// 当前 chat 是否为 self-talk(保存的消息/设备聊天):在 renderChatView 拉 chatlist 时填充,
// channelName 据此显示「保存的消息」而非 #id。
let currentChatIsSelfTalk = false;

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
  main.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'ui-spinner-wrap';
  wrap.appendChild(ui.spinner());
  main.appendChild(wrap);
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
        <div class="chat-header-actions"></div>
      </div>
      <div class="messages" id="messages"></div>
      <div id="composer-area"></div>
    `;
    // Task 13: 头部按钮 — 切换 detail panel(members/pin)。
    // 同 tab 已展开 → 折叠;否则展开并切到该 tab。同时确保 rightDrawerOpen=true 让抽屉可见。
    const headerEl = main.querySelector<HTMLElement>('.chat-header-actions');
    if (headerEl) {
      const membersBtn = ui.iconButton({ icon: 'users', title: '成员' });
      const pinBtn = ui.iconButton({ icon: 'pin', title: `置顶 · ${pinCount}` });
      const toggle = (tab: 'members' | 'pin'): void => {
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
        membersBtn.classList.toggle('active', state.detailPanelOpen && state.detailTab === 'members');
        pinBtn.classList.toggle('active', state.detailPanelOpen && state.detailTab === 'pin');
      };
      membersBtn.addEventListener('click', () => toggle('members'));
      pinBtn.addEventListener('click', () => toggle('pin'));
      if (state.detailPanelOpen && state.detailTab === 'members') membersBtn.classList.add('active');
      if (state.detailPanelOpen && state.detailTab === 'pin') pinBtn.classList.add('active');
      // Delta 批次 2:会话内搜索 + Gallery 相册按钮
      const searchBtn = ui.iconButton({ icon: 'search', title: '会话内搜索' });
      searchBtn.addEventListener('click', () => {
        void import('../components/search.js').then(({ openChatSearch }) => openChatSearch(chatId));
      });
      const galleryBtn = ui.iconButton({ icon: 'image', title: '媒体相册' });
      galleryBtn.addEventListener('click', () => {
        void import('../components/gallery.js').then(({ openGallery }) => openGallery(chatId));
      });
      headerEl.append(searchBtn, galleryBtn, membersBtn, pinBtn);
    }
    // 分页状态已在函数开头按频道切换判断重置,此处不再重复
    // Task 12: 在 mark_chat_noticed 之前拉取 unread count,
    // 否则 unread 已被清零。失败时为 0,不渲染分隔线。
    try {
      const chats = await call<ChatListItem[]>('get_chatlist');
      const chat = chats.find((c) => c.chat_id === chatId);
      currentChatUnread = chat?.unread || 0;
      currentChatIsSelfTalk = chat?.is_self_talk === true;
    } catch {
      currentChatUnread = 0;
      currentChatIsSelfTalk = false;
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
    ui.toast(e instanceof Error ? e.message : String(e));
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
  // 并发守卫:已有一次在跑则跳过本次(下次事件会再触发,不丢消息)。
  // 否则双事件并发会重复 push 相同消息。
  if (appendInFlight) return;
  appendInFlight = true;
  try {
    // 只拉取最新的 50 条,找出 state.messages 里没有的新消息
    const msgs = await call<MsgDto[]>('get_chat_msgs', { chatId, beforeMsgId: null });
    const existingIds = new Set(state.messages.map((m) => m.msg_id));
    // 真实消息到达时,移除本地乐观 tmp 消息(tmp_ 前缀),避免「乐观+真实」两条相同内容
    // 并存显示。乐观 tmp 由 composer 生成,msg_id 是 tmp_<ts> 字符串,与真实数字 id 不同,
    // 直接 push 真实消息会造成视觉上的重复(且 onSent 的 refreshMessages 可能晚于 MsgsChanged)。
    if (msgs.some((m) => !existingIds.has(m.msg_id))) {
      state.messages = state.messages.filter((m) => typeof m.msg_id !== 'string' || !String(m.msg_id).startsWith('tmp_'));
    }
    const newMsgs = msgs.filter((m) => !existingIds.has(m.msg_id));
    if (newMsgs.length === 0) return;
    // 记录追加前是否在底部,用于决定是否自动滚到新消息
    const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 50;
    state.messages.push(...newMsgs);
    // 防御性去重:历史遗留的重复 msg_id 会导致滚动增量渲染反复重建 → 卡顿。
    // 按 msg_id 去重(保留首次出现的)。
    const seen = new Set<string | number>();
    state.messages = state.messages.filter((m) => {
      if (seen.has(m.msg_id)) return false;
      seen.add(m.msg_id);
      return true;
    });
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
  } finally {
    appendInFlight = false;
  }
}

async function refreshMessages(chatId: number): Promise<void> {
  let msgs: MsgDto[] = [];
  try {
    msgs = await call<MsgDto[]>('get_chat_msgs', { chatId, beforeMsgId: null });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  state.messages = msgs;
  state.messagesOldestId = msgs.length > 0 ? msgs[0].msg_id : null;
  state.noMoreMsgs = false;
  const box = document.getElementById('messages');
  if (!box) return;
  if (msgs.length === 0) {
    box.appendChild(ui.empty('这个频道还没有消息,发第一条吧'));
    return;
  }
  // 增量更新依赖两个常驻 spacer 撑住总高度(scrollTop 由浏览器维护),
  // 初始渲染前先确保它们存在并设置高度。
  ensureSpacers(box, 0, msgs.length, msgs.length);
  // Task 11: 虚拟化渲染 — 初始展示底部(最新消息)范围。
  const end = msgs.length;
  const start = Math.max(0, end - VIEWPORT - 2 * BUFFER);
  await renderVisibleMessages(box, start, end);
  box.scrollTop = box.scrollHeight;
}

// 确保 box 首/末各有一个 spacer(spacerTop / spacerBottom),并设置估算高度。
// 增量更新全程保持这两个节点常驻,scrollHeight 才恒定。
function ensureSpacers(box: HTMLElement, start: number, end: number, total: number): void {
  let top = box.querySelector<HTMLElement>('.msg-spacer-top');
  if (!top) {
    top = document.createElement('div');
    top.className = 'msg-spacer-top';
    box.insertBefore(top, box.firstChild);
  }
  let bottom = box.querySelector<HTMLElement>('.msg-spacer-bottom');
  if (!bottom) {
    bottom = document.createElement('div');
    bottom.className = 'msg-spacer-bottom';
    box.appendChild(bottom);
  }
  top.style.height = (start * ITEM_HEIGHT) + 'px';
  bottom.style.height = ((total - end) * ITEM_HEIGHT) + 'px';
}

async function loadEarlier(chatId: number): Promise<void> {
  if (loadingEarlier) return;
  if (state.messagesOldestId == null || state.noMoreMsgs) return;
  loadingEarlier = true;
  let older: MsgDto[] = [];
  try {
    older = await call<MsgDto[]>('get_chat_msgs', { chatId, beforeMsgId: state.messagesOldestId });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
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
// 虚拟化渲染核心。增量更新:滚动时只把【滚出窗口】的节点从 DOM 移除、
// 把【滚进窗口】的插入到正确位置,窗口内已存在的节点一个都不动。
// 这样 scrollHeight 全程不变,scrollTop 完全由浏览器维护 —— 不需要任何手动
// 恢复 scrollTop,也就从根本上避免"渲染完被拉回旧位置"(整体替换的必然代价)。
async function renderVisibleMessages(box: HTMLElement, start: number, end: number): Promise<void> {
  // 并发守卫:本次渲染捕获递增 token,await 期间若有更新的调用推进 token,
  // 则本次(过时)直接放弃写入,避免 stale 数据覆盖 DOM。
  const token = ++renderToken;
  const visible = state.messages.slice(start, end);

  const dividerIndex = (currentChatUnread > 0 && state.messages.length >= currentChatUnread)
    ? state.messages.length - currentChatUnread
    : -1;

  // 现状盘点:box 里已有的所有带 data-msg 的节点,按 data-msg → element 记录。
  const existing = new Map<number, HTMLElement>();
  for (const el of Array.from(box.children)) {
    const msgId = (el as HTMLElement).dataset?.msg;
    if (msgId) existing.set(Number(msgId), el as HTMLElement);
  }

  // 锚点:新节点插入到哪个节点之前。spacerTop 永远在最前、spacerBottom 永远在最后,
  // 所以初值设为 spacerBottom —— 新节点插在它之前(append 到滚动条内)。
  // 遍历过程中 anchor 持续推进,保持消息顺序。
  let anchor: HTMLElement | null = box.querySelector<HTMLElement>('.msg-spacer-bottom');

  // 依次保证 [start, end) 每条消息都在 DOM 中且顺序正确。
  let prevDate: string | null = null;
  if (start > 0 && state.messages.length > 0) {
    prevDate = formatDate(new Date(state.messages[start - 1].ts * 1000));
  }

  for (let i = 0; i < visible.length; i++) {
    const absIdx = start + i;
    const m = visible[i];
    const dateStr = formatDate(new Date(m.ts * 1000));

    // 需要插一个日期分隔线吗?找它是否已在 DOM(用 data-date 标记)。
    if (dateStr !== prevDate) {
      anchor = ensureDivider(box, dateStr, anchor);
      prevDate = dateStr;
    }
    if (absIdx === dividerIndex) {
      anchor = ensureDivider(box, '新消息', anchor, 'msg-unread-divider');
    }

    const existingEl = existing.get(m.msg_id);
    if (existingEl) {
      // 已在 DOM:只修正分组角色,位置不动(浏览器按文档流天然对)。
      applyGroupRole(m, absIdx, dividerIndex, dateStr, existingEl);
      anchor = existingEl.nextElementSibling as HTMLElement | null;
    } else {
      // 不在 DOM:新建并插入到 anchor 之前。
      const role = computeGroupRole(m, absIdx, dividerIndex, dateStr);
      const frag = document.createElement('div');
      frag.innerHTML = await renderMessage(m, role);
      const node = frag.firstElementChild as HTMLElement;
      if (node) {
        bindMessageActions(frag);
        node.classList.add('msg-enter');
        node.addEventListener('animationend', () => node.classList.remove('msg-enter'), { once: true });
        box.insertBefore(node, anchor);
        anchor = node.nextElementSibling as HTMLElement | null;
      }
    }
  }

  // await 之后先检查并发 token:若已有更新的渲染,放弃本次(避免 stale 覆盖)
  if (token !== renderToken) return;

  // 移除滚出窗口的节点:遍历 box 子元素,把带 data-msg 但不在 visible 集合里的删掉。
  // 注意:不删 spacerTop/spacerBottom/日期分隔线/未读分隔线(它们由下轮渲染负责)。
  const keep = new Set(visible.map((m) => m.msg_id));
  for (const el of Array.from(box.children)) {
    const msgId = (el as HTMLElement).dataset?.msg;
    if (msgId && !keep.has(Number(msgId))) {
      el.remove();
    }
  }

  // 更新两个 spacer 的高度(反映 [0,start) 与 [end,total) 的估算高度)。
  // spacerTop 必为 box 首子元素、spacerBottom 必为末子元素。
  const spacerTop = box.querySelector<HTMLElement>('.msg-spacer-top');
  const spacerBottom = box.querySelector<HTMLElement>('.msg-spacer-bottom');
  if (spacerTop) spacerTop.style.height = (start * ITEM_HEIGHT) + 'px';
  if (spacerBottom) spacerBottom.style.height = ((state.messages.length - end) * ITEM_HEIGHT) + 'px';

  // 注意:不手动恢复 scrollTop —— scrollHeight 全程没变(增量更新),浏览器位置自然正确。
}

// 确保某个日期/未读分隔线节点在 DOM 中,返回其 nextElementSibling 作为下一个插入锚点。
// 已存在则复用,不存在则新建并插到 anchor 之前。
function ensureDivider(
  box: HTMLElement,
  key: string,
  anchor: HTMLElement | null,
  className = 'msg-date-divider',
): HTMLElement | null {
  const keyAttr = className === 'msg-date-divider' ? 'data-date' : 'data-unread';
  const existingDiv = box.querySelector<HTMLElement>(`.${className}[${keyAttr}="${CSS.escape(key)}"]`);
  let div: HTMLElement;
  if (existingDiv) {
    div = existingDiv;
  } else {
    div = document.createElement('div');
    div.className = className;
    div.setAttribute(keyAttr, key);
    if (className === 'msg-date-divider') {
      div.textContent = key;
    } else {
      div.innerHTML = `<span class="divider-line"></span><span class="divider-label">新消息</span><span class="divider-line"></span>`;
    }
    box.insertBefore(div, anchor);
  }
  return div.nextElementSibling as HTMLElement | null;
}

// 计算消息的全局分组角色。
// 【关键】必须用全局 state.messages[absIdx±1] 判断邻居,不能看 visible 切片——
// 切片只含窗口内消息,窗口边界消息的切片邻居是 undefined,导致 role 在
// middle/first/last 间横跳 → 气泡 collapsed 切换、padding-left 变化、meta 行距
// 变化 → 滚动时消息体左右异动 + 内部文字上下异动。
function computeGroupRole(m: MsgDto, absIdx: number, dividerIndex: number, dateStr: string): GroupRole {
  const isPending = m.state === 'pending' || m.state === 'failed';
  const prev = state.messages[absIdx - 1];
  const next = state.messages[absIdx + 1];
  const prevIsSame = !!prev && prev.from_id === m.from_id && !isPending
    && prev.state !== 'pending' && prev.state !== 'failed'
    && formatDate(new Date(prev.ts * 1000)) === dateStr
    && (absIdx - 1) !== dividerIndex;
  const nextIsSame = !!next && next.from_id === m.from_id && !isPending
    && next.state !== 'pending' && next.state !== 'failed'
    && formatDate(new Date(next.ts * 1000)) === dateStr
    && (absIdx + 1) !== dividerIndex;
  return !prevIsSame && !nextIsSame ? 'solo'
    : !prevIsSame && nextIsSame ? 'first'
    : prevIsSame && !nextIsSame ? 'last'
    : 'middle';
}

// 修正复用节点的分组角色:邻居变化后(追加/前插/分隔线移入),边界气泡的
// msg-group-* / collapsed 状态会过期。只在角色不同时重写类,避免抖动。
function applyGroupRole(
  m: MsgDto,
  absIdx: number,
  dividerIndex: number,
  dateStr: string,
  el: HTMLElement,
): void {
  const role = computeGroupRole(m, absIdx, dividerIndex, dateStr);

  for (const r of ['solo', 'first', 'middle', 'last'] as const) {
    el.classList.remove(`msg-group-${r}`, 'collapsed');
  }
  if (role !== 'solo') el.classList.add('collapsed');
  el.classList.add(`msg-group-${role}`);
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

// 跳转到指定消息:确保 chat 已渲染,滚动到目标消息(虚拟化下按索引估算位置),
// 并临时高亮。供 search.ts 消息结果点击调用。
export async function jumpToMessage(msgId: number): Promise<void> {
  if (state.currentChatId == null) return;
  const chatId = state.currentChatId;
  const box = document.getElementById('messages');
  if (!box) return;
  // 确保消息已加载(state.messages 含目标);未渲染则渲染 chat
  if (!document.getElementById('messages')?.children.length) {
    await renderChatView(chatId);
  }
  const idx = state.messages.findIndex((m) => m.msg_id === msgId);
  if (idx < 0) {
    // 目标不在已加载消息里(如更早的历史),尝试刷新拉全量
    await refreshMessages(chatId);
    const idx2 = state.messages.findIndex((m) => m.msg_id === msgId);
    if (idx2 < 0) return;
    await scrollToMsgIndex(idx2, box);
    return;
  }
  await scrollToMsgIndex(idx, box);
}

// 按消息索引滚动可视区(虚拟化:估算 scrollTop),渲染后高亮目标节点
async function scrollToMsgIndex(idx: number, box: HTMLElement): Promise<void> {
  const targetTop = Math.max(0, idx * ITEM_HEIGHT - 100);
  box.scrollTop = targetTop;
  const range = getVisibleRange(targetTop, box.clientHeight, ITEM_HEIGHT);
  await renderVisibleMessages(box, range.start, range.end);
  // 目标消息可能在渲染窗口内;若不在,再渲染覆盖它的窗口
  const msgId = state.messages[idx]?.msg_id;
  if (msgId != null) {
    const el = box.querySelector(`[data-msg="${msgId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (el as HTMLElement).style.background = 'var(--active)';
      setTimeout(() => {
        (el as HTMLElement).style.background = '';
      }, 2000);
    }
  }
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
  // self-talk(保存的消息/设备聊天)不在 workspace channels 里,单独给友好名称
  if (currentChatIsSelfTalk) return '保存的消息';
  const ch = state.channels.find((c: ChannelDto) => c.chat_id === chatId);
  return ch ? ch.name : `#${chatId}`;
}

function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
