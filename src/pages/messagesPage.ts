import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg } from '../components/icon.js';
import { ui } from '../components/ui.js';
import { escapeHtml } from '../components/escape.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { openMailingListProfile } from '../components/mailingListProfile.js';
import { isEmail, parseInviteLink } from '../utils/inviteLink.js';
import type { ChatListItem } from '../types.js';

let panel: HTMLElement | null = null;
let showArchived = false;

// 「保存的消息」入口逻辑。
// 注意:必须由 renderMessageList 每次重建时调用,不能依赖 renderNavPanel 单独 prepend——
// 因为切换聊天走 renderMessagesPage(panel) 重建列表,若入口只在 renderNavPanel 加,切聊天后入口就丢了。
let savedEntryRendered = false;

async function renderSavedMessagesEntry(list: HTMLElement): Promise<void> {
  if (savedEntryRendered) return;
  savedEntryRendered = true;
  const item = ui.listItem({
    title: '保存的消息',
    icon: 'bookmark',
    onClick: async () => {
      try {
        const chats = await call<ChatListItem[]>('get_chatlist');
        const selfTalk = chats.find((c) => c.is_self_talk);
        if (!selfTalk) {
          ui.toast('还没有保存的消息');
          return;
        }
        state.currentChatId = selfTalk.chat_id;
        saveState();
        await renderMessagesPage(panel!);
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
  item.classList.add('saved-messages-entry');
  list.prepend(item);
}

export async function renderMessagesPage(panelEl: HTMLElement): Promise<void> {
  panel = panelEl;
  // 每次重建 panel 都重置入口标记,确保「保存的消息」入口总是渲染
  savedEntryRendered = false;
  const avatarHtml = state.self ? await renderAvatarHtml(state.self) : '';
  panelEl.innerHTML = `
    <div class="nav-header">
      <div class="nav-title">消息</div>
      <div class="nav-subtitle">私聊与群组</div>
      <button class="nav-add-btn" id="messages-add" title="新建">${iconSvg('plus', { width: 18, height: 18 })}</button>
    </div>
    <div class="nav-list" id="messages-list"></div>
    <div class="nav-meta-footer">
      <button class="nav-meta-link" id="messages-archive-toggle" title="${showArchived ? '返回消息列表' : '查看已归档的会话'}">${showArchived ? '返回消息' : '已归档'}</button>
      <button class="nav-meta-link" id="messages-blocked-toggle" title="被屏蔽的联系人">屏蔽列表</button>
    </div>
    <div class="nav-user">
      ${avatarHtml}
      <div class="nav-user-info">
        <div class="nav-user-name">${escapeHtml(state.self?.name || 'me')}</div>
        <div class="nav-user-role">core</div>
      </div>
    </div>
  `;

  await renderMessageList();
  bindAddButton();
  bindUserBar();
  bindArchiveToggle();
  bindBlockedToggle();
}

function bindArchiveToggle(): void {
  const btn = document.getElementById('messages-archive-toggle');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    showArchived = !showArchived;
    void renderMessagesPage(panel!);
  });
}

function bindBlockedToggle(): void {
  const btn = document.getElementById('messages-blocked-toggle');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void import('../components/blockedContacts.js').then(({ openBlockedContacts }) => openBlockedContacts());
  });
}

// 陌生人来信分区:接受 → accept_chat;拒绝 → block_chat;操作后重拉列表。
async function renderRequestSection(list: HTMLElement, requests: ChatListItem[]): Promise<void> {
  if (requests.length === 0) return;
  const section = document.createElement('div');
  section.className = 'nav-request-section';
  section.innerHTML = `<div class="nav-group-title">新请求</div>`;
  for (const c of requests) {
    const row = document.createElement('div');
    row.className = 'nav-request-item';
    const letter = (c.name || '?').charAt(0).toUpperCase() || '?';
    row.innerHTML = `
      <div class="avatar nav-request-avatar">${escapeHtml(letter)}</div>
      <div class="nav-request-meta">
        <div class="nav-request-name">${escapeHtml(c.name || '新联系人')}</div>
        <div class="nav-request-preview">${escapeHtml(c.last_msg || '请求加你为好友')}</div>
      </div>
      <button class="nav-request-accept" data-chat="${c.chat_id}">接受</button>
      <button class="nav-request-reject" data-chat="${c.chat_id}">拒绝</button>
    `;
    section.appendChild(row);
  }
  section.querySelectorAll<HTMLElement>('.nav-request-accept').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const chatId = Number(btn.dataset.chat);
      try {
        await call('accept_chat', { chatId });
        await renderMessagesPage(panel!);
      } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
    });
  });
  section.querySelectorAll<HTMLElement>('.nav-request-reject').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const chatId = Number(btn.dataset.chat);
      try {
        await call('block_chat', { chatId });
        await renderMessagesPage(panel!);
      } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
    });
  });
  list.appendChild(section);
}

