import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { showToast } from '../toast.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';
import type { InboxEventDto, InboxEventType, Page } from '../types.js';

// SP6: Inbox 统一通知中心。
// 主区视图 renderInboxMain 渲染到 chat-main;nav-panel 仅保留简洁占位。
// 拉取 list_inbox_events (倒序),支持单条/全部标记已读。
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

// 主区通知中心:header (标题 + 未读数 + 全部已读) + 可滚动列表
export async function renderInboxMain(main: HTMLElement): Promise<void> {
  main.innerHTML = `
    <div class="nav-header">
      <div class="nav-title">通知</div>
      <div class="nav-subtitle">${state.inboxUnread > 0 ? `${state.inboxUnread} 条未读` : '已全部读完'}</div>
      <div class="nav-header-actions">
        <button class="nav-header-btn inbox-mark-all" title="全部已读">${iconSvg('check', { width: 14, height: 14 })}</button>
      </div>
    </div>
    <div class="nav-list inbox-list" style="padding:16px 20px"></div>
  `;

  await renderInboxListInto(main);
  attachMarkAllButton(main);
}

// —— 公共渲染/交互逻辑:nav 与 main 共用 ——

// 渲染容器内的通知列表 (拉取 + 空态/错误态 + 绑定点击)
async function renderInboxListInto(container: HTMLElement): Promise<void> {
  const list = container.querySelector<HTMLElement>('.inbox-list');
  if (!list) return;

  let events: InboxEventDto[] = [];
  try {
    events = await call<InboxEventDto[]>('list_inbox_events', { limit: 100 });
  } catch {
    list.innerHTML = `<div class="nav-empty">加载失败</div>`;
    return;
  }

  if (events.length === 0) {
    list.innerHTML = `<div class="nav-empty">暂无通知</div>`;
    return;
  }

  list.innerHTML = events.map((ev) => renderInboxItem(ev)).join('');
  attachInboxItemHandlers(container, list);
}

// 绑定单条通知点击:标记已读 + 跳转来源频道 + 定位消息
function attachInboxItemHandlers(container: HTMLElement, list: HTMLElement): void {
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
          updateInboxSubtitle(container);
          // 刷新 rail 角标
          const { renderRail } = await import('../shell/rail.js');
          await renderRail();
        } catch {}
      }

      // 跳转到来源频道 (卡片频道 → work 页)
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

// 更新容器内 header 的未读副标题
function updateInboxSubtitle(container: HTMLElement): void {
  const subtitle = container.querySelector<HTMLElement>('.nav-subtitle');
  if (subtitle) {
    subtitle.textContent = state.inboxUnread > 0 ? `${state.inboxUnread} 条未读` : '已全部读完';
  }
}

// 绑定「全部已读」按钮
function attachMarkAllButton(container: HTMLElement): void {
  const btn = container.querySelector<HTMLElement>('.inbox-mark-all');
  if (btn) btn.onclick = () => markAllInboxRead(container);
}

// 「全部已读」:清空未读 + 刷新列表/副标题/rail 角标
async function markAllInboxRead(container: HTMLElement): Promise<void> {
  try {
    await call('mark_all_inbox_read');
    state.inboxUnread = 0;
    saveState();
    await renderInboxListInto(container);
    updateInboxSubtitle(container);
    // 刷新 rail 角标
    const { renderRail } = await import('../shell/rail.js');
    await renderRail();
    showToast('已全部标记已读');
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  }
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
