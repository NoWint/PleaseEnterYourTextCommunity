import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { ui } from './ui.js';
import { renderAvatarHtml } from './avatar.js';
import type { ChatListItem, MemberDto } from '../types.js';

/**
 * 邮件列表 / 广播会话资料弹窗。
 * chat_type === 'mailinglist' → 邮件列表;'broadcast' → 广播(一人发多人收,类似 Telegram channel)。
 * 成员列表来自 get_chat_info;离开复用 leave_group(广播也用这个),归档复用 archive_chat。
 * 说明:types.ts 的 ChatInfoDto 由主 Agent 补齐(含 chat_type),此处仅声明所需子集。
 */

// get_chat_info 返回结构 —— 只声明本组件用到的字段,多余字段由后端额外返回,运行时忽略。
interface ChatInfo {
  members: MemberDto[];
}

export async function openMailingListProfile(chatId: number, chat: ChatListItem): Promise<void> {
  // ChatListItem.chat_type 由主 Agent 在 types.ts 补齐;此处用交叉类型防御性访问,字段就位后依然兼容。
  const chatType = (chat as ChatListItem & { chat_type?: string }).chat_type;
  const typeLabel = chatType === 'mailinglist' ? '邮件列表' : '广播';

  const archiveBtn = ui.button({
    label: chat.is_archived ? '取消归档' : '归档',
    variant: 'ghost',
    onClick: async () => {
      dlg.close();
      try {
        await call('archive_chat', { chatId, archive: !chat.is_archived });
        ui.toast(chat.is_archived ? '已取消归档' : '已归档');
        await refreshNav();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
  const leaveBtn = ui.button({
    label: '离开',
    variant: 'danger',
    onClick: async () => {
      dlg.close();
      try {
        await call('leave_group', { chatId });
        const wasCurrent = state.currentChatId === chatId;
        if (wasCurrent) {
          state.currentChatId = null;
          saveState();
        }
        ui.toast('已离开');
        await refreshNav();
        if (wasCurrent) await refreshMain();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const dlg = ui.dialog({
    title: chat.name,
    size: 'lg',
    body: `
      <div style="display:inline-block;background:var(--capsule);color:var(--text-mute);font-size:var(--font-scale-body);padding:2px 10px;border-radius:999px;margin-bottom:12px">${escapeHtml(typeLabel)}</div>
      <div id="mlp-members" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:8px"><div class="ui-spinner"></div></div>
    `,
    actions: [archiveBtn, leaveBtn],
  });

  try {
    const info = await call<ChatInfo>('get_chat_info', { chatId });
    const membersEl = dlg.overlay.querySelector<HTMLElement>('#mlp-members');
    if (!membersEl) return;
    const members = info.members || [];
    if (members.length === 0) {
      membersEl.innerHTML = `<div style="color:var(--text-weak);font-size:var(--font-scale-body);padding:8px">暂无成员</div>`;
      return;
    }
    const rows = await Promise.all(
      members.map(async (m) => {
        const avatarHtml = await renderAvatarHtml(m);
        return `
          <div class="ui-dialog-section" style="flex-direction:row;align-items:center;padding:8px 12px">
            ${avatarHtml}
            <div style="min-width:0">
              <div style="font-size:var(--font-scale-body);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.name)}${m.is_self ? '<span style="font-size:var(--font-scale-secondary);color:var(--text-weak);margin-left:4px">我</span>' : ''}</div>
              <div style="font-size:var(--font-scale-secondary);color:var(--text-weak);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.addr || '')}</div>
            </div>
          </div>`;
      }),
    );
    membersEl.innerHTML = rows.join('');
  } catch (e) {
    const membersEl = dlg.overlay.querySelector<HTMLElement>('#mlp-members');
    if (membersEl) membersEl.innerHTML = `<div style="color:var(--text-weak);font-size:var(--font-scale-body);padding:8px">加载成员失败</div>`;
  }
}

async function refreshNav(): Promise<void> {
  const { renderNavPanel } = await import('../shell/navPanel.js');
  await renderNavPanel();
}

async function refreshMain(): Promise<void> {
  const { renderMain } = await import('../shell/navPanel.js');
  await renderMain();
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
