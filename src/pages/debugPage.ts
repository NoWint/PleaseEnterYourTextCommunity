import { call, eventLog, type DcEvent } from '../api.js';
import { state } from '../state.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';

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

// 会话类型 → 图标 + 中文标签
const CHAT_TYPE_META: Record<string, { icon: IconName; label: string }> = {
  Single: { icon: 'user', label: '单聊' },
  Group: { icon: 'users', label: '群组' },
  SavedMessages: { icon: 'bookmark', label: '保存的消息' },
  DeviceChat: { icon: 'send', label: '设备' },
  MailList: { icon: 'users', label: '邮件列表' },
  Broadcast: { icon: 'send', label: '广播' },
  ContactRequest: { icon: 'user', label: '新联系人' },
};
const CHAT_TYPE_DEFAULT = { icon: 'message-circle', label: '会话' } as const;

function chatTypeMeta(type: string, isRequest: boolean): { icon: IconName; label: string } {
  if (isRequest) return CHAT_TYPE_META.ContactRequest;
  return CHAT_TYPE_META[type] || CHAT_TYPE_DEFAULT;
}

export async function renderDebugNav(panel: HTMLElement): Promise<void> {
  panel.innerHTML = `
    <div class="nav-header"><div class="nav-title">调试</div></div>
    <div class="nav-list dbg-nav-list">
      <div class="dbg-sec" id="dbg-route"></div>
      <div class="dbg-sec" id="dbg-self"></div>
      <div class="dbg-sec" id="dbg-ws"></div>
      <div class="dbg-sec" id="dbg-msgs"></div>
      <div class="dbg-sec" id="dbg-chatlist"></div>
    </div>
  `;
  renderRouteCard();
  renderSelfCard();
  renderWorkspacesCard();
  renderMsgStatsCard();
  await renderChatlist();
}

// 路由状态卡片:当前页 / 工作区 / 频道,排查状态串了
function renderRouteCard(): void {
  const box = document.getElementById('dbg-route');
  if (!box) return;
  const kv = (k: string, v: string) => `<div class="dbg-row dbg-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`;
  box.innerHTML = `
    <div class="dbg-sec-title">当前路由</div>
    <div class="dbg-group">${kv('页面', state.currentPage)}${kv('工作区', String(state.currentWsId ?? '—'))}${kv('会话', String(state.currentChatId ?? '—'))}</div>
  `;
}

// 自我信息卡片: 显示名 / 邮箱,快速核对当前账号
function renderSelfCard(): void {
  const box = document.getElementById('dbg-self');
  if (!box) return;
  const self = state.self;
  const kv = (k: string, v: string) => `<div class="dbg-row dbg-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`;
  box.innerHTML = `
    <div class="dbg-sec-title">账号</div>
    <div class="dbg-group">${kv('名称', self?.name || '—')}${kv('邮箱', self?.addr || '—')}</div>
  `;
}

// 工作区 + 频道卡片: ws#id(name) 与频道清单,排查频道被过滤误伤
function renderWorkspacesCard(): void {
  const box = document.getElementById('dbg-ws');
  if (!box) return;
  const wsRows = state.workspaces.map((w) => `
    <div class="dbg-row">
      <span class="dbg-ico">${iconSvg('layout-grid', { width: 15, height: 15 })}</span>
      <span class="dbg-row-main">${escapeHtml(w.name)}</span>
      <span class="dbg-mono">#${w.id}</span>
    </div>`).join('') || '<div class="dbg-row dbg-faint">(无工作区)</div>';
  const chans = state.channels.map((c) => `
    <div class="dbg-row">
      <span class="dbg-ico">${iconSvg('hash', { width: 15, height: 15 })}</span>
      <span class="dbg-row-main">${escapeHtml(c.name)}</span>
      <span class="dbg-cat-tag">${escapeHtml(c.category)}</span>
      <span class="dbg-mono">#${c.chat_id}</span>
    </div>`).join('') || '<div class="dbg-row dbg-faint">(无频道)</div>';
  box.innerHTML = `
    <div class="dbg-sec-title">工作区</div>
    <div class="dbg-group">${wsRows}</div>
    <div class="dbg-sec-title">频道</div>
    <div class="dbg-group">${chans}</div>
  `;
}

// 消息统计卡片: 当前会话已加载消息 / 分页游标
function renderMsgStatsCard(): void {
  const box = document.getElementById('dbg-msgs');
  if (!box) return;
  const loaded = state.messages.length;
  const kv = (k: string, v: string) => `<div class="dbg-row dbg-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`;
  box.innerHTML = `
    <div class="dbg-sec-title">消息</div>
    <div class="dbg-group">${kv('已加载', String(loaded))}${kv('最旧 id', String(state.messagesOldestId ?? '—'))}${kv('noMore', state.noMoreMsgs ? '是' : '否')}</div>
  `;
}

