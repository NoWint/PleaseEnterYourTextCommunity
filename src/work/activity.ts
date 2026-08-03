import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';
import type { ActivityDto } from '../types.js';

// SP6: 协作页"活动"tab 的 nav 面板内容。展示当前 workspace 的活动流。
// 拉取 list_activities(workspaceId, null, 100),按 created_at DESC 展示。
// 点击活动 → 若 target_type 为 card,跳转到对应协作频道并打开卡片详情。

interface ActionMeta {
  icon: IconName;
  label: (a: ActivityDto) => string;
}

const ACTION_META: Record<string, ActionMeta> = {
  card_created: {
    icon: 'plus',
    label: (a) => `创建了卡片「${payloadTitle(a)}」`,
  },
  card_updated: {
    icon: 'edit',
    label: (a) => `更新了卡片「${payloadTitle(a)}」`,
  },
  card_deleted: {
    icon: 'trash',
    label: (a) => `删除了卡片「${payloadTitle(a)}」`,
  },
  card_status_changed: {
    icon: 'check',
    label: (a) => `变更卡片状态「${payloadTitle(a)}」`,
  },
  channel_created: {
    icon: 'hash',
    label: () => `创建了频道`,
  },
  message_pinned: {
    icon: 'pin',
    label: () => `置顶了消息`,
  },
};

const DEFAULT_META: ActionMeta = {
  icon: 'info',
  label: (a) => `${a.action}`,
};

function payloadTitle(a: ActivityDto): string {
  if (!a.payload) return a.target_id.toString();
  try {
    const p = JSON.parse(a.payload) as { title?: string; name?: string };
    return p.title || p.name || a.target_id.toString();
  } catch {
    return a.target_id.toString();
  }
}

export async function renderActivityPanel(container: HTMLElement): Promise<void> {
  let activities: ActivityDto[] = [];
  try {
    activities = await call<ActivityDto[]>('list_activities', { channelChatId: null, limit: 100 });
  } catch {
    container.innerHTML = `<div class="nav-empty">活动加载失败</div>`;
    return;
  }

  if (activities.length === 0) {
    container.innerHTML = `<div class="nav-empty">暂无活动记录</div>`;
    return;
  }

  const itemsHtml = activities.map((a) => renderActivityItem(a)).join('');
  container.innerHTML = itemsHtml;

  container.querySelectorAll<HTMLElement>('.activity-item').forEach((el) => {
    el.onclick = async () => {
      const targetType = el.dataset.targetType || '';
      const channelId = el.dataset.channelId ? Number(el.dataset.channelId) : null;
      const targetId = el.dataset.targetId ? Number(el.dataset.targetId) : null;

      // 卡片类活动 → 跳转到对应协作频道
      if (targetType === 'card' && channelId) {
        state.currentPage = 'work';
        state.currentChatId = channelId;
        state.currentView = 'kanban';
        if (targetId) state.currentCardId = targetId;
        saveState();
        const { renderRail } = await import('../shell/rail.js');
        await renderRail();
        const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
        await renderNavPanel();
        await renderMain();
        if (targetId) {
          const { renderRightDrawer } = await import('../shell/rightDrawer.js');
          renderRightDrawer();
        }
      } else if (channelId) {
        // 频道类活动 → 跳转频道
        state.currentChatId = channelId;
        saveState();
        const { renderMain } = await import('../shell/navPanel.js');
        await renderMain();
      }
    };
  });
}

function renderActivityItem(a: ActivityDto): string {
  const meta = ACTION_META[a.action] || DEFAULT_META;
  const channelName = a.channel_chat_id
    ? state.channels.find((c) => c.chat_id === a.channel_chat_id)?.name || ''
    : '';
  const timeStr = formatTime(a.created_at);
  return `
    <div class="activity-item" data-target-type="${escapeHtml(a.target_type)}" data-target-id="${a.target_id}" data-channel-id="${a.channel_chat_id ?? ''}">
      <div class="activity-item-icon">${iconSvg(meta.icon, { width: 12, height: 12 })}</div>
      <div class="activity-item-body">
        <div class="activity-item-summary">
          <span class="activity-item-actor">${escapeHtml(a.actor_name)}</span>
          ${meta.label(a)}
        </div>
        <div class="activity-item-meta">
          ${channelName ? `<span class="activity-item-channel">#${escapeHtml(channelName)}</span>` : ''}
          <span class="activity-item-time">${escapeHtml(timeStr)}</span>
        </div>
      </div>
    </div>
  `;
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
