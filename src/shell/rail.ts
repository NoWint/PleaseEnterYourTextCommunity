import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { ui } from '../components/ui.js';
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
    { page: 'messages', icon: 'message-circle', label: '消息', badge: state.totalUnread },
    { page: 'groups', icon: 'users', label: '群组' },
    { page: 'work', icon: 'layout-grid', label: '协作' },
    { page: 'inbox', icon: 'inbox', label: '通知', badge: state.inboxUnread },
    // 机器人入口 — 位于通知下方
    { page: 'bots', icon: 'robot', label: '机器人' },
  ];

  const pageIconsHtml = pages.map((p) => {
    const active = state.currentPage === p.page ? 'active' : '';
    const badge = (p.badge ?? 0) > 0
      ? `<span class="rail-badge">${(p.badge! > 99) ? '99+' : p.badge}</span>`
      : '';
    return `<div class="rail-icon ${active}" data-page="${p.page}" role="button" tabindex="0" aria-label="${p.label}" title="${p.label}">
      ${iconSvg(p.icon, { width: 24, height: 24, strokeWidth: 1.5 })}
      ${badge}
    </div>`;
  }).join('');

  // 插件入口 — 位于协作按钮下方
  const pluginIconHtml = `<div class="rail-icon ${state.currentPage === 'plugins' ? 'active' : ''}" id="rail-plugins" role="button" tabindex="0" aria-label="插件" title="插件">
    ${iconSvg('package', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  // 调试入口 — 消息原文列表 (位于插件按钮下方, separator 之上)
  const debugIconHtml = `<div class="rail-icon ${state.currentPage === 'debug' ? 'active' : ''}" data-page="debug" role="button" tabindex="0" aria-label="调试" title="调试">
    ${iconSvg('bug', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  const githubIconHtml = `<div class="rail-icon ${state.currentPage === 'github' ? 'active' : ''}" data-page="github" role="button" tabindex="0" aria-label="GitHub" title="GitHub">
    ${iconSvg('git-branch', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  const settingsIconHtml = `<div class="rail-icon ${state.currentPage === 'settings' ? 'active' : ''}" data-page="settings" role="button" tabindex="0" aria-label="设置" title="设置">
    ${iconSvg('settings', { width: 24, height: 24, strokeWidth: 1.5 })}
  </div>`;

  const avatarHtml = state.self ? await renderAvatarHtml(state.self) : '';

  rail.innerHTML = `
    ${pageIconsHtml}
    ${pluginIconHtml}
    ${debugIconHtml}
    <div class="rail-separator"></div>
    <div class="rail-flex"></div>
    ${githubIconHtml}
    ${settingsIconHtml}
    <div class="rail-avatar" id="rail-avatar" role="button" tabindex="0" aria-label="用户菜单">${avatarHtml}</div>
  `;

  bindPageIcons();
  bindPluginsIcon();
  bindAvatar();
}

function bindPluginsIcon(): void {
  const el = document.getElementById('rail-plugins');
  if (!el) return;
  const activate = (): void => {
    state.currentPage = 'plugins';
    saveState();
    void renderRail().then(() => {
      void import('./navPanel.js').then(({ renderNavPanel, renderMain }) => {
        void renderNavPanel();
        void renderMain();
      });
    });
  };
  el.addEventListener('click', activate);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
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
    const activate = (): void => {
      const page = el.dataset.page as Page;
      navigateToPage(page).catch(reportError);
    };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });
}

function bindAvatar(): void {
  const el = document.getElementById('rail-avatar');
  if (!el) return;
  const activate = (e: Event): void => {
    e.stopPropagation();
    showUserMenu(el);
  };
  el.addEventListener('click', activate);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); }
  });
}

function showUserMenu(anchor: HTMLElement): void {
  ui.menu(anchor, [
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
      label: '切换账号',
      icon: 'users',
      action: () => {
        void showAccountSwitcher();
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
  ], 'top-left', { closeOn: 'hover', toggle: true });
}

// 切换账号:列出全部账号,点击切换后 reload 重建 UI(新选中账号的数据)。
async function showAccountSwitcher(): Promise<void> {
  let accounts: Array<{ id: number; name: string; addr: string; is_current: boolean }>;
  try {
    accounts = await call('list_accounts');
  } catch (e) {
    reportError(e);
    return;
  }
  const { ui } = await import('../components/ui.js');
  if (accounts.length <= 1) {
    ui.toast('当前只有一个账号');
    return;
  }
  const list = document.createElement('div');
  list.style.cssText = 'max-height:320px;overflow-y:auto;display:flex;flex-direction:column';
  for (const a of accounts) {
    const item = ui.listItem({
      title: a.name || a.addr || `账号 ${a.id}`,
      subtitle: a.addr,
      onClick: async () => {
        dlg?.close();
        if (a.is_current) return;
        try {
          await call('switch_account', { id: a.id });
          location.reload();
        } catch (e) {
          reportError(e);
        }
      },
    });
    if (a.is_current) {
      item.style.opacity = '0.6';
      item.style.cursor = 'default';
      const tag = document.createElement('span');
      tag.style.cssText = 'font-size:11px;color:var(--text-weak);margin-left:8px';
      tag.textContent = '当前';
      item.appendChild(tag);
    }
    list.appendChild(item);
  }
  let dlg: ReturnType<typeof ui.dialog> | null = null;
  dlg = ui.dialog({
    title: '切换账号',
    actions: [],
  });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(list, actionsEl);
}
