import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { iconSvg } from '../components/icon.js';
import { showDropdown, type DropdownItem } from '../components/dropdown.js';
import { createInlineInput } from '../components/inlineInput.js';
import { renderAvatarHtml } from '../components/avatar.js';
import type { ChatListItem } from '../types.js';

let panel: HTMLElement | null = null;

export async function renderMessagesPage(panelEl: HTMLElement): Promise<void> {
  panel = panelEl;
  const avatarHtml = state.self ? await renderAvatarHtml(state.self) : '';
  panelEl.innerHTML = `
    <div class="nav-header">
      <div class="nav-title">消息</div>
      <div class="nav-subtitle">私聊与非 workspace 群</div>
      <button class="nav-add-btn" id="messages-add" title="新建">${iconSvg('plus', { width: 18, height: 18 })}</button>
    </div>
    <div class="nav-list" id="messages-list"></div>
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
}

async function renderMessageList(): Promise<void> {
  const list = document.getElementById('messages-list');
  if (!list) return;
  let chats: ChatListItem[] = [];
  try {
    chats = await call<ChatListItem[]>('get_chatlist');
  } catch {
    chats = [];
  }
  const wsChatIds = new Set<number>();
  for (const ws of state.workspaces) {
    wsChatIds.add(ws.master_chat_id);
    for (const ch of state.channels) {
      if (ch.workspace_id === ws.id) wsChatIds.add(ch.chat_id);
    }
  }
  const messages = chats.filter((c) => !wsChatIds.has(c.chat_id));

  if (messages.length === 0) {
    list.innerHTML = `<div class="nav-empty">暂无会话,点击 + 开始</div>`;
    return;
  }

  const items = await Promise.all(messages.map(async (c) => {
    const time = c.last_ts ? formatTime(c.last_ts) : '';
    const unread = c.unread > 0 ? `<span class="nav-unread">${c.unread}</span>` : '';
    return `<div class="nav-chat-item ${state.currentChatId === c.chat_id ? 'active' : ''}" data-id="${c.chat_id}">
      <div class="nav-chat-name">${escapeHtml(c.name)}</div>
      <div class="nav-chat-preview">${escapeHtml(c.last_msg?.slice(0, 40) || '')}</div>
      <div class="nav-chat-time">${time}</div>
      ${unread}
    </div>`;
  }));
  list.innerHTML = items.join('');

  list.querySelectorAll<HTMLElement>('.nav-chat-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = Number(el.dataset.id);
      state.currentChatId = id;
      saveState();
      await renderMessagesPage(panel!);
      const { renderMain } = await import('../shell/navPanel.js');
      await renderMain();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChatContextMenu(el);
    });
  });
}

function bindAddButton(): void {
  const btn = document.getElementById('messages-add');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const items: DropdownItem[] = [
      { label: '添加好友(邮箱)', icon: 'user', action: () => showInlineEmailInput() },
      { label: '通过 QR 加入', icon: 'hash', action: () => showInlineQrInput() },
      { label: '创建群', icon: 'users', action: () => showInlineGroupInput() },
      { label: '加入 PEYT Studio', icon: 'layout-grid', action: () => { void joinPeytStudio(); } },
    ];
    showDropdown(btn as HTMLElement, items, { position: 'bottom-left' });
  });
}

function showInlineEmailInput(): void {
  const list = document.getElementById('messages-list');
  if (!list) return;
  const input = createInlineInput({
    placeholder: '输入邮箱地址',
    confirmLabel: '添加',
    onConfirm: async (email) => {
      try {
        const chatId = await call<number>('create_chat_by_email', { email });
        state.currentChatId = chatId;
        saveState();
        await renderMessagesPage(panel!);
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    onCancel: () => { void renderMessagesPage(panel!); },
  });
  list.insertBefore(input, list.firstChild);
}

function showInlineQrInput(): void {
  const list = document.getElementById('messages-list');
  if (!list) return;
  const input = createInlineInput({
    placeholder: '粘贴 QR 邀请链接',
    confirmLabel: '加入',
    onConfirm: async (qr) => {
      try {
        await call('secure_join', { qr });
        await renderMessagesPage(panel!);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    onCancel: () => { void renderMessagesPage(panel!); },
  });
  list.insertBefore(input, list.firstChild);
}

function showInlineGroupInput(): void {
  const list = document.getElementById('messages-list');
  if (!list) return;
  const input = createInlineInput({
    placeholder: '输入群名称',
    confirmLabel: '创建',
    onConfirm: async (name) => {
      try {
        const chatId = await call<number>('create_group_chat', { name });
        state.currentChatId = chatId;
        saveState();
        await renderMessagesPage(panel!);
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    onCancel: () => { void renderMessagesPage(panel!); },
  });
  list.insertBefore(input, list.firstChild);
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
    showToast(e instanceof Error ? e.message : String(e));
  }
}

function showChatContextMenu(anchor: HTMLElement): void {
  const id = Number(anchor.dataset.id);
  const items: DropdownItem[] = [
    { label: '查看资料', icon: 'user', action: () => showToast('查看资料(开发中)') },
    {
      label: '屏蔽',
      icon: 'volume-x',
      action: async () => {
        try {
          await call('block_chat', { chatId: id });
          showToast('已屏蔽');
          await renderMessagesPage(panel!);
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      label: '删除会话',
      icon: 'trash',
      danger: true,
      action: async () => {
        try {
          await call('delete_chat', { chatId: id });
          if (state.currentChatId === id) {
            state.currentChatId = null;
            saveState();
          }
          showToast('已删除');
          await renderMessagesPage(panel!);
          const { renderMain } = await import('../shell/navPanel.js');
          await renderMain();
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
  showDropdown(anchor, items, { position: 'bottom-right' });
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

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
