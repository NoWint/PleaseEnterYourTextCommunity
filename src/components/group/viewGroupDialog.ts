import { call, transformBlobURL, onEvent } from '../../api.js';
import { state } from '../../state.js';
import { saveState } from '../../persist.js';
import { ui, colorHex } from '../ui.js';
import { iconSvg } from '../icon.js';
import { escapeHtml, escapeAttr } from '../escape.js';
import { openMemberPicker, type MemberPick } from './memberPicker.js';
import { sendInviteLink } from '../shareLink.js';
import { normalizeUrlForQr } from '../../utils/deepLink.js';
import type { ChatInfoDto, MemberDto } from '../../types.js';
// @ts-expect-error qrcode 无类型声明
import QRCode from 'qrcode';

// 群信息弹窗(仿 Delta ViewGroup):
// 头像/名称/成员数/描述/加密徽章 + 编辑资料/加人/群二维码/保护状态/退群 + 当前/历史成员。
// 成员行保持展示+移除(不接 memberDetail —— 后者与 rightDrawer 深度耦合)。

export function openViewGroupDialog(chatId: number): void {
  let info: ChatInfoDto | null = null;
  let unsubscribe: (() => void) | null = null;

  const cancelBtn = ui.button({ label: '关闭', variant: 'ghost', onClick: () => dlg.close() });
  const dlg = ui.dialog({
    title: '群信息',
    size: 'lg',
    body: `<div id="vg-body"><div class="ui-spinner"></div></div>`,
    actions: [cancelBtn],
    // 无论经 ✕/遮罩/取消/退群关闭,都卸载 ChatModified 订阅(ui.dialog 内部 close 会触发 onClose)。
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
  const body = dlg.overlay.querySelector<HTMLElement>('#vg-body');
  if (!body) return;

  const load = async (): Promise<void> => {
    try {
      info = await call<ChatInfoDto>('get_chat_info', { chatId });
      await render(body, info, () => dlg.close(), () => void load());
    } catch (e) {
      body.innerHTML = `<div style="padding:16px;color:var(--text-weak)">加载失败</div>`;
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  };

  // ChatModified 时刷新本弹窗(群名/头像/成员变更实时同步,对齐 Delta useGroup.refresh)。
  onEvent('ChatModified', (e) => {
    if (e.chat_id === chatId) void load();
  }).then((off) => { unsubscribe = off; });

  void load();
}

async function render(body: HTMLElement, info: ChatInfoDto, close: () => void, refresh: () => void): Promise<void> {
  const avatarUrl = info.avatar ? await transformBlobURL(info.avatar) : null;
  const bg = colorHex(info.color ?? null);
  const letter = (info.name || '?').charAt(0).toUpperCase() || '?';
  const avatarHtml = avatarUrl
    ? `<img src="${escapeAttr(avatarUrl)}" class="vg-avatar" alt="" />`
    : `<div class="vg-avatar" style="background:${bg}">${escapeHtml(letter)}</div>`;
  const encryptBadge = info.is_encrypted
    ? `<span class="vg-badge">${iconSvg('shield', { width: 12, height: 12 })} 加密</span>`
    : `<span class="vg-badge">未加密</span>`;

  // 成员行头像异步解析(transformBlobURL)。
  const allMembers = [...info.members, ...info.past_members];
  const avatarMap = new Map<number, string>();
  await Promise.all(allMembers.map(async (m) => {
    if (m.avatar) {
      try { avatarMap.set(m.contact_id, await transformBlobURL(m.avatar)); } catch { /* 无头像 */ }
    }
  }));

  const actions: string[] = [];
  if (info.can_send) {
    actions.push(`<button class="ui-button ui-button-ghost ui-button-sm" data-vg="edit">编辑资料</button>`);
    actions.push(`<button class="ui-button ui-button-ghost ui-button-sm" data-vg="add">添加成员</button>`);
  }
  actions.push(`<button class="ui-button ui-button-ghost ui-button-sm" data-vg="qr">群二维码</button>`);
  actions.push(`<button class="ui-button ui-button-ghost ui-button-sm" data-vg="shield">保护状态</button>`);
  actions.push(`<button class="ui-button ui-button-danger ui-button-sm" data-vg="leave">退群</button>`);
  actions.push(`<button class="ui-button ui-button-danger ui-button-sm" data-vg="delete">删除群</button>`);

  body.innerHTML = `
    <div class="vg-head">
      ${avatarHtml}
      <div class="vg-head-meta">
        <div class="vg-name">${escapeHtml(info.name)}</div>
        <div class="vg-sub">${info.members.length} 位成员 ${encryptBadge}</div>
      </div>
    </div>
    ${info.description ? `<div class="vg-desc">${escapeHtml(info.description)}</div>` : ''}
    <div class="vg-actions">${actions.join('')}</div>
    <div class="vg-section-title">当前成员</div>
    <div id="vg-members">${info.members.map((m) => memberRow(m, info.can_send && !m.is_self, avatarMap)).join('')}</div>
    ${info.past_members.length > 0 ? `
      <div class="vg-section-title">历史成员</div>
      <div id="vg-past">${info.past_members.map((m) => memberRow(m, false, avatarMap)).join('')}</div>
    ` : ''}
  `;

  // 操作按钮
  body.querySelector<HTMLElement>('[data-vg="edit"]')?.addEventListener('click', () => openEditDialog(info, refresh));
  body.querySelector<HTMLElement>('[data-vg="add"]')?.addEventListener('click', () => openAddMemberDialog(info, refresh));
  body.querySelector<HTMLElement>('[data-vg="qr"]')?.addEventListener('click', () => void openGroupQr(info.chat_id, info.name));
  body.querySelector<HTMLElement>('[data-vg="shield"]')?.addEventListener('click', () => {
    void import('../protectionDialog.js').then(({ openProtectionDialog }) => openProtectionDialog(info.chat_id));
  });
  body.querySelector<HTMLElement>('[data-vg="leave"]')?.addEventListener('click', () => openLeaveDialog(info, close));
  body.querySelector<HTMLElement>('[data-vg="delete"]')?.addEventListener('click', () => openDeleteDialog(info, close));

  // 移除成员按钮
  body.querySelectorAll<HTMLElement>('[data-remove-member]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = Number(btn.dataset.removeMember);
      ui.confirm({
        title: '移除成员',
        message: `确认将该成员移出群聊?`,
        danger: true,
        confirmLabel: '移除',
        onConfirm: async () => {
          try {
            await call('remove_group_member', { chatId: info.chat_id, contactId: cid });
            ui.toast('已移除');
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e));
          }
        },
      });
    });
  });
}

