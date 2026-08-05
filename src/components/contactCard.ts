import { call, transformBlobURL } from '../api.js';
import { showToast } from '../toast.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg } from './icon.js';
import { colorHex } from './avatar.js';
import { escapeHtml, escapeAttr } from './escape.js';
import { mountPopup, closePopup } from './readReceiptsPopup.js';
import { isOnline, lastSeenText } from '../utils/online.js';
import type { MemberDto, CommonChatDto, ContactDto } from '../types.js';

// 联系人/成员资料卡片 popup。
// 左右分列:左 = 大号头像(右下角在线状态)+ username + 灰色邮箱 + 发消息/分享名片;
// 右 = 共有会话列表(点击直接切换聊天)。
//
// 触发来源:
// - memberDetail 的成员(带 contact_id / last_seen)
// - 消息流 vCard 名片(只有 name/addr,无 contact_id → 无共有会话/发消息,仅展示+加好友引导)

interface ContactProfile {
  contactId: number | null; // null = 仅名片数据(未解析出本机联系人)
  name: string;
  addr: string;
  avatar: string | null; // blobdir 路径(成员)或 data URL(名片)
  color: number | null;
  lastSeen: number; // 0 = 未知
}

// 组装 + 锚定 + 关闭绑定(复用 mountPopup)。加载状态先展示,数据异步填充。
export async function openContactCard(opts: {
  contactId: number | null;
  name: string;
  addr: string;
  avatar?: string | null;
  color?: number | null;
  lastSeen?: number;
  anchor: HTMLElement;
}): Promise<void> {
  const contact: ContactProfile = {
    contactId: opts.contactId ?? null,
    name: opts.name,
    addr: opts.addr,
    avatar: opts.avatar ?? null,
    color: opts.color ?? null,
    lastSeen: opts.lastSeen ?? 0,
  };
  mountPopup(`
    <div class="cc-card">
      <div class="cc-left">
        <div class="cc-avatar-row">${await renderBigAvatar(contact)}</div>
        <div class="cc-name">${escapeHtml(contact.name || '?')}</div>
        ${contact.addr ? `<div class="cc-addr">${escapeHtml(contact.addr)}</div>` : ''}
        <div class="cc-actions">
          ${contact.contactId ? `
            <button class="cc-btn cc-btn-primary" data-cc-msg="1">${iconSvg('send', { width: 14, height: 14 })}发消息</button>
            <button class="cc-btn" data-cc-share="1">${iconSvg('forward', { width: 14, height: 14 })}分享名片</button>
          ` : ''}
        </div>
      </div>
      <div class="cc-right">
        <div class="cc-right-title">共有会话</div>
        <div class="cc-chat-list"><div class="ui-spinner"></div></div>
      </div>
    </div>
  `, opts.anchor, 'rr-popup cc-popup');

  // 在线状态色点(头像右下角)。lastSeen 有效才显示。
  const avatarRow = document.querySelector('.cc-popup .cc-avatar-row');
  if (avatarRow && contact.lastSeen > 0) {
    const online = isOnline(contact.lastSeen);
    avatarRow.insertAdjacentHTML('beforeend',
      `<span class="cc-online-dot${online ? ' on' : ''}" title="${online ? '在线' : `最后活跃：${lastSeenText(contact.lastSeen)}`}"></span>`);
  }

  // 按钮动作
  const msgBtn = document.querySelector('[data-cc-msg="1"]');
  msgBtn?.addEventListener('click', () => {
    if (contact.contactId == null) return;
    void (async () => {
      try {
        const chatId = await call<number>('create_chat_by_contact', { contactId: contact.contactId });
        closePopup();
        await switchToChat(chatId);
        showToast('已进入私聊');
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    })();
  });
  const shareBtn = document.querySelector('[data-cc-share="1"]');
  shareBtn?.addEventListener('click', () => {
    if (contact.contactId == null || state.currentChatId == null) {
      showToast('当前无可发送会话');
      return;
    }
    void (async () => {
      try {
        await call('send_vcard', { chatId: state.currentChatId, contactId: contact.contactId });
        closePopup();
        showToast('名片已发送');
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    })();
  });

  // 共有会话列表(右侧)
  const listEl = document.querySelector<HTMLElement>('.cc-popup .cc-chat-list');
  if (listEl) {
    if (contact.contactId == null) {
      listEl.innerHTML = `<div class="cc-empty">名片联系人尚未添加为好友</div>`;
    } else {
      await renderCommonChats(listEl, contact.contactId);
    }
  }
}

// 大号头像:有图用图(blobdir 或 data URL),无图首字母色块。
async function renderBigAvatar(c: ContactProfile): Promise<string> {
  if (c.avatar) {
    try {
      // blobdir 绝对路径 → asset URL;data URL 直接可用
      const url = c.avatar.startsWith('data:') ? c.avatar : await transformBlobURL(c.avatar);
      if (url) return `<div class="cc-avatar"><img src="${escapeAttr(url)}" alt="" /></div>`;
    } catch { /* 落回首字母 */ }
  }
  const bg = colorHex(c.color);
  const letter = (c.name || '?').charAt(0).toUpperCase() || '?';
  return `<div class="cc-avatar" style="background:${bg}">${escapeHtml(letter)}</div>`;
}

// 拉共有会话并渲染列表,点击直接切换聊天。
async function renderCommonChats(listEl: HTMLElement, contactId: number): Promise<void> {
  let chats: CommonChatDto[];
  try {
    chats = await call<CommonChatDto[]>('list_common_chats', { contactId });
  } catch (e) {
    listEl.innerHTML = `<div class="cc-empty">加载失败:${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    return;
  }
  listEl.innerHTML = '';
  if (chats.length === 0) {
    listEl.innerHTML = `<div class="cc-empty">暂无共有会话</div>`;
    return;
  }
  for (const c of chats) {
    const row = document.createElement('div');
    row.className = 'cc-chat-row';
    const img = c.avatar ? await transformBlobURL(c.avatar) : null;
    const bg = colorHex(c.color);
    const letter = (c.name || '?').charAt(0).toUpperCase() || '?';
    row.innerHTML = `
      ${c.is_group ? iconSvg('users', { width: 14, height: 14 }) : ''}
      <span class="cc-chat-name">${escapeHtml(c.name)}</span>
    `;
    if (c.is_group) {
      const ic = row.querySelector('svg');
      if (ic) { ic.style.flexShrink = '0'; ic.style.color = 'var(--text-mute)'; }
    }
    row.addEventListener('click', () => {
      closePopup();
      void (async () => {
        state.currentChatId = c.chat_id;
        state.currentPage = 'messages';
        state.currentWsId = null;
        saveState();
        const { renderRail } = await import('../shell/rail.js');
        const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
        await renderRail();
        await renderNavPanel();
        await renderMain();
      })();
    });
    listEl.appendChild(row);
  }
}

// 切换到指定聊天(复用 memberDetail 的切换逻辑)。
async function switchToChat(chatId: number): Promise<void> {
  state.currentPage = 'messages';
  state.currentWsId = null;
  state.currentChatId = chatId;
  state.rightDrawerOpen = false;
  saveState();
  const { renderRightDrawer } = await import('../shell/rightDrawer.js');
  const { renderRail } = await import('../shell/rail.js');
  const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
  const { renderChatView } = await import('../chat/chatView.js');
  renderRightDrawer();
  await renderRail();
  await renderNavPanel();
  await renderChatView(chatId);
}
