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
    // 还原态 = 双层方块;最大化态 = 单方块(与 index.html 图标同风格:12px 画布 + 圆角 + 圆帽)
    maxBtn.innerHTML = isMax
      ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="3" y="1.5" width="7.5" height="7.5" rx="1.6" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 4.5h2.2V2.3h3.2v3.2H7.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.2"/></svg>';
  };
  await updateMaxState();
  unlistenResize = await win.onResized(() => void updateMaxState());
}

export function cleanupWindowControls(): void {
  unlistenResize?.();
  unlistenResize = null;
}
