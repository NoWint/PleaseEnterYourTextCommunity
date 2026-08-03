import { call } from './api.js';
import { initTheme, initFontScale } from './theme.js';
import { renderShell } from './shell/shell.js';
import { state } from './state.js';
import { saveState } from './persist.js';
import { createNavBanner } from './components/navBanner.js';
import { renderRail } from './shell/rail.js';
import { renderNavPanel } from './shell/navPanel.js';

interface EnsurePeytResult {
  role: string;
  invite_qr?: string;
}

async function boot(): Promise<void> {
  initTheme();
  initFontScale();
  // macOS Overlay 标题栏:原生三色按钮浮在内容上,标记 <html> 以便 CSS 预留拖拽区与顶部间距
  if (/(Macintosh|Mac OS X|MacIntel)/.test(navigator.userAgent)) {
    document.documentElement.classList.add('window-overlay');
  }
  const configured = await call<boolean>('is_configured');
  if (configured) {
    await renderShell();
    // 已配置账号: 静默确保 PEYT Studio 存在 (existing/founder)
    await ensurePeytStudio();
  } else {
    const { renderLogin } = await import('./views/login.js');
    renderLogin(async () => {
      await renderShell();
      // 首次登录: 创建 PEYT Studio, founder 显示 nav banner 欢迎指引
      await ensurePeytStudio();
    });
  }
}

async function ensurePeytStudio(): Promise<void> {
  try {
    const r = await call<EnsurePeytResult>('ensure_peyt_studio');
    // founder 且未关闭过 banner → 显示 PEYT Studio 欢迎指引(替代 peytInvite 弹窗)
    if (r.role === 'founder' && !state.peytBannerDismissed) {
      showPeytBanner(r.invite_qr || '');
    }
  } catch (e) {
    console.warn('[peyt] ensure failed', e);
  }
}

// Task 16: 首次登录 PEYT Studio 欢迎流程 — 在 nav panel 顶部插入 nav banner。
// founder 可复制邀请链接分享给同事,或点击"查看频道"跳转到 groups 页。
// 关闭 banner 后持久化 peytBannerDismissed,后续不再显示。
function showPeytBanner(inviteLink: string): void {
  const panel = document.getElementById('channel-tree');
  if (!panel) return;
  const banner = createNavBanner({
    title: 'PEYT Studio 已就绪',
    subtitle: '分享邀请链接给同事加入',
    inviteLink,
    onViewChannels: () => {
      state.currentPage = 'groups';
      saveState();
      void renderRail().then(() => {
        void renderNavPanel();
      });
    },
    onDismiss: () => {
      state.peytBannerDismissed = true;
      saveState();
    },
  });
  panel.insertBefore(banner, panel.firstChild);
}

boot();
