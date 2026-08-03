import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { ui } from './ui.js';
import { iconSvg } from './icon.js';
import type { ContactDto } from '../types.js';

// 从通讯录添加好友:列表选择 → create_chat_by_email → 打开会话。
// 数据来自 get_contacts(全量联系人,含已建会话的),已存在会话直接打开而非重建(命令幂等)。

function letterColor(name: string): string {
  // 由名字哈希出稳定背景色,替代无 avatar 字段时的色块
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 35% 45%)`;
}

export async function openContactsPicker(): Promise<void> {
  let contacts: ContactDto[];
  try {
    contacts = await call<ContactDto[]>('get_contacts');
  } catch {
    ui.toast('加载通讯录失败');
    return;
  }
  // 过滤自己
  const selfAddr = state.self?.addr;
  contacts = contacts.filter((c) => c.addr !== selfAddr);

  const dlg = ui.dialog({
    title: '从通讯录添加',
    size: 'lg',
    body: `
      <div class="ui-search">${iconSvg('search', { width: 14, height: 14 })}<input class="ui-search-input" id="cp-search-input" placeholder="搜索联系人..." autocomplete="off"></div>
      <div id="cp-list" style="display:flex;flex-direction:column;gap:2px;margin-top:12px;max-height:360px;overflow-y:auto"></div>
    `,
  });

  const listEl = dlg.overlay.querySelector<HTMLElement>('#cp-list');
  if (!listEl) return;
  const searchInput = dlg.overlay.querySelector<HTMLInputElement>('#cp-search-input');

  const render = (query: string): void => {
    const q = query.trim().toLowerCase();
    const filtered = q ? contacts.filter((c) => c.name.toLowerCase().includes(q) || c.addr.toLowerCase().includes(q)) : contacts;
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="ui-empty" style="padding:24px 8px">没有匹配的联系人</div>`;
      return;
    }
    listEl.innerHTML = filtered.map((c) => {
      const letter = (c.name || c.addr || '?').charAt(0).toUpperCase() || '?';
      return `
        <div class="ui-list-item cp-contact" data-addr="${escapeAttr(c.addr)}" style="padding:8px 10px">
          <div class="avatar" style="background:${letterColor(c.name || c.addr)};flex:none">${escapeHtml(letter)}</div>
          <div class="ui-list-meta">
            <div class="ui-list-title">${escapeHtml(c.name || c.addr)}</div>
            <div class="ui-list-sub">${escapeHtml(c.addr)}</div>
          </div>
          <span class="cp-add">${iconSvg('plus', { width: 14, height: 14 })}</span>
        </div>`;
    }).join('');
    listEl.querySelectorAll<HTMLElement>('.cp-contact').forEach((el) => {
      el.addEventListener('click', () => void addContact(el.dataset.addr || ''));
    });
  };

  async function addContact(addr: string): Promise<void> {
    if (!addr) return;
    try {
      const chatId = await call<number>('create_chat_by_email', { email: addr });
      state.currentChatId = chatId;
      saveState();
      dlg.close();
      const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
      await renderNavPanel();
      await renderMain();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }

  searchInput?.addEventListener('input', () => render(searchInput.value));
  render('');
  searchInput?.focus();
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
