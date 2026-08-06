import { call, transformBlobURL } from '../api.js';
import { listen } from '@tauri-apps/api/event';
import { state } from '../state.js';
import { renderMessage, bindMessageActions, clearReactionsCache, clearPinnedCache, updatePinnedCache, setReadCounts, type GroupRole } from './message.js';
import { resolveMessageText } from '../utils/envelope.js';
import { renderComposer } from './composer.js';
import { saveState } from '../persist.js';
import { ui } from '../components/ui.js';
import { escapeHtml } from '../components/escape.js';
import { colorHex } from '../components/avatar.js';
import { renderTopicBubbleHtml, openWordAnalysisPopup } from '../components/wordCloud.js';
import { initSegmenter, computeTopics, type TopicCluster } from '../utils/wordAnalysis.js';
import { loadSummaryPrefs, getSummaryPrefs } from '../utils/summaryPrefs.js';
import { iconSvg } from '../components/icon.js';
import { initSummaryBubble, scheduleSummary, renderBubbleHtml, openSummaryBubbleView, setFallbackClusters, applySummaryEvent } from '../components/summaryBubble.js';
import { openEncryptionPopup } from '../components/encryptionPopup.js';
import { openOnlinePopup } from '../components/onlinePopup.js';
import { isOnline, lastSeenText } from '../utils/online.js';
import type { MsgDto, RoleDto, MemberDto, ChannelDto, ChatListItem, AppState } from '../types.js';