async function renderMessageList(): Promise<void> {
  const list = document.getElementById('messages-list');
  if (!list) return;
  let chats: ChatListItem[] = [];
  try {
    // 归档视图:仅拉归档会话(后端 DC_GCL_ARCHIVED_ONLY);常规视图:仅未归档。
    chats = await call<ChatListItem[]>('get_chatlist', showArchived ? { archivedOnly: true } : {});
  } catch {
    chats = [];
  }
  // 按会话类型过滤,而非 chat_id 集合:workspace 主群/频道都是群(排除),
  // 保留单聊(1:1 会话)。用类型判断避免 chat_id 与 securejoin 会话冲突时误伤。
  // showArchived 分流:已归档视图只看 is_archived 会话,常规视图隐藏它们。
  const requests = chats.filter((c) => !showArchived && c.is_contact_request);
  const messages = chats.filter((c) =>
    showArchived
      ? c.is_archived && !c.is_group && !c.is_self_talk && !c.is_contact_request
      : !c.is_archived && !c.is_group && !c.is_self_talk && !c.is_contact_request
  );

  // 陌生人来信:「新请求」分区置顶,接受/拒绝 (修复 contact request 被过滤不可见的 bug)
  if (!showArchived) await renderRequestSection(list, requests);

  // 「保存的消息」入口置顶渲染(仅常规视图;归档视图里保存的消息不是归档会话)
  if (!showArchived) await renderSavedMessagesEntry(list);

  if (messages.length === 0) {
    list.appendChild(ui.empty('暂无会话,点击 + 开始'));
    return;
  }

  for (const c of messages) {
    const trailing = document.createElement('div');
    trailing.className = 'nav-item-trailing';
    if (c.last_ts) {
      const t = document.createElement('span');
      t.className = 'nav-chat-time';
      t.textContent = formatTime(c.last_ts);
      trailing.appendChild(t);
    }
    if (c.unread > 0) trailing.appendChild(ui.badge({ text: String(c.unread) }));

    const item = ui.listItem({
      title: c.name,
      subtitle: c.last_msg?.slice(0, 40) || '',
      trailing,
      onClick: async () => {
        state.currentChatId = c.chat_id;
        saveState();
        await renderMessagesPage(panel!);
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      },
    });
    // 广播 / 邮件列表会话在标题前加类型标记(ui.listItem 的 title 是转义字符串,故改 innerHTML 注入)
    const chatType = (c as ChatListItem & { chat_type?: string }).chat_type;
    const typeMark = chatType === 'broadcast'
      ? '<span class="nav-type-mark" style="margin-right:4px">📢</span>'
      : chatType === 'mailinglist'
        ? '<span class="nav-type-mark" style="margin-right:4px">✉️</span>'
        : '';
    if (typeMark) {
      const titleEl = item.querySelector('.ui-list-title');
      if (titleEl) titleEl.innerHTML = typeMark + escapeHtml(c.name);
    }
    item.dataset.id = String(c.chat_id);
    if (state.currentChatId === c.chat_id) item.classList.add('active');
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChatContextMenu(item, c);
    });
    list.appendChild(item);
  }
}

function bindAddButton(): void {
  const btn = document.getElementById('messages-add');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    ui.menu(btn as HTMLElement, [
      { label: '选择联系人', icon: 'user', action: () => { void import('../components/contactsPicker.js').then((m) => m.openContactsPicker()); } },
      { label: '通过邮箱添加', icon: 'user', action: () => showInlineEmailInput() },
      { label: '通过链接添加', icon: 'hash', action: () => showInlineQrInput() },
      { separator: true },
      { label: '新建群聊', icon: 'users', action: () => showInlineGroupInput() },
      { separator: true },
      { label: '分享我的邀请链接', icon: 'copy', action: () => { void import('../components/inviteDialog.js').then((m) => m.openInviteDialog()); } },
      { label: '加入 PEYT 团队', icon: 'layout-grid', action: () => { void joinPeytStudio(); } },
    ], 'bottom-left');
  });
}

function showInlineEmailInput(): void {
  ui.inputDialog({
    title: '添加好友',
    placeholder: '输入对方邮箱地址',
    type: 'email',
    confirmLabel: '添加',
    onConfirm: async (email) => {
      const chatId = await call<number>('create_chat_by_email', { email });
      state.currentChatId = chatId;
      saveState();
      await renderMessagesPage(panel!);
      const { renderMain } = await import('../shell/navPanel.js');
      await renderMain();
    },
  });
}

