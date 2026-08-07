// 自绘标题栏窗口控制按钮绑定(Windows/Linux 无边框窗口)。
// macOS 走 Overlay 原生红绿灯,不创建这些按钮,本模块仅在有 #wb-* 按钮时生效。

type TauriWindowModule = typeof import('@tauri-apps/api/window');
type WindowHandle = import('@tauri-apps/api/window').Window;

let unlistenResize: (() => void) | null = null;

export async function initWindowControls(): Promise<void> {
  const minBtn = document.getElementById('wb-min');
  const maxBtn = document.getElementById('wb-max');
  const closeBtn = document.getElementById('wb-close');
  if (!minBtn || !maxBtn || !closeBtn) return;

  let win: WindowHandle;
  let tauriWin: TauriWindowModule;
  try {
    tauriWin = await import('@tauri-apps/api/window');
    win = tauriWin.getCurrentWindow();
  } catch (e) {
    console.error('[window-controls] tauri api unavailable:', e);
    return;
  }

  minBtn.addEventListener('click', () => void win.minimize());
  maxBtn.addEventListener('click', () => void win.toggleMaximize());
  closeBtn.addEventListener('click', () => void win.close());

  // 最大化/还原图标切换:窗口 resize 时更新 max 按钮的 title 与图形状态
  const updateMaxState = async (): Promise<void> => {
    const isMax = await win.isMaximized().catch(() => false);
    maxBtn.title = isMax ? '还原' : '最大化';
    maxBtn.setAttribute('aria-label', isMax ? '还原' : '最大化');
    // 还原态 = 用户指定嵌套方框(1024 viewBox);最大化态 = 手绘单方块(与 index.html 一致)
    maxBtn.innerHTML = isMax
      ? '<svg width="12" height="12" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M768 170.666667h-341.333333c-46.933333 0-85.333333 38.4-85.333334 85.333333v85.333333H256c-46.933333 0-85.333333 38.4-85.333333 85.333334v341.333333c0 46.933333 38.4 85.333333 85.333333 85.333333h341.333333c46.933333 0 85.333333-38.4 85.333334-85.333333v-85.333333h85.333333c46.933333 0 85.333333-38.4 85.333333-85.333334V256c0-46.933333-38.4-85.333333-85.333333-85.333333zM256 768v-341.333333h341.333333v341.333333H256z m512-170.666667h-85.333333v-170.666666c0-46.933333-38.4-85.333333-85.333334-85.333334h-170.666666V256h341.333333v341.333333z" fill="currentColor" p-id="1710"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.2"/></svg>';
  };
  await updateMaxState();
  unlistenResize = await win.onResized(() => void updateMaxState());
}

export function cleanupWindowControls(): void {
  unlistenResize?.();
  unlistenResize = null;
}
