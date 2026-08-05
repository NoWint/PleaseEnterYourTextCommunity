// 主题总结详情看板(detail 车道,spec §9.5 分析类型注册表)。
// 7 个分析区块平铺,各自独立入队/流式/状态/刷新;样式全部行内 cssText + var(--xxx) token,
// 不新增全局 CSS。summary 区块后端返回文本(走 tagParser 渲染行内引用),
// 其余区块返回 JSON 字符串(渲染前 JSON.parse,失败显示原文)。
import { call } from '../api.js';
import { ui } from './ui.js';
import { iconSvg, type IconName } from './icon.js';
import { escapeHtml } from './escape.js';
import { parseSafeTags } from '../utils/tagParser.js';
import { listenSummaryEvents, type SummaryEvent } from '../utils/summaryState.js';

export type AnalysisKind =
  | 'summary' | 'participation' | 'action_items' | 'resources'
  | 'open_questions' | 'timeline' | 'decisions';

interface AnalysisType {
  kind: AnalysisKind;
  title: string;
  icon: IconName;
}

// 分析类型注册表(§9.5):看板区块按注册顺序自上而下平铺,新增类型 = 加一行。
const ANALYSIS_TYPES: AnalysisType[] = [
  { kind: 'summary', title: '主题总结', icon: 'file-text' },
  { kind: 'participation', title: '参与分析', icon: 'users' },
  { kind: 'action_items', title: '待办事项', icon: 'check' },
  { kind: 'resources', title: '资源与文件', icon: 'paperclip' },
  { kind: 'open_questions', title: '悬而未决', icon: 'message-circle' },
  { kind: 'timeline', title: '话题时间线', icon: 'timeline' },
  { kind: 'decisions', title: '决策记录', icon: 'bookmark' },
];

export interface SummaryContext {
  lines: string[];
  prevAnalysis?: string;
}

export interface DashboardOpts {
  onRefreshAll?: () => void;
  /** 由调用方(chatView)提供上下文窗口行 + 上次分析;组件不直接碰全局 state */
  getContext?: () => SummaryContext;
}

type SectionStatus = 'idle' | 'streaming' | 'done' | 'error';

interface Section {
  kind: AnalysisKind;
  status: SectionStatus;
  content: string;
  statsHtml: string; // participation: 前端即时统计(0 token)
  el: HTMLElement;
  statusEl: HTMLElement;
  streamEl: HTMLElement;
  resultEl: HTMLElement;
}

const SECTION_HEAD_STYLE = 'display:flex;align-items:center;gap:8px;padding:8px 10px;';
const SECTION_BODY_STYLE = 'padding:0 10px 10px;font-size:13px;line-height:1.7;color:var(--text);';
const SUB_ITEM_STYLE = 'margin:4px 0;padding:6px 8px;border-radius:8px;background:var(--surface-layer-02);';
const GROUP_TITLE_STYLE = 'margin:6px 0 2px;font-size:12px;font-weight:600;color:var(--text-weak);';
const EMPTY_STYLE = 'font-size:12px;color:var(--text-mute);';

