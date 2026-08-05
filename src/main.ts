import { call } from './api.js';
import { initTheme, initFontScale } from './theme.js';
import { setLocale, getLocale } from './i18n/index.js';
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
  setLocale(getLocale());
  // 无边框窗口平台标记(决定 CSS 显示哪种标题栏):
  // - macOS: titleBarStyle Overlay → 原生红绿灯悬浮,只留纯拖拽区(window-overlay)
  // - Windows/Linux: decorations:false → 自绘标题栏(标题 + 最小化/最大化/关闭)(window-frame)
  const ua = navigator.userAgent;
  if (/(Macintosh|Mac OS X|MacIntel)/.test(ua)) {
    document.documentElement.classList.add('window-overlay');
  } else if (/(Win|Windows)/.test(ua) || /(Linux|X11)/.test(ua)) {
    document.documentElement.classList.add('window-frame');
    // 自绘标题栏:绑定窗口控制按钮(最小化/最大化/关闭)
    void import('./shell/windowControls.js').then((m) => m.initWindowControls());
  }
  // 深链:注册事件监听(唤起/冷启动 URL 都经 dc-event DeepLink 分发)
  void import('./utils/deepLink.js').then(({ registerDeepLinkListener }) => registerDeepLinkListener());

  const configured = await call<boolean>('is_configured');
  if (configured) {
    await renderShell();
    // 已配置账号: 静默确保 PEYT Studio 存在 (existing/founder)
    await ensurePeytStudio();
    // 冷启动补收:启动早于事件注册时的深链
    void import('./utils/deepLink.js').then(({ processPendingDeepLink }) => processPendingDeepLink());
  } else {
    const { renderLogin } = await import('./views/login.js');
    renderLogin(async () => {
      await renderShell();
      // 首次登录: 创建 PEYT Studio, founder 显示 nav banner 欢迎指引
      await ensurePeytStudio();
      // 登录后处理暂存的深链(dclogin 预填 / 邀请)
      void import('./utils/deepLink.js').then(({ processPendingDeepLink }) => processPendingDeepLink());
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