function memberRow(m: MemberDto, removable: boolean, avatarMap: Map<number, string>): string {
  const url = avatarMap.get(m.contact_id);
  const bg = colorHex(m.color);
  const letter = (m.name || '?').charAt(0).toUpperCase() || '?';
  const avatarHtml = url
    ? `<img src="${escapeAttr(url)}" class="vg-member-avatar" alt="" />`
    : `<div class="vg-member-avatar" style="background:${bg}">${escapeHtml(letter)}</div>`;
  return `
    <div class="vg-member">
      ${avatarHtml}
      <div class="vg-member-meta">
        <div class="vg-member-name">${escapeHtml(m.name)}${m.is_self ? '<span class="vg-self-tag">我</span>' : ''}</div>
        <div class="vg-member-addr">${escapeHtml(m.addr || '')}</div>
      </div>
      ${removable ? `<button class="vg-remove" data-remove-member="${m.contact_id}" title="移除">${iconSvg('trash', { width: 14, height: 14 })}</button>` : ''}
    </div>
  `;
}

// 添加成员:memberPicker 多选 → 逐个 add_group_member(contact_id)。
function openAddMemberDialog(info: ChatInfoDto, refresh: () => void): void {
  openMemberPicker({
    title: '添加成员',
    existing: new Set(info.members.map((m) => m.contact_id)),
    onOk: async (picks: MemberPick[]) => {
      try {
        for (const p of picks) {
          await call('add_group_member', {
            chatId: info.chat_id,
            email: p.email,
            contactId: p.contact_id || null,
          });
        }
        ui.toast(`已添加 ${picks.length} 位成员`);
        refresh();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

// 编辑资料:名称 + 描述 + 头像(原图直设),保存时逐个调 rename_group / set_group_description / set_group_avatar。
function openEditDialog(info: ChatInfoDto, refresh: () => void): void {
  let avatarPath: string | null = info.avatar;
  const nameInput = ui.input({ value: info.name, placeholder: '群名称' });
  const descInput = document.createElement('textarea');
  descInput.className = 'cg-desc';
  descInput.placeholder = '群描述(可选)';
  descInput.value = info.description;

  const avatarHost = document.createElement('div');
  const rebuildAvatar = async (): Promise<void> => {
    avatarHost.innerHTML = `
      <div class="cg-avatar-box">
        <img id="cg-avatar-img" class="cg-avatar-img" alt="群头像" style="display:none" />
        <div id="cg-avatar-ph" class="cg-avatar-ph">${iconSvg('users', { width: 28, height: 28 })}</div>
      </div>
      <div class="cg-avatar-actions">
        <button class="ui-button ui-button-ghost ui-button-sm" id="cg-upload">上传头像</button>
        <button class="ui-button ui-button-ghost ui-button-sm" id="cg-remove">移除</button>
      </div>
    `;
    const img = avatarHost.querySelector<HTMLImageElement>('#cg-avatar-img');
    const ph = avatarHost.querySelector<HTMLElement>('#cg-avatar-ph');
    if (avatarPath && img && ph) {
      try {
        img.src = await transformBlobURL(avatarPath);
        img.style.display = 'block';
        ph.style.display = 'none';
      } catch { /* 保持占位 */ }
    }
    avatarHost.querySelector<HTMLElement>('#cg-upload')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) void (async () => {
          try {
            const buf = await file.arrayBuffer();
            const bytes = Array.from(new Uint8Array(buf));
            const ext = (file.name.split('.').pop() || 'png').toLowerCase();
            avatarPath = await call<string>('save_avatar_from_bytes', { bytes, ext });
            await rebuildAvatar();
          } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
        })();
      });
      input.click();
    });
    avatarHost.querySelector<HTMLElement>('#cg-remove')?.addEventListener('click', () => {
      avatarPath = null;
      void rebuildAvatar();
    });
  };

  const cancelBtn = ui.button({ label: '取消', variant: 'ghost', onClick: () => editDlg.close() });
  const saveBtn = ui.button({
    label: '保存', variant: 'primary',
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) { ui.toast('请输入群名称'); return; }
      saveBtn.disabled = true;
      try {
        const p: Array<Promise<unknown>> = [];
        if (name !== info.name) p.push(call('rename_group', { chatId: info.chat_id, name }));
        const desc = descInput.value.trim();
        if (desc !== info.description) p.push(call('set_group_description', { chatId: info.chat_id, description: desc }));
        if (avatarPath !== info.avatar) p.push(call('set_group_avatar', { chatId: info.chat_id, path: avatarPath || '' }));
        await Promise.all(p);
        editDlg.close();
        ui.toast('已保存');
        refresh();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
        saveBtn.disabled = false;
      }
    },
  });

  const editDlg = ui.dialog({
    title: '编辑群资料',
    size: 'md',
    body: `
      <div id="cg-avatar-slot"></div>
      <div id="cg-name-slot"></div>
      <div id="cg-desc-slot"></div>
    `,
    actions: [cancelBtn, saveBtn],
  });
  editDlg.overlay.querySelector('#cg-avatar-slot')?.appendChild(avatarHost);
  editDlg.overlay.querySelector('#cg-name-slot')?.appendChild(nameInput);
  editDlg.overlay.querySelector('#cg-desc-slot')?.appendChild(descInput);
  void rebuildAvatar();
  nameInput.focus();
}

