import { call, transformBlobURL } from '../../api.js';
import { state } from '../../state.js';
import { ui, colorHex } from '../ui.js';
import { iconSvg } from '../icon.js';
import { escapeHtml, escapeAttr } from '../escape.js';
import type { ContactDto } from '../../types.js';

// 成员选择器(仿 Delta AddMemberInnerDialog):
// 搜索联系人 + 多选 chips + 已入群成员禁用 + 手输新邮箱。
// 供群创建对话框(openCreateGroupDialog)与群信息弹窗加人(openViewGroupDialog)复用。

export interface MemberPick {
  /** 通讯录联系人 id;0 表示手输邮箱(contact 尚未建立) */
  contact_id: number;
  email: string;
  name: string;
}

export function openMemberPicker(opts: {
  title?: string;
  /** 已入群成员 contactId 集合(这些行禁用) */
  existing?: Set<number>;
  /** 是否排除自己(默认 true:加人/建群都不应选自己) */
  excludeSelf?: boolean;
  onOk: (picks: MemberPick[]) => void;
}): void {
  const existing = opts.existing ?? new Set<number>();
  const excludeSelf = opts.excludeSelf ?? true;
  const picks: MemberPick[] = [];

  // 通讯录(过滤自己)
  let contacts: ContactDto[] = [];
  const loadContacts = async (): Promise<void> => {
    try {
      contacts = await call<ContactDto[]>('get_contacts');
      if (excludeSelf && state.self?.addr) {
        contacts = contacts.filter((c) => c.addr !== state.self!.addr);
      }
    } catch {
      contacts = [];
    }
  };

  const render = async (): Promise<void> => {
    const list = dlg.overlay.querySelector<HTMLElement>('#mp-list');
    const chipsEl = dlg.overlay.querySelector<HTMLElement>('#mp-chips');
    if (!list || !chipsEl) return;
    const q = (dlg.overlay.querySelector<HTMLInputElement>('#mp-search')?.value ?? '').trim().toLowerCase();
    const pickedIds = new Set(picks.map((p) => p.contact_id));
    const pickedEmails = new Set(picks.filter((p) => p.contact_id === 0).map((p) => p.email.toLowerCase()));

    // 顶部 chips:已选成员(可移除);self 不可被加,故不会出现在 chips
    chipsEl.innerHTML = picks.map((p, i) => `
      <span class="mp-chip">
        ${escapeHtml(p.name || p.email)}
        <span class="mp-chip-x" data-idx="${i}" title="移除">${iconSvg('x', { width: 12, height: 12 })}</span>
      </span>
    `).join('');
    chipsEl.querySelectorAll<HTMLElement>('.mp-chip-x').forEach((x) => {
      x.addEventListener('click', () => {
        picks.splice(Number(x.dataset.idx), 1);
        void render();
      });
    });

    // 联系人列表
    const filtered = q
      ? contacts.filter((c) => c.name.toLowerCase().includes(q) || c.addr.toLowerCase().includes(q))
      : contacts;
    // 手输邮箱:搜索无结果且输入是合法邮箱 → 追加「以邮箱添加」行
    const isEmail = q.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
    const alreadyPicked = pickedEmails.has(q.toLowerCase());
    const manualRow = q !== '' && filtered.length === 0 && isEmail && !alreadyPicked
      ? `<div class="mp-contact mp-manual" data-email="${escapeAttr(q)}">
          <span class="mp-check">${iconSvg('plus', { width: 14, height: 14 })}</span>
          <div class="ui-list-meta">
            <div class="ui-list-title">以邮箱添加</div>
            <div class="ui-list-sub">${escapeHtml(q)}</div>
          </div>
        </div>`
      : '';
    if (manualRow) {
      list.innerHTML = manualRow;
      list.querySelector<HTMLElement>('.mp-manual')?.addEventListener('click', () => {
        picks.push({ contact_id: 0, email: q, name: q });
        const input = dlg.overlay.querySelector<HTMLInputElement>('#mp-search');
        if (input) input.value = '';
        void render();
      });
      return;
    }
    if (filtered.length === 0) {
      list.innerHTML = `<div class="ui-empty" style="padding:20px 8px">没有匹配的联系人</div>`;
      return;
    }
    const rows = await Promise.all(filtered.map(async (c) => {
      const disabled = existing.has(c.id) || pickedIds.has(c.id);
      const url = c.avatar ? await transformBlobURL(c.avatar) : null;
      const bg = colorHex(c.color);
      const letter = (c.name || c.addr || '?').charAt(0).toUpperCase() || '?';
      const avatarHtml = url
        ? `<span class="ui-list-avatar"><img src="${escapeAttr(url)}" alt="" /></span>`
        : `<span class="ui-list-avatar"><span class="ui-avatar-letter" style="background:${bg}">${escapeHtml(letter)}</span></span>`;
      return `
        <div class="mp-contact ${disabled ? 'disabled' : ''}" data-cid="${c.id}" data-addr="${escapeAttr(c.addr)}" data-name="${escapeAttr(c.name)}">
          <span class="mp-check">${iconSvg(disabled ? 'check' : 'plus', { width: 14, height: 14 })}</span>
          ${avatarHtml}
          <div class="ui-list-meta">
            <div class="ui-list-title">${escapeHtml(c.name)}</div>
            <div class="ui-list-sub">${escapeHtml(c.addr)}</div>
          </div>
          ${disabled ? '<span class="mp-state">已选</span>' : ''}
        </div>`;
    }));
    list.innerHTML = rows.join('');
    list.querySelectorAll<HTMLElement>('.mp-contact:not(.disabled)').forEach((el) => {
      el.addEventListener('click', () => {
        picks.push({
          contact_id: Number(el.dataset.cid),
          email: el.dataset.addr || '',
          name: el.dataset.name || el.dataset.addr || '',
        });
        void render();
      });
    });
  };

  const cancelBtn = ui.button({ label: '取消', variant: 'ghost', onClick: () => dlg.close() });
  const okBtn = ui.button({ label: '确定', variant: 'primary', onClick: () => {
    if (picks.length === 0) return;
    dlg.close();
    opts.onOk(picks);
  } });

  const dlg = ui.dialog({
    title: opts.title || '选择成员',
    size: 'lg',
    body: `
      <div id="mp-chips" class="mp-chips"></div>
      <div class="ui-search">${iconSvg('search', { width: 14, height: 14 })}<input class="ui-search-input" id="mp-search" placeholder="搜索联系人 / 输入邮箱..." autocomplete="off"></div>
      <div id="mp-list" style="display:flex;flex-direction:column;gap:2px;margin-top:12px;max-height:360px;overflow-y:auto"></div>
    `,
    actions: [cancelBtn, okBtn],
  });

  void loadContacts().then(() => void render());
  dlg.overlay.querySelector<HTMLInputElement>('#mp-search')?.addEventListener('input', () => void render());
  dlg.overlay.querySelector<HTMLInputElement>('#mp-search')?.focus();
}
