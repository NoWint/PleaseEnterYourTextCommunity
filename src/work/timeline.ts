import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { renderViewToggle, bindViewToggle } from '../components/viewToggle.js';
import { escapeHtml } from '../components/escape.js';
import type { CardDto, CardStatus } from '../types.js';

// SP7: 协作时间线视图。按 created_at DESC 排列卡片, 左侧时间轴 + 右侧卡片摘要。
// 由 navPanel.ts 的 renderMain 通过 dynamic import 调用, 渲染到 #chat-main。
// 顶部 main-header (标题 + ViewToggle) + 时间线主体 (按 今天 / 昨天 / 更早 分组)。
// 点击卡片 → 设置 currentCardId + 打开 rightDrawer 显示 cardDetail。

const STATUS_LABEL: Record<CardStatus, string> = {
  todo: 'Todo',
  in_progress: 'Doing',
  done: 'Done',
};

interface TimelineGroup {
  key: 'today' | 'yesterday' | 'earlier';
  label: string;
  items: CardDto[];
}

export async function renderTimeline(chatId: number): Promise<void> {
  const main = document.getElementById('chat-main');
  if (!main) return;

  let cards: CardDto[] = [];
  try {
    cards = await call<CardDto[]>('list_cards', { workspaceId: state.currentWsId, chatId });
    state.cards = cards;
  } catch (e) {
    showToast('加载卡片失败: ' + (e instanceof Error ? e.message : String(e)));
    cards = state.cards || [];
  }

  // created_at DESC
  const sorted = [...cards].sort((a, b) => b.created_at - a.created_at);
  const groups = groupByDate(sorted);

  main.innerHTML = `
    <div class="main-header">
      <div>
        <div class="main-title">协作时间线</div>
        <div class="main-subtitle">${cards.length} 个卡片 · 按 created_at 倒序</div>
      </div>
      <div class="main-actions">
        ${renderViewToggle(chatId)}
      </div>
    </div>
    <div class="main-body">
      <div class="timeline-view">
        ${cards.length === 0
          ? `<div class="empty">暂无卡片</div>`
          : groups.map((g) => renderGroup(g)).join('')}
      </div>
    </div>
  `;

  // 绑定 ViewToggle
  bindViewToggle(chatId);

  // 绑定卡片点击 → 打开右侧详情抽屉
  main.querySelectorAll<HTMLElement>('.timeline-item').forEach((el) => {
    el.onclick = async () => {
      const cardId = Number(el.dataset.cardId);
      state.currentCardId = cardId;
      state.rightDrawerOpen = true;
      state.detailPanelOpen = true;
      saveState();
      main.querySelectorAll('.timeline-item').forEach((c) => c.classList.remove('selected'));
      el.classList.add('selected');
      const { renderRightDrawer } = await import('../shell/rightDrawer.js');
      renderRightDrawer();
    };
  });
}

// 按 created_at 的 local 日期分组:今天 / 昨天 / 更早。组内保持 DESC。
function groupByDate(cards: CardDto[]): TimelineGroup[] {
  const now = new Date();
  const todayKey = dateKey(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = dateKey(yesterday);

  const today: CardDto[] = [];
  const yesterdayCards: CardDto[] = [];
  const earlier: CardDto[] = [];
  for (const c of cards) {
    const key = dateKey(new Date(c.created_at * 1000));
    if (key === todayKey) today.push(c);
    else if (key === yesterdayKey) yesterdayCards.push(c);
    else earlier.push(c);
  }
  const groups: TimelineGroup[] = [
    { key: 'today', label: '今天', items: today },
    { key: 'yesterday', label: '昨天', items: yesterdayCards },
    { key: 'earlier', label: '更早', items: earlier },
  ];
  return groups.filter((g) => g.items.length > 0);
}

function renderGroup(g: TimelineGroup): string {
  return `
    <div class="timeline-group">
      <div class="timeline-group-header">${g.label} · ${g.items.length}</div>
      <div class="timeline-items">
        ${g.items.map((c) => renderItem(c, g.key)).join('')}
      </div>
    </div>
  `;
}

function renderItem(c: CardDto, groupKey: TimelineGroup['key']): string {
  const d = new Date(c.created_at * 1000);
  const axisLabel =
    groupKey === 'earlier'
      ? d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
      : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const dueStr = c.due_date
    ? new Date(c.due_date * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    : '';
  const assignee = c.assignee_name || '未指派';
  const initial = c.assignee_name ? c.assignee_name[0].toUpperCase() : '?';
  return `
    <div class="timeline-item status-${c.status}" data-card-id="${c.id}">
      <div class="timeline-axis">${escapeHtml(axisLabel)}</div>
      <div class="timeline-card">
        <div class="timeline-card-title">${escapeHtml(c.title)}</div>
        <div class="timeline-card-meta">
          <span class="tl-status">${STATUS_LABEL[c.status]}</span>
          <span class="tl-assignee" title="${escapeHtml(assignee)}"><span class="tl-avatar">${escapeHtml(initial)}</span>${escapeHtml(assignee)}</span>
          ${dueStr ? `<span class="tl-due">截止 ${dueStr}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
