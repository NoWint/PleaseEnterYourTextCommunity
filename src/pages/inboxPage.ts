import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { showToast } from '../toast.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { renderAvatarHtml } from '../components/avatar.js';
import type { InboxEventDto, InboxEventType, Page } from '../types.js';

// SP6: Inbox 统一通知中心。渲染到 nav-panel,作为 rail 第 4 个图标的页面。
// 拉取 list_inbox_events (倒序),按 type 分组展示,支持单条/全部标记已读。
// 点击事件 → 跳转到来源频道 (messages 页) 并定位消息 (若 msg_id 存在)。

interface EventTypeMeta {
  icon: IconName;
  label: string;
}

const EVENT_META: Record<InboxEventType, EventTypeMeta> = {
  mention: { icon: 'hash', label: '提及' },
  reply: { icon: 'reply', label: '回复' },
  card_assign: { icon: 'layout-grid', label: '卡片指派' },
  system: { icon: 'info', label: '系统' },
};

export async function renderInboxPage(panel: HTMLElement): Promise<void> {
  const avatarHtml = state.self ? await renderAvatarHtml(state.self) : '';

  panel.innerHTML = `
    <div class="nav-header">
      <div class="nav-title">通知</div>
      <div class="nav-subtitle">${state.inboxUnread > 0 ? `${state.inboxUnread} 条未读` : '已全部读完'}</div>
      <div class="nav-header-actions">
        <button class="nav-header-btn" id="inbox-mark-all" title="全部已读">${iconSvg('check', { width: 14, height: 14 })}</button>
      </div>
    </div>
    <div class="nav-list" id="inbox-list"></div>
    <div class="nav-user">
      ${avatarHtml}
      <div class="nav-user-info">
        <div class="nav-user-name">${escapeHtml(state.self?.name || 'me')}</div>
      </div>
    </div>
  `;

  await renderInboxList();

  const markAllBtn = panel.querySelector<HTMLElement>('#inbox-mark-all');
  if (markAllBtn) {
    markAllBtn.onclick = async () => {
      try {
        await call('mark_all_inbox_read');
        state.inboxUnread = 0;
        saveState();
        await renderInboxList();
        // 更新 header 副标题
        const subtitle = panel.querySelector<HTMLElement>('.nav-subtitle');
        if (subtitle) subtitle.textContent = '已全部读完';
        // 刷新 rail 角标
        const { renderRail } = await import('../shell/rail.js');
        await renderRail();
        showToast('已全部标记已读');
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    };
  }
}

async function renderInboxList(): Promise<void> {
  const list = document.getElementById('inbox-list');
  if (!list) return;

  let events: InboxEventDto[] = [];
  try {
    events = await call<InboxEventDto[]>('list_inbox_events', { limit: 100 });
  } catch (e) {
    list.innerHTML = `<div class="nav-empty">加载失败</div>`;
    return;
  }

  if (events.length === 0) {
    list.innerHTML = `<div class="nav-empty">暂无通知</div>`;
    return;
  }

  const itemsHtml = events.map((ev) => renderInboxItem(ev)).join('');
  list.innerHTML = itemsHtml;

  list.querySelectorAll<HTMLElement>('.inbox-item').forEach((el) => {
    el.onclick = async () => {
      const id = Number(el.dataset.id);
      const chatId = Number(el.dataset.chatId);
      const msgId = el.dataset.msgId ? Number(el.dataset.msgId) : null;
      const read = el.dataset.read === '1';

      // 单条标记已读
      if (!read) {
        try {
          await call('mark_inbox_read', { eventId: id });
          el.dataset.read = '1';
          el.classList.remove('unread');
          state.inboxUnread = Math.max(0, state.inboxUnread - 1);
          saveState();
          // 更新 header 副标题 + rail 角标
          const subtitle = document.querySelector<HTMLElement>('#inbox-list')?.previousElementSibling?.querySelector('.nav-subtitle');
          if (subtitle) {
            subtitle.textContent = state.inboxUnread > 0 ? `${state.inboxUnread} 条未读` : '已全部读完';
          }
          const { renderRail } = await import('../shell/rail.js');
          await renderRail();
        } catch {}
      }

      // 跳转到来源频道
      if (chatId) {
        const isCardChannel = await isCardSpace(chatId);
        const targetPage: Page = isCardChannel ? 'work' : 'messages';
        state.currentPage = targetPage;
        state.currentChatId = chatId;
        if (isCardChannel) state.currentView = 'kanban';
        saveState();
        const { renderRail } = await import('../shell/rail.js');
        await renderRail();
        const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
        await renderNavPanel();
        await renderMain();
        const { renderRightDrawer } = await import('../shell/rightDrawer.js');
        renderRightDrawer();

        // 若有 msg_id,跳转后定位消息 (仅 messages 页)
        if (msgId && !isCardChannel) {
          setTimeout(() => {
            const msgEl = document.querySelector(`[data-msg="${msgId}"]`);
            if (msgEl) {
              msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
              (msgEl as HTMLElement).style.background = 'var(--active)';
              setTimeout(() => { (msgEl as HTMLElement).style.background = ''; }, 2000);
            }
          }, 200);
        }
      }
    };
  });
}

function renderInboxItem(ev: InboxEventDto): string {
  const meta = EVENT_META[ev.type as InboxEventType] || EVENT_META.system;
  const channelName = state.channels.find((c) => c.chat_id === ev.source_chat_id)?.name || '未知频道';
  const timeStr = formatTime(ev.created_at);
  const unreadCls = ev.read_at == null ? 'unread' : '';
  return `
    <div class="inbox-item ${unreadCls}" data-id="${ev.id}" data-chat-id="${ev.source_chat_id}" data-msg-id="${ev.msg_id ?? ''}" data-read="${ev.read_at != null ? '1' : '0'}">
      <div class="inbox-item-icon">${iconSvg(meta.icon, { width: 14, height: 14 })}</div>
      <div class="inbox-item-body">
        <div class="inbox-item-head">
          <span class="inbox-item-type">${escapeHtml(meta.label)}</span>
          <span class="inbox-item-time">${escapeHtml(timeStr)}</span>
        </div>
        <div class="inbox-item-summary">${escapeHtml(ev.summary)}</div>
        <div class="inbox-item-meta">
          <span class="inbox-item-actor">${escapeHtml(ev.actor_name)}</span>
          <span class="inbox-item-channel">#${escapeHtml(channelName)}</span>
        </div>
      </div>
      ${ev.read_at == null ? '<span class="inbox-unread-dot"></span>' : ''}
    </div>
  `;
}

async function isCardSpace(chatId: number): Promise<boolean> {
  try {
    const { getSpaceType } = await import('../shell/navPanel.js');
    const st = await getSpaceType(chatId);
    return st === 'card';
  } catch {
    return false;
  }
}

function formatTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );
}
