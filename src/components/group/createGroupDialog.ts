import { call, transformBlobURL } from '../../api.js';
import { state } from '../../state.js';
import { saveState } from '../../persist.js';
import { ui } from '../ui.js';
import { iconSvg } from '../icon.js';
import { escapeHtml } from '../escape.js';
import { openMemberPicker, type MemberPick } from './memberPicker.js';

// 群创建对话框(仿 Delta CreateGroup):
// 群名 + 群描述 + 群头像(原图直设,显示时 CSS 圆形裁剪)+ 成员选择器。
// 成功后进入新会话。

export function openCreateGroupDialog(): void {
  let avatarPath: string | null = null; // blobdir 绝对路径;null=未设置
  const members: MemberPick[] = [];

  const nameInput = ui.input({ placeholder: '群名称' });
  const descInput = document.createElement('textarea');
  descInput.className = 'cg-desc';
  descInput.placeholder = '群描述(可选)';

  // 头像区:每次 rebuild 后重新查询并绑定事件(fillAvatarImage 异步填图)。
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
      } catch { /* 预览失败保持占位 */ }
    }
    avatarHost.querySelector<HTMLElement>('#cg-upload')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) void setAvatarFromFile(file);
      });
      input.click();
    });
    avatarHost.querySelector<HTMLElement>('#cg-remove')?.addEventListener('click', () => {
      avatarPath = null;
      void rebuildAvatar();
    });
  };
  const setAvatarFromFile = async (file: File): Promise<void> => {
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      avatarPath = await call<string>('save_avatar_from_bytes', { bytes, ext });
      await rebuildAvatar();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  };

  // 成员区:添加成员按钮 → memberPicker;已选 chips 可移除。
  const membersWrap = document.createElement('div');
  const renderMembers = (): void => {
    membersWrap.innerHTML = `
      <div class="cg-members-row">
        <span class="cg-members-label">${members.length} 位成员</span>
        <button class="ui-button ui-button-ghost ui-button-sm" id="cg-add-member">${iconSvg('plus', { width: 14, height: 14 })} 添加成员</button>
      </div>
      <div class="cg-members-chips">
        ${members.map((m, i) => `
          <span class="cg-member-chip">
            ${escapeHtml(m.name || m.email)}
            <span class="cg-member-x" data-idx="${i}" title="移除">${iconSvg('x', { width: 12, height: 12 })}</span>
          </span>
        `).join('')}
      </div>
    `;
    membersWrap.querySelector<HTMLElement>('#cg-add-member')?.addEventListener('click', () => {
      openMemberPicker({
        title: '选择群成员',
        existing: new Set<number>(),
        onOk: (picks) => {
          members.length = 0;
          members.push(...picks);
          renderMembers();
        },
      });
    });
    membersWrap.querySelectorAll<HTMLElement>('.cg-member-x').forEach((x) => {
      x.addEventListener('click', () => {
        members.splice(Number(x.dataset.idx), 1);
        renderMembers();
      });
    });
  };

  const cancelBtn = ui.button({ label: '取消', variant: 'ghost', onClick: () => dlg.close() });
  const createBtn = ui.button({
    label: '创建群', variant: 'primary',
    onClick: async () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        nameInput.style.borderColor = 'var(--danger)';
        setTimeout(() => { nameInput.style.borderColor = ''; }, 1500);
        ui.toast('请输入群名称');
        return;
      }
      createBtn.disabled = true;
      try {
        // 参数用 camelCase:tauri #[tauri::command] 默认把 Rust 参数名 camelCase 化,
        // 后端 member_emails/member_contact_ids/avatar_path → 前端传 memberEmails/memberContactIds/avatarPath。
        const chatId = await call<number>('create_group', {
          name,
          memberEmails: members.filter((m) => m.contact_id === 0).map((m) => m.email),
          memberContactIds: members.filter((m) => m.contact_id !== 0).map((m) => m.contact_id),
          description: descInput.value.trim() || null,
          avatarPath,
        });
        dlg.close();
        state.currentChatId = chatId;
        saveState();
        // 刷新侧栏列表(新群出现在消息列表)+ 渲染主区
        const { renderNavPanel, renderMain, refreshChannels } = await import('../../shell/navPanel.js');
        await refreshChannels();
        await renderNavPanel();
        await renderMain();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
        createBtn.disabled = false;
      }
    },
  });

  const dlg = ui.dialog({
    title: '创建群',
    size: 'lg',
    body: `
      <div id="cg-avatar-slot"></div>
      <div id="cg-name-slot"></div>
      <div id="cg-desc-slot"></div>
      <div id="cg-members-slot"></div>
    `,
    actions: [cancelBtn, createBtn],
  });

  dlg.overlay.querySelector('#cg-avatar-slot')?.appendChild(avatarHost);
  dlg.overlay.querySelector('#cg-name-slot')?.appendChild(nameInput);
  dlg.overlay.querySelector('#cg-desc-slot')?.appendChild(descInput);
  dlg.overlay.querySelector('#cg-members-slot')?.appendChild(membersWrap);
  void rebuildAvatar();
  renderMembers();
  nameInput.focus();
}
