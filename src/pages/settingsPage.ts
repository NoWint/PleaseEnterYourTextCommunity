import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { getCurrentTheme, applyTheme, BUILTIN_THEMES } from '../theme.js';
import { ui } from '../components/ui.js';
import { createInlineInput } from '../components/inlineInput.js';
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
  { id: 'about', icon: 'info', label: '关于' },
];

export async function renderSettingsNav(panel: HTMLElement): Promise<void> {
  const itemsHtml = sections.map((s) => {
    const active = state.currentSettingsSection === s.id ? 'active' : '';
    return `<div class="settings-nav-item ${active}" data-section="${s.id}">
      ${iconSvg(s.icon, { width: 16, height: 16 })}
      <span>${escapeHtml(s.label)}</span>
    </div>`;
  }).join('');
  panel.innerHTML = `<div class="nav-header"><div class="nav-title">设置</div></div><div class="nav-list">${itemsHtml}</div>`;
  panel.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((el) => {
    el.addEventListener('click', async () => {
      state.currentSettingsSection = el.dataset.section as SettingsSection;
      saveState();
      await renderSettingsNav(panel);
      const { renderMain } = await import('../shell/navPanel.js');
      await renderMain();
    });
  });
}

export async function renderSettingsMain(main: HTMLElement): Promise<void> {
  switch (state.currentSettingsSection) {
    case 'account': await renderAccount(main); break;
    case 'appearance': renderAppearance(main); break;
    case 'team': await renderTeam(main); break;
    case 'notifications': renderNotifications(main); break;
    case 'plugins': await renderPlugins(main); break;
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
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 220 });
    const body = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
        <img src="${dataUrl}" alt="我的二维码" style="width:220px;height:220px;border-radius:8px;background:#fff;padding:8px;box-sizing:border-box" />
        <div style="font-size:12px;color:#8e8e93">用于让对方扫码添加你为联系人</div>
        <div style="width:100%;display:flex;gap:8px;align-items:center">
          <input class="ui-input" type="text" value="${escapeHtml(qr)}" readonly style="flex:1" />
          <button class="ui-button ui-button-primary ui-button-sm" id="qr-copy-btn">复制链接</button>
        </div>
      </div>`;
    const dlg = ui.dialog({ title: '我的二维码', body, size: 'sm' });
    dlg.overlay.querySelector<HTMLButtonElement>('#qr-copy-btn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(qr);
        ui.toast('已复制');
      } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
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
function renderAppearance(main: HTMLElement): void {
  const current = getCurrentTheme();
  const pluginThemes = window.__peytchat_themes || [];
  const themesHtml = [
    ...BUILTIN_THEMES.map((t) => `
      <div class="settings-theme ${current === t.id ? 'active' : ''}" data-theme="${t.id}">
        <div class="theme-swatch" style="background:${t.swatch}"></div>
        <span>${escapeHtml(t.label)}</span>
      </div>`),
    ...pluginThemes.map((t) => `
      <div class="settings-theme ${current === t.id ? 'active' : ''}" data-theme="${t.id}">
        <div class="theme-swatch" style="background:${t.swatch}"></div>
        <span>${escapeHtml(t.name)}</span>
      </div>`),
  ].join('');
  main.innerHTML = `
    <div class="settings-section">
      <h2>外观</h2>
      <div class="settings-themes">${themesHtml}</div>
    </div>
  `;
  main.querySelectorAll<HTMLElement>('.settings-theme').forEach((el) => {
    el.addEventListener('click', () => {
      const theme = el.dataset.theme as string;
      applyTheme(theme);
      main.querySelectorAll('.settings-theme').forEach((e) => e.classList.remove('active'));
      el.classList.add('active');
    });
  });
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
    const input = createInlineInput({
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
function renderNotifications(main: HTMLElement): void {
  main.innerHTML = '';
  const desktopEnabled = Notification.permission === 'granted';
  const badgeEnabled = localStorage.getItem('peyt.badgeEnabled') !== 'false';
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>通知</h2>';

  const desktopSwitch = ui.switch_({ checked: desktopEnabled, onChange: async (v) => {
    if (v && Notification.permission !== 'granted') await Notification.requestPermission();
  } });
  const desktopRow = document.createElement('div');
  desktopRow.className = 'settings-toggle-row';
  desktopRow.append('桌面通知', desktopSwitch);
  section.appendChild(desktopRow);

  const badgeSwitch = ui.switch_({ checked: badgeEnabled, onChange: (v) => {
    localStorage.setItem('peyt.badgeEnabled', String(v));
  } });
  const badgeRow = document.createElement('div');
  badgeRow.className = 'settings-toggle-row';
  badgeRow.append('Dock 角标', badgeSwitch);
  section.appendChild(badgeRow);

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

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
