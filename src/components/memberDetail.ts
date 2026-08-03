import { call, transformBlobURL } from '../api.js';
import { showToast } from '../toast.js';
import { state } from '../state.js';
import { renderChatView } from '../chat/chatView.js';
import { renderRightDrawer } from '../shell/rightDrawer.js';
import { renderRail } from '../shell/rail.js';
import { renderNavPanel, renderMain } from '../shell/navPanel.js';
import { saveState } from '../persist.js';
import { colorHex } from './avatar.js';
import { escapeHtml } from './escape.js';
import { ui } from './ui.js';
import type { MemberDto } from '../types.js';

interface ChatInfo {
  members: MemberDto[];
}

export async function renderMemberDetail(body: HTMLElement, contactId: number): Promise<void> {
  body.innerHTML = `<div class="spinner"><span></span></div>`;
  try {
    const info = await call<ChatInfo>('get_chat_info', { chatId: state.currentChatId });
    const member = (info.members || []).find((m) => m.contact_id === contactId);
    if (!member) {
      body.innerHTML = `<div style="padding:16px;color:var(--text-weak)">成员不存在</div>`;
      return;
    }
    const avatarUrl = member.avatar ? await transformBlobURL(member.avatar) : null;
    const bg = colorHex(member.color);
    const letter = (member.name || '?').charAt(0).toUpperCase() || '?';
    const avatarHtml = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" class="member-detail-avatar" alt="" />`
      : `<div class="member-detail-avatar" style="background:${bg}">${escapeHtml(letter)}</div>`;
    body.innerHTML = `
      <div class="rd-group">成员详情</div>
      <div id="md-actions" style="padding:0 16px 8px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:10px;margin:8px 0">
          ${avatarHtml}
          <div>
            <div style="font-size:var(--font-scale-body);font-weight:600;color:var(--text)">${escapeHtml(member.name)}</div>
            <div style="font-size:var(--font-scale-micro);color:var(--text-weak)">${escapeHtml(member.addr || '')}</div>
          </div>
        </div>
      </div>
    `;
    const actions = document.getElementById('md-actions');
    if (actions) {
      const msgBtn = ui.button({
        label: '发消息',
        size: 'sm',
        onClick: async () => {
          try {
            const chatId = await call<number>('create_chat_by_contact', { contactId });
            state.currentPage = 'messages';
            state.currentWsId = null;
            state.currentChatId = chatId;
            state.rightDrawerOpen = false;
            saveState();
            renderRightDrawer();
            await renderRail();
            await renderNavPanel();
            await renderChatView(chatId);
            showToast('已进入私聊');
          } catch (e) {
            showToast(e instanceof Error ? e.message : String(e));
          }
        },
      });
      msgBtn.style.marginTop = '8px';
      const backBtn = ui.button({
        label: '返回成员列表',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          state.detailTab = 'members';
          renderRightDrawer();
        },
      });
      actions.append(msgBtn, backBtn);
    }
  } catch (e) {
    body.innerHTML = `<div style="padding:16px;color:var(--text-weak)">加载失败</div>`;
    showToast(e instanceof Error ? e.message : String(e));
  }
}
