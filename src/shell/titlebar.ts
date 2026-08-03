import { getCurrentWindow } from '@tauri-apps/api/window';

// 顶栏工具栏:VSCode 式居中长条全局搜索(macOS / Windows 都有)。
// Windows/Linux 另有自绘窗口控制按钮(独立固定右上角,见 index.html / styles.css)。

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

  // 有 shell(聊天区)才显示;登录页隐藏
  const main = document.getElementById('chat-main');
  const rect = main?.getBoundingClientRect();
  tools.style.display = main && rect && rect.width > 0 ? 'flex' : 'none';

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
