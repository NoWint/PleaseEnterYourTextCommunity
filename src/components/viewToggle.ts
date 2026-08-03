import { state } from '../state.js';
import { saveState } from '../persist.js';
import { iconSvg } from './icon.js';
import type { CurrentView } from '../types.js';
import type { IconName } from './icon.js';

// SP7: 共享视图切换组件。替代 kanban.ts / list.ts 各自渲染的 .view-toggle,
// 提供 4 个视图 (看板 / 列表 / 日历 / 时间线) 切换按钮, 用 TDesign SVG 图标。
// 由 calendar.ts / timeline.ts (及后续迁移后的 kanban/list) 调用。
//
// 点击按钮:更新 state.currentView + 按频道记忆 viewPrefs[chatId] + saveState,
// 然后 dynamic import navPanel.renderMain 触发 re-render (单一分发路径)。
// 注:navPanel 的 calendar/timeline 分发由主 agent 集成, 本组件只负责状态 + 触发。

interface ViewOption {
  view: CurrentView;
  label: string;
  icon: IconName;
}

const VIEW_OPTIONS: ReadonlyArray<ViewOption> = [
  { view: 'kanban', label: '看板', icon: 'columns' },
  { view: 'list', label: '列表', icon: 'list' },
  { view: 'calendar', label: '日历', icon: 'calendar' },
  { view: 'timeline', label: '时间线', icon: 'timeline' },
];

function currentViewFor(chatId: number): CurrentView {
  return state.viewPrefs[chatId] ?? state.currentView;
}

// 返回 4 按钮 .view-toggle HTML (含 data-chat-id 便于 bindViewToggle 定位)。
export function renderViewToggle(chatId: number): string {
  const current = currentViewFor(chatId);
  const buttons = VIEW_OPTIONS.map((opt) => {
    const isActive = opt.view === current;
    return `<button class="view-btn${isActive ? ' active' : ''}" data-view="${opt.view}" title="${opt.label}">
      ${iconSvg(opt.icon, { width: 13, height: 13 })}<span class="view-btn-label">${opt.label}</span>
    </button>`;
  }).join('');
  return `<div class="view-toggle" data-chat-id="${chatId}">${buttons}</div>`;
}

// 绑定 .view-toggle 内按钮点击 → 切换视图 (状态记忆 + 触发 renderMain)。
export function bindViewToggle(chatId: number): void {
  const main = document.getElementById('chat-main');
  if (!main) return;
  const toggle = main.querySelector<HTMLElement>(`.view-toggle[data-chat-id="${chatId}"]`);
  if (!toggle) return;
  toggle.querySelectorAll<HTMLElement>('.view-btn').forEach((btn) => {
    btn.onclick = async () => {
      const view = btn.dataset.view as CurrentView | undefined;
      if (!view) return;
      if (view === currentViewFor(chatId)) return;
      state.currentView = view;
      state.viewPrefs[chatId] = view;
      saveState();
      const { renderMain } = await import('../shell/navPanel.js');
      await renderMain();
    };
  });
}
