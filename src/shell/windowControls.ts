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
    // 还原态 = 双层方块;最大化态 = tdesign fullscreen 方框(24 viewBox 渲染 14px)
    maxBtn.innerHTML = isMax
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 9H9V5M19 9H15V5M19 15H15V19M5 15H9V19" stroke="currentColor" stroke-width="2" stroke-linecap="square"/><path d="M9 15H15V9" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 9H9V5M19 9H15V5M19 15H15V19M5 15H9V19" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
  };
  await updateMaxState();
  unlistenResize = await win.onResized(() => void updateMaxState());
}

export function cleanupWindowControls(): void {
  unlistenResize?.();
  unlistenResize = null;
}
