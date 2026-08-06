import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { getCurrentTheme, applyTheme, BUILTIN_THEMES, getCurrentFontScale, applyFontScale, FONT_SCALES, type FontScale, type BuiltinTheme } from '../theme.js';
import { ui } from '../components/ui.js';
import { escapeHtml } from '../components/escape.js';
import { sendInviteLink } from '../components/shareLink.js';
import { normalizeUrlForQr } from '../utils/deepLink.js';
import { getSummaryPrefs, saveSummaryPrefs, loadSummaryPrefs, type SummaryPrefs } from '../utils/summaryPrefs.js';
import type { SettingsSection, SelfProfile } from '../types.js';
// qrcode 包无自带类型声明,也无 @types/qrcode,用 @ts-expect-error 跳过类型检查
// @ts-expect-error
import QRCode from 'qrcode';

const sections: Array<{ id: SettingsSection; icon: IconName; label: string }> = [
  { id: 'account', icon: 'user', label: '账号' },
  { id: 'appearance', icon: 'palette', label: '外观' },
  { id: 'team', icon: 'users', label: '当前团队' },
  { id: 'notifications', icon: 'bell', label: '通知' },
  { id: 'plugins', icon: 'layout-grid', label: '插件' },
  { id: 'github', icon: 'git-branch', label: 'GitHub' },
  { id: 'intelligence', icon: 'sparkles', label: '智能' },
  { id: 'about', icon: 'info', label: '关于' },
];

// 智能页下载进度监听(模块级,重渲染前先解绑,避免累积)
let dlUnlisten: (() => void) | null = null;

export async function renderSettingsNav(panel: HTMLElement): Promise<void> {
  panel.innerHTML = `<div class="nav-header"><div class="nav-title">设置</div></div>`;
  const navList = document.createElement('div');
  navList.className = 'nav-list';
  for (const s of sections) {
    const item = ui.listItem({
      title: s.label,
      icon: s.icon,
      onClick: async () => {
        state.currentSettingsSection = s.id;
        saveState();
        await renderSettingsNav(panel);
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      },
    });
    if (state.currentSettingsSection === s.id) item.classList.add('active');
    navList.appendChild(item);
  }
  panel.appendChild(navList);
}

export async function renderSettingsMain(main: HTMLElement): Promise<void> {
  switch (state.currentSettingsSection) {
    case 'account': await renderAccount(main); break;
    case 'appearance': renderAppearance(main); break;
    case 'team': await renderTeam(main); break;
    case 'notifications': await renderNotifications(main); break;
    case 'plugins': await renderPlugins(main); break;
    case 'github': await renderGithub(main); break;
    case 'intelligence': await renderIntelligence(main); break;
    case 'about': renderAbout(main); break;
  }
}

async function renderPlugins(main: HTMLElement): Promise<void> {
  const { renderPluginSettings } = await import('../plugins/settings.js');
  await renderPluginSettings(main);
}