interface ChatInfo {
  name: string;
  is_group: boolean;
  is_encrypted: boolean;
  members: MemberDto[];
  avatar: string | null;
  color: number | null;
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
  // 主题气泡状态机:每次打开会话挂接当前 chatId(幂等,首次载入 cache 恢复 done)
  initSummaryBubble(chatId, resolveMessageText);
  // summary-event 全局监听只挂一次(streaming/done/error → 更新气泡 DOM)
  bindSummaryEvents();
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
    // 单聊/群聊标记立即更新——channelName 渲染标题依赖它,稍后第 134 行的
    // chatlist 也会写,但标题在更早就渲染,若滞后会显示上一个频道的名称/或 #XX。
    // headerName/headerIsGroup 用本次 info 的值,避免时序错位显示上一个频道的名称。
    let chatInfo: ChatInfo | null = null;
    let headerName = '';
    let headerIsGroup = false;
    try {
      const info = await call<ChatInfo>('get_chat_info', { chatId });
      state.currentMembers = info.members || [];
      chatInfo = info;
      headerIsGroup = info.is_group;
      headerName = headerNameOf(info, chatId);
      // 立即写全局,供 message.ts 渲染气泡/role tag 用
      state.currentChatIsGroup = info.is_group;
    } catch {
      state.currentMembers = [];
      state.currentChatIsGroup = false;
    }
    // 渲染骨架(含 Task 13 头部按钮:members / pin,触发 detail panel)
    // 成员数标签:state.currentMembers 来自上面 get_chat_info,失败为空则隐藏
    const memberCount = state.currentMembers?.length || 0;
    // 单聊不显示 "N 成员"(对应用户名已在标题,气泡内也无 name/role tag)
    const membersTag = memberCount > 0 && headerIsGroup
      ? `<span class="ch-members">${memberCount} 成员</span>`
      : '';
    // 头部头像:单聊 = 对方成员头像;群聊 = 会话头像(chatInfo.avatar)。无则生成首字母色块(仿聊天列表)。
    const headerAvatarHtml = await buildHeaderAvatarHtml(chatInfo, headerName || channelName(chatId));
    // 会话已加密(以 core is_encrypted 为准)→ 右侧按钮组圆形气泡,点击弹指纹 popup。
    const lockBtn = chatInfo?.is_encrypted
      ? `<button class="ch-ctl-btn" data-chat-enc="1" title="已加密,查看成员指纹" aria-label="加密状态">${iconSvg('lock', { width: 16, height: 16 })}</button>`
      : '';
    // 在线状态气泡:置于 ch-head 右侧,icon + 简要文字(群聊「N 人在线」/ 单聊「在线|最后活跃」)。
    const onlineBlock = buildOnlineBlockHtml(chatInfo, headerIsGroup);
    // 右上角按钮组:会话内搜索 / 媒体相册 / 加密锁 / 「更多」(最右侧,打开侧栏)。
    // 群信息改由点击 ch-head 弹出;成员/置顶并入右侧栏。
    const ctrlButtons = `
      <button class="ch-ctl-btn" data-ctl="search" title="会话内搜索" aria-label="搜索">${iconSvg('search', { width: 16, height: 16 })}</button>
      <button class="ch-ctl-btn" data-ctl="gallery" title="媒体相册" aria-label="媒体相册">${iconSvg('image', { width: 16, height: 16 })}</button>
      ${lockBtn}
      <button class="ch-ctl-btn" data-ctl="more" title="更多" aria-label="更多">${iconSvg('more-horizontal', { width: 16, height: 16 })}</button>
    `;
    main.innerHTML = `
      <div class="messages" id="messages">
        <div class="chat-header" data-header="1">
          <div class="ch-head${headerIsGroup ? ' ch-head-clickable' : ''}">
            <div class="ch-head-row">
              ${headerAvatarHtml}
              <span class="ch-title">${escapeHtml(headerName || channelName(chatId))}</span>
              ${membersTag}
              <span class="ch-topic">${escapeHtml(topic)}</span>
            </div>
          </div>
          ${onlineBlock}
          <div class="ch-topic-chip" data-topic-chip="1" data-topic-bubble="1"></div>
          <div class="ch-ctls">
            ${ctrlButtons}
          </div>
        </div>
      </div>
      <div id="composer-area"></div>
    `;
    bindHeaderControls(main, chatId);
    // 锁徽章点击 → 加密信息 popup(成员指纹列表)
    main.querySelector('[data-chat-enc="1"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openEncryptionPopup(e.currentTarget as HTMLElement, chatId);
    });
    // 在线气泡点击 → 在线/离线成员列表 popup
    main.querySelector('[data-online-block="1"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openOnlinePopup(e.currentTarget as HTMLElement, chatId);
    });
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
    // 会话内新消息 → 防抖重算主题气泡(LLM 模式静默滚动重新总结,词频模式重算簇)。
    // 由 shell.ts refreshCurrentChat(MsgsChanged/IncomingMsg) 经 appendNewMessages 触发。
    scheduleTopicRefresh();
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
  // 消息更新(切会话/新消息/发送后)→ 防抖重算主题词频气泡
  scheduleTopicRefresh();
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
    // 聊天头(嵌入消息流,sticky 固定顶部)不属于对账序列,跳过
    if ((el as HTMLElement).dataset.header === '1') continue;
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
    // 聊天头不属于对账序列,保留(sticky 固定顶部)
    if ((el as HTMLElement).dataset.header === '1') continue;
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

// 从本次 chat_info 取头部标题: 单聊用对方 username, 群聊用 info 名(chat_info.name)。
// 不走 state.currentMembers/currentChatIsGroup —— 那些是全局缓存, 切换时可能滞后。
function headerNameOf(info: ChatInfo, chatId: number): string {
  if (!info.is_group) {
    const other = info.members?.find((mm) => !mm.is_self);
    if (other?.name) return other.name;
  }
  if (info.name) return info.name;
  return '';
}

// 头部头像 HTML: 单聊 = 对方成员头像; 群聊 = 会话头像(chatInfo.avatar)。
// 头像路径是 blobdir 绝对路径, 经 transformBlobURL 转可加载 URL。
// 无头像 → 仿聊天列表生成首字母色块(色取对方成员/群聊 color, 字母取标题首字符)。
async function buildHeaderAvatarHtml(info: ChatInfo | null, displayName: string): Promise<string> {
  if (!info) return '';
  const other = info.is_group ? null : info.members?.find((mm) => !mm.is_self) || null;
  const avatarPath = info.is_group ? info.avatar : other?.avatar || null;
  const color = info.is_group ? info.color : other?.color ?? null;
  if (avatarPath) {
    try {
      const url = await transformBlobURL(avatarPath);
      if (url) return `<img class="ch-avatar" src="${escapeHtml(url)}" alt="" />`;
    } catch {
      // 转换失败 → 落到底部首字母兜底
    }
  }
  const letter = (displayName || '?').charAt(0).toUpperCase() || '?';
  return `<div class="ch-avatar ch-avatar-letter" style="background:${colorHex(color)}">${escapeHtml(letter)}</div>`;
}

