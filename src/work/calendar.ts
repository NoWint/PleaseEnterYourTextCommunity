import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { iconSvg } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';
import { renderViewToggle, bindViewToggle } from '../components/viewToggle.js';
import type { CardDto, CardStatus } from '../types.js';

// SP7: 协作日历视图。按 task 的 due_date 在当月日历网格中展示卡片。
// 由 navPanel.ts 的 renderMain 通过 dynamic import 调用, 渲染到 #chat-main。
// 顶部 main-header (标题 + ViewToggle) + 月份切换 + 7x5~6 日历网格 + 底部"未排期"。
// 点击卡片 → 设置 currentCardId + 打开 rightDrawer 显示 cardDetail。

// 模块级游标:当前展示的年/月 (month 0-indexed)。跨渲染保留, 便于月份切换。
let viewYear: number | null = null;
let viewMonth: number | null = null;

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;
const STATUS_LABEL: Record<CardStatus, string> = {
  todo: 'Todo',
  in_progress: 'Doing',
  done: 'Done',
};

interface DayCell {
  date: Date;
  year: number;
  month: number;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  key: string; // YYYY-MM-DD (local)
}

export async function renderCalendar(chatId: number): Promise<void> {
  const main = document.getElementById('chat-main');
  if (!main) return;

  // 初始化月份游标为今天 (仅首次)
  const now = new Date();
  if (viewYear === null || viewMonth === null) {
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
  }
  const year = viewYear;
  const month = viewMonth;

  let cards: CardDto[] = [];
  try {
    cards = await call<CardDto[]>('list_cards', { workspaceId: state.currentWsId, chatId });
    state.cards = cards;
  } catch (e) {
    showToast('加载卡片失败: ' + (e instanceof Error ? e.message : String(e)));
    cards = state.cards || [];
  }

  const scheduled = cards.filter((c) => c.due_date != null);
  const unscheduled = cards.filter((c) => c.due_date == null);
  // 按 due_date 的 local YYYY-MM-DD 分组
  const byDay = new Map<string, CardDto[]>();
  for (const c of scheduled) {
    const d = new Date(c.due_date! * 1000);
    const key = dateKey(d);
    const arr = byDay.get(key) ?? [];
    arr.push(c);
    byDay.set(key, arr);
  }

  const cells = buildMonthGrid(year, month, now);
  const monthLabel = `${year}年${month + 1}月`;

  main.innerHTML = `
    <div class="main-header">
      <div>
        <div class="main-title">协作日历</div>
        <div class="main-subtitle">${cards.length} 个卡片 · ${scheduled.length} 已排期</div>
      </div>
      <div class="main-actions">
        ${renderViewToggle(chatId)}
      </div>
    </div>
    <div class="main-body">
      <div class="calendar-view">
        <div class="calendar-toolbar">
          <button class="cal-nav-btn" id="cal-prev" title="上一月">${iconSvg('chevron-left', { width: 14, height: 14 })}</button>
          <span class="cal-month-label">${monthLabel}</span>
          <button class="cal-nav-btn" id="cal-next" title="下一月">${iconSvg('chevron-right', { width: 14, height: 14 })}</button>
          <button class="cal-today-btn" id="cal-today" title="回到今天">今天</button>
        </div>
        <div class="calendar-grid-wrap">
          ${cards.length === 0 ? `<div class="empty">暂无卡片</div>` : `
            <div class="calendar-grid">
              ${WEEKDAY_LABELS.map((w) => `<div class="calendar-weekday">${w}</div>`).join('')}
              ${cells.map((cell) => renderDayCell(cell, byDay.get(cell.key) ?? [])).join('')}
            </div>
          `}
        </div>
        ${unscheduled.length > 0 ? `
          <div class="calendar-unscheduled">
            <div class="cal-unsched-header">未排期 · ${unscheduled.length}</div>
            <div class="cal-unsched-list">
              ${unscheduled.map((c) => renderUnscheduledChip(c)).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  // 绑定 ViewToggle
  bindViewToggle(chatId);

  // 绑定月份切换
  const prevBtn = main.querySelector<HTMLElement>('#cal-prev');
  const nextBtn = main.querySelector<HTMLElement>('#cal-next');
  const todayBtn = main.querySelector<HTMLElement>('#cal-today');
  prevBtn && (prevBtn.onclick = () => {
    shiftMonth(-1);
    void renderCalendar(chatId);
  });
  nextBtn && (nextBtn.onclick = () => {
    shiftMonth(1);
    void renderCalendar(chatId);
  });
  todayBtn && (todayBtn.onclick = () => {
    const t = new Date();
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    void renderCalendar(chatId);
  });

  // 绑定卡片点击 → 打开右侧详情抽屉
  main.querySelectorAll<HTMLElement>('.calendar-card').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const cardId = Number(el.dataset.cardId);
      state.currentCardId = cardId;
      state.rightDrawerOpen = true;
      state.detailPanelOpen = true;
      saveState();
      main.querySelectorAll('.calendar-card').forEach((c) => c.classList.remove('selected'));
      el.classList.add('selected');
      const { renderRightDrawer } = await import('../shell/rightDrawer.js');
      renderRightDrawer();
    };
  });
}