export function renderSummaryDashboard(chatId: number, mountEl: HTMLElement, opts: DashboardOpts = {}): void {
  const getContext = opts.getContext ?? (() => ({ lines: [] }));
  const onRefreshAll = opts.onRefreshAll;
  mountEl.style.cssText = 'display:flex;flex-direction:column;min-height:0;max-height:66vh;';
  mountEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:2px 4px 10px;flex:none;">
      <span style="font-size:15px;font-weight:600;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">会话主题分析</span>
      <button data-sd-refresh-all="1" style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-strong);background:var(--surface-layer-02);color:var(--text-mute);font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer;transition:color 120ms var(--anim-ease),background 120ms var(--anim-ease);">${iconSvg('refresh-cw', { width: 12, height: 12 })}刷新全部</button>
    </div>
    <div data-sd-list="1" style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:2px;"></div>
  `;
  const listEl = mountEl.querySelector<HTMLElement>('[data-sd-list="1"]');
  if (!listEl) return;
  const sections = new Map<AnalysisKind, Section>();
  for (const t of ANALYSIS_TYPES) {
    const s = buildSection(t, chatId, getContext);
    sections.set(t.kind, s);
    listEl.appendChild(s.el);
  }
  mountEl.querySelector<HTMLElement>('[data-sd-refresh-all="1"]')?.addEventListener('click', () => {
    onRefreshAll?.();
    for (const s of sections.values()) void enqueueDetail(chatId, s, getContext);
  });
  // 监听 detail 车道事件,按 (chatId, lane='detail', kind) 更新对应区块
  void listenSummaryEvents((e: SummaryEvent) => {
    if (e.lane !== 'detail' || e.chatId !== chatId || !e.kind) return;
    const s = sections.get(e.kind as AnalysisKind);
    if (s) handleDetailEvent(s, e);
  });
  // 看板打开即全类型入队(本地队列串行;API 模式并发,后端同 chat 同 lane 限同类型去重)
  for (const s of sections.values()) void enqueueDetail(chatId, s, getContext);
}

function buildSection(t: AnalysisType, chatId: number, getContext: () => SummaryContext): Section {
  const el = document.createElement('div');
  el.style.cssText = 'border:1px solid var(--border);border-radius:10px;background:var(--surface-layer-01);flex:none;';
  el.innerHTML = `
    <div style="${SECTION_HEAD_STYLE}">
      <span style="display:inline-flex;color:var(--accent);flex-shrink:0;">${iconSvg(t.icon, { width: 14, height: 14 })}</span>
      <span style="font-size:13px;font-weight:600;color:var(--text);flex:1;min-width:0;">${escapeHtml(t.title)}</span>
      <span data-sd-status="1" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-mute);"></span>
      <button data-sd-refresh="1" title="重新分析" style="display:inline-flex;border:none;background:transparent;color:var(--text-mute);cursor:pointer;padding:2px;border-radius:6px;">${iconSvg('refresh-cw', { width: 13, height: 13 })}</button>
    </div>
    <div style="${SECTION_BODY_STYLE}">
      <div data-sd-stream="1" style="display:none;font-size:12px;color:var(--text-mute);white-space:pre-wrap;word-break:break-all;"></div>
      <div data-sd-result="1"></div>
    </div>
  `;
  const s: Section = {
    kind: t.kind,
    status: 'idle',
    content: '',
    statsHtml: '',
    el,
    statusEl: el.querySelector<HTMLElement>('[data-sd-status="1"]')!,
    streamEl: el.querySelector<HTMLElement>('[data-sd-stream="1"]')!,
    resultEl: el.querySelector<HTMLElement>('[data-sd-result="1"]')!,
  };
  setSectionStatus(s, 'idle', '待分析');
  el.querySelector<HTMLElement>('[data-sd-refresh="1"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void enqueueDetail(chatId, s, getContext);
  });
  return s;
}

function setSectionStatus(s: Section, status: SectionStatus, label: string): void {
  s.status = status;
  s.statusEl.innerHTML = '';
  if (status === 'streaming') s.statusEl.appendChild(ui.spinner());
  const text = document.createElement('span');
  text.textContent = label;
  s.statusEl.appendChild(text);
  s.streamEl.style.display = status === 'streaming' ? 'block' : 'none';
}

async function enqueueDetail(chatId: number, s: Section, getContext: () => SummaryContext): Promise<void> {
  if (s.kind === 'participation') {
    // stats_plus_llm:前端统计即时出(0 token,秒出),LLM 解读随后流式补
    s.statsHtml = renderParticipationStats(getContext().lines ?? []);
    s.resultEl.innerHTML = s.statsHtml;
  }
  s.content = '';
  setSectionStatus(s, 'streaming', '分析中…');
  const ctx = getContext();
  try {
    await call('enqueue_summary', {
      chatId,
      lane: 'detail',
      kind: s.kind,
      context: { lines: ctx.lines ?? [], prevAnalysis: ctx.prevAnalysis },
    });
  } catch (e) {
    s.status = 'error';
    s.statusEl.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = '失败';
    s.statusEl.appendChild(label);
    s.resultEl.innerHTML = `<div style="color:var(--danger);font-size:12px;">入队失败:${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

function handleDetailEvent(s: Section, e: SummaryEvent): void {
  if (e.status === 'streaming') {
    s.status = 'streaming';
    if (e.delta) s.content += e.delta;
    setSectionStatus(s, 'streaming', '分析中…');
    s.streamEl.textContent = s.content;
  } else if (e.status === 'done') {
    s.status = 'done';
    s.content = e.result !== undefined ? e.result : s.content;
    setSectionStatus(s, 'done', '完成');
    renderDone(s);
  } else if (e.status === 'error') {
    s.status = 'error';
    s.content = '';
    setSectionStatus(s, 'error', '失败');
    s.resultEl.innerHTML = `<div style="font-size:12px;color:var(--danger);">${escapeHtml(e.error?.message ?? e.error?.code ?? '分析失败')}</div>
      <div style="font-size:11px;color:var(--text-mute);margin-top:2px;">点击区块右上角刷新重试</div>`;
  } else if (e.status === 'cancelled') {
    s.status = 'error';
    setSectionStatus(s, 'error', '已过期');
    s.resultEl.innerHTML = `<div style="font-size:12px;color:var(--text-mute);">分析被新消息打断,点击刷新重试</div>`;
  }
}

function renderDone(s: Section): void {
  const html = renderKindContent(s);
  s.resultEl.innerHTML = html || `<div style="${EMPTY_STYLE}">无内容</div>`;
  bindResultInteractions(s);
}

function renderKindContent(s: Section): string {
  const prefix = s.statsHtml
    ? `${s.statsHtml}<div style="height:1px;background:var(--border);margin:8px 0;"></div>`
    : '';
  if (!s.content) return prefix;
  if (s.kind === 'summary') return prefix + parseSafeTags(s.content);
  let data: unknown;
  try {
    data = JSON.parse(s.content);
  } catch {
    return prefix + `<pre style="margin:0;font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--text-mute);font-family:inherit;">${escapeHtml(s.content)}</pre>`;
  }
  if (s.kind === 'action_items') {
    const checkboxes = renderActionItems(data);
    if (checkboxes) return prefix + checkboxes;
  }
  return prefix + renderJson(data);
}

// 待办区块:items 数组渲染为可勾选清单(勾选 = 完成态,仅本地视觉)
function renderActionItems(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  return items
    .map((it: unknown) => {
      const text = typeof it === 'string'
        ? it
        : it && typeof it === 'object' ? String((it as Record<string, unknown>).text ?? '') : '';
      return `<label style="display:flex;align-items:flex-start;gap:8px;margin:4px 0;padding:6px 8px;border-radius:8px;background:var(--surface-layer-02);cursor:pointer;transition:opacity 120ms var(--anim-ease);">
        <input type="checkbox" style="margin-top:3px;flex-shrink:0;">
        <span style="font-size:13px;min-width:0;">${parseSafeTags(text)}</span>
      </label>`;
    })
    .join('');
}

// 通用 JSON 渲染:数组 → 条目盒;对象 → 分组标题 + 键值行(标量字符串再走 tagParser)
function renderJson(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return `<div style="margin:2px 0;">${parseSafeTags(data)}</div>`;
  if (typeof data === 'number' || typeof data === 'boolean') {
    return `<span style="color:var(--text-mute);">${escapeHtml(String(data))}</span>`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return `<div style="${EMPTY_STYLE}">无数据</div>`;
    return data.map((it) => `<div style="${SUB_ITEM_STYLE}">${renderJson(it)}</div>`).join('');
  }
  const obj = data as Record<string, unknown>;
  const parts: string[] = [];
  // resources:url 字段渲染为可点击项(open_external 走系统浏览器),title 作显示名
  if (typeof obj.url === 'string' && /^https?:\/\//.test(obj.url)) {
    const title = typeof obj.title === 'string' && obj.title ? obj.title : obj.url;
    parts.push(`<div style="margin:2px 0;"><span data-sd-open="${escapeHtml(obj.url)}" style="color:var(--accent);cursor:pointer;text-decoration:underline;">${parseSafeTags(title)}</span></div>`);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '' || k === 'url' || k === 'title') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      parts.push(`<div style="${GROUP_TITLE_STYLE}">${escapeHtml(k)}</div>`);
      for (const it of v) parts.push(`<div style="${SUB_ITEM_STYLE}">${renderJson(it)}</div>`);
    } else if (typeof v === 'object') {
      parts.push(`<div style="${GROUP_TITLE_STYLE}">${escapeHtml(k)}</div>`);
      parts.push(`<div style="${SUB_ITEM_STYLE}">${renderJson(v)}</div>`);
    } else {
      parts.push(`<div style="margin:2px 0;"><span style="font-size:12px;color:var(--text-mute);">${escapeHtml(k)}: </span><span>${parseSafeTags(String(v))}</span></div>`);
    }
  }
  return parts.join('');
}