// 生成 header 在线状态气泡(icon + 文字,材质与 ch-head 一致),置于 ch-head 右侧:
// - 单聊:在线 = 绿点+「在线」,离线 = 灰点+「最后活跃：X」。
// - 群聊:users 图标 + 「N 人在线」。
// 点击弹在线/离线成员列表 popup。无在线数据(群聊 0 人 / 单聊无 last_seen)→ 不渲染。
function buildOnlineBlockHtml(info: ChatInfo | null, isGroup: boolean): string {
  if (!info) return '';
  const members = info.members || [];
  if (isGroup) {
    // 群聊始终显示气泡(含 0 人在线):统计不含自己(is_self),点击查看在线/离线全名单。
    const onlineCount = members.filter((m) => !m.is_self && isOnline(m.last_seen)).length;
    return `<span class="ch-online-block${onlineCount > 0 ? ' on' : ''}" data-online-block="1" title="查看在线与离线成员">
      ${iconSvg('users', { width: 13, height: 13 })}
      <span>${onlineCount} 人在线</span>
    </span>`;
  }
  const other = members.find((m) => !m.is_self);
  if (!other || other.last_seen <= 0) return '';
  const online = isOnline(other.last_seen);
  const label = online ? '在线' : `最后活跃：${lastSeenText(other.last_seen)}`;
  return `<span class="ch-online-block${online ? ' on' : ''}" data-online-block="1" title="${online ? '在线' : `最后活跃时间：${lastSeenText(other.last_seen)}`}">
    <span class="ch-online-dot${online ? ' on' : ''}"></span>
    <span>${escapeHtml(label)}</span>
  </span>`;
}

function channelName(chatId: number): string {
  // self-talk(保存的消息/设备聊天)不在 workspace channels 里,单独给友好名称
  if (currentChatIsSelfTalk) return '保存的消息';
  // 单聊:不显示 #id,用对方 username(非 self 成员)
  if (!state.currentChatIsGroup) {
    const other = state.currentMembers?.find((mm) => !mm.is_self);
    if (other?.name) return other.name;
  }
  // 频道(channels)里的名称(群聊频道)
  const ch = state.channels.find((c: ChannelDto) => c.chat_id === chatId);
  if (ch?.name) return ch.name;
  return `#${chatId}`;
}

// ── 会话主题词频气泡 ──────────────────────────────────────
let topicTimer: ReturnType<typeof setTimeout> | null = null;
let topicWords: TopicCluster[] = [];

// 防抖 300ms: 切换会话/新消息触发, 避免频繁重算。懒加载分词, 失败静默。
// LLM 模式走 summary 队列(气泡状态机流式/失败降级);词频/off 走原 computeTopics。
function scheduleTopicRefresh(): void {
  if (topicTimer) clearTimeout(topicTimer);
  topicTimer = setTimeout(async () => {
    topicTimer = null;
    try {
      await initSegmenter();
    } catch (err) {
      // 分词初始化失败 → 隐藏气泡, 不阻断聊天(先打日志便于排查)
      console.warn('[word-freq] jieba init failed:', err);
      document.querySelector('[data-topic-chip="1"]')?.remove();
      return;
    }
    // 冷启动:内存缓存可能是默认(wordfreq),先拉一次后端偏好,否则重启后
    // 持久化的 llm 模式不生效 → 永远走 computeTopics。已加载时直接命中缓存。
    const prefs = await loadSummaryPrefs();
    const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
    if (!chip) return;
    if (prefs.mode === 'llm') {
      // LLM 模式:先算词频簇作降级兜底,再交给气泡状态机(流式追加/失败降级)
      setFallbackClusters(computeTopics(state.messages, resolveMessageText, 4));
      const st = await scheduleSummary(state.messages, resolveMessageText, prefs.contextN);
      if (st) {
        chip.innerHTML = renderBubbleHtml(st);
        syncChipTitle(chip);
        bindTopicChipClick(); // 委托已在,幂等
      }
      return;
    }
    // 词频/off:原 computeTopics
    const clusters = computeTopics(state.messages, resolveMessageText, 4);
    topicWords = clusters;
    chip.innerHTML = renderTopicBubbleHtml(clusters);
    syncChipTitle(chip);
    // 点击:全局委托(bindTopicChipClick 一次挂载)按模式分流 —— 词频弹词云 / LLM 弹看板
    bindTopicChipClick();
  }, 300);
}

