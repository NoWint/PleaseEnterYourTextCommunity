import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { iconSvg } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';
import { ui } from '../components/ui.js';
import { renderViewToggle, bindViewToggle } from '../components/viewToggle.js';
import { renderCardDetail } from './cardDetail.js';
import type { CardDto } from '../types.js';

// SP5 Task 7 → Task 15: 协作列表视图。表格形式展示卡片,支持列头排序、点击卡片打开
// 详情 (renderCardDetail)、切换到看板 (renderKanban)。
// 由 navPanel.ts 的 renderMain 通过 dynamic import 调用,渲染到 #chat-main。
//
// 零弹窗约束:新建卡片改用 createInlineInput (替代 prompt),"+ 新建" 按钮用 SVG 图标。
//
// 排序策略:brief 要求"排序后重新调用 renderList(chatId) 刷新"。但 renderList
// 内会重新调 list_cards 覆盖 state.cards,直接重排会被覆盖。因此用模块级
// currentSortField 记忆当前排序字段,renderList 在 fetch 后应用排序再渲染。
// 这样排序 / 新建 / 删除 (由 cardDetail.ts 调 renderList 触发) 都能正确呈现。
declare global {
  interface Window {
    __sortList?: (field: SortField) => void;
  }
}

type SortField = 'title' | 'status' | 'assignee_name' | 'due_date' | 'created_at';

let currentSortField: SortField | null = null;

export async function renderList(chatId: number): Promise<void> {
  const main = document.getElementById('chat-main');
  if (!main) return;
  let cards: CardDto[] = [];
  try {
    cards = await call<CardDto[]>('list_cards', { workspaceId: state.currentWsId, chatId });
    state.cards = cards;
  } catch (e) {
    showToast('加载失败: ' + (e instanceof Error ? e.message : String(e)));
    cards = state.cards || [];
  }
  // 应用当前排序 (若有)
  if (currentSortField && cards.length) {
    const field = currentSortField;
    cards = [...cards].sort((a, b) => {
      const va = (a[field] ?? '') as string | number;
      const vb = (b[field] ?? '') as string | number;
      return String(va).localeCompare(String(vb));
    });
    state.cards = cards;
  }

  main.innerHTML = `
    <div class="main-header">
      <div>
        <div class="main-title">协作列表</div>
        <div class="main-subtitle">${cards.length} 个卡片</div>
      </div>
      <div class="main-actions" id="list-actions">
        ${renderViewToggle(chatId)}
      </div>
    </div>
    <div class="main-body">
      <div class="list-view">
        <table class="list-table">
          <thead>
            <tr>
              <th class="th-sortable ${currentSortField === 'title' ? 'sorted' : ''}" onclick="window.__sortList('title')">标题</th>
              <th>类型</th>
              <th class="th-sortable ${currentSortField === 'status' ? 'sorted' : ''}" onclick="window.__sortList('status')">状态</th>
              <th class="th-sortable ${currentSortField === 'assignee_name' ? 'sorted' : ''}" onclick="window.__sortList('assignee_name')">指派</th>
              <th class="th-sortable ${currentSortField === 'due_date' ? 'sorted' : ''}" onclick="window.__sortList('due_date')">截止</th>
              <th class="th-sortable ${currentSortField === 'created_at' ? 'sorted' : ''}" onclick="window.__sortList('created_at')">创建</th>
            </tr>
          </thead>
          <tbody>
            ${cards.map((c) => renderRow(c)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  // 绑定 ViewToggle (4 视图切换:看板/列表/日历/时间线)
  bindViewToggle(chatId);
  // 绑定行点击 → 打开详情
  main.querySelectorAll<HTMLElement>('tbody tr').forEach((tr) => {
    tr.onclick = () => {
      const cardId = Number(tr.dataset.cardId);
      state.currentCardId = cardId;
      main.querySelectorAll('tr').forEach((r) => r.classList.remove('selected'));
      tr.classList.add('selected');
      void renderCardDetail(cardId);
    };
  });
  // "+ 新建" 按钮 → 内联创建 (替代 prompt)
  const actionsEl = main.querySelector<HTMLElement>('#list-actions');
  let newCardBtn: HTMLButtonElement;
  newCardBtn = ui.button({ label: '新建', icon: 'plus', variant: 'primary', onClick: () => { if (actionsEl) showInlineCreateCard(actionsEl, newCardBtn, chatId); } });
  if (actionsEl) actionsEl.appendChild(newCardBtn);
  // 列头排序:记忆字段后重新调用 renderList(chatId) 刷新 (按 brief 要求)
  window.__sortList = (field: SortField): void => {
    currentSortField = field;
    void renderList(chatId);
  };
}

// 列表视图内联创建卡片:隐藏 "+ 新建" 按钮,插入 createInlineInput。
// 确认 → create_card (默认 todo) → 重新渲染。取消 → 移除输入框 + 恢复按钮。
function showInlineCreateCard(
  actionsEl: HTMLElement,
  newCardBtn: HTMLElement,
  chatId: number
): void {
  newCardBtn.style.display = 'none';
  const input = ui.inlineInput({
    placeholder: '输入卡片标题',
    confirmLabel: '创建',
    onConfirm: async (title) => {
      try {
        await call('create_card', {
          workspaceId: state.currentWsId,
          chatId,
          type_: 'task',
          title,
          description: null,
          assigneeContactId: null,
          dueDate: null,
        });
        showToast('已创建');
        await renderList(chatId);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    onCancel: () => {
      newCardBtn.style.display = '';
      input.remove();
    },
  });
  actionsEl.appendChild(input);
}

function renderRow(c: CardDto): string {
  const statusClass = c.status;
  const dueStr = c.due_date ? new Date(c.due_date * 1000).toLocaleDateString('zh-CN') : '—';
  const createdStr = c.created_at ? new Date(c.created_at * 1000).toLocaleDateString('zh-CN') : '—';
  return `
    <tr data-card-id="${c.id}">
      <td class="col-title">${escapeHtml(c.title)}</td>
      <td><span class="col-type ${c.type === 'task' ? 'task' : ''}">${c.type === 'task' ? 'Task' : 'Card'}</span></td>
      <td class="col-status ${statusClass}"><span class="dot"></span>${statusLabel(c.status)}</td>
      <td>${escapeHtml(c.assignee_name || '—')}</td>
      <td>${dueStr}</td>
      <td>${createdStr}</td>
    </tr>
  `;
}

function statusLabel(s: string): string {
  return ({ todo: 'Todo', in_progress: 'In Progress', done: 'Done' } as Record<string, string>)[s] || s;
}
