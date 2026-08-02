import { call, eventLog, type DcEvent } from '../api.js';
import { state } from '../state.js';
import { iconSvg } from '../components/icon.js';

const PAGE_SIZE = 20;

export interface RawMsgDto {
  msg_id: number;
  chat_id: number;
  chat_name: string;
  from_name: string;
  is_out: boolean;
  ts: number;
  view_type: string;
  text: string;
}

type Filter = 'all' | 'envelope' | 'out';

interface PageState {
  items: RawMsgDto[];
  cursor: number | null;
  hasMore: boolean;
  filter: Filter;
  loading: boolean;
}

const ps: PageState = { items: [], cursor: null, hasMore: true, filter: 'all', loading: false };

export function renderDebugNav(panel: HTMLElement): void {
  panel.innerHTML = `
    <div class="nav-header"><div class="nav-title">调试</div></div>
    <div class="empty">消息原文列表在主区查看</div>
  `;
}

export async function renderDebugMain(main: HTMLElement): Promise<void> {
  main.innerHTML = `
    <div class="dbg-toolbar">
      <span class="dbg-count" id="dbg-count">0 条</span>
      <span class="dbg-filter">
        <label><input type="radio" name="dbg-filter" value="all" ${ps.filter === 'all' ? 'checked' : ''}/>全部</label>
        <label><input type="radio" name="dbg-filter" value="envelope" ${ps.filter === 'envelope' ? 'checked' : ''}/>仅信封</label>
        <label><input type="radio" name="dbg-filter" value="out" ${ps.filter === 'out' ? 'checked' : ''}/>仅发出</label>
      </span>
      <button class="dbg-refresh" id="dbg-refresh" title="刷新">${iconSvg('refresh-cw', { width: 14, height: 14 })}</button>
    </div>
    <div class="dbg-chatlist" id="dbg-state"></div>
    <div class="dbg-chatlist" id="dbg-chatlist"></div>
    <div class="dbg-chatlist" id="dbg-events"></div>
    <div class="dbg-list" id="dbg-list"></div>
    <div class="dbg-footer">
      <button class="dbg-more" id="dbg-more">加载更多</button>
      <span class="dbg-status" id="dbg-status"></span>
    </div>
  `;

  main.querySelectorAll<HTMLInputElement>('input[name="dbg-filter"]').forEach((r) => {
    r.addEventListener('change', () => {
      ps.filter = r.value as Filter;
      reset();
      void loadMore().then(render);
    });
  });
  main.querySelector<HTMLElement>('#dbg-refresh')?.addEventListener('click', () => {
    reset();
    void loadMore().then(render);
  });
  main.querySelector<HTMLElement>('#dbg-more')?.addEventListener('click', () => {
    void loadMore().then(render);
  });

  await loadMore();
  render();
  await renderChatlist();
  renderEventLog();
  renderStateDiag();
  // 事件流面板实时刷新,便于观察事件是否到达前端
  window.setInterval(() => {
    renderEventLog();
  }, 1000);
}

// 前端状态诊断: 显示 workspaces/channels/currentWsId,排查会话被 filter 误伤
function renderStateDiag(): void {
  const box = document.getElementById('dbg-state');
  if (!box) return;
  const ws = state.workspaces.map((w) => `ws#${w.id}(${escapeHtml(w.name)}) master=${w.master_chat_id}`).join(' ');
  const chans = state.channels.map((c) => `ch#${c.chat_id}`).join(' ');
  const wsIds = new Set<number>();
  for (const w of state.workspaces) {
    wsIds.add(w.master_chat_id);
    for (const c of state.channels) if (c.workspace_id === w.id) wsIds.add(c.chat_id);
  }
  box.innerHTML = `<div class="dbg-chat-head">前端状态:</div>
    <div class="dbg-chat-row">currentWsId=${state.currentWsId} currentPage=${state.currentPage} currentChatId=${state.currentChatId}</div>
    <div class="dbg-chat-row">workspaces: ${ws || '(空)'}</div>
    <div class="dbg-chat-row">channels: ${chans || '(空)'}</div>
    <div class="dbg-chat-row">wsChatIds(会被过滤): ${[...wsIds].join(',') || '(空)'}</div>`;
}

// 事件流面板: 显示最近收到的 dc-event,排查事件驱动刷新失效
function renderEventLog(): void {
  const box = document.getElementById('dbg-events');
  if (!box) return;
  const rows = eventLog.slice(-30).map((e) => {
    const brief = e.msg_id != null ? `msg=${e.msg_id}` : e.chat_id != null ? `chat=${e.chat_id}` : '';
    return `<div class="dbg-chat-row">${escapeHtml(e.typ)} ${brief ? '<span class="dbg-type">' + escapeHtml(brief) + '</span>' : ''}</div>`;
  }).join('') || '<div class="dbg-chat-row">(无事件)</div>';
  box.innerHTML = `<div class="dbg-chat-head">事件流 (${eventLog.length}):</div>${rows}`;
}