// 同步气泡 tooltip:chip.textContent 即纯文本(图标为 svg 无文本),
// 设为原生 title → 鼠标悬停显示气泡内完整总结文本(气泡过长被省略号截断时看全)。
function syncChipTitle(chip: HTMLElement): void {
  const text = chip.textContent?.trim();
  chip.title = text || '';
}

// 主题气泡点击全局委托:ch-topic-chip 自身即气泡(data-topic-bubble 标记),
// innerHTML 更新不重建 chip,委托一次挂载避免监听器累积。按模式分流:
// LLM 模式 → 打开分析看板;词频/off 模式 → 打开词云弹窗。
let topicChipClickBound = false;
function bindTopicChipClick(): void {
  if (topicChipClickBound) return;
  topicChipClickBound = true;
  document.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-topic-bubble="1"]');
    if (!chip) return;
    const prefs = getSummaryPrefs();
    if (prefs.mode === 'llm') {
      e.stopPropagation();
      openSummaryBubbleView(chip);
    } else {
      e.stopPropagation();
      openWordAnalysisPopup(chip, topicWords);
    }
  });
}

// 全局 summary-event 监听:streaming/done/error → 更新气泡 DOM。
// 只挂一次(会话切换/重渲染不重复 listen),由 renderChatView 打开会话时调用。
let summaryEventBound = false;
function bindSummaryEvents(): void {
  if (summaryEventBound) return;
  summaryEventBound = true;
  void listen('summary-event', (ev) => {
    const p = ev.payload as { chatId: number; lane: string; status: string; delta?: string; result?: string; error?: { code: string } };
    const st = applySummaryEvent(p);
    if (!st) return;
    const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
    if (chip) {
      chip.innerHTML = renderBubbleHtml(st);
      syncChipTitle(chip);
      bindTopicChipClick(); // 委托已在,幂等
    }
  });
}

// 头部按钮组点击绑定:搜索/相册/「更多」+ ch-head 点击弹群信息。
// 「更多」打开 rightDrawer(展开 members tab);ch-head 点击弹群信息 popup(群聊)。
function bindHeaderControls(main: HTMLElement, chatId: number): void {
  main.querySelector<HTMLElement>('[data-ctl="search"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void import('../components/search.js').then(({ openChatSearch }) => openChatSearch(chatId));
  });
  main.querySelector<HTMLElement>('[data-ctl="gallery"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void import('../components/gallery.js').then(({ openGallery }) => openGallery(chatId));
  });
  // 「更多」→ 开关右侧栏:已展开且停在 members → 折叠;否则展开 members
  main.querySelector<HTMLElement>('[data-ctl="more"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.detailPanelOpen && state.detailTab === 'members' && state.rightDrawerOpen) {
      state.detailPanelOpen = false;
    } else {
      state.detailPanelOpen = true;
      state.detailTab = 'members';
      state.rightDrawerOpen = true;
    }
    saveState();
    void import('../shell/rightDrawer.js').then(({ renderRightDrawer }) => renderRightDrawer());
  });
  // 点击 ch-head → 弹群信息 popup(群聊);单聊暂无动作
  main.querySelector<HTMLElement>('.ch-head')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.currentChatIsGroup) return;
    void import('../components/group/viewGroupDialog.js').then(({ openViewGroupDialog }) => {
      openViewGroupDialog(chatId);
    });
  });
}