function shiftMonth(delta: number): void {
  if (viewYear === null || viewMonth === null) return;
  let m = viewMonth + delta;
  let y = viewYear;
  if (m < 0) { m = 11; y--; }
  else if (m > 11) { m = 0; y++; }
  viewYear = y;
  viewMonth = m;
}

// 构建当月日历网格 (周一起始), 含上下月补齐单元格, 共 ceil((offset+days)/7)*7 格。
function buildMonthGrid(year: number, month: number, now: Date): DayCell[] {
  const first = new Date(year, month, 1);
  const firstWeekday = first.getDay(); // 0=Sun..6=Sat
  const offset = (firstWeekday + 6) % 7; // 周一起始的前置格数
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((offset + daysInMonth) / 7) * 7;

  const todayKey = dateKey(now);
  const cells: DayCell[] = [];
  // 起始日期 = 当月1号往前 offset 天
  const start = new Date(year, month, 1 - offset);
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = dateKey(d);
    cells.push({
      date: d,
      year: d.getFullYear(),
      month: d.getMonth(),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      isToday: key === todayKey,
      key,
    });
  }
  return cells;
}

function renderDayCell(cell: DayCell, dayCards: CardDto[]): string {
  const classes = ['calendar-cell'];
  if (!cell.inMonth) classes.push('other');
  if (cell.isToday) classes.push('today');
  const cardsHtml = dayCards
    .slice()
    .sort((a, b) => (a.due_date! - b.due_date!))
    .map((c) => renderCalendarCard(c))
    .join('');
  return `
    <div class="${classes.join(' ')}" data-key="${cell.key}">
      <div class="calendar-cell-date">${cell.day}</div>
      <div class="calendar-cell-cards">${cardsHtml}</div>
    </div>
  `;
}

function renderCalendarCard(c: CardDto): string {
  const time = new Date(c.due_date! * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="calendar-card status-${c.status}" data-card-id="${c.id}" title="${escapeHtml(c.title)} · ${time}">
      <span class="cal-card-dot"></span>
      <span class="cal-card-time">${time}</span>
      <span class="cal-card-title">${escapeHtml(c.title)}</span>
    </div>
  `;
}

function renderUnscheduledChip(c: CardDto): string {
  return `
    <div class="calendar-card unsched status-${c.status}" data-card-id="${c.id}" title="${escapeHtml(c.title)}">
      <span class="cal-card-dot"></span>
      <span class="cal-card-title">${escapeHtml(c.title)}</span>
      <span class="cal-card-status">${STATUS_LABEL[c.status]}</span>
    </div>
  `;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