// ── 账号 ──────────────────────────────────────────────
async function renderAccount(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>账号</h2>';

  // 头像行
  const avatarHtml = state.self ? await renderAvatarHtml(state.self) : '';
  const avatarRow = document.createElement('div');
  avatarRow.className = 'settings-avatar-row';
  avatarRow.innerHTML = `<div class="settings-avatar-large" id="settings-avatar">${avatarHtml}</div>`;
  section.appendChild(avatarRow);

  const options = document.createElement('div');
  options.className = 'settings-avatar-options';
  options.style.display = 'none';
  options.appendChild(ui.button({ label: '上传', icon: 'upload', size: 'sm', onClick: () => triggerAvatarUpload(main) }));
  options.appendChild(ui.button({ label: '移除', icon: 'trash', size: 'sm', danger: true, onClick: async () => {
    try {
      await call('update_profile', { name: null, avatarPath: '' });
      state.self = await call<SelfProfile>('get_self_profile');
      const { renderRail } = await import('../shell/rail.js');
      await renderRail();
      await renderAccount(main);
      ui.toast('头像已移除');
    } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
  } }));
  avatarRow.appendChild(options);
  avatarRow.querySelector('#settings-avatar')?.addEventListener('click', () => {
    options.style.display = options.style.display === 'none' ? 'flex' : 'none';
  });

  // 显示名
  const nameInput = ui.input({ value: state.self?.name || '', placeholder: '显示名' });
  nameInput.addEventListener('blur', async () => {
    const name = nameInput.value.trim();
    if (name && name !== state.self?.name) {
      try {
        await call('update_profile', { name, avatarPath: null });
        state.self = await call<SelfProfile>('get_self_profile');
        const { renderRail } = await import('../shell/rail.js');
        await renderRail();
        ui.toast('已保存');
      } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
    }
  });
  section.appendChild(ui.field({ label: '显示名', children: nameInput }));

  // 邮箱
  const addr = document.createElement('div');
  addr.className = 'settings-readonly';
  addr.textContent = state.self?.addr || '—';
  section.appendChild(ui.field({ label: '邮箱', children: addr }));

  // Delta 批次 4:多设备绑定 + 备份恢复入口
  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:8px;margin-top:16px;flex-wrap:wrap';
  actionsRow.appendChild(ui.button({
    label: '多设备绑定', icon: 'package', size: 'sm',
    onClick: () => { void import('../components/setupMultiDevice.js').then((m) => m.openMultiDeviceSetup()); },
  }));
  actionsRow.appendChild(ui.button({
    label: '备份与恢复', icon: 'download', size: 'sm',
    onClick: () => { void import('../components/backupDialog.js').then((m) => m.openBackupDialog()); },
  }));
  actionsRow.appendChild(ui.button({
    label: '我的二维码', icon: 'user', size: 'sm',
    onClick: showMyQr,
  }));
  section.appendChild(actionsRow);

  main.appendChild(section);
}

