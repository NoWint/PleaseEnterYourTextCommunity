import { state } from '../state.js';
import { getCurrentWindow } from '@tauri-apps/api/window';

// 顶栏工具栏(上下文面包屑 + VSCode 式居中搜索条):macOS / Windows 都有。
// Windows/Linux 另有自绘窗口控制按钮(独立固定右上角,见 index.html / styles.css)。

const PAGE_LABELS: Record<string, string> = {
  messages: '消息',
  groups: '群组',
  work: '协作',
  inbox: '通知',
  bots: '机器人',
  plugins: '插件',
  settings: '设置',
  debug: '调试',
};

let searchBound = false;
let wcBound = false;
let resizeBound = false;

export function updateTitlebar(): void {
  const root = document.documentElement;
  const isMac = root.classList.contains('window-overlay');
  const isWin = root.classList.contains('windows');
  if (!isMac && !isWin) return;

  const tools = document.getElementById('titlebar-tools');
  if (!tools) return;

  // 上下文面包屑:工作区 › 页面 › 当前频道
  const ctx = tools.querySelector<HTMLElement>('#titlebar-context');
  if (ctx) {
    const ws = state.workspaces.find((w) => w.id === state.currentWsId);
    const pageLabel = PAGE_LABELS[state.currentPage] || state.currentPage;
    let text = pageLabel;
    if (ws?.name) text = `${ws.name} › ${pageLabel}`;
    if (
      (state.currentPage === 'messages' || state.currentPage === 'groups') &&
      state.currentChatId != null
    ) {
      const ch = state.channels.find((c) => c.chat_id === state.currentChatId);
      if (ch?.name) text += ` › ${ch.name}`;
    }
    ctx.textContent = text;
    ctx.title = text;
  }

  // 定位:
  // - macOS:锚定到聊天区(跟随抽屉开合),给红绿灯留位
  // - Windows:占满宽度(窗口控制按钮独立固定右上角)
  const main = document.getElementById('chat-main');
  const rect = main?.getBoundingClientRect();
  if (!main || !rect || rect.width <= 0) {
    tools.style.display = 'none';
  } else {
    tools.style.display = 'flex';
    if (isMac) {
      tools.style.left = `${Math.max(70, rect.left)}px`;
      tools.style.right = `${window.innerWidth - rect.right}px`;
    } else {
      tools.style.left = '0px';
      tools.style.right = '0px';
    }
  }

  if (!resizeBound) {
    resizeBound = true;
    window.addEventListener('resize', () => updateTitlebar());
  }
  if (!searchBound) {
    const search = tools.querySelector<HTMLElement>('#titlebar-search');
    if (search) {
      searchBound = true;
      search.addEventListener('click', () => {
        void import('../components/search.js').then(({ openSearch }) => openSearch());
      });
    }
  }
  if (!wcBound) {
    const wc = document.getElementById('window-controls');
    if (wc) {
      wcBound = true;
      const win = getCurrentWindow();
      wc.querySelector('[data-wc="min"]')?.addEventListener('click', () => void win.minimize());
      wc.querySelector('[data-wc="max"]')?.addEventListener('click', () => void win.toggleMaximize());
      wc.querySelector('[data-wc="close"]')?.addEventListener('click', () => void win.close());
    }
  }
}
