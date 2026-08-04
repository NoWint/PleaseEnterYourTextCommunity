import { call } from '../api.js';
import { state } from '../state.js';
import { renderMessage, bindMessageActions, clearReactionsCache, clearPinnedCache, updatePinnedCache, setReadCounts, type GroupRole } from './message.js';
import { renderComposer } from './composer.js';
import { saveState } from '../persist.js';
import { ui } from '../components/ui.js';
import { escapeHtml } from '../components/escape.js';
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
    try { topic = (await call<string>('get_channel_topic', { chatId })) || ''; } catch {}
    try {
      const pins = await call<ChannelPin[]>('get_channel_pins', { chatId });
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
      </div>
      <div class="messages" id="messages"></div>
      <div id="composer-area"></div>
    `;
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
    // 打开聊天 = 已读:标记 seen(清未读徽标 + 向对方发送已读回执)。
    // 不能用 mark_chat_noticed —— 那只是 InFresh→InNoticed,core 不会发 MDN,
    // 对方永远看不到「已读」。
    try {
      await call('mark_chat_seen', { chatId });
      // 已读 → 未读分隔线清零:避免 currentChatUnread 快照陈旧导致 dividerIndex
      // 随 msgs.length 增长漂移,把分隔线插进同人连续组里破坏圆角/头像/缩进。
      currentChatUnread = 0;
    } catch {}
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
  // 切换聊天后刷新右侧抽屉:折叠态重挂展开按钮,展开态刷新成员/媒体/存档内容
  try {
    const { renderRightDrawer } = await import('../shell/rightDrawer.js');
    renderRightDrawer();
  } catch {}
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
    // 先补齐已读计数,再全量渲染(复用已有节点,只新建新消息),浏览器原生滚动
    await loadReadCounts(newMsgs);
    await renderAllMessages(box);
    if (wasAtBottom) {
      box.scrollTop = box.scrollHeight;
      // 用户看到了新消息 → 标记 seen 并触发 MDN,让发送方显示已读。
      // (mark_chat_noticed 不触发 MDN,对方看不到已读。)
      try {
        await call('mark_chat_seen', { chatId });
        // 已读 → 清空未读分隔线计数,下次渲染不再出现(否则快照陈旧分隔线漂移错乱)
        currentChatUnread = 0;
      } catch {}
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
  // 已读计数必须在渲染前填充:气泡渲染「N 人已读」时依赖 readCountMap,
  // 渲染后再拉会导致首屏计数恒为 0。
  await loadReadCounts(msgs);
  // Delta 式全量渲染:所有消息都是真实 DOM 节点,浏览器原生管理滚动
  // (scrollHeight = 真实高度,scrollTop 天然稳定,零手动补偿)。
  await renderAllMessages(box);
  box.scrollTop = box.scrollHeight;
}

// 已读系统:批量拉取发出的消息的已读人数,填充 readCountMap(气泡渲染「N 人已读」)。
// 只对真实 id(非 tmp_ 乐观消息)的发出消息查询;失败静默(下次刷新会补)。
async function loadReadCounts(msgs: MsgDto[]): Promise<void> {
  const ids: number[] = [];
  for (const m of msgs) {
    if (m.is_out) ids.push(m.msg_id);
  }
  if (ids.length === 0) return;
  try {
    const counts = await call<number[]>('get_msg_read_counts', { msgIds: ids });
    setReadCounts(ids, counts);
  } catch { /* 失败静默,下次渲染自动补齐 */ }
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
  await loadReadCounts(older);
  await renderAllMessages(box);
  const heightDelta = box.scrollHeight - prevHeight;
  box.scrollTop = prevTop + heightDelta;
  loadingEarlier = false;
}

// Delta 式全量渲染:所有已加载消息都是真实 DOM 节点,浏览器原生管理滚动。
// scrollHeight = 真实内容高度,scrollTop 天然稳定 —— 不需要 spacer 估算、不需要
// 手动补偿。
//
// 消除闪烁的关键:不调用 box.innerHTML=''(清空会销毁全部节点触发整区重绘),
// 改为有序对账(diff)—— 已有消息节点原样保留(不重写 innerHTML,内容零重绘),
// 只新建缺失节点、移除多余节点、把新节点插到正确位置。发送消息时只有那条
// 新气泡被创建,整条消息流不再闪烁。
async function renderAllMessages(box: HTMLElement): Promise<void> {
  // 并发守卫:多次渲染交错时,只有最后一次写入 DOM
  const token = ++renderToken;
  const msgs = state.messages;
  const prevScrollTop = box.scrollTop;
  const prevScrollHeight = box.scrollHeight;

  const dividerIndex = (currentChatUnread > 0 && msgs.length >= currentChatUnread)
    ? msgs.length - currentChatUnread
    : -1;

  // 现有节点索引:key = m:msg_id / d:日期 / u:未读位置
  const existing = new Map<string, HTMLElement>();
  for (const el of Array.from(box.children)) {
    const h = el as HTMLElement;
    const key = h.dataset.msg
      ? `m:${h.dataset.msg}`
      : h.classList.contains('msg-date-divider') && h.dataset.date
        ? `d:${h.dataset.date}`
        : h.classList.contains('msg-unread-divider') && h.dataset.unread
          ? `u:${h.dataset.unread}`
          : '';
    if (key) existing.set(key, h);
  }

  // 组装目标序列(有序 key + 节点)。日期/未读分隔线缺则建;消息缺则渲染。
  const items: Array<{ key: string; el: HTMLElement }> = [];
  let prevDate: string | null = null;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const dateStr = formatDate(new Date(m.ts * 1000));

    if (dateStr !== prevDate) {
      const key = `d:${dateStr}`;
      let d = existing.get(key);
      if (!d) {
        d = document.createElement('div');
        d.className = 'msg-date-divider';
        d.dataset.date = dateStr;
        d.textContent = dateStr;
        existing.set(key, d);
      }
      items.push({ key, el: d });
      prevDate = dateStr;
    }

    if (i === dividerIndex) {
      const key = `u:${dividerIndex}`;
      let d = existing.get(key);
      if (!d) {
        d = document.createElement('div');
        d.className = 'msg-unread-divider';
        d.dataset.unread = String(dividerIndex);
        d.innerHTML = `<span class="divider-line"></span><span class="divider-label">新消息</span><span class="divider-line"></span>`;
        existing.set(key, d);
      }
      items.push({ key, el: d });
    }

    const key = `m:${m.msg_id}`;
    let el = existing.get(key);
    if (el) {
      // 复用:只修正分组角色(邻居变化),内容不动
      applyGroupRole(m, i, dividerIndex, dateStr, el);
    } else {
      const role = computeGroupRole(m, i, dividerIndex, dateStr);
      const msgFrag = document.createElement('div');
      msgFrag.innerHTML = await renderMessage(m, role);
      const node = msgFrag.firstElementChild as HTMLElement;
      if (node) {
        bindMessageActions(msgFrag);
        node.classList.add('msg-enter');
        node.addEventListener('animationend', () => node.classList.remove('msg-enter'), { once: true });
        existing.set(key, node);
        el = node;
      }
    }
    if (el) items.push({ key, el });
  }

  // await 之后检查并发 token:若有更新的渲染,放弃本次
  if (token !== renderToken) return;

  // 1) 移除不再需要的节点(删除的消息/过期分隔线/空态提示)。
  // renderAllMessages 只在有消息时被调用,空态(.ui-empty)只出现在无消息分支,
  // 不会与消息并存,因此非目标节点一律移除。
  const desired = new Set(items.map((it) => it.key));
  for (const el of Array.from(box.children)) {
    const h = el as HTMLElement;
    const key = h.dataset.msg
      ? `m:${h.dataset.msg}`
      : h.classList.contains('msg-date-divider') && h.dataset.date
        ? `d:${h.dataset.date}`
        : h.classList.contains('msg-unread-divider') && h.dataset.unread
          ? `u:${h.dataset.unread}`
          : '';
    if (!desired.has(key)) el.remove();
  }

  // 2) 有序对账:保持 items 顺序,每个目标节点应紧跟在「上一个已就位节点」之后。
  // anchor 记录上一个已就位节点;当前项正确位置 = box 首元素(anchor 为空)
  // 或 current.previousSibling === anchor。否则 insertBefore 到 anchor 之后。
  // 已有节点在正确位置时零操作(不移动、不重写内容 → 不闪烁);
  // 只有缺失节点/错位节点才被插入。注意方向:此前实现用 nextSibling === anchor
  // 且 insertBefore(el, anchor),首次渲染会把新节点逐个插到前面 → 整流反转、
  // 最新消息跑到顶部、滚不到底。已修正为 previousSibling 语义。
  let anchor: HTMLElement | null = null;
  for (const it of items) {
    const el = it.el;
    const correctlyPlaced = el.parentNode === box && (anchor === null ? box.firstChild === el : el.previousSibling === anchor);
    if (!correctlyPlaced) {
      box.insertBefore(el, anchor ? anchor.nextSibling : null);
    }
    anchor = el;
  }

  // scrollTop 补偿:顶部插入(loadEarlier)时按 scrollHeight 增量保持视口;
  // 底部追加无需补偿(scrollTop 本来就贴底,appendNewMessages 会再设 scrollHeight)。
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
  // 未读分隔线插在 dividerIndex 消息「之前」。因此:
  // - 消息 absIdx 正上方有分隔线 ⟺ absIdx === dividerIndex(它不与该分隔线上方的消息成组)
  // - 消息 absIdx 正下方有分隔线 ⟺ absIdx === dividerIndex - 1(它不与分隔线下方的消息成组)
  // 此前 prev 判断用了 (absIdx-1)!==dividerIndex(即 absIdx===dividerIndex+1),差一位 → 分隔线
  // 不能正确打断分组 → 上下同人消息错误折叠/拆开 → 圆角、头像、缩进错乱。
  const prevIsSame = !!prev && prev.from_id === m.from_id && !isPending
    && prev.state !== 'pending' && prev.state !== 'failed'
    && formatDate(new Date(prev.ts * 1000)) === dateStr
    && absIdx !== dividerIndex;
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
  // 折叠条件必须与 renderMessage 完全一致:middle/last 折叠(隐藏头像),solo/first 展开。
  // 之前用 role!=='solo' 把 first 也折叠了 → 重渲染后组首头像被错误隐藏(头像显示错乱)。
  if (role === 'middle' || role === 'last') el.classList.add('collapsed');
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

