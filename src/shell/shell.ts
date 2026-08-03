import { call, onEvent } from '../api.js';
import { state } from '../state.js';
import { loadPlugins } from '../plugins/manager.js';
import { renderRail, refreshWorkspaces } from './rail.js';
import { renderNavPanel, renderMain, refreshChannels } from './navPanel.js';
import { renderRightDrawer } from './rightDrawer.js';
import { bindColumnResizers } from './columnResizer.js';
import { loadState, saveState } from '../persist.js';
import { showToast } from '../toast.js';
import { stateLabel, updateReactionsCache, renderReactionCapsule } from '../chat/message.js';
import { appendNewMessages } from '../chat/chatView.js';
import type { MsgState, MsgDto } from '../types.js';

// Task 8: 消息 reactions 形状 — 与 message.ts 内部 Reaction 接口结构一致。
// message.ts 未导出 Reaction,这里本地声明供 call<Reaction[]> 类型推断使用。
interface Reaction {
  emoji: string;
  count: number;
}

interface ChatInfo {
  name: string;
}

interface ChatListItem {
  chat_id: number;
  unread: number;
}

// Tauri 全局对象局部类型(仅用 setBadgeCount)。
interface TauriWindow {
  __TAURI__?: {
    app?: {
      setBadgeCount?: (count: number) => Promise<void>;
    };
  };
}

const PEYT_INVITE_PREFIX = '[PEYT_INVITE]';
const CARD_PREFIX = '[CARD]';

