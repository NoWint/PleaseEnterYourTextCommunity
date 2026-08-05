import { call, transformBlobURL } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg } from '../components/icon.js';
import { ui, colorHex } from '../components/ui.js';
import { escapeHtml, escapeAttr } from '../components/escape.js';
import { openMailingListProfile } from '../components/mailingListProfile.js';
import { renderMemberDetail } from '../components/memberDetail.js';
import { chatPreviewText } from '../chat/message.js';
import { isOnline, lastSeenText } from '../utils/online.js';
import type { ChatListItem, MemberDto } from '../types.js';

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
  // 面板结构首次渲染;后续(MsgsChanged → refreshSidebar → renderNavPanel)跳过
  // innerHTML 重建 —— 否则整个 nav panel 全量销毁重建,列表闪烁。
  // 结构不变只刷新列表(renderMessageList 内部 diff)。
  const alreadyRendered = panelEl.dataset.messagesRendered === '1'
    && panelEl.querySelector('#messages-list')
    && panelEl.querySelector('#messages-add');
  if (!alreadyRendered) {
    panelEl.dataset.messagesRendered = '1';
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
    `;
    // 按钮只在首次渲染时绑定,避免重复 addEventListener
    bindAddButton();
    bindArchiveToggle();
    bindBlockedToggle();
  }

  await renderMessageList();
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
  // 过滤:排除 workspace 频道群(在 state.channels 里,由 groupsPage 管理),
  // 保留单聊 + 用户手动创建的 core 群(不在 channels → 消息列表显示)。
  // 修复:原来用 !c.is_group 会把 core 群也排除,导致创建群后列表无入口。
  const wsChannelIds = new Set(state.channels.map((ch) => ch.chat_id));
  const isWsChannel = (c: ChatListItem): boolean => wsChannelIds.has(c.chat_id);
  const requests = chats.filter((c) => !showArchived && c.is_contact_request);
  const messages = chats.filter((c) =>
    showArchived
      ? c.is_archived && !isWsChannel(c) && !c.is_self_talk && !c.is_contact_request
      : !c.is_archived && !isWsChannel(c) && !c.is_self_talk && !c.is_contact_request
  );

  // 清掉每次刷新都要重建的节点:请求区 / 保存入口 / 空态。
  // (真正会话项走下方 data-id diff,不在此列 —— 避免重复渲染导致闪烁。)
  list.querySelectorAll<HTMLElement>(':scope > .nav-request-section, :scope > .saved-messages-entry, :scope > .ui-empty')
    .forEach((el) => el.remove());
  savedEntryRendered = false;

  // 陌生人来信:「新请求」分区置顶,接受/拒绝 (修复 contact request 被过滤不可见的 bug)
  if (!showArchived) await renderRequestSection(list, requests);

  // 「保存的消息」入口置顶渲染(仅常规视图;归档视图里保存的消息不是归档会话)
  if (!showArchived) await renderSavedMessagesEntry(list);

  if (messages.length === 0) {
    list.appendChild(ui.empty('暂无会话,点击 + 开始'));
    return;
  }

  // 会话列表 diff:发消息触发 MsgsChanged → refreshSidebar → 本函数。
  // 若每次都重建节点,整列会闪烁(元素销毁/重建 → 重排重绘)。
  // 改为:已有节点按 data-id 复用,只更新标题/摘要/未读/时间/激活态;
  // 新会话才创建节点,消失的会话才移除 —— 普通发消息时列表零重建,不闪。
  const existingEls = new Map<string, HTMLElement>();
  for (const el of Array.from(list.querySelectorAll<HTMLElement>('.ui-list-item'))) {
    const id = el.dataset.id;
    if (id) existingEls.set(id, el);
  }
  const desiredIds = new Set(messages.map((c) => String(c.chat_id)));
  for (const [id, el] of existingEls) {
    if (!desiredIds.has(id)) el.remove();
  }

  for (const c of messages) {
    const cid = String(c.chat_id);
    const existing = existingEls.get(cid);
    if (existing) {
      // 复用节点:更新标题/摘要/未读/时间/激活态,不重建。
      const titleEl = existing.querySelector('.ui-list-title');
      const subEl = existing.querySelector('.ui-list-sub');
      if (titleEl) titleEl.textContent = c.name;
      if (subEl) subEl.textContent = chatPreviewText(c).slice(0, 40);
      // 在线绿点:单聊复用节点时同步状态(上线/下线由 ContactsChanged 触发列表刷新)
      updateOnlineDot(existing, c);
      // 重建 trailing(未读数/时间) —— 尾部内容小,重建成本低
      let trailing = existing.querySelector('.nav-item-trailing');
      if (trailing) trailing.remove();
      trailing = buildTrailing(c);
      if (trailing) existing.appendChild(trailing);
      existing.classList.toggle('active', state.currentChatId === c.chat_id);
      continue;
    }

    const trailing = buildTrailing(c) ?? undefined;
    const item = ui.listItem({
      title: c.name,
      subtitle: chatPreviewText(c).slice(0, 40),
      trailing,
      onClick: async () => {
        state.currentChatId = c.chat_id;
        saveState();
        await renderMessagesPage(panel!);
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      },
    });
    // 会话头像:单聊 = 对方联系人头像/颜色(后端 build_chatlist 已解析);
    // 群聊/保存消息 = 会话自身图标。avatarUrl 需 await,故列表项先建再插入头像。
    // 单聊对方在线 → 头像右下角绿点 + hover 显示最后活跃时间。
    if (!item.querySelector('.ui-list-avatar')) {
      const av = document.createElement('span');
      av.className = 'ui-list-avatar';
      const letter = (c.name || '?').charAt(0).toUpperCase() || '?';
      const bg = colorHex(c.color);
      const img = c.avatar ? await transformBlobURL(c.avatar) : null;
      av.innerHTML = img
        ? `<img src="${escapeAttr(img)}" alt="" />`
        : `<span class="ui-avatar-letter" style="background:${bg}">${escapeHtml(letter)}</span>`;
      const wrap = document.createElement('span');
      wrap.className = 'nav-avatar-wrap';
      if (!c.is_group && !c.is_self_talk) {
        const online = isOnline(c.contact_last_seen);
        const dot = document.createElement('span');
        dot.className = `nav-online-dot${online ? ' on' : ''}`;
        if (online) {
          dot.title = `最后一次接收/发送时间：${lastSeenText(c.contact_last_seen)}`;
        }
        wrap.append(av, dot);
      } else {
        wrap.appendChild(av);
      }
      item.prepend(wrap);
    }
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
    item.dataset.id = cid;
    if (state.currentChatId === c.chat_id) item.classList.add('active');
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChatContextMenu(item, c);
    });
    list.appendChild(item);
  }
}

// 复用节点时同步单聊在线绿点:不存在则建,存在则仅切换 on 态与 tooltip。
function updateOnlineDot(item: HTMLElement, c: ChatListItem): void {
  if (c.is_group || c.is_self_talk) return;
  let wrap = item.querySelector<HTMLElement>('.nav-avatar-wrap');
  if (!wrap) return; // 无头像容器(异常),跳过
  let dot = wrap.querySelector<HTMLElement>('.nav-online-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'nav-online-dot';
    wrap.appendChild(dot);
  }
  const online = isOnline(c.contact_last_seen);
  dot.classList.toggle('on', online);
  dot.title = online ? `最后一次接收/发送时间：${lastSeenText(c.contact_last_seen)}` : '';
}

// 构建会话尾部(时间 + 未读数徽标),diff 复用时重建尾部
function buildTrailing(c: ChatListItem): HTMLElement | null {
  if (!c.last_ts && c.unread <= 0) return null;
  const trailing = document.createElement('div');
  trailing.className = 'nav-item-trailing';
  if (c.last_ts) {
    const t = document.createElement('span');
    t.className = 'nav-chat-time';
    t.textContent = formatTime(c.last_ts);
    trailing.appendChild(t);
  }
  if (c.unread > 0) trailing.appendChild(ui.badge({ text: String(c.unread) }));
  return trailing;
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
    placeholder: '粘贴邮箱 / 邀请链接 / 老 QR',
    confirmLabel: '加入',
    onConfirm: async (input) => {
      const raw = input.trim();
      try {
        // 统一走深链路由:邮箱→create_chat_by_email;peyt/i.delta.chat/OPENPGP4FPR→
        // normalize→secure_join;dcaccount/dclogin→登录预填。(复用唤起逻辑,一处维护)
        await import('../utils/deepLink.js').then(({ routeDeepLink }) => routeDeepLink(raw));
        await renderMessagesPage(panel!);
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

function showInlineGroupInput(): void {
  // 仿 Delta CreateGroup:名称/描述/头像/成员选择器统一在群创建对话框完成。
  void import('../components/group/createGroupDialog.js').then(({ openCreateGroupDialog }) => openCreateGroupDialog());
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
        if (isMailing) {
          void openMailingListProfile(c.chat_id, c);
          return;
        }
        void openChatProfile(c);
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

// 查看资料:1:1 会话渲染成员详情弹窗;群聊列出成员姓名/邮箱。
async function openChatProfile(c: ChatListItem): Promise<void> {
  try {
    const info = await call<{ members: MemberDto[] }>('get_chat_info', { chatId: c.chat_id });
    const members = info.members || [];
    if (c.is_group) {
      const rows = members.length
        ? members.map((m) => `
            <div class="ui-list-item">
              <div class="ui-list-meta">
                <div class="ui-list-title">${escapeHtml(m.name)}</div>
                ${m.addr ? `<div class="ui-list-sub">${escapeHtml(m.addr)}</div>` : ''}
              </div>
            </div>`).join('')
        : '<div style="padding:16px;color:var(--text-weak)">暂无成员</div>';
      ui.dialog({ title: c.name, body: `<div>${rows}</div>`, size: 'md' });
      return;
    }
    const other = members.find((m) => !m.is_self);
    if (!other) {
      ui.toast('暂无成员资料');
      return;
    }
    const dlg = ui.dialog({ title: '成员资料', body: '<div></div>', size: 'md' });
    const bodyEl = dlg.overlay.querySelector<HTMLElement>('.ui-dialog-body');
    if (bodyEl) {
      // renderMemberDetail 内部按 state.currentChatId 拉取成员,临时切换目标会话
      const prevChatId = state.currentChatId;
      state.currentChatId = c.chat_id;
      await renderMemberDetail(bodyEl, other.contact_id);
      state.currentChatId = prevChatId;
    }
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

