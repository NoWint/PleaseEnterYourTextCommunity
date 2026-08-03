// 命令面板 — 对齐 Delta CommandPalette / VS Code Palette。
// Cmd/Ctrl+P 打开（快捷键由主 Agent 在 shell.ts 接入）,模糊搜索命令,键盘导航执行。
// 键盘:ArrowUp/Down 移动选中,Enter 执行,Esc 关闭;点击浮层空白处关闭。
// 样式策略:复用 styles.css 的 .overlay / .search-dialog / .sr-item.sr-command 等类,
// 仅注入极少量 .command-palette-overlay 定位与关闭动画（首次打开时挂到 <head>,不改 styles.css）。
import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg, type IconName } from './icon.js';
import { ui } from './ui.js';
import type { Page, CurrentView } from '../types.js';

interface CommandItem {
  label: string;
  icon: IconName;
  hint?: string;
  action: () => void | Promise<void>;
}

let paletteOpen = false;
let selectedIndex = 0;
let filterTimer: ReturnType<typeof setTimeout> | null = null;

function buildCommands(): CommandItem[] {
  return [
    { label: '新建私聊', icon: 'user', action: () => newDirectChat() },
    { label: '新建群', icon: 'users', action: () => newGroup() },
    { label: '切换看板视图', icon: 'layout-grid', action: () => switchView('kanban') },
    { label: '切换列表视图', icon: 'list', action: () => switchView('list') },
    { label: '切换日历视图', icon: 'calendar', action: () => switchView('calendar') },
    { label: '切换时间线视图', icon: 'clock', action: () => switchView('timeline') },
    { label: '外观设置', icon: 'palette', action: () => openAppearance() },
    { label: '跳转消息', icon: 'message-circle', action: () => navigateToPage('messages') },
    { label: '跳转群组', icon: 'users', action: () => navigateToPage('groups') },
    { label: '跳转协作', icon: 'layout-grid', action: () => navigateToPage('work') },
    { label: '跳转 Inbox', icon: 'inbox', action: () => navigateToPage('inbox') },
    { label: '跳转设置', icon: 'settings', action: () => navigateToPage('settings') },
    { label: '归档当前会话', icon: 'inbox', action: () => archiveCurrentChat() },
    { label: '标记所有 Inbox 已读', icon: 'check', action: () => markAllInboxRead() },
  ];
}

// ── 命令实现 ──────────────────────────────────────────

async function newDirectChat(): Promise<void> {
  ui.inputDialog({
    title: '新建私聊',
    placeholder: '输入对方邮箱地址',
    type: 'email',
    confirmLabel: '开始私聊',
    onConfirm: async (email) => {
      const chatId = await call<number>('create_chat_by_email', { email });
      state.currentChatId = chatId;
      state.currentPage = 'messages';
      saveState();
      await navigateToPage('messages');
    },
  });
}

async function newGroup(): Promise<void> {
  ui.inputDialog({
    title: '新建群',
    placeholder: '输入群名称',
    confirmLabel: '创建',
    onConfirm: async (name) => {
      const chatId = await call<number>('create_group_chat', { name });
      state.currentChatId = chatId;
      state.currentPage = 'messages';
      saveState();
      await navigateToPage('messages');
    },
  });
}

async function archiveCurrentChat(): Promise<void> {
  const chatId = state.currentChatId;
  if (chatId == null) {
    ui.toast('当前没有打开会话');
    return;
  }
  try {
    await call('archive_chat', { chatId, archive: true });
    ui.toast('已归档');
    state.currentChatId = null;
    saveState();
    await navigateToPage(state.currentPage);
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
}

async function markAllInboxRead(): Promise<void> {
  try {
    await call('mark_all_inbox_read');
    state.inboxUnread = 0;
  } catch (e) {
    console.error('mark_all_inbox_read failed:', e);
  }
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

// ── 浮层 ──────────────────────────────────────────────

/** 首次打开时注入专属样式（只挂一次,不触碰 styles.css）。 */
function ensureStyles(): void {
  if (document.getElementById('command-palette-css')) return;
  const style = document.createElement('style');
  style.id = 'command-palette-css';
  style.textContent = `
.command-palette-overlay { align-items: flex-start; padding-top: 60px; }
.command-palette-overlay.closing { animation: fade-out 120ms ease-in forwards; }
`;
  document.head.appendChild(style);
}

export function openCommandPalette(): void {
  if (paletteOpen) return;
  paletteOpen = true;
  selectedIndex = 0;
  ensureStyles();

  const overlay = document.createElement('div');
  overlay.className = 'overlay command-palette-overlay';
  overlay.id = 'command-palette-overlay';
  overlay.innerHTML = `
    <div class="search-dialog">
      <input id="palette-input" placeholder="输入命令..." autocomplete="off" />
      <div id="palette-results" class="search-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>('#palette-input');
  input?.focus();
  // 防抖 150ms 过滤命令;空查询显示全部
  input?.addEventListener('input', () => {
    if (filterTimer) clearTimeout(filterTimer);
    const val = input.value;
    filterTimer = setTimeout(() => { renderCommands(val.trim()); }, 150);
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateSelected();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
    }
  });
  // 点击浮层空白处关闭（点对话框本体不关）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommandPalette();
  });

  renderCommands('');
}

export function closeCommandPalette(): void {
  if (!paletteOpen) return;
  paletteOpen = false;
  if (filterTimer) {
    clearTimeout(filterTimer);
    filterTimer = null;
  }
  const overlay = document.getElementById('command-palette-overlay');
  if (overlay) {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 120);
  }
}

// ── 过滤 / 渲染 / 键盘导航 ───────────────────────────

function renderCommands(q: string): void {
  const resultsEl = document.getElementById('palette-results');
  if (!resultsEl) return;
  selectedIndex = 0;
  const lower = q.toLowerCase();
  const allCommands = buildCommands();
  // 空查询显示全部,非空时按 label 模糊匹配
  const matched = q
    ? allCommands.filter((c) => c.label.toLowerCase().includes(lower))
    : allCommands;
  if (matched.length === 0) {
    resultsEl.innerHTML = `<div class="sr-empty">无匹配命令</div>`;
    return;
  }
  const items = matched
    .map((c) => {
      const cmdIdx = allCommands.indexOf(c);
      const hint = c.hint ? `<span class="sr-hint">${escapeHtml(c.hint)}</span>` : '';
      return `<div class="sr-item sr-command" data-cmd-idx="${cmdIdx}">
        <span class="sr-icon">${iconSvg(c.icon, { width: 14, height: 14, strokeWidth: 1.5 })}</span>
        <span class="sr-content">${escapeHtml(c.label)}</span>
        ${hint}
      </div>`;
    })
    .join('');
  resultsEl.innerHTML = items;
  bindResults(resultsEl);
  const els = resultsEl.querySelectorAll<HTMLElement>('.sr-item');
  if (els.length > 0) updateSelection(els);
}

function moveSelection(delta: number): void {
  const items = document.querySelectorAll<HTMLElement>('#palette-results .sr-item');
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
  const items = document.querySelectorAll<HTMLElement>('#palette-results .sr-item');
  const el = items[selectedIndex];
  if (el) el.click();
}

function bindResults(resultsEl: HTMLElement): void {
  const commands = buildCommands();
  resultsEl.querySelectorAll<HTMLElement>('.sr-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const idx = Number(el.dataset.cmdIdx);
      const cmd = commands[idx];
      if (cmd) {
        closeCommandPalette();
        await cmd.action();
      }
    });
  });
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
