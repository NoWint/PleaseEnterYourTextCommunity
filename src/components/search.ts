import { call } from '../api.js';
import { state } from '../state.js';
import { renderChatView } from '../chat/chatView.js';
import { iconSvg, type IconName } from './icon.js';
import { saveState } from '../persist.js';
import { escapeHtml } from './escape.js';
import type { Page, CurrentView } from '../types.js';

interface SearchResult {
  chat_id: number;
  msg_id: number;
  chat_name: string;
  from_name: string;
  text: string;
}

interface ChatInfo {
  members: MemberInfo[];
}

interface MemberInfo {
  contact_id: number;
  name: string;
}

interface CommandItem {
  label: string;
  icon: IconName;
  hint?: string;
  action: () => void | Promise<void>;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let selectedIndex = 0;
// 非 null 表示「会话内搜索」模式（chatView 头部按钮进入），只在当前会话内搜索消息
let chatSearchChatId: number | null = null;

function buildCommands(): CommandItem[] {
  return [
    { label: '跳转消息', icon: 'message-circle', action: () => navigateToPage('messages') },
    { label: '跳转群组', icon: 'users', action: () => navigateToPage('groups') },
    { label: '跳转协作', icon: 'layout-grid', action: () => navigateToPage('work') },
    { label: '跳转 Inbox', icon: 'inbox', action: () => navigateToPage('inbox') },
    { label: '跳转设置', icon: 'settings', action: () => navigateToPage('settings') },
    { label: '切换看板视图', icon: 'layout-grid', action: () => switchView('kanban') },
    { label: '切换列表视图', icon: 'list', action: () => switchView('list') },
    { label: '切换日历视图', icon: 'calendar', action: () => switchView('calendar') },
    { label: '切换时间线视图', icon: 'clock', action: () => switchView('timeline') },
    { label: '外观设置', icon: 'palette', action: () => openAppearance() },
    { label: '标记所有 Inbox 已读', icon: 'check', action: () => markAllInboxRead() },
  ];
}

function openAppearance(): void {
  state.currentSettingsSection = 'appearance';
  navigateToPage('settings').catch((e) => console.error(e));
}

async function navigateToPage(page: Page): Promise<void> {
  state.currentPage = page;
  if (page !== 'settings') {
    state.currentSettingsSection = 'account';
  }
  saveState();
  const { renderRail } = await import('../shell/rail.js');
  await renderRail();
  const { renderNavPanel } = await import('../shell/navPanel.js');
  await renderNavPanel();
  const { renderRightDrawer } = await import('../shell/rightDrawer.js');
  renderRightDrawer();
  const { renderMain } = await import('../shell/navPanel.js');
  await renderMain();
}

async function switchView(view: CurrentView): Promise<void> {
  state.currentView = view;
  saveState();
  const { renderMain } = await import('../shell/navPanel.js');
  await renderMain();
}

async function markAllInboxRead(): Promise<void> {
  try {
    await call('mark_all_inbox_read');
    state.inboxUnread = 0;
  } catch (e) {
    console.error('mark_all_inbox_read failed:', e);
  }
}

export function openSearch(): void {
  if (state.searchOpen) return;
  state.searchOpen = true;
  selectedIndex = 0;
  const overlay = document.createElement('div');
  overlay.className = 'overlay search-overlay';
  overlay.style.display = 'flex';
  overlay.id = 'search-overlay';
  overlay.innerHTML = `
    <div class="search-dialog">
      <input id="search-input" placeholder="${chatSearchChatId != null ? '搜索此会话...' : '搜索或输入命令...'}" autocomplete="off" />
      <div id="search-results" class="search-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector<HTMLInputElement>('#search-input');
  input?.focus();
  input?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    const val = input.value;
    searchTimer = setTimeout(() => { void doSearch(val.trim()); }, 200);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateSelected();
    }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSearch();
  });
  // 初始展示命令分组
  void doSearch('');
}

// 会话内搜索：chatView 头部搜索按钮调用。设置 chatSearchChatId 使 doSearch
// 只搜当前会话，并复用 openSearch() 打开浮层（placeholder 显示「搜索此会话...」）
export function openChatSearch(chatId: number): void {
  chatSearchChatId = chatId;
  openSearch();
}

export function closeSearch(): void {
  chatSearchChatId = null;
  const overlay = document.getElementById('search-overlay');
  if (overlay) {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 150);
  }
  state.searchOpen = false;
}

async function doSearch(q: string): Promise<void> {
  const resultsEl = document.getElementById('search-results');
  if (!resultsEl) return;
  selectedIndex = 0;
  const lower = q.toLowerCase();
  const sections: string[] = [];

  // 命令分组：query 为空时显示全部命令，非空时显示匹配命令
  const allCommands = buildCommands();
  const matchedCommands = q
    ? allCommands.filter((c) => c.label.toLowerCase().includes(lower))
    : allCommands;
  if (matchedCommands.length > 0) {
    const items = matchedCommands
      .map((c) => {
        const cmdIdx = allCommands.indexOf(c);
        const hint = c.hint ? `<span class="sr-hint">${escapeHtml(c.hint)}</span>` : '';
        return `<div class="sr-item sr-command" data-type="command" data-cmd-idx="${cmdIdx}">
          <span class="sr-icon">${iconSvg(c.icon, { width: 14, height: 14, strokeWidth: 1.5 })}</span>
          <span class="sr-content">${escapeHtml(c.label)}</span>
          ${hint}
        </div>`;
      })
      .join('');
    sections.push(`<div class="sr-section">命令</div>${items}`);
  }

  // 仅当 q 非空时执行消息/频道/成员搜索
  if (q) {
    try {
      const results = await call<SearchResult[]>('search_msgs', { query: q, chatId: chatSearchChatId ?? undefined });
      if (results && results.length > 0) {
        const items = results
          .map(
            (r) =>
              `<div class="sr-item" data-type="msg" data-chat="${r.chat_id}" data-id="${r.msg_id}"><span class="sr-type">${escapeHtml(r.chat_name)}</span><span class="sr-content">${escapeHtml(r.from_name)}: ${escapeHtml(r.text)}</span></div>`
          )
          .join('');
        sections.push(`<div class="sr-section">消息 (${results.length})</div>${items}`);
      }
    } catch (e) {
      console.error('search_msgs failed:', e);
    }
    const chanMatches = (state.channels || [])
      .filter((c) => (c.name || '').toLowerCase().includes(lower))
      .slice(0, 5);
    if (chanMatches.length > 0) {
      const items = chanMatches
        .map(
          (c) =>
            `<div class="sr-item" data-type="channel" data-id="${c.chat_id}"><span class="sr-type">频道</span><span class="sr-content">#${escapeHtml(c.name)}</span></div>`
        )
        .join('');
      sections.push(`<div class="sr-section">频道</div>${items}`);
    }
    try {
      if (state.currentChatId) {
        const info = await call<ChatInfo>('get_chat_info', { chatId: state.currentChatId });
        const memMatches = (info.members || [])
          .filter((m) => (m.name || '').toLowerCase().includes(lower))
          .slice(0, 5);
        if (memMatches.length > 0) {
          const items = memMatches
            .map(
              (m) =>
                `<div class="sr-item" data-type="member" data-id="${m.contact_id}"><span class="sr-type">成员</span><span class="sr-content">${escapeHtml(m.name)}</span></div>`
            )
            .join('');
          sections.push(`<div class="sr-section">成员</div>${items}`);
        }
      }
    } catch {}
  }

  resultsEl.innerHTML = sections.join('') || `<div class="sr-empty">无结果</div>`;
  bindSearchResults();
  // 重置选中到第一项
  const items = resultsEl.querySelectorAll<HTMLElement>('.sr-item');
  if (items.length > 0) {
    updateSelection(items);
  }
}

