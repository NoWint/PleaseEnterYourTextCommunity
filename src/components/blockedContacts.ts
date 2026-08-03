import { call } from '../api.js';
import { ui } from './ui.js';
import { escapeHtml } from './escape.js';
import type { ContactDto } from '../types.js';

// 屏蔽列表弹窗(对齐 Delta UnblockContacts):列出被屏蔽的联系人,可取消屏蔽。
// 取消屏蔽后重新拉取并重建列表(ui.dialog 的 body 是 HTML 字符串)。
export async function openBlockedContacts(): Promise<void> {
  const renderBody = (contacts: ContactDto[]): string => {
    if (contacts.length === 0) {
      return `<div class="ui-empty">没有被屏蔽的联系人</div>`;
    }
    return contacts
      .map(
        (c) => `
        <div class="ui-list-item" style="display:flex;align-items:center;gap:8px;padding:8px 10px">
          <div style="flex:1;min-width:0">
            <div class="ui-list-title">${escapeHtml(c.name)}</div>
            <div class="ui-list-sub">${escapeHtml(c.addr)}</div>
          </div>
          <button class="ui-button ui-button-ghost ui-button-sm" data-unblock="${c.id}">取消屏蔽</button>
        </div>`
      )
      .join('');
  };

  let contacts: ContactDto[] = [];
  try {
    contacts = await call<ContactDto[]>('get_blocked_contacts');
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }

  const dlg = ui.dialog({
    title: '屏蔽列表',
    body: renderBody(contacts),
    onClose: () => {},
  });

  // 绑定取消屏蔽按钮:取消后重拉列表,重建 dialog body
  const bind = () => {
    dlg.overlay.querySelectorAll<HTMLElement>('[data-unblock]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.unblock);
        try {
          await call('unblock_contact', { contactId: id });
          contacts = await call<ContactDto[]>('get_blocked_contacts');
          const body = dlg.overlay.querySelector('.ui-dialog-body');
          if (body) {
            body.innerHTML = renderBody(contacts);
            bind();
          }
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        }
      });
    });
  };
  bind();
}