// 会话诊断: 按类型分组的圆角卡片,每种会话一个可读标签
async function renderChatlist(): Promise<void> {
  const box = document.getElementById('dbg-chatlist');
  if (!box) return;
  try {
    const chats = await call<Array<{ chat_id: number; name: string; type: string; is_contact_request: boolean }>>('debug_chatlist');
    const groups = new Map<string, Array<{ chat_id: number; name: string; type: string; is_contact_request: boolean }>>();
    for (const c of chats) {
      const key = chatTypeMeta(c.type, c.is_contact_request).label;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    const secs = [...groups.entries()].map(([label, list]) => `
      <div class="dbg-sec-title">${escapeHtml(label)} <span class="dbg-count">${list.length}</span></div>
      <div class="dbg-group">${list.map((c) => `
        <div class="dbg-row">
          <span class="dbg-ico">${iconSvg(chatTypeMeta(c.type, c.is_contact_request).icon, { width: 15, height: 15 })}</span>
          <span class="dbg-row-main">${escapeHtml(c.name || '(unnamed)')}</span>
          <span class="dbg-mono">#${c.chat_id}</span>
        </div>`).join('')}</div>`).join('');
    box.innerHTML = secs || '<div class="dbg-sec-title">会话</div><div class="dbg-group"><div class="dbg-row dbg-faint">(空)</div></div>';
  } catch (e) {
    box.innerHTML = `<div class="dbg-sec-title">会话</div><div class="dbg-group"><div class="dbg-row dbg-faint">诊断失败: ${escapeHtml(String(e))}</div></div>`;
  }
}

const FILTER_LABEL: Record<Filter, string> = { all: '全部', envelope: '信封', out: '发出' };

export async function renderDebugMain(main: HTMLElement): Promise<void> {
  main.innerHTML = `
    <div class="dbg-toolbar">
      <div class="dbg-title">
        <div class="dbg-title-main">消息原文</div>
        <div class="dbg-title-sub" id="dbg-count">0 条</div>
      </div>
      <div class="dbg-seg" id="dbg-seg">
        ${(Object.keys(FILTER_LABEL) as Filter[]).map((f) =>
          `<button data-f="${f}" class="${ps.filter === f ? 'active' : ''}">${FILTER_LABEL[f]}</button>`
        ).join('')}
      </div>
      <button class="dbg-refresh" id="dbg-refresh" title="刷新">${iconSvg('refresh-cw', { width: 15, height: 15 })}</button>
    </div>
    <div class="dbg-events" id="dbg-events">
      <div class="dbg-ev-head">
        <span class="dbg-ev-title">事件流</span>
        <span class="dbg-ev-count" id="dbg-ev-count">0</span>
      </div>
      <div class="dbg-ev-body" id="dbg-ev-body"></div>
    </div>
    <div class="dbg-list" id="dbg-list"></div>
    <div class="dbg-footer">
      <button class="dbg-more" id="dbg-more">加载更多</button>
      <span class="dbg-status" id="dbg-status"></span>
    </div>
  `;

  main.querySelectorAll<HTMLButtonElement>('#dbg-seg button').forEach((b) => {
    b.addEventListener('click', () => {
      ps.filter = b.dataset.f as Filter;
      main.querySelectorAll('#dbg-seg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
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
  renderEventLog();
  // 事件流面板实时刷新,便于观察事件是否到达前端
  window.setInterval(() => {
    renderEventLog();
  }, 1000);
}

// 事件名 hash → 色相,给每类事件一个稳定颜色点,快速辨别事件类型
function eventColor(typ: string): string {
  let h = 0;
  for (let i = 0; i < typ.length; i++) h = (h * 31 + typ.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 62%)`;
}

// 事件流面板: 显示最近收到的 dc-event,排查事件驱动刷新失效
function renderEventLog(): void {
  const countEl = document.getElementById('dbg-ev-count');
  if (countEl) countEl.textContent = String(eventLog.length);
  const box = document.getElementById('dbg-ev-body');
  if (!box) return;
  const rows = eventLog.slice(-40).map((e) => {
    const brief = e.msg_id != null ? `msg=${e.msg_id}` : e.chat_id != null ? `chat=${e.chat_id}` : '';
    return `
      <div class="dbg-ev-row">
        <span class="dbg-ev-dot" style="background:${eventColor(e.typ)}"></span>
        <span class="dbg-ev-name">${escapeHtml(e.typ)}</span>
        ${brief ? `<span class="dbg-ev-brief">${escapeHtml(brief)}</span>` : ''}
      </div>`;
  }).join('') || '<div class="dbg-ev-row dbg-faint">(无事件)</div>';
  box.innerHTML = rows;
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
    <span class="dbg-dir ${item.is_out ? 'out' : 'in'}">${item.is_out ? '发出' : '收到'}</span>
    <span class="dbg-chat">${escapeHtml(item.chat_name || `#${item.chat_id}`)}</span>
    <span class="dbg-from">${escapeHtml(item.from_name || '?')}</span>
    <span class="dbg-spacer"></span>
    <span class="dbg-vtype">${escapeHtml(item.view_type)}</span>
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
