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

// 并发守卫:递增 token。renderAllMessages 里 await 会让多个调用交错,
// 后发的更新看到的前置调用若已过时(stale),会覆盖 DOM。
// 每次新调用递增 renderToken 并捕获当前值,await 后仅当 token 仍是本次调用才写入 DOM。
let renderToken = 0;

// Task 12: 当前 chat 的未读消息数,用于渲染"新消息"分隔线。
// 在 renderChatView 中拉取一次(mark_chat_noticed 之前)。若拉取失败或为 0,则不渲染。
let currentChatUnread = 0;

// 当前 chat 是否为 self-talk(保存的消息/设备聊天):在 renderChatView 拉 chatlist 时填充,
// channelName 据此显示「保存的消息」而非 #id。
let currentChatIsSelfTalk = false;

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
    // 单聊不显示 "N 成员"(对应用户名已在标题,气泡内也无 name/role tag)
    const membersTag = memberCount > 0 && state.currentChatIsGroup
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
      // 群聊标记存 state(message.ts 渲染气泡时也读):单聊隐藏 name/role tag
      state.currentChatIsGroup = chat?.is_group === true;
    } catch {
      currentChatUnread = 0;
      currentChatIsSelfTalk = false;
      state.currentChatIsGroup = false;
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

// Task 9: 增量追加新消息。Delta 式全量 DOM 下,新消息到达时:
// - 用户在底部 → 追加 DOM 节点并保持贴底
// - 用户在上方 → 不打扰(仅更新 state,下次操作自然看到)
// 由 shell.js refreshCurrentChat 在收到实时事件(MsgsChanged / IncomingMsg)时调用。
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
    // 并存显示。
    if (msgs.some((m) => !existingIds.has(m.msg_id))) {
      state.messages = state.messages.filter((m) => typeof m.msg_id !== 'string' || !String(m.msg_id).startsWith('tmp_'));
    }
    const newMsgs = msgs.filter((m) => !existingIds.has(m.msg_id));
    if (newMsgs.length === 0) return;
    // 记录追加前是否在底部,用于决定是否自动滚到新消息
    const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 50;
    state.messages.push(...newMsgs);
    // 防御性去重
    const seen = new Set<string | number>();
    state.messages = state.messages.filter((m) => {
      if (seen.has(m.msg_id)) return false;
      seen.add(m.msg_id);
      return true;
    });
    // 全量渲染(复用已有节点,只新建新消息),浏览器原生滚动
    await renderAllMessages(box);
    if (wasAtBottom) {
      box.scrollTop = box.scrollHeight;
      // 用户看到了新消息 → 标记已读并触发 MDN,让发送方(delta)显示已读
      try { await call('mark_chat_noticed', { chatId }); } catch {}
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
  // Delta 式全量渲染:所有消息都是真实 DOM 节点,浏览器原生管理滚动
  // (scrollHeight = 真实高度,scrollTop 天然稳定,零手动补偿)。
  await renderAllMessages(box);
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
  const prevHeight = box.scrollHeight;
  state.messages = [...older, ...state.messages];
  state.messagesOldestId = older[0].msg_id;
  state.noMoreMsgs = older.length < 50;
  // Delta 式全量渲染:prepend 更早消息后整体重渲染,保持用户视口不变。
  // box.innerHTML='' 会清掉 scrollTop,渲染后补偿 scrollHeight 增量(顶部插入的高度)。
  await renderAllMessages(box);
  const heightDelta = box.scrollHeight - prevHeight;
  box.scrollTop = prevTop + heightDelta;
  loadingEarlier = false;
}

// Delta 式全量渲染:所有已加载消息都是真实 DOM 节点,浏览器原生管理滚动。
// scrollHeight = 真实内容高度,scrollTop 天然稳定 —— 不需要 spacer 估算、不需要
// 手动补偿,从根源消除闪烁循环与微动。数据量可控(get_chat_msgs 每次 50 条分页,
// loadEarlier 累积到几百条,全量 DOM 渲染完全可行,Delta 桌面端即此方案)。
//
// 增量优化:已存在的消息节点复用(不重建),只新建缺失的。日期分隔线/未读分隔线
// 通过 data-* 标记复用。全量重渲染(频道切换)时 box 内容整体重建。
async function renderAllMessages(box: HTMLElement): Promise<void> {
  // 并发守卫:多次渲染交错时,只有最后一次写入 DOM
  const token = ++renderToken;
  const msgs = state.messages;
  // 渲染前记录:box.innerHTML='' 会清掉 scrollTop,渲染后按 scrollHeight 增量补偿,
  // 保持视口内容稳定(全量 DOM 下 scrollHeight 是真实内容高度,补偿即真实位移)。
  const prevScrollTop = box.scrollTop;
  const prevScrollHeight = box.scrollHeight;

  const dividerIndex = (currentChatUnread > 0 && msgs.length >= currentChatUnread)
    ? msgs.length - currentChatUnread
    : -1;

  // 复用已有节点:按 data-msg 索引,避免全量重建
  const existing = new Map<number, HTMLElement>();
  for (const el of Array.from(box.children)) {
    const msgId = (el as HTMLElement).dataset?.msg;
    if (msgId) existing.set(Number(msgId), el as HTMLElement);
  }

  // 当前 DOM 里已有的日期/未读分隔线(复用)
  const existingDividers = new Set<string>();
  box.querySelectorAll<HTMLElement>('.msg-date-divider').forEach((d) => existingDividers.add(`d:${d.dataset.date}`));
  box.querySelectorAll<HTMLElement>('.msg-unread-divider').forEach((d) => existingDividers.add(`u:${d.dataset.unread}`));

  // 组装新序列:日期分隔线 + 消息 + 未读分隔线,顺序与 state.messages 一致
  const frag = document.createDocumentFragment();
  let prevDate: string | null = null;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const dateStr = formatDate(new Date(m.ts * 1000));

    // 日期分隔线(仅在需要时插入,复用已存在的)
    if (dateStr !== prevDate) {
      const key = `d:${dateStr}`;
      if (!existingDividers.has(key)) {
        const d = document.createElement('div');
        d.className = 'msg-date-divider';
        d.dataset.date = dateStr;
        d.textContent = dateStr;
        frag.appendChild(d);
        existingDividers.add(key);
      }
      prevDate = dateStr;
    }

    // 未读分隔线
    if (i === dividerIndex) {
      const key = `u:${dividerIndex}`;
      if (!existingDividers.has(key)) {
        const d = document.createElement('div');
        d.className = 'msg-unread-divider';
        d.dataset.unread = String(dividerIndex);
        d.innerHTML = `<span class="divider-line"></span><span class="divider-label">新消息</span><span class="divider-line"></span>`;
        frag.appendChild(d);
        existingDividers.add(key);
      }
    }

    const existingEl = existing.get(m.msg_id);
    if (existingEl) {
      // 复用:修正分组角色(相邻同人折叠),位置由文档流决定
      applyGroupRole(m, i, dividerIndex, dateStr, existingEl);
      frag.appendChild(existingEl);
    } else {
      // 新建消息
      const role = computeGroupRole(m, i, dividerIndex, dateStr);
      const msgFrag = document.createElement('div');
      msgFrag.innerHTML = await renderMessage(m, role);
      const node = msgFrag.firstElementChild as HTMLElement;
      if (node) {
        bindMessageActions(msgFrag);
        node.classList.add('msg-enter');
        node.addEventListener('animationend', () => node.classList.remove('msg-enter'), { once: true });
        frag.appendChild(node);
      }
    }
  }

  // await 之后检查并发 token:若有更新的渲染,放弃本次
  if (token !== renderToken) return;

  // 原子替换:新序列整体替换 box 内容。浏览器一次绘制。
  box.innerHTML = '';
  box.appendChild(frag);

  // scrollTop 补偿:box.innerHTML='' 清掉了 scrollTop,按 scrollHeight 增量补偿,
  // 保持视口内容稳定(全量 DOM 下 scrollHeight 是真实高度,增量即真实位移)。
  // 调用方若要贴底(如 appendNewMessages 底部路径),在此之后自行设 scrollTop=scrollHeight。
  const heightDelta = box.scrollHeight - prevScrollHeight;
  const target = Math.max(0, prevScrollTop + heightDelta);
  if (Math.abs(target - box.scrollTop) > 0.5) {
    box.scrollTop = target;
  }
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

// composer 乐观消息:push 后全量渲染并滚到底(DOM 式,直接 append 也安全,
// 但用 renderAllMessages 统一处理日期/分组/未读分隔线)。
export function appendOptimisticMessage(tmpMsg: MsgDto): void {
  const box = document.getElementById('messages');
  if (!box) return;
  state.messages.push(tmpMsg);
  void renderAllMessages(box).then(() => {
    box.scrollTop = box.scrollHeight;
  });
}

// 跳转到指定消息:全量 DOM 下所有消息都在,直接找节点滚动并高亮。
// 供 search.ts 消息结果点击调用。
export async function jumpToMessage(msgId: number): Promise<void> {
  if (state.currentChatId == null) return;
  const chatId = state.currentChatId;
  const box = document.getElementById('messages');
  if (!box) return;
  // 确保消息已加载;未渲染则渲染 chat
  if (!box.children.length) {
    await renderChatView(chatId);
  }
  if (!state.messages.some((m) => m.msg_id === msgId)) {
    // 目标不在已加载消息里(如更早的历史),尝试刷新拉全量
    await refreshMessages(chatId);
    if (!state.messages.some((m) => m.msg_id === msgId)) return;
  }
  const el = box.querySelector(`[data-msg="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (el as HTMLElement).style.background = 'var(--active)';
    setTimeout(() => {
      (el as HTMLElement).style.background = '';
    }, 2000);
  }
}

// 全量重渲染(读最新 reactionsCache/状态),用于反应/消息状态实时更新。
export function refreshVisibleMessages(): void {
  const box = document.getElementById('messages');
  if (!box || state.messages.length === 0) return;
  void renderAllMessages(box);
}

function bindScrollListener(chatId: number): void {
  const box = document.getElementById('messages');
  if (!box) return;
  box.addEventListener('scroll', () => {
    // 顶部触发分页(loadEarlier 内部有 loadingEarlier / noMoreMsgs 守卫)。
    // 全量 DOM 渲染无需 debounce 重算可视区——消息始终在 DOM,浏览器原生滚动。
    if (box.scrollTop === 0) {
      void loadEarlier(chatId);
    }
  });
}

function channelName(chatId: number): string {
  // self-talk(保存的消息/设备聊天)不在 workspace channels 里,单独给友好名称
  if (currentChatIsSelfTalk) return '保存的消息';
  // 单聊:不显示 #id,用对方 username(非 self 成员)
  if (!state.currentChatIsGroup) {
    const other = state.currentMembers?.find((mm) => !mm.is_self);
    if (other?.name) return other.name;
  }
  const ch = state.channels.find((c: ChannelDto) => c.chat_id === chatId);
  return ch ? ch.name : `#${chatId}`;
}

function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
