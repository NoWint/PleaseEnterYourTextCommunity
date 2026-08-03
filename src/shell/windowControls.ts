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
    // 还原态 = 单方块;最大化态 = 双层方块(表示可还原)
    maxBtn.innerHTML = isMax
      ? '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="2.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1.1"/><path d="M3.5 3V2.5H8.5V7.5H8" stroke="currentColor" stroke-width="1.1"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1.5" width="8" height="8" stroke="currentColor" stroke-width="1.1"/></svg>';
  };
  await updateMaxState();
  unlistenResize = await win.onResized(() => void updateMaxState());
}

export function cleanupWindowControls(): void {
  unlistenResize?.();
  unlistenResize = null;
}
