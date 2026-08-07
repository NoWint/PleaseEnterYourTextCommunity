import { call, onEvent, transformBlobURL } from '../api.js';
import type { DcEvent } from '../api.js';
import { ui } from '../components/ui.js';

interface AccountInfo {
  id: number;
  name: string;
  addr: string;
  is_current: boolean;
  avatar: string | null;
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
        <div class="login-form" id="login-form"></div>
      </div>
    </div>
  `;
  const form = app.querySelector<HTMLElement>('#login-form')!;
  void initLogin(form, onSuccess);
}

async function initLogin(form: HTMLElement, onSuccess: () => void | Promise<void>): Promise<void> {
  let accounts: AccountInfo[] = [];
  try {
    accounts = await call<AccountInfo[]>('list_accounts');
  } catch (e) {
    console.warn('[login] list_accounts 失败,降级为新建账号表单', e);
  }
  if (accounts.length > 0) {
    renderAccountPicker(form, accounts, onSuccess);
  } else {
    renderNewAccount(form, onSuccess);
  }
}

// ── 账号选择:顶部切换 tab(选择账号 / 新建账号)──────────
function renderAccountPicker(form: HTMLElement, accounts: AccountInfo[], onSuccess: () => void | Promise<void>): void {
  // iOS 分段式切换 tab:选择账号 / 新建账号
  const tabsEl = document.createElement('div');
  tabsEl.className = 'tabs';
  const tabSelect = document.createElement('button');
  tabSelect.type = 'button';
  tabSelect.className = 'tab active';
  tabSelect.textContent = '选择账号';
  const tabNew = document.createElement('button');
  tabNew.type = 'button';
  tabNew.className = 'tab';
  tabNew.textContent = '新建账号';
  tabsEl.append(tabSelect, tabNew);
  form.appendChild(tabsEl);

  // 面板 1:账号卡列表
  const selectPanel = document.createElement('div');
  selectPanel.className = 'tab-panel';
  const list = document.createElement('div');
  list.className = 'login-accounts';
  for (const a of accounts) list.appendChild(accountCard(a, onSuccess));
  selectPanel.appendChild(list);
  form.appendChild(selectPanel);

  // 面板 2:新建账号表单
  const newForm = document.createElement('form');
  newForm.id = 'login-new-form';
  newForm.className = 'login-new-form tab-panel';
  newForm.hidden = true;
  bindNewAccountForm(newForm, onSuccess);
  form.appendChild(newForm);

  tabSelect.addEventListener('click', () => {
    tabSelect.classList.add('active');
    tabNew.classList.remove('active');
    selectPanel.hidden = false;
    newForm.hidden = true;
  });
  tabNew.addEventListener('click', () => {
    tabNew.classList.add('active');
    tabSelect.classList.remove('active');
    newForm.hidden = false;
    selectPanel.hidden = true;
  });
}

function accountCard(a: AccountInfo, onSuccess: () => void | Promise<void>): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'login-account-card';

  const avatar = document.createElement('div');
  avatar.className = 'login-account-avatar';
  const letter = (a.name || '?').charAt(0).toUpperCase();
  avatar.textContent = letter;
  if (a.avatar) {
    void transformBlobURL(a.avatar).then((url) => {
      if (!url) return;
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      avatar.textContent = '';
      avatar.appendChild(img);
    });
  }

  const meta = document.createElement('div');
  meta.className = 'login-account-meta';
  const name = document.createElement('div');
  name.className = 'login-account-name';
  name.textContent = a.name || a.addr || `账号 ${a.id}`;
  const mail = document.createElement('div');
  mail.className = 'login-account-mail';
  mail.textContent = a.addr;
  meta.append(name, mail);

  btn.append(avatar, meta);

  if (a.is_current) {
    const tag = document.createElement('span');
    tag.className = 'login-account-current';
    tag.textContent = '当前';
    btn.appendChild(tag);
  }

  btn.addEventListener('click', async () => {
    if (a.is_current) { await onSuccess(); return; }
    btn.disabled = true;
    try {
      await call('switch_account', { id: a.id });
    } catch (e) {
      btn.disabled = false;
      ui.toast(e instanceof Error ? e.message : String(e));
      return;
    }
    await onSuccess();
  });
  return btn;
}

// ── 新建账号表单 ──────────────────────────────────────
function renderNewAccount(form: HTMLElement, onSuccess: () => void | Promise<void>): void {
  const formEl = document.createElement('form');
  formEl.id = 'login-new-form';
  formEl.className = 'login-new-form';
  bindNewAccountForm(formEl, onSuccess);
  form.appendChild(formEl);
}

function bindNewAccountForm(formEl: HTMLFormElement, onSuccess: () => void | Promise<void>): void {
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '输入显示名，自动创建 yzjtiantian.cn 免费账号，立即开始聊天。';
  const displayName = ui.input({ placeholder: '显示名（如：张三）' });
  displayName.id = 'display-name';
  displayName.required = true;
  displayName.maxLength = 60;
  const createBtn = ui.button({ label: '创建账号' });
  createBtn.id = 'login-create-btn';
  formEl.append(hint, displayName, createBtn);

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = displayName.value.trim() || '';
    if (!name) return;
    createBtn.disabled = true;
    createBtn.textContent = '创建中…';
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onEvent('ConfigureProgress', (p: DcEvent) => {
        const progress = p.progress as number;
        if (progress === 0) createBtn.textContent = '失败…';
        else if (progress >= 1000) createBtn.textContent = '成功，正在进入…';
        else if (progress > 0) createBtn.textContent = `${Math.floor(progress / 10)}%`;
        if (p.comment) console.log('[configure]', p.comment);
      });
    } catch {}
    try {
      await call('create_chatmail_account', { displayName: name });
    } catch (err) {
      if (unlisten) unlisten();
      createBtn.disabled = false;
      createBtn.textContent = '创建账号';
      ui.toast(err instanceof Error ? err.message : String(err));
      return;
    }
    if (unlisten) unlisten();
    await onSuccess();
  });
}
