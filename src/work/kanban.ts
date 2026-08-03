import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { iconSvg } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';
import { ui } from '../components/ui.js';
import { renderViewToggle, bindViewToggle } from '../components/viewToggle.js';
import type { CardDto, CardStatus } from '../types.js';

// SP5 Task 6 → Task 15: 协作看板视图。三列 (Todo / In Progress / Done)，支持卡片
// 状态切换、点击卡片打开详情 (renderCardDetail)、列底部内联创建卡片。
// 由 navPanel.ts 的 renderMain 通过 dynamic import 调用，渲染到 #chat-main。
//
// 零弹窗约束:新建卡片改用 createInlineInput (替代 prompt)，删除走 showInlineConfirm。
// 全局函数 __switchToList / __newCard 保留以兼容原 inline onclick handlers。
declare global {
  interface Window {
    __newCard?: (chatId: number, status?: CardStatus) => void;
  }
}

export async function renderKanban(chatId: number): Promise<void> {
  const main = document.getElementById('chat-main');
  if (!main) return;
  let cards: CardDto[] = [];
  try {
    cards = await call<CardDto[]>('list_cards', { workspaceId: state.currentWsId, chatId });
    state.cards = cards;
  } catch (e) {
    showToast('加载卡片失败: ' + (e instanceof Error ? e.message : String(e)));
  }
  const todoCards = cards.filter((c) => c.status === 'todo');
  const ipCards = cards.filter((c) => c.status === 'in_progress');
  const doneCards = cards.filter((c) => c.status === 'done');

  main.innerHTML = `
    <div class="main-header">
      <div>
        <div class="main-title">协作看板</div>
        <div class="main-subtitle">${cards.length} 个卡片</div>
      </div>
      <div class="main-actions" id="kanban-actions">
        ${renderViewToggle(chatId)}
      </div>
    </div>
    <div class="main-body">
      <div class="kanban">
        ${renderColumn('Todo', todoCards, 'todo', chatId)}
        ${renderColumn('In Progress', ipCards, 'in_progress', chatId)}
        ${renderColumn('Done', doneCards, 'done', chatId)}
      </div>
    </div>
  `;
  // 顶部「新建」按钮 (ui.button,点击复用全局 __newCard)
  const actions = main.querySelector('#kanban-actions');
  if (actions) {
    const newBtn = ui.button({ label: '新建', icon: 'plus', variant: 'primary', onClick: () => window.__newCard?.(chatId) });
    actions.appendChild(newBtn);
  }

  // 绑定 ViewToggle (4 视图切换:看板/列表/日历/时间线)
  bindViewToggle(chatId);
  // 绑定卡片点击 → 打开右侧详情抽屉
  main.querySelectorAll<HTMLElement>('.card').forEach((el) => {
    el.onclick = async () => {
      const cardId = Number(el.dataset.cardId);
      state.currentCardId = cardId;
      // C1 修复:点击卡片前先打开右侧抽屉,让 rightDrawer.ts 的 work+card 分支
      // 移除 collapsed 类,否则 renderCardDetail 写入的 innerHTML 会被零宽度抽屉隐藏。
      state.rightDrawerOpen = true;
      state.detailPanelOpen = true;
      saveState();
      main.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'));
      el.classList.add('selected');
      const { renderRightDrawer } = await import('../shell/rightDrawer.js');
      renderRightDrawer();
    };
  });
  // 绑定状态切换按钮 (segmented control: Todo/Doing/Done)
  main.querySelectorAll<HTMLElement>('.card-status-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const cardId = Number(btn.dataset.cardId);
      const newStatus = btn.dataset.status as CardStatus;
      try {
        await call('update_card', { cardId, status: newStatus });
        await renderKanban(chatId);
      } catch (err) {
        showToast('更新状态失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    };
  });
  // 绑定列底部 "+ 添加卡片" → 内联创建 (替代 prompt)
  main.querySelectorAll<HTMLElement>('.card-add').forEach((addEl) => {
    addEl.onclick = () => {
      const status = (addEl.dataset.status as CardStatus) ?? 'todo';
      const colBody = addEl.parentElement;
      if (!colBody) return;
      showInlineCreateCard(colBody, addEl, chatId, status);
    };
  });

  // 暴露全局函数 (兼容 inline onclick handlers,避免静态 import 循环)
  window.__newCard = (cid: number, status: CardStatus = 'todo'): void => {
    // 顶部 "新建" 按钮:在目标列 (默认 Todo) 底部展开内联输入
    const colBody = main.querySelector<HTMLElement>(`.kanban-col[data-status="${status}"] .kanban-col-body`);
    const addEl = colBody?.querySelector<HTMLElement>('.card-add') ?? null;
    if (colBody && addEl) {
      showInlineCreateCard(colBody, addEl, cid, status);
    }
  };
}

// 列内联创建卡片:隐藏 "+ 添加卡片" 按钮,插入 createInlineInput。
// 确认 → create_card (后端总建为 todo) + 必要时 update_card 改状态 → 重新渲染。
// 取消 → 重新渲染 (恢复 add 按钮)。失败 → toast,输入框标错保留。
function showInlineCreateCard(
  colBody: HTMLElement,
  addEl: HTMLElement,
  chatId: number,
  defaultStatus: CardStatus
): void {
  addEl.style.display = 'none';
  const input = ui.inlineInput({
    placeholder: '输入卡片标题',
    confirmLabel: '创建',
    onConfirm: async (title) => {
      try {
        const card = await call<CardDto>('create_card', {
          workspaceId: state.currentWsId,
          chatId,
          type_: 'task',
          title,
          description: null,
          assigneeContactId: null,
          dueDate: null,
        });
        // M7 修复:create_card 后端总是创建为 "todo",若目标列非 todo 需追加 update_card。
        if (defaultStatus !== 'todo' && card?.id) {
          await call('update_card', { cardId: card.id, status: defaultStatus });
        }
        showToast('已创建');
        await renderKanban(chatId);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    onCancel: () => {
      addEl.style.display = '';
      input.remove();
    },
  });
  colBody.appendChild(input);
}

function renderColumn(title: string, cards: CardDto[], status: CardStatus, _chatId: number): string {
  return `
    <div class="kanban-col" data-status="${status}">
      <div class="kanban-col-header">
        <span class="kanban-col-title">${escapeHtml(title)}</span>
        <span class="kanban-col-count">${cards.length}</span>
      </div>
      <div class="kanban-col-body">
        ${cards.map((c) => renderCard(c, status)).join('')}
        <div class="card-add" data-status="${status}">${iconSvg('plus', { width: 12, height: 12 })} 添加卡片</div>
      </div>
    </div>
  `;
}

function renderCard(c: CardDto, currentStatus: CardStatus): string {
  const dueStr = c.due_date
    ? new Date(c.due_date * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    : '';
  const isOverdue = c.due_date ? c.due_date < Date.now() / 1000 : false;
  const assigneeInitial = c.assignee_name ? c.assignee_name[0].toUpperCase() : '';
  // M5 修复:状态切换从无标签小圆点改为带文字的 segmented control (Todo/Doing/Done)。
  return `
    <div class="card" data-card-id="${c.id}">
      <div class="card-title">${escapeHtml(c.title)}</div>
      <div class="card-meta">
        <span class="card-type ${c.type === 'task' ? 'task' : ''}">${c.type === 'task' ? 'Task' : 'Card'}</span>
        ${dueStr ? `<span class="card-due ${isOverdue ? 'overdue' : ''}">${escapeHtml(dueStr)}</span>` : ''}
        ${assigneeInitial ? `<span class="card-assignee">${escapeHtml(assigneeInitial)}</span>` : ''}
      </div>
      <div class="card-status-row">
        <button class="card-status-btn ${currentStatus === 'todo' ? 'active' : ''}" data-card-id="${c.id}" data-status="todo" title="Todo">Todo</button>
        <button class="card-status-btn ${currentStatus === 'in_progress' ? 'active' : ''}" data-card-id="${c.id}" data-status="in_progress" title="In Progress">Doing</button>
        <button class="card-status-btn ${currentStatus === 'done' ? 'active' : ''}" data-card-id="${c.id}" data-status="done" title="Done">Done</button>
      </div>
    </div>
  `;
}