// 资源区块:links 渲染为可点击项(open_external 走系统浏览器),files 渲染为文件名行
function bindResultInteractions(s: Section): void {
  s.resultEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const label = cb.closest('label');
      if (!label) return;
      label.style.opacity = cb.checked ? '0.55' : '1';
      const span = label.querySelector('span');
      if (span) span.style.textDecoration = cb.checked ? 'line-through' : 'none';
    });
  });
  s.resultEl.querySelectorAll<HTMLElement>('[data-sd-open]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = el.dataset.sdOpen ?? '';
      if (url) void call('open_external', { url });
    });
  });
}

// participation 前端统计(0 token,秒出):消息数 / 发言人数 / 活跃时段
function renderParticipationStats(lines: string[]): string {
  const names = new Set<string>();
  const hours: number[] = [];
  const LINE_RE = /^\[id=\d+\] (.+?) \[(\d{4}-\d{2}-\d{2}) (\d{2}):\d{2}\]: /;
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    names.add(m[1]);
    hours.push(Number(m[3]));
  }
  const total = lines.length;
  const active = hours.length ? `${Math.min(...hours)}:00–${Math.max(...hours)}:00` : '—';
  const rows = [
    ['消息数', String(total)],
    ['发言人数', String(names.size)],
    ['活跃时段', active],
  ];
  return rows
    .map(
      ([k, v]) =>
        `<div style="display:flex;justify-content:space-between;gap:12px;margin:2px 0;font-size:12px;"><span style="color:var(--text-mute);">${k}</span><span style="color:var(--text);font-weight:600;">${escapeHtml(v)}</span></div>`,
    )
    .join('');
}
