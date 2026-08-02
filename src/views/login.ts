import { call, clearError, onEvent } from '../api.js';
import type { DcEvent } from '../api.js';

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
        <div class="login-form">
          <div class="tabs">
          <button type="button" class="tab active" data-tab="quick">快速开始</button>
          <button type="button" class="tab" data-tab="email">邮箱登录</button>
        </div>

        <form id="quick-form" class="tab-panel" hidden>
          <p class="hint">输入显示名，自动创建 yzjtiantian.cn 免费账号，立即开始聊天。</p>
          <input id="display-name" type="text" placeholder="显示名（如：张三）" required maxlength="60" />
          <button type="submit" id="quick-btn">开始聊天</button>
        </form>

        <form id="email-form" class="tab-panel" hidden>
          <input id="email" type="email" placeholder="邮箱" required autocomplete="username" />
          <input id="password" type="password" placeholder="密码" required autocomplete="current-password" />
          <button type="button" id="advanced-toggle" class="link">高级设置</button>
          <div id="advanced" class="advanced" hidden>
            <input id="imap_host" placeholder="IMAP 主机" />
            <input id="imap_port" type="number" placeholder="IMAP 端口" />
            <select id="imap_security">
              <option value="">IMAP 安全（自动）</option>
              <option value="ssl">SSL/TLS</option>
              <option value="tls">STARTTLS</option>
              <option value="plain">明文</option>
            </select>
            <input id="imap_user" placeholder="IMAP 用户名" />
            <input id="smtp_host" placeholder="SMTP 主机" />
            <input id="smtp_port" type="number" placeholder="SMTP 端口" />
            <select id="smtp_security">
              <option value="">SMTP 安全（自动）</option>
              <option value="ssl">SSL/TLS</option>
              <option value="tls">STARTTLS</option>
              <option value="plain">明文</option>
            </select>
            <input id="smtp_user" placeholder="SMTP 用户名" />
            <input id="smtp_password" type="password" placeholder="SMTP 密码" />
          </div>
          <button type="submit" id="login-btn">登录</button>
        </form>

          <div id="error" class="error" style="display:none"></div>
        </div>
      </div>
    </div>
  `;

  const tabs = app.querySelectorAll<HTMLButtonElement>('.tab');
  const panels: Record<string, HTMLElement | null> = {
    quick: app.querySelector('#quick-form'),
    email: app.querySelector('#email-form'),
  };
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      Object.entries(panels).forEach(([k, p]) => {
        if (p) p.hidden = k !== t.dataset.tab;
      });
      clearError();
    });
  });
  if (panels.quick) panels.quick.hidden = false;
  if (panels.email) panels.email.hidden = true;

  const toggle = app.querySelector<HTMLButtonElement>('#advanced-toggle');
  const advanced = app.querySelector<HTMLElement>('#advanced');
  if (toggle && advanced) {
    toggle.addEventListener('click', () => {
      advanced.hidden = !advanced.hidden;
    });
  }

  const quickForm = app.querySelector<HTMLFormElement>('#quick-form');
  quickForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const displayNameEl = app.querySelector<HTMLInputElement>('#display-name');
    const displayName = displayNameEl?.value.trim() || '';
    if (!displayName) return;
    const btn = app.querySelector<HTMLButtonElement>('#quick-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '创建中…';
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onEvent('ConfigureProgress', (p: DcEvent) => {
        const progress = p.progress as number;
        if (progress === 0) btn.textContent = '失败…';
        else if (progress >= 1000) btn.textContent = '成功，正在进入…';
        else if (progress > 0) btn.textContent = `${Math.floor(progress / 10)}%`;
        if (p.comment) console.log('[configure]', p.comment);
      });
    } catch {}
    try {
      await call('create_chatmail_account', { displayName });
      if (unlisten) unlisten();
      await onSuccess();
    } catch {
      if (unlisten) unlisten();
      btn.disabled = false;
      btn.textContent = '开始聊天';
    }
  });

  const emailForm = app.querySelector<HTMLFormElement>('#email-form');
  emailForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const emailEl = app.querySelector<HTMLInputElement>('#email');
    const passwordEl = app.querySelector<HTMLInputElement>('#password');
    const email = emailEl?.value.trim() || '';
    const password = passwordEl?.value || '';
    const adv = advanced?.hasAttribute('hidden') ? null : collectAdvanced(app);
    const btn = app.querySelector<HTMLButtonElement>('#login-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '登录中…';
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onEvent('ConfigureProgress', (p: DcEvent) => handleProgress(btn, '登录成功，正在进入…', p));
    } catch {}
    try {
      await call('login', { email, password, advanced: adv });
      if (unlisten) unlisten();
      await onSuccess();
    } catch {
      if (unlisten) unlisten();
      btn.disabled = false;
      btn.textContent = '登录';
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
