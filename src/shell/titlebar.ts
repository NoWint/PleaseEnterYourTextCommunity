// 顶栏工具栏:VSCode 式居中长条全局搜索(macOS / Windows 都有)。
// Windows/Linux 的窗口控制按钮由 windowControls.ts 单独绑定(见 shell/windowControls.ts)。

let searchBound = false;
let resizeBound = false;

export function updateTitlebar(): void {
  const root = document.documentElement;
  const isMac = root.classList.contains('window-overlay');
  const isWin = root.classList.contains('window-frame');
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
}