async function showMyQr(): Promise<void> {
  let qr = '';
  try {
    qr = await call<string>('get_my_qr');
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  try {
    // 二维码内容归一化为 core 可解析形式(i.delta.chat);展示文本仍为品牌 peyt 域名
    const qrCore = normalizeUrlForQr(qr);
    const dataUrl = await QRCode.toDataURL(qrCore, { margin: 1, width: 220 });
    const body = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
        <img src="${dataUrl}" alt="我的二维码" style="width:220px;height:220px;border-radius:8px;background:#fff;padding:8px;box-sizing:border-box" />
        <div style="font-size:12px;color:#8e8e93">用于让对方扫码添加你为联系人</div>
        <div style="width:100%;display:flex;gap:8px;align-items:center">
          <input class="ui-input" type="text" value="${escapeHtml(qr)}" readonly style="flex:1" />
          <button class="ui-button ui-button-primary ui-button-sm" id="qr-copy-btn">复制链接</button>
          <button class="ui-button ui-button-ghost ui-button-sm" id="qr-share-btn">分享</button>
        </div>
      </div>`;
    const dlg = ui.dialog({ title: '我的二维码', body, size: 'sm' });
    dlg.overlay.querySelector<HTMLButtonElement>('#qr-copy-btn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(qr);
        ui.toast('已复制');
      } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
    });
    dlg.overlay.querySelector<HTMLButtonElement>('#qr-share-btn')?.addEventListener('click', () => {
      void sendInviteLink(qr);
    });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
}

function triggerAvatarUpload(main: HTMLElement): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const path = await call<string>('save_avatar_from_bytes', { bytes, ext });
      await call('update_profile', { name: null, avatarPath: path });
      state.self = await call<SelfProfile>('get_self_profile');
      const { renderRail } = await import('../shell/rail.js');
      await renderRail();
      await renderAccount(main);
      ui.toast('头像已更新');
    } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
  });
  input.click();
}

// ── 外观 ──────────────────────────────────────────────
// Telegram 式主页微缩预览:预览容器挂 data-theme 触发该主题的变量作用域,
// 内部元素用 var(--xxx) 渲染迷你三栏界面,真实呈现主题效果。
function themePreviewHtml(id: string): string {
  return `
  <span class="theme-swatch theme-preview" data-theme="${id}">
    <span class="tp-rail"></span>
    <span class="tp-nav">
      <i class="tp-nav-item"></i><i class="tp-nav-item"></i><i class="tp-nav-item"></i>
    </span>
    <span class="tp-chat">
      <span class="tp-chat-head"></span>
      <span class="tp-msg"><i class="tp-bubble"></i></span>
      <span class="tp-msg short"><i class="tp-bubble"></i></span>
      <span class="tp-msg out"><i class="tp-bubble"></i></span>
      <span class="tp-input"></span>
    </span>
    <span class="theme-swatch-check">${iconSvg('check')}</span>
  </span>`;
}

function renderAppearance(main: HTMLElement): void {
  const current = getCurrentTheme();
  const pluginThemes = window.__peytchat_themes || [];
  const renderCard = (t: { id: string; label: string; swatch: string; preview?: string; mode?: 'plugin' }) => {
    const isActive = current === t.id;
    const thumb = t.mode === 'plugin'
      ? `<span class="theme-swatch" style="background:${t.swatch}"></span>`
      : themePreviewHtml(t.id);
    return `
    <button type="button" class="settings-theme ${isActive ? 'active' : ''}" data-theme-id="${t.id}">
      ${thumb}
      <span class="theme-name">${escapeHtml(t.label)}</span>
    </button>`;
  };
  const dark = BUILTIN_THEMES.filter((t) => t.group === 'dark');
  const light = BUILTIN_THEMES.filter((t) => t.group === 'light');
  const groupHtml = (title: string, list: { id: string; label: string; swatch: string; preview?: string; mode?: 'plugin' }[]) => `
    <div class="theme-group">
      <div class="theme-group-head">
        <span class="theme-group-title">${escapeHtml(title)}</span>
        <span class="theme-group-count">${list.length}</span>
        <span class="theme-group-line"></span>
      </div>
      <div class="settings-themes">${list.map((t) => renderCard(t)).join('')}</div>
    </div>`;
  const themesHtml = groupHtml('深色主题', dark)
    + groupHtml('浅色主题', light)
    + (pluginThemes.length
      ? groupHtml('插件主题', pluginThemes.map((t) => ({ id: t.id, label: t.name, swatch: t.swatch, mode: 'plugin' as const })))
      : '');
  const currentScale = getCurrentFontScale();
  main.innerHTML = `
    <div class="settings-section settings-appearance">
      <h2>外观</h2>
      ${themesHtml}
      <div class="settings-font-row">
        <div class="settings-font-label">字体大小</div>
        <div id="font-scale-picker"></div>
      </div>
    </div>
  `;
  main.querySelectorAll<HTMLElement>('.settings-theme').forEach((el) => {
    el.addEventListener('click', () => {
      const theme = el.dataset.themeId as string;
      applyTheme(theme);
      main.querySelectorAll('.settings-theme').forEach((e) => e.classList.remove('active'));
      el.classList.add('active');
    });
  });
  const picker = main.querySelector('#font-scale-picker');
  if (picker) {
    picker.appendChild(ui.segmented({
      items: FONT_SCALES.map((s) => ({ value: s.id, label: s.label })),
      value: currentScale,
      onChange: (v) => {
        applyFontScale(v as FontScale);
      },
    }));
  }
}

// ── 当前团队 ──────────────────────────────────────────
async function renderTeam(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const ws = state.workspaces.find((w) => w.id === state.currentWsId);
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>当前团队</h2>';

  if (!ws) {
    section.appendChild(ui.empty('未加入任何团队'));
    const joinArea = document.createElement('div');
    const input = ui.inlineInput({
      placeholder: '粘贴邀请链接 (dcgroup:... 或 OPENPGP4FPR:...)',
      confirmLabel: '加入',
      onConfirm: async (qr) => {
        try {
          const r = await call<{ workspace_id: number }>('join_peyt_studio', { qr });
          state.currentWsId = r.workspace_id;
          saveState();
          const { refreshWorkspaces, renderRail } = await import('../shell/rail.js');
          await refreshWorkspaces();
          await renderRail();
          await renderTeam(main);
          ui.toast('已加入 PEYT Studio');
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
          throw e;
        }
      },
    });
    joinArea.appendChild(input);
    section.appendChild(ui.field({ label: '加入 PEYT Studio', children: joinArea }));
    main.appendChild(section);
    return;
  }

  let inviteLink = '';
  try { inviteLink = await call<string>('get_securejoin_qr', { chatId: ws.master_chat_id }); } catch {}
  const memberCount = state.wsMembers[ws.id] || 0;
  const channelCount = state.channels.filter((c) => c.workspace_id === ws.id).length;

  const name = document.createElement('div');
  name.className = 'settings-readonly';
  name.textContent = ws.name;
  section.appendChild(ui.field({ label: '团队名', children: name }));

  const members = document.createElement('div');
  members.className = 'settings-readonly';
  members.textContent = String(memberCount);
  section.appendChild(ui.field({ label: '成员数', children: members }));

  const chans = document.createElement('div');
  chans.className = 'settings-readonly';
  chans.textContent = String(channelCount);
  section.appendChild(ui.field({ label: '频道数', children: chans }));

  // 邀请链接 + 复制
  const inviteInput = ui.input({ value: inviteLink });
  inviteInput.readOnly = true;
  const copyBtn = ui.button({ label: '复制', icon: 'copy', size: 'sm', onClick: async () => {
    try {
      await navigator.clipboard.writeText(inviteInput.value);
      ui.toast('邀请链接已复制');
    } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
  } });
  const inviteRow = document.createElement('div');
  inviteRow.className = 'settings-invite-row';
  inviteRow.appendChild(inviteInput);
  inviteRow.appendChild(copyBtn);
  section.appendChild(ui.field({ label: '邀请链接', children: inviteRow }));

  // 退出团队
  const leaveBtn = ui.button({ label: '退出团队', icon: 'log-out', variant: 'danger', onClick: () => {
    ui.confirm({
      title: '退出团队',
      message: '确定退出当前团队?退出后将无法查看团队频道。',
      confirmLabel: '退出',
      danger: true,
      onConfirm: async () => {
        await call('leave_workspace', { id: ws.id });
        state.currentWsId = null;
        state.currentChatId = null;
        saveState();
        const { refreshWorkspaces, renderRail } = await import('../shell/rail.js');
        await refreshWorkspaces();
        await renderRail();
        await renderTeam(main);
      },
    });
  } });
  const zone = document.createElement('div');
  zone.className = 'settings-danger-zone';
  zone.appendChild(leaveBtn);
  section.appendChild(zone);

  main.appendChild(section);
}

// ── 通知 ──────────────────────────────────────────────
// 偏好持久化:peyt.notificationsEnabled = 应用级总开关(对齐 Delta desktopSettings.notifications),
// peyt.badgeEnabled = Dock 角标。开关状态读偏好而非 Notification.permission —— 系统权限是
// 「能否弹」,偏好是「要不要弹」,两者分离(Delta 亦是:总开关 + OS 权限)。
async function renderNotifications(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const notifEnabled = localStorage.getItem('peyt.notificationsEnabled') !== 'false';
  const badgeEnabled = localStorage.getItem('peyt.badgeEnabled') !== 'false';
  // 系统权限:由 Rust 侧(user-notify)查询 —— Windows/Linux 桌面默认授予,macOS 区分授权/拒绝。
  // 不再用浏览器 Notification.permission(那是 webview 的权限,与系统原生通知无关)。
  let systemPermitted = true;
  try {
    systemPermitted = await call<boolean>('get_notification_permission');
  } catch { /* 未接 Tauri(纯浏览器 preview)时保持 true */ }
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>通知</h2>';

  const desktopSwitch = ui.switch_({ checked: notifEnabled, onChange: async (v) => {
    localStorage.setItem('peyt.notificationsEnabled', String(v));
    if (v) {
      // 开启时触发系统权限请求(仅 macOS 会弹系统询问;Windows/Linux no-op 恒 true)
      try { await call('request_notification_permission'); } catch {}
    }
  } });
  const desktopRow = document.createElement('div');
  desktopRow.className = 'settings-toggle-row';
  desktopRow.append('桌面通知', desktopSwitch);
  section.appendChild(desktopRow);
  // 副说明:系统权限与偏好分开显示
  const permHint = document.createElement('div');
  permHint.className = 'settings-toggle-hint';
  permHint.textContent = systemPermitted
    ? '系统通知权限已开启'
    : '系统通知权限未开启,请在系统设置中允许通知';
  section.appendChild(permHint);

  const badgeSwitch = ui.switch_({ checked: badgeEnabled, onChange: (v) => {
    localStorage.setItem('peyt.badgeEnabled', String(v));
    // 关闭时立即清空角标
    if (!v) void clearBadge();
  } });
  const badgeRow = document.createElement('div');
  badgeRow.className = 'settings-toggle-row';
  badgeRow.append('Dock 角标', badgeSwitch);
  section.appendChild(badgeRow);

  main.appendChild(section);
}

async function clearBadge(): Promise<void> {
  try {
    const tauri = window as unknown as { __TAURI__?: { app?: { setBadgeCount?: (n: number) => Promise<void> } } };
    if (tauri.__TAURI__?.app?.setBadgeCount) await tauri.__TAURI__.app.setBadgeCount(0);
  } catch {}
}

// ── GitHub ──────────────────────────────────────────────
// D1:全局 GitHub token(存后端 github_settings 表)。GitHubPage 与 Bot 工具共用。
async function renderGithub(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>GitHub</h2>';

  let current = '';
  try {
    const s = await call<{ token?: string | null }>('get_github_settings');
    current = s.token || '';
  } catch { /* 忽略 */ }

  const tokenInput = ui.input({ type: 'password', value: current, placeholder: 'GitHub Token(留空 = 公开只读)' });
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:center';
  row.appendChild(tokenInput);
  row.appendChild(ui.button({
    label: '保存',
    icon: 'check',
    variant: 'primary',
    onClick: async () => {
      try {
        await call('set_github_token', { token: tokenInput.value.trim() || null });
        ui.toast('Token 已保存');
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  }));
  row.appendChild(ui.button({
    label: '清除',
    icon: 'trash',
    danger: true,
    onClick: async () => {
      try {
        await call('set_github_token', { token: null });
        tokenInput.value = '';
        ui.toast('Token 已清除');
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  }));
  section.appendChild(ui.field({
    label: '全局 GitHub Token',
    children: row,
    help: '无 token 时公开仓库只读;代码搜索需 token。左侧栏 GitHub 页使用此全局 token。',
  }));

  main.appendChild(section);
}

// ── 智能 ──────────────────────────────────────────────
// 唯一配置界面在智能中心 Tab4;设置页保留入口,点击跳转。
async function renderIntelligence(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>智能</h2>';

  let mode = '';
  try {
    const s = await call<{ mode?: string }>('get_intelligence_settings');
    mode = s.mode || '';
  } catch { /* 未接后端时保持空 */ }
  const modeMap: Record<string, string> = { off: '关闭', wordfreq: '词频', llm: 'LLM' };
  const modeBadge = mode ? ` <span class="ui-badge">${modeMap[mode] ?? mode}</span>` : '';

  const card = document.createElement('div');
  card.className = 'ui-card';
  card.innerHTML = `
    <div class="ui-card-head"><span class="ui-card-title">智能中心</span></div>
    <div class="ui-card-body" style="font-size:var(--font-scale-secondary);color:var(--text-mute);line-height:1.7">
      知识库、主题总结、自动总结配置与模型设置统一在智能中心管理(唯一配置界面)。${modeBadge}
    </div>`;
  section.appendChild(card);

  section.appendChild(ui.button({
    label: '打开智能中心',
    icon: 'sparkles',
    variant: 'primary',
    onClick: async () => {
      state.currentPage = 'intelligence';
      state.intelligenceTab = 'settings';
      saveState();
      const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
      await renderNavPanel();
      await renderMain();
    },
  }));

  main.appendChild(section);
}

// ── 关于 ──────────────────────────────────────────────
function renderAbout(main: HTMLElement): void {
  main.innerHTML = '';
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>关于</h2>';
  const version = document.createElement('div');
  version.className = 'settings-readonly';
  version.textContent = '0.1.0';
  section.appendChild(ui.field({ label: '版本', children: version }));

  const logoutBtn = ui.button({ label: '登出', icon: 'log-out', variant: 'danger', onClick: () => {
    ui.confirm({
      title: '登出',
      message: '确定登出当前账号?',
      confirmLabel: '登出',
      danger: true,
      onConfirm: async () => {
        await call('logout');
        location.reload();
      },
    });
  } });
  const zone = document.createElement('div');
  zone.className = 'settings-danger-zone';
  zone.appendChild(logoutBtn);
  section.appendChild(zone);

  main.appendChild(section);
}

// ── 智能 ──────────────────────────────────────────────
// 主题总结引擎:模式(off/词频/LLM) + 来源(本地/API) + 模型下载面板(选档后点下载)。
// 偏好持久化在后端 SQL(summary_settings 表),经 summaryPrefs 读写。
async function renderIntelligence(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  dlUnlisten?.(); // 先解绑旧监听,避免重渲染累积
  dlUnlisten = null;
  await loadSummaryPrefs(); // 拉后端偏好 + 下载状态 + API 配置(一次 summary_get_state)
  const prefs = getSummaryPrefs();
  const { engineDownloaded, modelDownloaded, apiBaseUrl, apiKey, apiModel } = prefs;

  const section = document.createElement('div');
  section.className = 'settings-section settings-intelligence';
  section.innerHTML = '<h2>智能</h2>';

  // ── 引擎模式:pill 分段 ─────────────────────────────
  const modeSeg = ui.segmented({
    items: [
      { value: 'off', label: '关闭' },
      { value: 'wordfreq', label: '词频' },
      { value: 'llm', label: 'LLM' },
    ],
    value: prefs.mode,
    onChange: (v) => {
      prefs.mode = v as SummaryPrefs['mode'];
      void saveSummaryPrefs(prefs).then(() => renderIntelligence(main));
    },
  });
  section.appendChild(ui.field({ label: '总结引擎', children: modeSeg }));

  // LLM 模式:来源 + 上下文条数
  if (prefs.mode === 'llm') {
    const srcSeg = ui.segmented({
      items: [
        { value: 'local', label: '本地模型' },
        { value: 'api', label: 'API' },
      ],
      value: prefs.source,
      onChange: (v) => {
        prefs.source = v as SummaryPrefs['source'];
        void saveSummaryPrefs(prefs).then(() => renderIntelligence(main));
      },
    });
    section.appendChild(ui.field({ label: 'LLM 来源', children: srcSeg }));

    const nInput = ui.input({ value: String(prefs.contextN), type: 'number' });
    nInput.addEventListener('change', () => {
      const n = Number(nInput.value);
      if (!Number.isNaN(n)) { prefs.contextN = Math.min(200, Math.max(10, n)); nInput.value = String(prefs.contextN); void saveSummaryPrefs(prefs); }
    });
    section.appendChild(ui.field({ label: '上下文条数', children: nInput, help: '注入最近 N 条消息,默认 50。字数硬上限 4000 自动截断。' }));
  }

  // ── 本地模型下载面板 ───────────────────────────────
  if (prefs.mode === 'llm' && prefs.source === 'local') {
    const localCard = document.createElement('div');
    localCard.className = 'sd-card';

    const sizeSeg = ui.segmented({
      items: [
        { value: '0.5b', label: '0.5B' },
        { value: '1.5b', label: '1.5B' },
      ],
      value: prefs.modelSize,
      onChange: (v) => {
        prefs.modelSize = v as SummaryPrefs['modelSize'];
        void saveSummaryPrefs(prefs);
      },
    });
    localCard.appendChild(ui.field({ label: '模型档位', children: sizeSeg, help: '0.5B ~0.4GB · 1.5B ~1GB。CPU 推理:档位越小越快。' }));

    const dl = ui.button({
      label: modelDownloaded ? '已下载' : '下载模型',
      icon: 'download',
      variant: modelDownloaded ? 'ghost' : 'primary',
      disabled: modelDownloaded,
      onClick: async () => {
        try {
          await call('summary_download', { what: 'model', size: prefs.modelSize });
        } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
      },
    });
    localCard.appendChild(ui.field({ label: '模型', children: dl }));

    const bar = document.createElement('div');
    bar.className = 'settings-toggle-hint';
    bar.textContent = modelDownloaded ? '引擎与模型已就绪' : (engineDownloaded ? '引擎就绪,等待下载模型' : '点击下载引擎与模型');
    localCard.appendChild(bar);

    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen('download-progress', (ev) => {
      const p = ev.payload as { what?: string; status: string; bytes?: number; total?: number; rate?: number; message?: string };
      if (p.status === 'error') {
        bar.textContent = `下载失败:${p.message ?? '未知错误'}`;
        ui.toast(`下载失败:${p.message ?? '未知错误'}`);
        return;
      }
      if (p.what !== 'model' && p.what !== 'engine') return;
      if (p.status === 'downloading' && p.total) {
        const pct = Math.round(((p.bytes ?? 0) / p.total) * 100);
        bar.textContent = `${p.what === 'engine' ? '引擎' : '模型'} ${pct}% · ${fmtBytes(p.bytes ?? 0)}/${fmtBytes(p.total)} · ${fmtBytes(p.rate ?? 0)}/s`;
      } else if (p.status === 'done') {
        bar.textContent = '下载完成';
        ui.toast(`${p.what === 'engine' ? '引擎' : '模型'} 下载完成`);
        void renderIntelligence(main);
      }
    });
    dlUnlisten = un;

    section.appendChild(localCard);
  }

  // ── API 配置卡片 ──────────────────────────────────
  if (prefs.mode === 'llm' && prefs.source === 'api') {
    const apiCard = document.createElement('div');
    apiCard.className = 'sd-card';

    // BaseURL:预设下拉 + 自由输入
    const baseUrlInput = ui.input({ value: apiBaseUrl ?? 'https://api.deepseek.com', placeholder: 'https://api.deepseek.com' });
    apiCard.appendChild(ui.field({ label: 'API 地址 (Base URL)', children: baseUrlInput, help: '默认 DeepSeek。OpenAI 兼容服务填对应 /v1 地址。' }));

    // KEY
    const keyInput = ui.input({ value: apiKey ?? '', type: 'password', placeholder: 'sk-…' });
    apiCard.appendChild(ui.field({ label: 'API 密钥 (Key)', children: keyInput, help: '仅保存在本地数据库,不会上传。' }));

    // 模型:可自由输入的下拉(datalist)+ 获取模型按钮
    const modelWrap = document.createElement('div');
    modelWrap.className = 'sd-model-row';
    const modelInput = ui.input({ value: apiModel ?? 'deepseek-chat', placeholder: 'deepseek-chat' });
    modelInput.setAttribute('list', 'sd-model-list'); // 原生 datalist:可自由输入 + 下拉建议
    const datalist = document.createElement('datalist');
    datalist.id = 'sd-model-list';
    datalist.innerHTML = [
      { v: 'deepseek-chat', l: 'DeepSeek Chat (通用对话)' },
      { v: 'deepseek-reasoner', l: 'DeepSeek Reasoner (深度推理)' },
      { v: 'deepseek-v4-flash', l: 'DeepSeek V4 Flash (快速)' },
      { v: 'deepseek-v4-pro', l: 'DeepSeek V4 Pro (最强)' },
    ].map((m) => `<option value="${m.v}" label="${m.l}">`).join('');
    const fetchBtn = ui.button({
      label: '获取模型',
      icon: 'refresh-cw',
      variant: 'ghost',
      onClick: async () => {
        const base = baseUrlInput.value.trim();
        const key = keyInput.value.trim();
        if (!base || !key) { ui.toast('请先填写 API 地址与密钥'); return; }
        fetchBtn.disabled = true;
        const orig = fetchBtn.textContent;
        fetchBtn.textContent = '获取中…';
        try {
          const models = await call<string[]>('summary_list_models', { baseUrl: base, apiKey: key });
          if (models.length === 0) { ui.toast('未获取到模型'); return; }
          datalist.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
          if (!models.includes(modelInput.value.trim())) modelInput.value = models[0];
          ui.toast(`获取到 ${models.length} 个模型`);
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        } finally {
          fetchBtn.disabled = false;
          fetchBtn.textContent = orig;
        }
      },
    });
    modelWrap.appendChild(modelInput);
    modelWrap.appendChild(fetchBtn);
    apiCard.appendChild(ui.field({ label: '模型', children: modelWrap }));
    apiCard.appendChild(datalist); // datalist 独立节点,input[list] 引用它

    // 保存按钮:显式保存,反馈落库
    const saveBtn = ui.button({
      label: '保存',
      icon: 'check',
      variant: 'primary',
      onClick: async () => {
        const base = baseUrlInput.value.trim();
        const key = keyInput.value.trim();
        const model = modelInput.value.trim();
        if (!base || !key || !model) { ui.toast('请完整填写 API 地址、密钥与模型'); return; }
        try {
          await call('summary_set_api', { baseUrl: base, apiKey: key, model });
          // 同步内存缓存
          Object.assign(prefs, { apiBaseUrl: base, apiKey: key, apiModel: model });
          ui.toast('API 配置已保存');
        } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
      },
    });
    const clearBtn = ui.button({
      label: '清除',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        try {
          await call('summary_clear_api');
          baseUrlInput.value = 'https://api.deepseek.com';
          keyInput.value = '';
          modelInput.value = 'deepseek-chat';
          ui.toast('API 配置已清除');
        } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
      },
    });
    const btnRow = document.createElement('div');
    btnRow.className = 'sd-actions';
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(clearBtn);
    apiCard.appendChild(btnRow);

    section.appendChild(apiCard);
  }

  main.appendChild(section);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