// 群二维码:get_securejoin_qr(chatId) → QRCode.toDataURL → 展示 + 复制链接。
async function openGroupQr(chatId: number, name: string): Promise<void> {
  let qr = '';
  try {
    qr = await call<string>('get_securejoin_qr', { chatId });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  let dataUrl = '';
  try {
    // 二维码内容归一化为 core 可解析形式(i.delta.chat);展示文本仍为品牌 peyt 域名
    dataUrl = await QRCode.toDataURL(normalizeUrlForQr(qr), { margin: 1, width: 220 });
  } catch {
    ui.toast('二维码生成失败');
    return;
  }
  const copyBtn = ui.button({
    label: '复制链接', size: 'sm',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(qr);
        ui.toast('链接已复制');
      } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
    },
  });
  const shareBtn = ui.button({
    label: '分享', size: 'sm',
    onClick: () => void sendInviteLink(qr),
  });
  ui.dialog({
    title: `加入「${name}」`,
    size: 'sm',
    body: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
        <img src="${escapeAttr(dataUrl)}" alt="群二维码" style="width:220px;height:220px;border-radius:8px;background:#fff;padding:8px;box-sizing:border-box" />
        <div style="font-size:12px;color:var(--text-weak)">扫码或复制链接,对方加入群聊</div>
        <input class="ui-input" type="text" value="${escapeAttr(qr)}" readonly style="width:100%;font-size:11px" />
      </div>
    `,
    actions: [copyBtn, shareBtn],
  });
}

// 退群:确认后 leave_group,成功后关闭弹窗并退出当前会话。
function openLeaveDialog(info: ChatInfoDto, close: () => void): void {
  ui.confirm({
    title: '退出群聊',
    message: '确定退出该群聊?',
    danger: true,
    confirmLabel: '退出',
    onConfirm: async () => {
      try {
        await call('leave_group', { chatId: info.chat_id });
        close();
        if (state.currentChatId === info.chat_id) {
          state.currentChatId = null;
          saveState();
          const { renderMain } = await import('../../shell/navPanel.js');
          await renderMain();
        }
        ui.toast('已退出群聊');
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

// 删除群(本地删除,不清历史重复群外的对端)。确认后 delete_chat,退出当前会话。
function openDeleteDialog(info: ChatInfoDto, close: () => void): void {
  ui.confirm({
    title: '删除群聊',
    message: `确定删除「${info.name}」?此操作仅在本端移除该会话。`,
    danger: true,
    confirmLabel: '删除',
    onConfirm: async () => {
      try {
        await call('delete_chat', { chatId: info.chat_id });
        close();
        if (state.currentChatId === info.chat_id) {
          state.currentChatId = null;
          saveState();
          const { renderNavPanel, renderMain, refreshChannels } = await import('../../shell/navPanel.js');
          await refreshChannels();
          await renderNavPanel();
          await renderMain();
        }
        ui.toast('群已删除');
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
