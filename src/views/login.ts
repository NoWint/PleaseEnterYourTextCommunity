import { call, clearError, onEvent } from '../api.js';
import type { DcEvent } from '../api.js';
import { ui } from '../components/ui.js';

interface AdvancedConfig {
  imap_host: string | null;
  imap_port: number | null;
  imap_security: string | null;
  imap_user: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: string | null;
  smtp_user: string | null;
  smtp_password: string | null;
}

function handleProgress(btn: HTMLButtonElement, doneText: string, p: DcEvent): void {
  const progress = p.progress as number;
  const comment = (p.comment as string) || '';
  if (progress === 0) {
    btn.textContent = '失败…';
  } else if (progress >= 1000) {
    btn.textContent = doneText;
  } else if (progress > 0) {
    const pct = Math.floor(progress / 10);
    btn.textContent = `${pct}%`;
  }
  if (comment) {
    console.log('[configure]', comment);
  }
}

export function renderLogin(onSuccess: () => void | Promise<void>): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-hero">
        <img class="login-hero-logo" src="/logo.jpg" alt="PEYT Studio" />
        <h1 class="login-hero-title">PEYT Studio</h1>
        <p class="login-hero-slogan">Type Everything</p>
      </div>
      <div class="login-panel">
        <div class="login-form"></div>
      </div>
    </div>
  `;
  const form = app.querySelector<HTMLElement>('.login-form')!;

  // ── tabs(快速开始 / 邮箱登录)─────────────────────
  const tabsEl = document.createElement('div');
  tabsEl.className = 'tabs';
  const tabQuick = document.createElement('button');
  tabQuick.type = 'button';
  tabQuick.className = 'tab active';
  tabQuick.dataset.tab = 'quick';
  tabQuick.textContent = '快速开始';
  const tabEmail = document.createElement('button');
  tabEmail.type = 'button';
  tabEmail.className = 'tab';
  tabEmail.dataset.tab = 'email';
  tabEmail.textContent = '邮箱登录';
  tabsEl.append(tabQuick, tabEmail);
  form.appendChild(tabsEl);

  // ── 快速开始表单 ─────────────────────────────────
  const quickForm = document.createElement('form');
  quickForm.id = 'quick-form';
  quickForm.className = 'tab-panel';
  const quickHint = document.createElement('p');
  quickHint.className = 'hint';
  quickHint.textContent = '输入显示名，自动创建 yzjtiantian.cn 免费账号，立即开始聊天。';
  const displayName = ui.input({ placeholder: '显示名（如：张三）' });
  displayName.id = 'display-name';
  displayName.required = true;
  displayName.maxLength = 60;
  const quickBtn = ui.button({ label: '开始聊天' });
  quickBtn.id = 'quick-btn';
  quickForm.append(quickHint, displayName, quickBtn);
  form.appendChild(quickForm);

  // ── 邮箱登录表单 ─────────────────────────────────
  const emailForm = document.createElement('form');
  emailForm.id = 'email-form';
  emailForm.className = 'tab-panel';
  emailForm.hidden = true;
  const email = ui.input({ placeholder: '邮箱', type: 'email' });
  email.id = 'email';
  email.required = true;
  email.autocomplete = 'username';
  const password = ui.input({ placeholder: '密码', type: 'password' });
  password.id = 'password';
  password.required = true;
  password.autocomplete = 'current-password';
  const advancedToggle = ui.button({ label: '高级设置', variant: 'ghost' });
  advancedToggle.id = 'advanced-toggle';
  advancedToggle.type = 'button';
  advancedToggle.classList.add('link');
  const advanced = document.createElement('div');
  advanced.id = 'advanced';
  advanced.className = 'advanced';
  advanced.hidden = true;
  const imapHost = ui.input({ placeholder: 'IMAP 主机' });
  imapHost.id = 'imap_host';
  const imapPort = ui.input({ placeholder: 'IMAP 端口', type: 'number' });
  imapPort.id = 'imap_port';
  const imapSecurity = ui.select({
    options: [
      { value: '', label: 'IMAP 安全（自动）' },
      { value: 'ssl', label: 'SSL/TLS' },
      { value: 'tls', label: 'STARTTLS' },
      { value: 'plain', label: '明文' },
    ],
  });
  imapSecurity.id = 'imap_security';
  const imapUser = ui.input({ placeholder: 'IMAP 用户名' });
  imapUser.id = 'imap_user';
  const smtpHost = ui.input({ placeholder: 'SMTP 主机' });
  smtpHost.id = 'smtp_host';
  const smtpPort = ui.input({ placeholder: 'SMTP 端口', type: 'number' });
  smtpPort.id = 'smtp_port';
  const smtpSecurity = ui.select({
    options: [
      { value: '', label: 'SMTP 安全（自动）' },
      { value: 'ssl', label: 'SSL/TLS' },
      { value: 'tls', label: 'STARTTLS' },
      { value: 'plain', label: '明文' },
    ],
  });
  smtpSecurity.id = 'smtp_security';
  const smtpUser = ui.input({ placeholder: 'SMTP 用户名' });
  smtpUser.id = 'smtp_user';
  const smtpPassword = ui.input({ placeholder: 'SMTP 密码', type: 'password' });
  smtpPassword.id = 'smtp_password';
  advanced.append(imapHost, imapPort, imapSecurity, imapUser, smtpHost, smtpPort, smtpSecurity, smtpUser, smtpPassword);
  const loginBtn = ui.button({ label: '登录' });
  loginBtn.id = 'login-btn';
  emailForm.append(email, password, advancedToggle, advanced, loginBtn);
  form.appendChild(emailForm);

  const errorEl = document.createElement('div');
  errorEl.id = 'error';
  errorEl.className = 'error';
  errorEl.style.display = 'none';
  form.appendChild(errorEl);

  // ── tab 切换 ──────────────────────────────────────
  tabQuick.addEventListener('click', () => {
    tabQuick.classList.add('active');
    tabEmail.classList.remove('active');
    quickForm.hidden = false;
    emailForm.hidden = true;
    clearError();
  });
  tabEmail.addEventListener('click', () => {
    tabEmail.classList.add('active');
    tabQuick.classList.remove('active');
    emailForm.hidden = false;
    quickForm.hidden = true;
    clearError();
  });

  advancedToggle.addEventListener('click', () => {
    advanced.hidden = !advanced.hidden;
  });

  // ── 快速开始提交 ──────────────────────────────────
  quickForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const name = displayName.value.trim() || '';
    if (!name) return;
    quickBtn.disabled = true;
    quickBtn.textContent = '创建中…';
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onEvent('ConfigureProgress', (p: DcEvent) => {
        const progress = p.progress as number;
        if (progress === 0) quickBtn.textContent = '失败…';
        else if (progress >= 1000) quickBtn.textContent = '成功，正在进入…';
        else if (progress > 0) quickBtn.textContent = `${Math.floor(progress / 10)}%`;
        if (p.comment) console.log('[configure]', p.comment);
      });
    } catch {}
    try {
      await call('create_chatmail_account', { displayName: name });
      if (unlisten) unlisten();
      await onSuccess();
    } catch {
      if (unlisten) unlisten();
      quickBtn.disabled = false;
      quickBtn.textContent = '开始聊天';
    }
  });

  // ── 邮箱登录提交 ──────────────────────────────────
  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const emailVal = email.value.trim() || '';
    const passwordVal = password.value || '';
    const adv = advanced.hasAttribute('hidden') ? null : collectAdvanced(app);
    loginBtn.disabled = true;
    loginBtn.textContent = '登录中…';
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onEvent('ConfigureProgress', (p: DcEvent) => handleProgress(loginBtn, '登录成功，正在进入…', p));
    } catch {}
    try {
      await call('login', { email: emailVal, password: passwordVal, advanced: adv });
      if (unlisten) unlisten();
      await onSuccess();
    } catch {
      if (unlisten) unlisten();
      loginBtn.disabled = false;
      loginBtn.textContent = '登录';
    }
  });
}

function collectAdvanced(root: HTMLElement | Document): AdvancedConfig {
  const get = (id: string): string | null => {
    const el = root.querySelector<HTMLInputElement>(`#${id}`);
    const v = el?.value.trim() || '';
    return v ? v : null;
  };
  const getNum = (id: string): number | null => {
    const el = root.querySelector<HTMLInputElement>(`#${id}`);
    const v = el?.value.trim() || '';
    return v ? Number(v) : null;
  };
  return {
    imap_host: get('imap_host'),
    imap_port: getNum('imap_port'),
    imap_security: get('imap_security'),
    imap_user: get('imap_user'),
    smtp_host: get('smtp_host'),
    smtp_port: getNum('smtp_port'),
    smtp_security: get('smtp_security'),
    smtp_user: get('smtp_user'),
    smtp_password: get('smtp_password'),
  };
}