export async function renderShell(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="shell">
      <div id="ws-rail" class="rail"></div>
      <div id="channel-tree" class="nav-panel"></div>
      <div id="nav-resizer" class="col-resizer" data-resizer="nav"></div>
      <div id="chat-main" class="chat-main"><div class="empty">选择一个频道</div></div>
      <div id="drawer-resizer" class="col-resizer" data-resizer="drawer"></div>
      <div id="right-drawer" class="right-drawer collapsed"></div>
    </div>
  `;

  // 列宽拖动:启动即应用持久化宽度,再渲染各栏
  bindColumnResizers();

  // 恢复持久化状态
  loadState();
  await refreshWorkspaces();
  try {
    state.self = await call('get_self_profile');
  } catch {}
  try {
    await call('validate_channels');
  } catch {}

  // 根据恢复的状态预加载频道列表;渲染交由 renderNavPanel/renderMain 按 currentPage 路由
  if (state.currentWsId != null && state.workspaces.find((w) => w.id === state.currentWsId)) {
    await refreshChannels();
  }

  // SP6: 初始化 Inbox 未读数 (启动时拉取一次,后续增量更新)
  try {
    state.inboxUnread = await call<number>('get_inbox_unread_count');
  } catch {}

  await renderRail();
  await renderNavPanel();
  await renderMain();
  renderRightDrawer();

  // 加载已启用的插件
  void loadPlugins();

  // 注册全局事件刷新(保留 shell.js 全部 19 个 handler,仅更新模块引用)
  onEvent('MsgsChanged', () => {
    if (state.currentChatId != null) void refreshCurrentChat();
    void refreshSidebar();
    void updateBadge();
  });
  onEvent('IncomingMsg', (e) => {
    void handleIncomingMsg(e);
  });
  onEvent('ChatlistItemChanged', () => {
    void refreshSidebar();
    void updateBadge();
  });
  onEvent('ChatModified', () => {
    void refreshSidebar();
  });
  onEvent('ContactsChanged', () => {
    void refreshSidebar();
  });

  // Task 13: 自己的头像变了(本机设置 or 多设备同步) → 刷新 state.self + rail 底部头像。
  onEvent('SelfavatarChanged', async () => {
    try {
      state.self = await call('get_self_profile');
      await renderRail();
    } catch {}
  });

  // Task 8: 消息状态/反应/删除/会话删除等 13 个事件 handler
  onEvent('MsgDelivered', (e) => updateMsgState(e.msg_id as number, 'delivered'));
  onEvent('MsgFailed', (e) => updateMsgState(e.msg_id as number, 'failed'));
  onEvent('MsgDeleted', (e) => removeMsg(e.msg_id as number));
  onEvent('ReactionsChanged', (e) => {
    // 延迟拉取:事件先于数据库写入,等库落定后再拉反应并重渲染可视区
    setTimeout(() => void refreshMsgReactions(e.msg_id as number), 200);
  });
  onEvent('MsgRead', (e) => updateMsgState(e.msg_id as number, 'read'));
  onEvent('MsgsNoticed', () => {
    // 未读分隔线清除,UI 自然刷新
  });
  onEvent('ChatDeleted', async (e) => {
    const chatId = e.chat_id as number;
    state.channels = state.channels.filter((c) => c.chat_id !== chatId);
    if (state.currentChatId === chatId) {
      state.currentChatId = null;
      state.currentMembers = [];
      state.messages = [];
      const main = document.getElementById('chat-main');
      if (main) main.innerHTML = `<div class="empty">选择一个频道</div>`;
    }
    await renderRail();
    await renderNavPanel();
    saveState();
  });
  onEvent('ChatEphemeralTimerModified', () => {
    // no-op
  });
  onEvent('IncomingReaction', (e) => {
    void refreshMsgReactions(e.msg_id as number);
  });
  onEvent('IncomingMsgBunch', () => {
    // no-op
  });
  onEvent('SecurejoinJoinerProgress', (e) => {
    // 握手完成(progress>=1000)时新会话建立,强制刷新侧栏让 1:1 会话出现
    if ((e.progress as number) >= 1000) {
      void refreshSidebar();
      void updateBadge();
    }
  });
  onEvent('SecurejoinInviterProgress', (e) => {
    // 对方加入我们发起的会话时同样刷新(本机作为邀请方)
    if ((e.progress as number) >= 1000) {
      void refreshSidebar();
      void updateBadge();
    }
  });
  onEvent('WebxdcStatusUpdate', () => {
    // no-op
  });
  onEvent('WebxdcRealtimeData', () => {
    // no-op
  });
  onEvent('WebxdcInstanceDeleted', () => {
    // no-op
  });

  // 全局快捷键
  document.addEventListener('keydown', async (e) => {
    // Cmd+P / Ctrl+P 命令面板
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      const { openCommandPalette, closeCommandPalette } = await import('../components/commandPalette.js');
      const overlay = document.querySelector('.command-palette-overlay');
      if (overlay) closeCommandPalette();
      else openCommandPalette();
      return;
    }
    // Cmd+K / Ctrl+K 搜索
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const { openSearch, closeSearch } = await import('../components/search.js');
      if (state.searchOpen) closeSearch();
      else openSearch();
      return;
    }
    // ESC 逐级关闭
    if (e.key === 'Escape') {
      if (state.searchOpen) {
        const { closeSearch } = await import('../components/search.js');
        closeSearch();
        return;
      }
      const overlay = document.querySelector('.overlay');
      if (overlay) {
        overlay.remove();
        return;
      }
      const replyPreview = document.getElementById('reply-preview');
      if (replyPreview) {
        const area = document.getElementById('composer-area');
        if (area) {
          delete area.dataset.replyTo;
          if (state.currentChatId != null) {
            const { renderComposer } = await import('../chat/composer.js');
            renderComposer(state.currentChatId, () => {});
          }
        }
        return;
      }
      if (state.rightDrawerOpen) {
        state.rightDrawerOpen = false;
        renderRightDrawer();
        return;
      }
    }
  });

  // 请求通知权限:仅在用户开启通知偏好时(否则一启动就弹权限框很突兀)
  if (
    'Notification' in window &&
    Notification.permission === 'default' &&
    localStorage.getItem('peyt.notificationsEnabled') !== 'false'
  ) {
    Notification.requestPermission();
  }

  // 初始 Dock 角标
  void updateBadge();
}

// 通知队列:多条新消息合并成一条聚合通知(对齐 Delta notifications.ts)
interface QueuedNotif {
  chatId: number;
  name: string;
  preview: string;
}
let notifQueue: QueuedNotif[] = [];
let notifTimer: ReturnType<typeof setTimeout> | null = null;

function queueNotification(chatId: number, name: string, preview: string): void {
  // 应用级总开关(设置页持久化的偏好) + 系统权限都满足才弹
  if (localStorage.getItem('peyt.notificationsEnabled') === 'false') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  notifQueue.push({ chatId, name, preview });
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(() => flushNotifications(), 800);
}

function flushNotifications(): void {
  notifTimer = null;
  if (notifQueue.length === 0) return;
  const first = notifQueue[0];
  const count = notifQueue.length;
  const name = count === 1 ? first.name : `${count} 条新消息`;
  const body =
    count === 1
      ? first.preview
      : notifQueue
          .map((n) => n.name)
          .filter((v, i, a) => a.indexOf(v) === i)
          .join(', ');
  const notif = new Notification(name, { body });
  notif.onclick = () => {
    // 聚焦第一条消息的 chat(复用现有聚焦逻辑)
    state.currentChatId = first.chatId;
    state.currentPage = 'messages';
    state.currentWsId = null;
    saveState();
    void renderRail().then(() => renderNavPanel().then(() => renderMain()));
    window.focus();
  };
  notifQueue = [];
}

async function handleIncomingMsg(e: { [key: string]: unknown }): Promise<void> {
  const chatId = e.chat_id as number;
  const text = (e.text as string) || '';

  // 收到的任何消息:若所属会话是未接受的 contact request,自动 accept
  // (幂等,已接受会话无副作用),使 1:1 会话进入 chatlist 并显示消息/已读状态
  if (chatId != null) {
    try {
      await call('accept_chat', { chatId });
    } catch {}
  }

  // [CARD] 消息同步:解析卡片消息并同步本地卡片数据库
  if (text.startsWith(CARD_PREFIX)) {
    try {
      const cardJson = text.slice(CARD_PREFIX.length);
      await call('upsert_card_from_msg', { msgId: e.msg_id, cardJson });
      // 若当前在 Work 页协作视图且是这个频道,刷新看板
      if (
        state.currentPage === 'work' &&
        state.currentChatId === chatId &&
        state.currentView === 'kanban'
      ) {
        const { renderKanban } = await import('../work/kanban.js');
        await renderKanban(chatId);
      }
      return; // [CARD] 消息不作为普通消息处理
    } catch {}
  }

  // [PEYT_INVITE] 消息: PEYT Studio 创始人在 master 群发送的频道邀请,
  // 新成员加入 master 群后自动 securejoin 闲聊/工作群并关联到 workspace。
  if (text.startsWith(PEYT_INVITE_PREFIX)) {
    try {
      const json = JSON.parse(text.slice(PEYT_INVITE_PREFIX.length)) as {
        general_qr?: string;
        work_qr?: string;
      };
      const ws = state.workspaces.find((w) => w.master_chat_id === chatId);
      if (ws) {
        if (json.general_qr) {
          await call('join_peyt_channel', {
            workspaceId: ws.id,
            qr: json.general_qr,
            name: '闲聊',
            category: 'General',
            spaceType: null,
          });
        }
        if (json.work_qr) {
          await call('join_peyt_channel', {
            workspaceId: ws.id,
            qr: json.work_qr,
            name: '工作',
            category: 'General',
            spaceType: 'card',
          });
        }
        // 刷新频道列表 + 重新渲染 nav panel(替代 channelTree.renderChannelTree)
        await refreshChannels();
        await renderNavPanel();
      }
    } catch (err) {
      console.warn('[peyt] invite parse failed', err);
    }
    // PEYT_INVITE 不作为普通消息展示,直接 return
    return;
  }

  // SP6: 检测 @提及,记录到 Inbox 通知中心 (增量更新未读角标)
  void detectAndRecordMention(chatId, e.msg_id as number | undefined, text);

  if (state.currentChatId === chatId) {
    await refreshCurrentChat();
  } else {
    try {
      const info = await call<ChatInfo>('get_chat_info', { chatId });
      const name = info.name || '新消息';
      const preview = (text || '').slice(0, 50);
      queueNotification(chatId, name, preview);
    } catch {}
  }
  void refreshSidebar();
  void updateBadge();
}

async function updateBadge(): Promise<void> {
  try {
    const tauri = window as unknown as TauriWindow;
    // 角标开关关闭时直接清零(设置页切换后立即可见)
    if (localStorage.getItem('peyt.badgeEnabled') === 'false') {
      if (tauri.__TAURI__?.app?.setBadgeCount) await tauri.__TAURI__.app.setBadgeCount(0);
      return;
    }
    // 同时拉常规 + 归档会话的未读:归档会话新消息也应计入总角标(Delta 语义:归档不打扰但有未读提示)
    const [normal, archived] = await Promise.all([
      call<ChatListItem[]>('get_chatlist'),
      call<ChatListItem[]>('get_chatlist', { archivedOnly: true }),
    ]);
    const total = [...normal, ...archived].reduce((sum, c) => sum + (c.unread || 0), 0);
    if (tauri.__TAURI__?.app?.setBadgeCount) {
      await tauri.__TAURI__.app.setBadgeCount(total);
    }
  } catch {}
}

async function refreshCurrentChat(): Promise<void> {
  if (state.currentChatId != null) {
    // Task 9: 增量追加新消息,而非全量重渲染(保留 scroll 位置和已加载的历史)
    await appendNewMessages(state.currentChatId);
    saveState();
  }
}

// 侧栏刷新防抖:realtime 事件风暴(MsgsChanged/ChatlistItemChanged 等)会高频触发
// refreshSidebar,多个并发 renderNavPanel 会在同一 #messages-list 上交错 prepend
// 「保存的消息」入口 → 重复出现多个入口。防抖 150ms 合并 burst。
let sidebarTimer: ReturnType<typeof setTimeout> | null = null;
function refreshSidebar(): void {
  if (sidebarTimer) clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(() => {
    sidebarTimer = null;
    void doRefreshSidebar();
  }, 150);
}

async function doRefreshSidebar(): Promise<void> {
  await refreshWorkspaces();
  await refreshChannels();
  await renderRail();
  await renderNavPanel();
  saveState();
}

// Task 8 helpers: 消息状态/删除/反应实时更新
function updateMsgState(msgId: number, newState: MsgState): void {
  const msg = state.messages.find((m) => m.msg_id === msgId);
  if (msg) {
    msg.state = newState;
    const el = document.querySelector(`[data-msg="${msgId}"]`);
    if (el) {
      const stateEl = el.querySelector('.msg-state');
      if (stateEl) stateEl.innerHTML = stateLabel(newState);
      el.classList.remove('state-pending', 'state-delivered', 'state-failed', 'state-read');
      el.classList.add('state-' + newState);
    }
  }
}

function removeMsg(msgId: number): void {
  state.messages = state.messages.filter((m) => m.msg_id !== msgId);
  const el = document.querySelector(`[data-msg="${msgId}"]`);
  if (el) el.remove();
}

async function refreshMsgReactions(msgId: number): Promise<void> {
  try {
    const reactions = await call<Reaction[]>('get_reactions', { msgId });
    // 更新 message.ts 的 reactions 缓存,重渲染时 renderReactions 直接命中
    updateReactionsCache(msgId, reactions);
    const msgEl = document.querySelector(`[data-msg="${msgId}"]`);
    if (!msgEl) return;
    const wrap = msgEl.querySelector<HTMLElement>('.msg-reactions');

    // 无反应 → 移除整个 reactions 节点(若有)
    if (!reactions || reactions.length === 0) {
      if (wrap) wrap.remove();
      return;
    }

    // diff 更新胶囊:已存在的按 emoji 复用(只改计数,不重建 → 不重播动画),
    // 新增的追加,消失的移除。避免 innerHTML 重建导致每个胶囊 re-pop。
    const existingCaps = new Map<string, HTMLElement>();
    if (wrap) {
      wrap.querySelectorAll<HTMLElement>('.msg-reaction').forEach((c) => {
        const emoji = c.dataset.emoji || '';
        existingCaps.set(emoji, c);
      });
    }
    const fragment = wrap ?? document.createElement('div');
    if (!wrap) fragment.className = 'msg-reactions';
    for (const r of reactions) {
      let cap = existingCaps.get(r.emoji);
      if (cap) {
        // 复用:更新计数(仅 >1 显示)
        const countEl = cap.querySelector('.msg-reaction-count');
        if (r.count > 1) {
          if (countEl) countEl.textContent = String(r.count);
          else {
            const span = document.createElement('span');
            span.className = 'msg-reaction-count';
            span.textContent = String(r.count);
            cap.appendChild(span);
          }
        } else if (countEl) {
          countEl.remove();
        }
        existingCaps.delete(r.emoji);
      } else {
        // 新增胶囊
        cap = document.createElement('span');
        cap.className = 'msg-reaction';
        cap.dataset.msg = String(msgId);
        cap.dataset.emoji = r.emoji;
        cap.innerHTML = renderReactionCapsule(r, msgId);
        cap.addEventListener('click', async () => {
          try {
            await call('send_reaction', { chatId: state.currentChatId, msgId, emoji: r.emoji });
          } catch (e) {
            showToast(e instanceof Error ? e.message : String(e));
          }
        });
        fragment.appendChild(cap);
      }
    }
    // 移除已消失的胶囊
    for (const cap of existingCaps.values()) cap.remove();
    // 若 reactions 节点原本不存在,插入到 msg-bubble 内(reaction-picker 之前)。
    // 必须插到 .msg-bubble 里:react 胶囊是消息内容的一部分,不能插到 .msg 直接子级
    // (那会在气泡外面,且 insertBefore 的 reference 非同级会抛 DOMException → 反应不显示)。
    if (!wrap) {
      const bubble = msgEl.querySelector('.msg-bubble');
      if (bubble) {
        const picker = bubble.querySelector('.msg-reaction-picker');
        if (picker) bubble.insertBefore(fragment, picker);
        else bubble.appendChild(fragment);
      }
    }
  } catch {}
}

// SP6: 检测消息中的 @提及 (含 @all),记录到 inbox_events 并增量更新未读角标。
// IncomingMsg 事件仅含 chat_id/msg_id/text,需调用 get_chat_msgs 获取发送者信息。
// 排除自己发的消息 (多设备同步时自己消息也会触发 IncomingMsg)。
async function detectAndRecordMention(
  chatId: number,
  msgId: number | undefined,
  text: string
): Promise<void> {
  const selfName = state.self?.name || '';
  const isMention =
    !!selfName &&
    !!msgId &&
    (text.includes(`@${selfName}`) || text.includes('@all'));
  if (!isMention) return;

  // 拉取最近消息,定位 msg_id 对应的发送者
  let fromId = 0;
  let fromName = '未知';
  try {
    const msgs = await call<MsgDto[]>('get_chat_msgs', { chatId, beforeMsgId: null });
    const msg = msgs.find((m) => m.msg_id === msgId);
    if (msg) {
      fromId = msg.from_id;
      fromName = msg.from_name || '未知';
    }
  } catch {}

  // 排除自己发的消息
  if (state.self && fromId === state.self.id) return;

  try {
    await call('record_inbox_event', {
      eventType: 'mention',
      sourceChatId: chatId,
      msgId: msgId ?? null,
      actorId: fromId,
      actorName: fromName,
      summary: text.slice(0, 100),
    });
    state.inboxUnread++;
    saveState();
    await renderRail();
  } catch {}
}