function showInlineQrInput(): void {
  ui.inputDialog({
    title: '添加好友',
    placeholder: '粘贴邮箱 / peyt:// 邀请链接 / 老 QR',
    confirmLabel: '加入',
    onConfirm: async (input) => {
      const raw = input.trim();
      try {
        // 依次识别:邮箱 → peyt:// 邀请链接 → 老 securejoin 链接
        if (isEmail(raw)) {
          const chatId = await call<number>('create_chat_by_email', { email: raw });
          state.currentChatId = chatId;
          saveState();
          await renderMessagesPage(panel!);
          const { renderMain } = await import('../shell/navPanel.js');
          await renderMain();
          return;
        }
        const peytEmail = parseInviteLink(raw);
        if (peytEmail) {
          const chatId = await call<number>('create_chat_by_email', { email: peytEmail });
          state.currentChatId = chatId;
          saveState();
          await renderMessagesPage(panel!);
          const { renderMain } = await import('../shell/navPanel.js');
          await renderMain();
          return;
        }
        // 兼容老 securejoin 链接 (dccontact: / dcgroup: / https://i.delta.chat/#)
        const chatId = await call<number>('secure_join', { qr: raw });
        try {
          await call('accept_chat', { chatId });
        } catch {}
        state.currentChatId = chatId;
        saveState();
        await renderMessagesPage(panel!);
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
  });
}

function showInlineGroupInput(): void {
  ui.inputDialog({
    title: '创建群',
    placeholder: '输入群名称',
    confirmLabel: '创建',
    onConfirm: async (name) => {
      const chatId = await call<number>('create_group_chat', { name });
      state.currentChatId = chatId;
      saveState();
      await renderMessagesPage(panel!);
      const { renderMain } = await import('../shell/navPanel.js');
      await renderMain();
    },
  });
}

async function joinPeytStudio(): Promise<void> {
  try {
    const r = await call<{ workspace_id: number }>('join_peyt_studio', {});
    state.currentWsId = r.workspace_id;
    state.currentPage = 'groups';
    saveState();
    const { refreshWorkspaces } = await import('../shell/rail.js');
    await refreshWorkspaces();
    const { renderRail } = await import('../shell/rail.js');
    await renderRail();
    const { renderNavPanel } = await import('../shell/navPanel.js');
    await renderNavPanel();
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
}

function showChatContextMenu(anchor: HTMLElement, c: ChatListItem): void {
  // 广播 / 邮件列表会话:查看资料 → 打开邮件列表资料弹窗;其余仍为占位
  const chatType = (c as ChatListItem & { chat_type?: string }).chat_type;
  const isMailing = chatType === 'mailinglist' || chatType === 'broadcast';
  ui.menu(anchor, [
    {
      label: '查看资料',
      icon: 'user',
      action: () => {
        if (isMailing) void openMailingListProfile(c.chat_id, c);
        else ui.toast('查看资料(开发中)');
      },
    },
    {
      label: c.is_archived ? '取消归档' : '归档',
      icon: 'inbox',
      action: async () => {
        try {
          await call('archive_chat', { chatId: c.chat_id, archive: !c.is_archived });
          ui.toast(c.is_archived ? '已取消归档' : '已归档');
          await renderMessagesPage(panel!);
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      label: '屏蔽',
      icon: 'volume-x',
      action: async () => {
        try {
          await call('block_chat', { chatId: c.chat_id });
          ui.toast('已屏蔽');
          await renderMessagesPage(panel!);
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      label: '删除会话',
      icon: 'trash',
      danger: true,
      action: async () => {
        try {
          await call('delete_chat', { chatId: c.chat_id });
          if (state.currentChatId === c.chat_id) {
            state.currentChatId = null;
            saveState();
          }
          ui.toast('已删除');
          await renderMessagesPage(panel!);
          const { renderMain } = await import('../shell/navPanel.js');
          await renderMain();
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ], 'bottom-right');
}

function bindUserBar(): void {
  const userBar = panel?.querySelector<HTMLElement>('.nav-user');
  if (!userBar) return;
  userBar.style.cursor = 'pointer';
  userBar.addEventListener('click', async () => {
    state.currentPage = 'settings';
    state.currentSettingsSection = 'account';
    saveState();
    const { renderRail } = await import('../shell/rail.js');
    await renderRail();
    const { renderNavPanel } = await import('../shell/navPanel.js');
    await renderNavPanel();
    const { renderMain } = await import('../shell/navPanel.js');
    await renderMain();
  });
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