// 会话诊断: 显示 get_chatlist 原始内容, 对照侧栏排查缺失会话
async function renderChatlist(): Promise<void> {
  const box = document.getElementById('dbg-chatlist');
  if (!box) return;
  try {
    const chats = await call<Array<{ chat_id: number; name: string; type: string; is_contact_request: boolean }>>('debug_chatlist');
    const rows = chats.map((c) =>
      `<div class="dbg-chat-row">#${c.chat_id} <b>${escapeHtml(c.name || '(unnamed)')}</b> <span class="dbg-type">${c.type}${c.is_contact_request ? ' REQUEST' : ''}</span></div>`
    ).join('') || '<div class="dbg-chat-row">(空)</div>';
    box.innerHTML = `<div class="dbg-chat-head">会话诊断 (${chats.length}):</div>${rows}`;
  } catch (e) {
    box.innerHTML = `<div class="dbg-chat-head">会话诊断失败: ${escapeHtml(String(e))}</div>`;
  }
}

function reset(): void {
  ps.items = [];
  ps.cursor = null;
  ps.hasMore = true;
}

function matches(item: RawMsgDto, f: Filter): boolean {
  if (f === 'out' && !item.is_out) return false;
  if (f === 'envelope' && !isEnvelope(item.text)) return false;
  return true;
}

function isEnvelope(text: string): boolean {
  return text.startsWith('[PEYT]');
}

async function loadMore(): Promise<void> {
  if (ps.loading || !ps.hasMore) return;
  ps.loading = true;
  const list = document.getElementById('dbg-list');
  const status = document.getElementById('dbg-status');
  try {
    const batch = await call<RawMsgDto[]>('get_all_messages', { cursor: ps.cursor, limit: PAGE_SIZE });
    const filtered = batch.filter((m) => matches(m, ps.filter));
    ps.items.push(...filtered);
    ps.cursor = batch.length > 0 ? batch[batch.length - 1].ts : null;
    // 若本页全被过滤掉, 继续拉下一批
    if (batch.length === PAGE_SIZE && filtered.length === 0) {
      await loadMore();
      return;
    }
    ps.hasMore = batch.length === PAGE_SIZE;
  } catch (e) {
    if (status) status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    ps.loading = false;
  }
  if (list) list.dataset.loading = '';
}

function render(): void {
  const list = document.getElementById('dbg-list');
  const count = document.getElementById('dbg-count');
  const moreBtn = document.getElementById('dbg-more') as HTMLButtonElement | null;
  const status = document.getElementById('dbg-status');
  if (!list) return;

  const frag = document.createDocumentFragment();
  for (const item of ps.items) {
    frag.appendChild(renderItem(item));
  }
  list.innerHTML = '';
  list.appendChild(frag);

  if (count) count.textContent = `${ps.items.length} 条`;
  if (moreBtn) moreBtn.style.display = ps.hasMore ? '' : 'none';
  if (status) status.textContent = ps.loading ? '加载中…' : '';
}

function renderItem(item: RawMsgDto): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dbg-item';

  const head = document.createElement('div');
  head.className = 'dbg-meta';
  head.innerHTML = `
    <span class="dbg-tag ${item.is_out ? 'out' : 'in'}">${item.is_out ? '发出' : '收到'}</span>
    <span class="dbg-chat">${escapeHtml(item.chat_name || `#${item.chat_id}`)}</span>
    <span class="dbg-from">${escapeHtml(item.from_name || '?')}</span>
    <span class="dbg-type">${escapeHtml(item.view_type)}</span>
    <span class="dbg-ts">${formatTime(item.ts)}</span>
    <span class="dbg-id">#${item.msg_id}</span>
  `;
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'dbg-body';
  if (isEnvelope(item.text)) {
    const json = item.text.slice('[PEYT]'.length);
    const pretty = tryPrettyJson(json);
    if (pretty) {
      const pre = document.createElement('pre');
      pre.className = 'dbg-json';
      pre.textContent = pretty;
      body.appendChild(pre);
    } else {
      const code = document.createElement('code');
      code.className = 'dbg-code';
      code.textContent = item.text;
      body.appendChild(code);
    }
  } else {
    const code = document.createElement('code');
    code.className = 'dbg-code';
    code.textContent = item.text || '(空消息)';
    body.appendChild(code);
  }
  el.appendChild(body);

  return el;
}

function tryPrettyJson(raw: string): string | null {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return null;
  }
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );
}
