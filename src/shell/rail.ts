import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { showDropdown } from '../components/dropdown.js';
import type { Page, WorkspaceDto } from '../types.js';

export async function refreshWorkspaces(): Promise<void> {
  try {
    state.workspaces = await call<WorkspaceDto[]>('list_workspaces');
  } catch {}
}

export async function renderRail(): Promise<void> {
  const rail = document.getElementById('ws-rail');
  if (!rail) return;
  rail.className = 'rail';

  const pages: Array<{ page: Page; icon: IconName; label: string; badge?: number }> = [
    { page: 'messages', icon: 'message-circle', label: '消息' },
    { page: 'groups', icon: 'users', label: '群组' },
    { page: 'work', icon: 'layout-grid', label: '协作' },
    { page: 'inbox', icon: 'inbox', label: '通知', badge: state.inboxUnread },
  ];

  const pageIconsHtml = pages.map((p) => {
    const active = state.currentPage === p.page ? 'active' : '';
    const badge = (p.badge ?? 0) > 0
      ? `<span class="rail-badge">${(p.badge! > 99) ? '99+' : p.badge}</span>`
      : '';
    return `<div class="rail-icon ${active}" data-page="${p.page}" title="${p.label}">
      ${iconSvg(p.icon, { width: 24, height: 24, strokeWidth: 1.5 })}
      ${badge}
    </div>`;
  }).join('');

  // 插件入口 — 位于协作按钮下方
  const pluginIconHtml = `<div class="rail-icon ${state.currentPage === 'plugins' ? 'active' : ''}" id="rail-plugins" title="插件">
    ${iconSvg('package', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  // 终端入口 — 位于插件按钮下方
  const terminalIconHtml = `<div class="rail-icon ${state.currentPage === 'terminal' ? 'active' : ''}" data-page="terminal" title="终端">
    ${iconSvg('terminal', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  // 调试入口 — 消息原文列表 (位于终端按钮下方, separator 之上)
  const debugIconHtml = `<div class="rail-icon ${state.currentPage === 'debug' ? 'active' : ''}" data-page="debug" title="调试">
    ${iconSvg('bug', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  const settingsIconHtml = `<div class="rail-icon ${state.currentPage === 'settings' ? 'active' : ''}" data-page="settings" title="设置">
    ${iconSvg('settings', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  const avatarHtml = state.self ? await renderAvatarHtml(state.self) : '';

  rail.innerHTML = `
    ${pageIconsHtml}
    ${pluginIconHtml}
    ${terminalIconHtml}
    ${debugIconHtml}
    <div class="rail-separator"></div>
    <div class="rail-flex"></div>
    ${settingsIconHtml}
    <div class="rail-avatar" id="rail-avatar">${avatarHtml}</div>
  `;

  bindPageIcons();
  bindPluginsIcon();
  bindAvatar();
}

function bindPluginsIcon(): void {
  const el = document.getElementById('rail-plugins');
  if (!el) return;
  el.addEventListener('click', () => {
    state.currentPage = 'plugins';
    saveState();
    void renderRail().then(() => {
      void import('./navPanel.js').then(({ renderNavPanel, renderMain }) => {
        void renderNavPanel();
        void renderMain();
      });
    });
  });
}

async function navigateToPage(page: Page): Promise<void> {
  state.currentPage = page;
  if (page !== 'settings') {
    state.currentSettingsSection = 'account';
  }
  saveState();
  await renderRail();
  const { renderNavPanel } = await import('./navPanel.js');
  await renderNavPanel();
  const { renderRightDrawer } = await import('./rightDrawer.js');
  renderRightDrawer();
  const { renderMain } = await import('./navPanel.js');
  await renderMain();
}

function reportError(e: unknown): void {
  showToast(e instanceof Error ? e.message : String(e));
}

function bindPageIcons(): void {
  document.querySelectorAll<HTMLElement>('.rail-icon[data-page]').forEach((el) => {
    el.addEventListener('click', () => {
      const page = el.dataset.page as Page;
      navigateToPage(page).catch(reportError);
    });
  });
}

function bindAvatar(): void {
  const el = document.getElementById('rail-avatar');
  if (!el) return;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    showUserMenu(el);
  });
}

function showUserMenu(anchor: HTMLElement): void {
  showDropdown(anchor, [
    {
      label: '外观设置',
      icon: 'palette',
      action: () => {
        state.currentSettingsSection = 'appearance';
        navigateToPage('settings').catch(reportError);
      },
    },
    {
      label: '账号设置',
      icon: 'user',
      action: () => {
        navigateToPage('settings').catch(reportError);
      },
    },
    {
      label: '重启',
      icon: 'refresh-cw',
      action: () => {
        // 重载前端:重新 boot + 全量拉取,排查事件流/会话刷新问题
        location.reload();
      },
    },
    {
      label: '登出',
      icon: 'log-out',
      danger: true,
      action: async () => {
        try {
          await call('logout');
          location.reload();
        } catch (e) {
          reportError(e);
        }
      },
    },
  ], { position: 'top-left' });
}
