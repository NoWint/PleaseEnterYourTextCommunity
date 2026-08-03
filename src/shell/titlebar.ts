import { state } from '../state.js';

// macOS 顶栏(Overlay 标题栏条内)工具栏:上下文面包屑 + 全局搜索入口。
// 仅 html.window-overlay 生效;非 macOS 下 #titlebar-tools 隐藏,此模块为 no-op。
// 容器 pointer-events:none,除搜索按钮外不拦截窗口拖拽。

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
let resizeBound = false;

export function updateTitlebar(): void {
  if (!document.documentElement.classList.contains('window-overlay')) return;
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

  // 定位:有聊天区则锚定到聊天区(跟随抽屉开合);无聊天区(登录页等)隐藏工具栏
  const main = document.getElementById('chat-main');
  const rect = main?.getBoundingClientRect();
  if (!main || !rect || rect.width <= 0) {
    tools.style.display = 'none';
    return;
  }
  tools.style.display = 'flex';
  tools.style.left = `${Math.max(70, rect.left)}px`;
  tools.style.right = `${window.innerWidth - rect.right}px`;

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
}