function moveSelection(delta: number): void {
  const items = document.querySelectorAll<HTMLElement>('#search-results .sr-item');
  if (items.length === 0) return;
  selectedIndex = (selectedIndex + delta + items.length) % items.length;
  updateSelection(items);
}

function updateSelection(items: NodeListOf<HTMLElement>): void {
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === selectedIndex);
  });
  const sel = items[selectedIndex];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function activateSelected(): void {
  const items = document.querySelectorAll<HTMLElement>('#search-results .sr-item');
  const el = items[selectedIndex];
  if (el) el.click();
}

function bindSearchResults(): void {
  const resultsEl = document.getElementById('search-results');
  if (!resultsEl) return;
  const commands = buildCommands();
  resultsEl.querySelectorAll<HTMLElement>('.sr-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const type = el.dataset.type || '';
      const id = el.dataset.id || '';
      if (type === 'command') {
        const idx = Number(el.dataset.cmdIdx);
        const cmd = commands[idx];
        if (cmd) {
          closeSearch();
          await cmd.action();
        }
      } else if (type === 'channel') {
        state.currentChatId = Number(id);
        closeSearch();
        await renderChatView(Number(id));
      } else if (type === 'msg') {
        const chatId = el.dataset.chat ? Number(el.dataset.chat) : state.currentChatId;
        if (chatId != null) {
          state.currentChatId = chatId;
          closeSearch();
          // chatView 是虚拟化渲染，目标消息可能在视口外，querySelector 找不到 →
          // 改调 chatView 的 jumpToMessage(msgId)：渲染、滚动并临时高亮。
          // 该函数由主 Agent 在 chatView.ts 暴露，尚未实现前走旧逻辑兜底。
          const mod = (await import('../chat/chatView.js')) as unknown as {
            jumpToMessage?: (msgId: number) => Promise<void>;
          };
          const jumpToMessage = mod.jumpToMessage;
          if (jumpToMessage) {
            await jumpToMessage(Number(id));
          } else {
            await renderChatView(chatId);
            const msgEl = document.querySelector(`[data-msg="${id}"]`);
            if (msgEl) {
              msgEl.scrollIntoView({ behavior: 'smooth' });
              (msgEl as HTMLElement).style.background = 'var(--active)';
              setTimeout(() => {
                (msgEl as HTMLElement).style.background = '';
              }, 2000);
            }
          }
        }
      } else if (type === 'member') {
        closeSearch();
        state.rightDrawerOpen = true;
        state.detailTab = 'members';
        const { renderRightDrawer } = await import('../shell/rightDrawer.js');
        renderRightDrawer();
        setTimeout(async () => {
          const body = document.getElementById('rd-body');
          if (body) {
            const { renderMemberDetail } = await import('./memberDetail.js');
            await renderMemberDetail(body, Number(id));
          }
        }, 100);
      }
    });
  });
}
