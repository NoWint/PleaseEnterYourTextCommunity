// 主题分析看板:全屏横向分栏。
// 左侧玻璃导航(词云 + 分析类型目录),右侧单列内容区(顶部总结文本段 + 各 JSON 列表块)。
// 每类独立入队/流式/状态/刷新;JSON 输出按 schema 结构化渲染,解析失败降级 <pre>。
// 动效遵循 Apple 弹簧(全屏从触发点缩放展开,关闭沿对称路径反向退出)。
import { iconSvg, type IconName } from './icon.js';
import { escapeHtml } from './escape.js';
import { call } from '../api.js';
import { state } from '../state.js';
import { ui } from './ui.js';
import type { MsgDto } from '../types.js';
import { buildContextWindow, formatWindowLines } from '../utils/summaryContext.js';
import type { WindowMsg } from '../utils/summaryContext.js';
import { computeParticipation } from '../utils/participation.js';
import { getSummaryPrefs, loadSummaryPrefs } from '../utils/summaryPrefs.js';
import { resolveMessageText } from '../utils/envelope.js';
import { renderMarkdown } from '../utils/markdown.js';

export type AnalysisKind = 'summary' | 'participation' | 'action_items'
  | 'mood' | 'open_questions' | 'timeline' | 'decisions';

interface AnalysisType {
  kind: AnalysisKind;
  title: string;
  icon: IconName;        // 导航图标名
  engine: 'llm' | 'local_stats' | 'stats_plus_llm';
  priority: number;
}

const ANALYSIS_TYPES: AnalysisType[] = [
  { kind: 'summary', title: '总结', icon: 'file-text', engine: 'llm', priority: 0 },
  { kind: 'mood', title: '情绪氛围', icon: 'smile', engine: 'llm', priority: 0 },
  { kind: 'action_items', title: '行动项', icon: 'check', engine: 'llm', priority: 0 },
  { kind: 'participation', title: '参与度', icon: 'users', engine: 'stats_plus_llm', priority: 0 },
  { kind: 'open_questions', title: '悬而未决', icon: 'info', engine: 'llm', priority: 1 },
  { kind: 'timeline', title: '话题演变', icon: 'clock', engine: 'llm', priority: 1 },
  { kind: 'decisions', title: '决策', icon: 'pin', engine: 'llm', priority: 2 },
];

// 每 chat 每 kind 的状态:done 内容缓存 + 显示
const detailCache = new Map<string, { kind: AnalysisKind; status: string; text: string }>();

// 当前弹窗实例(单例,关闭时清理)
let fullscreenEl: HTMLElement | null = null;
// 当前弹窗的上下文窗口(participation 统计缓存命中重算用)
let fsWin: WindowMsg[] = [];

// ── JSON 结构化渲染 ──────────────────────────────────────
/** 解析 JSON,失败返回 null(调用方降级为 <pre> 转义显示)。 */
function safeParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** 跳转引用 chip(当前占位,后续接入消息定位)。 */
function refChip(id: number | string | undefined): string {
  if (id == null) return '';
  return `<a class="sd-ref" data-ref="${escapeHtml(String(id))}">↗</a>`;
}

/** action_items: {items:[{text,assignee?,due?,ref?}]} → checkbox 列表。 */
function renderActionItems(text: string): string {
  const d = safeParseJson(text) as { items?: Array<{ text?: string; assignee?: string; due?: string; ref?: number }> } | null;
  if (!d || !Array.isArray(d.items)) return fallbackJson(text);
  const rows = d.items
    .map((it) => {
      const meta = [
        it.assignee ? `<span class="sd-chip">${escapeHtml(it.assignee)}</span>` : '',
        it.due ? `<span class="sd-chip sd-chip-due">${escapeHtml(it.due)}</span>` : '',
      ].filter(Boolean).join('');
      // 真 checkbox(隐藏)驱动勾选态;点击行即切换
      return `<label class="sd-item"><input type="checkbox" class="sd-check-input"><span class="sd-checkbox"></span><span class="sd-item-text">${escapeHtml(it.text ?? '')}${refChip(it.ref)}</span>${meta ? `<span class="sd-item-meta">${meta}</span>` : ''}</label>`;
    })
    .join('');
  return `<div class="sd-list">${rows || '<div class="sd-empty">无行动项</div>'}</div>`;
}

/** open_questions: {questions:[{text,asked_by,ref}]} → 问题列表。 */
function renderOpenQuestions(text: string): string {
  const d = safeParseJson(text) as { questions?: Array<{ text?: string; asked_by?: string; ref?: number }> } | null;
  if (!d || !Array.isArray(d.questions)) return fallbackJson(text);
  const rows = d.questions.map((q) =>
    `<div class="sd-item"><span class="sd-q-icon">?</span><span class="sd-item-text">${escapeHtml(q.text ?? '')}${refChip(q.ref)}</span>${q.asked_by ? `<span class="sd-item-meta"><span class="sd-chip">${escapeHtml(q.asked_by)}</span></span>` : ''}</div>`).join('');
  return `<div class="sd-list">${rows || '<div class="sd-empty">无悬而未决</div>'}</div>`;
}

/** timeline: {phases:[{period,topic,key_messages:[ref]}]} → 垂直时间线。 */
function renderTimeline(text: string): string {
  const d = safeParseJson(text) as { phases?: Array<{ period?: string; topic?: string; key_messages?: number[] }> } | null;
  if (!d || !Array.isArray(d.phases)) return fallbackJson(text);
  const nodes = d.phases.map((ph) =>
    `<div class="sd-tl-node"><div class="sd-tl-dot"></div><div class="sd-tl-body"><div class="sd-tl-period">${escapeHtml(ph.period ?? '')}</div><div class="sd-tl-topic">${escapeHtml(ph.topic ?? '')}${(ph.key_messages ?? []).map((m) => refChip(m)).join('')}</div></div></div>`).join('');
  return `<div class="sd-timeline">${nodes || '<div class="sd-empty">无话题演变</div>'}</div>`;
}

/** decisions: {decisions:[{title,by,rationale,ref}]} → 决策卡片。 */
function renderDecisions(text: string): string {
  const d = safeParseJson(text) as { decisions?: Array<{ title?: string; by?: string; rationale?: string; ref?: number }> } | null;
  if (!d || !Array.isArray(d.decisions)) return fallbackJson(text);
  const cards = d.decisions.map((dc) =>
    `<div class="sd-dec"><div class="sd-dec-head">${iconSvg('pin', { width: 14, height: 14 })}<span class="sd-dec-title">${escapeHtml(dc.title ?? '')}</span>${dc.by ? `<span class="sd-chip">${escapeHtml(dc.by)}</span>` : ''}${refChip(dc.ref)}</div>${dc.rationale ? `<div class="sd-dec-rationale">${escapeHtml(dc.rationale)}</div>` : ''}</div>`).join('');
  return `<div class="sd-list">${cards || '<div class="sd-empty">无决策</div>'}</div>`;
}

/** 参与度统计(纯前端) → 成员条。 */
function renderParticipationStat(win: WindowMsg[]): string {
  const p = computeParticipation(win);
  return p.per_member
    .map((m) => `<div class="sd-p-row"><span class="sd-p-name">${escapeHtml(m.name)}</span><span class="sd-p-nums">${m.msg_count} 条 · ${m.char_count} 字 · ${m.active_days} 天</span></div>`)
    .join('');
}

/** summary:markdown 渲染(内嵌 <user>/<message> 标签解析成可点 chip)。 */
function renderSummary(text: string): string {
  return `<div class="sd-summary sd-markdown">${renderMarkdown(text)}</div>`;
}

/** mood: {overall, score, emoji, summary, highlights:[{text,emoji}]} → 情绪卡片。 */
function renderMood(text: string): string {
  const d = safeParseJson(text) as {
    overall?: string; score?: number; emoji?: string; summary?: string;
    highlights?: Array<{ text?: string; emoji?: string }>;
  } | null;
  if (!d || typeof d !== 'object') return fallbackJson(text);
  const score = typeof d.score === 'number' ? Math.max(0, Math.min(100, d.score)) : 50;
  const tone = score >= 66 ? 'positive' : score >= 34 ? 'neutral' : 'negative';
  const emoji = d.emoji || '😐';
  const overall = d.overall || (tone === 'positive' ? '积极' : tone === 'negative' ? '消极' : '中立');
  const highlights = Array.isArray(d.highlights)
    ? d.highlights.map((h) =>
        `<div class="sd-mood-hl"><span class="sd-mood-hl-emoji">${escapeHtml(h.emoji || '•')}</span><span class="sd-mood-hl-text">${escapeHtml(h.text ?? '')}</span></div>`).join('')
    : '';
  return `<div class="sd-mood">
    <div class="sd-mood-top">
      <div class="sd-mood-emoji sd-mood-${tone}">${escapeHtml(emoji)}</div>
      <div class="sd-mood-meta">
        <span class="sd-mood-overall">${escapeHtml(overall)}</span>
        <div class="sd-mood-bar"><div class="sd-mood-bar-fill sd-mood-${tone}" style="width:${score}%"></div></div>
      </div>
    </div>
    ${d.summary ? `<div class="sd-mood-summary sd-markdown">${renderMarkdown(d.summary)}</div>` : ''}
    ${highlights ? `<div class="sd-mood-hls">${highlights}</div>` : ''}
  </div>`;
}

/** JSON 解析失败降级:整段转义 <pre> 显示,不崩 UI。 */
function fallbackJson(text: string): string {
  return `<pre class="sd-json">${escapeHtml(text)}</pre>`;
}

/**
 * 流式中实时渲染:JSON kinds 尝试增量解析,能 parse 就渲染卡片(未完成字段自然缺失,
 * 由各 renderer 的可选字段兜底);parse 失败显示「生成中…」不显示原始 JSON。
 * 非 JSON(summary/participation 文本)直接显示累积文本(实时打字机)。
 */
function renderStreaming(kind: AnalysisKind, text: string): string {
  if (!text) return '<span class="sd-streaming">生成中…</span>';
  if (isJsonKind(kind)) {
    const d = safeParseJson(text);
    if (d == null) return '<span class="sd-streaming">生成中…</span>';
    return renderDetailBody(kind, text);
  }
  // summary / participation 解读:markdown 实时渲染(换行/标签实时生效)
  return renderMarkdown(text);
}

function isJsonKind(kind: AnalysisKind): boolean {
  return kind === 'action_items' || kind === 'mood' || kind === 'open_questions'
    || kind === 'timeline' || kind === 'decisions';
}

/** 按 kind 渲染详情。 */
function renderDetailBody(kind: AnalysisKind, text: string): string {
  switch (kind) {
    case 'summary': return renderSummary(text);
    case 'mood': return renderMood(text);
    case 'action_items': return renderActionItems(text);
    case 'open_questions': return renderOpenQuestions(text);
    case 'timeline': return renderTimeline(text);
    case 'decisions': return renderDecisions(text);
    default: return fallbackJson(text);
  }
}

// ── 全屏打开/关闭 ────────────────────────────────────────
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** 全屏层从 anchor 位置 spring 展开(transform-origin 锚定触发点,§7)。 */
function animateOpen(sheet: HTMLElement, anchor: HTMLElement): void {
  if (REDUCED_MOTION) return;
  const r = anchor.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  sheet.style.transformOrigin = `${cx}px ${cy}px`;
  sheet.animate(
    [{ transform: 'scale(0.92)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
    { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

/** 关闭:反向路径动画后移除(§7 对称路径)。 */
function animateClose(sheet: HTMLElement, anchor: HTMLElement, done: () => void): void {
  if (REDUCED_MOTION) { done(); return; }
  const r = anchor.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  sheet.style.transformOrigin = `${cx}px ${cy}px`;
  const anim = sheet.animate(
    [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.92)', opacity: 0 }],
    { duration: 240, easing: 'cubic-bezier(0.55, 0, 0.55, 0.2)' },
  );
  anim.onfinish = done;
}

// ── 导航/内容交互 ────────────────────────────────────────
function bindNavScroll(content: HTMLElement): void {
  const navItems = content.querySelectorAll<HTMLElement>('[data-nav-kind]');
  // 滚动监听:当前可见块高亮导航项(§8 方向提示)
  const onScroll = () => {
    let current: string | null = null;
    for (const item of navItems) {
      const kind = item.dataset.navKind!;
      const block = content.querySelector<HTMLElement>(`[data-body="${kind}"]`)?.closest('.sd-block');
      if (!block) continue;
      const rect = block.getBoundingClientRect();
      if (rect.top <= content.offsetHeight / 2) current = kind;
    }
    for (const item of navItems) {
      item.classList.toggle('active', item.dataset.navKind === current);
    }
  };
  content.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/** 折叠/展开块(块头点击)。 */
function bindCollapse(content: HTMLElement): void {
  content.querySelectorAll<HTMLElement>('.sd-block-head').forEach((head) => {
    head.addEventListener('click', () => {
      const block = head.closest('.sd-block');
      if (!block) return;
      block.classList.toggle('collapsed');
    });
  });
}

// ── 主入口 ───────────────────────────────────────────────
export async function openSummaryDashboard(anchor: HTMLElement, chatId: number, msgs: MsgDto[], resolve: (t: string) => string): Promise<void> {
  await loadSummaryPrefs(); // 拉最新偏好(后端 SQL)
  const prefs = getSummaryPrefs();
  if (prefs.mode !== 'llm') { await openWordAnalysisPopupFallback(anchor, msgs, resolve); return; }
  const win = buildContextWindow(msgs, resolve, prefs.contextN);
  fsWin = win; // 缓存命中时 participation 统计重算用
  const prompt = formatWindowLines(win); // 含绝对时间;participation 用结构化 window 本地统计

  // 左侧导航(词云 + 类型目录)
  const navList = ANALYSIS_TYPES.map((t) =>
    `<button class="sd-nav-item" data-nav-kind="${t.kind}">${iconSvg(t.icon, { width: 16, height: 16 })}<span>${escapeHtml(t.title)}</span></button>`).join('');
  const nav = `
    <div class="sd-nav">
      <div class="sd-nav-title">会话主题分析</div>
      <canvas class="sd-canvas" width="240" height="150"></canvas>
      <div class="sd-nav-list">${navList}</div>
    </div>`;

  // 右侧内容:顶部总结块 + 各列表块单列
  const blocks = ANALYSIS_TYPES.map((t) => `
    <section class="sd-block" data-kind="${t.kind}">
      <div class="sd-block-head">
        <span class="sd-block-title">${iconSvg(t.icon, { width: 16, height: 16 })}${escapeHtml(t.title)}</span>
        <span class="sd-block-actions">
          <button class="sd-refresh" data-refresh="${t.kind}" title="刷新">${iconSvg('refresh-cw', { width: 14, height: 14 })}</button>
          <button class="sd-collapse" title="折叠">${iconSvg('chevron-down', { width: 14, height: 14 })}</button>
        </span>
      </div>
      <div class="sd-body" data-body="${t.kind}">加载中…</div>
    </section>`).join('');

  const content = `
    <div class="sd-content" data-sd-content="1">
      ${blocks}
    </div>`;

  // 大号居中弹窗挂载(.ui-overlay 已 flex 居中;.sd-sheet 是大号面板,内部横向分栏)
  const overlay = document.createElement('div');
  overlay.className = 'ui-overlay sd-overlay';
  overlay.dataset.sdChat = String(chatId);
  overlay.innerHTML = `
    <div class="sd-sheet">
      <button class="sd-close" data-sd-close="1" title="关闭">${iconSvg('x', { width: 18, height: 18 })}</button>
      ${nav}
      ${content}
    </div>`;
  document.body.appendChild(overlay);
  fullscreenEl = overlay;
  animateOpen(overlay.querySelector<HTMLElement>('.sd-sheet')!, anchor);

  const close = () => {
    const sheet = overlay.querySelector<HTMLElement>('.sd-sheet');
    animateClose(sheet!, anchor, () => {
      overlay.remove();
      if (fullscreenEl === overlay) fullscreenEl = null;
    });
  };
  overlay.querySelector('[data-sd-close]')?.addEventListener('click', close);
  // 点击遮罩空白处关闭(点内容区不关)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // Escape 关闭
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  window.addEventListener('keydown', onKey, { once: true });

  // 标签点击委托:<message> → 关看板跳原文;<user> → 打开成员名片。
  // 覆盖 .sd-ref / .mention-chip[data-msg-ref] / .mention-chip[data-user-ref]
  overlay.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const refEl = t.closest<HTMLElement>('.mention-chip[data-msg-ref], .mention-chip[data-user-ref], .sd-ref[data-ref]');
    if (!refEl) return;
    e.stopPropagation();
    // user 分支:模糊匹配成员 → 单名片/多人列表(AI 名字常不带空格/错字,精确找不到走 fuzzyMatchMembers)
    if (refEl.dataset.userRef != null) {
      const name = refEl.dataset.userRef;
      // 「我」→ 当前用户 self(精确)
      if (name === '我' && state.self) {
        void import('./contactCard.js').then(({ openContactCard }) =>
          openContactCard({ contactId: state.self!.id, name: state.self!.name, addr: state.self!.addr, avatar: state.self!.avatar ?? null, anchor: refEl }));
        return;
      }
      // 「你」→ 单聊对方(非 self 成员);群聊回退按名字模糊匹配
      if (name === '你' && !state.currentChatIsGroup) {
        const other = state.currentMembers.find((m) => !m.is_self);
        if (other) {
          void import('./memberPicker.js').then(({ openUserPicker }) =>
            openUserPicker(other.name, refEl));
          return;
        }
      }
      void import('./memberPicker.js').then(({ openUserPicker }) => openUserPicker(name, refEl));
      return;
    }
    // message 分支:跳原文。即使 id 不在当前窗口也尝试(chatView 兜底刷新加载)。
    // 先移除 overlay(立即,不播关闭动画——避免滚动被遮罩挡住),再跳。
    const ref = refEl.dataset.ref ?? refEl.dataset.msgRef;
    if (ref == null) return;
    const id = Number(ref);
    if (!Number.isNaN(id)) {
      overlay.remove();
      if (fullscreenEl === overlay) fullscreenEl = null;
      void import('../chat/chatView.js').then(({ jumpToMessage }) => jumpToMessage(id));
    }
  });

  // 数据已在打开聊天时预请求(prefetchSummary,与气泡一起);popup 打开只渲染:
  // 缓存命中直接显示,未命中显示「分析中…」(等预请求 streaming/done 实时填充)。
  for (const t of ANALYSIS_TYPES) {
    const body = overlay.querySelector<HTMLElement>(`[data-body="${t.kind}"]`);
    if (!body) continue;
    const cached = detailCache.get(`${chatId}:${t.kind}`);
    if (cached && cached.status === 'done' && cached.text) {
      // participation:统计前端即时算 + 缓存解读
      body.innerHTML = t.kind === 'participation'
        ? `<div class="sd-p-stat">${renderParticipationStat(win)}</div><div class="sd-p-insight"><div class="sd-insight-text">${renderMarkdown(cached.text)}</div></div>`
        : renderDetailBody(t.kind, cached.text);
    } else if (t.kind === 'participation') {
      // participation 统计即时渲染(0 token),解读等预请求
      body.innerHTML = `<div class="sd-p-stat">${renderParticipationStat(win)}</div><div class="sd-p-insight">分析中…</div>`;
    }
    // 其余未命中:保持初始「分析中…」(bindFullscreenEvents 流式实时填充)
  }

  // 导航点击 → 滚动定位到块
  overlay.querySelectorAll<HTMLElement>('[data-nav-kind]').forEach((item) => {
    item.addEventListener('click', () => {
      const kind = item.dataset.navKind!;
      const block = overlay.querySelector<HTMLElement>(`[data-body="${kind}"]`)?.closest('.sd-block');
      const contentEl = overlay.querySelector<HTMLElement>('[data-sd-content]');
      if (block && contentEl) block.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
      const realItem = item as HTMLElement;
      overlay.querySelectorAll('[data-nav-kind]').forEach((n) => n.classList.toggle('active', n === realItem));
    });
  });
  // 块刷新 + 折叠
  overlay.querySelectorAll<HTMLElement>('[data-refresh]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      enqueueOverlay(overlay, chatId, kindOf(btn.dataset.refresh as AnalysisKind), prompt);
    });
  });
  bindCollapse(overlay.querySelector<HTMLElement>('[data-sd-content]')!);
  bindNavScroll(overlay.querySelector<HTMLElement>('[data-sd-content]')!);

  // 画词云:真实 jieba 分词 → 复用 wordCloud 的 drawWordCloud(DPR 缩放)
  requestAnimationFrame(() => {
    const canvas = overlay.querySelector<HTMLCanvasElement>('.sd-canvas');
    if (canvas) void drawCloudAsync(canvas, msgs, resolve);
  });

  bindFullscreenEvents();
  // 兜底:若该 chat 缓存为空(60s 防抖刚清缓存/从冷启动直接开 popup)且无请求在途,
  // 补批预请求(anyCached 守卫保证不重复整批;beginDetailRequest 按 kind 幂等)。
  void prefetchSummary(chatId, msgs, resolve).catch(() => {});
}

function kindOf(k: AnalysisKind): AnalysisKind { return k; }

/** 当前弹窗实例入队(带缓存:已有 done 结果 → 直接渲染,不重新请求)。 */
function enqueueOverlay(overlay: HTMLElement, chatId: number, kind: AnalysisKind, prompt: string, reset = true): void {
  const body = overlay.querySelector<HTMLElement>(`[data-body="${kind}"]`);
  // 缓存命中:直接渲染已 done 内容,不请求(无新消息时重复打开不重新请求)
  const cached = detailCache.get(`${chatId}:${kind}`);
  if (cached && cached.status === 'done' && cached.text) {
    if (body) {
      // participation 缓存的是 LLM 解读文本;统计为前端即时算(重新算,因为窗口可能变化)
      body.innerHTML = kind === 'participation'
        ? `<div class="sd-p-stat">${renderParticipationStat(fsWin)}</div><div class="sd-p-insight"><div class="sd-insight-text">${renderMarkdown(cached.text)}</div></div>`
        : renderDetailBody(kind, cached.text);
    }
    return;
  }
  if (body && reset) body.textContent = '分析中…';
  detailCache.delete(`${chatId}:${kind}`);
  beginDetailRequest(chatId, kind); // 入队即标记请求开始(kind 级去重)
  void call('summary_enqueue', { chatId, lane: 'detail', kind, prompt }).catch(() => {
    endDetailRequest(chatId, kind); // 入队失败 → 请求未发出,结束标记
    if (body) body.textContent = '分析失败';
  });
}

// 每个 chat 正在进行的 detail 请求 kind 集合(kind 级去重配对)。
// 入队时 begin(+1),收到 done/error 时 end(-1)。streaming 不参与计数——
// 否则请求在生成前失败(网络/超时/API 拒绝)只有 error 无 streaming,计数错乱。
const detailPending = new Map<number, Set<string>>();
// 绿勾消失定时器(上次 detail 完成后 5s 移除)
let checkTimer: ReturnType<typeof setTimeout> | null = null;

const LOADING_SVG = `<svg class="ch-bubble-loading" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
const CHECK_SVG = `<svg class="ch-bubble-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

// 60s 防抖窗口读秒:scheduleRefresh 启动时气泡右侧显示「Xs总结」,窗口期内不闲置。
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownChatId: number | null = null;
let countdownRemaining = 0;

function clearCountdown(): void {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  countdownChatId = null;
  countdownRemaining = 0;
}

/**
 * 统一渲染气泡指示器(优先级:detail pending > 60s 读秒 > 绿勾 5s)。
 * pending → 呼吸灯+旋转 loading;读秒 → 「Xs总结」;完成 → 绿勾 5s 后清空。
 */
function applyBubbleState(chatId: number): void {
  const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
  if (!chip) return;
  // 仅当该 chat 是当前激活会话时控制气泡
  if (state.currentChatId !== chatId) return;
  const pending = detailPending.get(chatId);
  const active = !!pending && pending.size > 0;
  const indicator = chip.querySelector<HTMLElement>('.ch-bubble-indicator');
  if (!indicator) return;
  if (active) {
    // detail 请求在途 → 呼吸灯 + 旋转 loading(读秒让位)
    if (checkTimer) clearTimeout(checkTimer);
    chip.classList.add('breathing-detail');
    indicator.classList.remove('cd');
    indicator.innerHTML = LOADING_SVG;
  } else if (countdownChatId === chatId) {
    // 60s 防抖窗口内 → 读秒「Xs总结」(不闲置)
    if (checkTimer) clearTimeout(checkTimer);
    chip.classList.remove('breathing-detail');
    indicator.classList.add('cd');
    indicator.innerHTML = `<span class="ch-bubble-countdown">${countdownRemaining}s总结</span>`;
  } else {
    chip.classList.remove('breathing-detail');
    indicator.classList.remove('cd');
    indicator.innerHTML = CHECK_SVG;
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      const chipNow = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
      const ind = chipNow?.querySelector<HTMLElement>('.ch-bubble-indicator');
      if (ind) ind.innerHTML = '';
    }, 5000);
  }
}

/**
 * 气泡 re-render 后恢复指示器:renderBubbleHtml(summaryBubble)会重建空 indicator span,
 * 读秒/loading 状态由 chatView 在 re-render 后调用本函数恢复。
 */
export function restoreBubbleIndicator(): void {
  if (state.currentChatId == null) return;
  applyBubbleState(state.currentChatId);
}

/** 入队时调用:标记该 kind 请求开始(kind 已 pending 则忽略,防重复入队重复计数)。 */
export function beginDetailRequest(chatId: number, kind: string): void {
  if (!detailPending.has(chatId)) detailPending.set(chatId, new Set());
  const s = detailPending.get(chatId)!;
  if (s.has(kind)) return; // 已在请求中,不重复 +1
  s.add(kind);
  applyBubbleState(chatId);
}

/** done/error 时调用:标记该 kind 请求结束。 */
export function endDetailRequest(chatId: number, kind: string): void {
  const s = detailPending.get(chatId);
  if (!s) return;
  s.delete(kind);
  if (s.size === 0) detailPending.delete(chatId);
  applyBubbleState(chatId);
}

let fullscreenBound = false;
function bindFullscreenEvents(): void {
  if (fullscreenBound) return;
  fullscreenBound = true;
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen('summary-event', (ev) => {
      const p = ev.payload as { chatId: number; lane: string; kind: string; status: string; delta?: string; result?: string; error?: { code: string } };
      if (p.lane !== 'detail') return;
      // 全局处理(done/error 配对计数 + 缓存):prefetchSummary 在打开聊天时已 beginDetailRequest,
      // 即使看板未打开,detail 的 done/error 也必须 endDetailRequest,否则呼吸灯/loading 永不熄灭。
      handleDetailEvent(p);
      // 仅当该 chat 的 popup 打开时才渲染 DOM
      const popup = document.querySelector<HTMLElement>('.sd-overlay[data-sd-chat]');
      if (!popup || popup.dataset.sdChat !== String(p.chatId)) return;
      const body = popup.querySelector<HTMLElement>(`[data-body="${p.kind}"]`);
      if (!body) return;
      const cur = detailCache.get(`${p.chatId}:${p.kind}`) ?? { kind: p.kind as AnalysisKind, status: 'idle', text: '' };
      // participation:统计(.sd-p-stat)保留,只更新 LLM 解读(.sd-p-insight)
      const target = p.kind === 'participation' ? body.querySelector<HTMLElement>('.sd-p-insight') : body;
      if (!target) return;
      if (cur.status === 'done') {
        // participation 解读:markdown 渲染(换行/标签可点);其他按 kind 渲染
        target.innerHTML = p.kind === 'participation'
          ? `<div class="sd-insight-text">${renderMarkdown(cur.text)}</div>`
          : renderDetailBody(p.kind as AnalysisKind, cur.text);
        // 卡片出现动画:done 后加 .sd-reveal,stagger 由子项 animation-delay 控制
        const block = target.closest('.sd-block');
        if (block) {
          block.classList.add('sd-done');
          requestAnimationFrame(() => {
            target.querySelectorAll('.sd-item, .sd-dec, .sd-tl-node, .sd-res-link, .sd-res-file, .sd-p-row').forEach((el, i) => {
              (el as HTMLElement).style.setProperty('--reveal-i', String(i));
              el.classList.add('sd-reveal');
            });
          });
        }
      }
      else if (cur.status === 'error') target.innerHTML = '<div class="wc-empty">分析失败,点击刷新重试</div>';
      // streaming:实时渲染(JSON 增量解析/文本打字机)。streaming 阶段不加 reveal 动画(done 才加)
      else target.innerHTML = renderStreaming(p.kind as AnalysisKind, cur.text);
    });
  });
}

/**
 * 全局处理 detail 事件:配对呼吸灯计数 + 更新 detailCache。
 * 由 chatView 的全局 summary-event 监听调用(无论看板是否打开),
 * 确保 prefetchSummary 预请求的 done/error 都能 endDetailRequest → 呼吸灯正常熄灭。
 */
export function handleDetailEvent(p: { chatId: number; kind: string; status: string; delta?: string; result?: string }): void {
  // 请求结束标记(done/error 配对入队时的 begin)。streaming 不参与计数——
  // 请求在生成前失败只有 error 无 streaming,靠 kind 级配对避免计数错乱。
  if (p.status === 'done' || p.status === 'error') endDetailRequest(p.chatId, p.kind);
  const key = `${p.chatId}:${p.kind}`;
  const cur = detailCache.get(key) ?? { kind: p.kind as AnalysisKind, status: 'idle', text: '' };
  if (p.status === 'streaming') { cur.status = 'streaming'; cur.text += p.delta ?? ''; }
  else if (p.status === 'done') { cur.status = 'done'; cur.text = p.result ?? cur.text; }
  else if (p.status === 'error') { cur.status = 'error'; }
  detailCache.set(key, cur);
  // 同步气泡指示器(呼吸灯/loading 随 detail 请求状态)
  restoreBubbleIndicator();
}

// ── 缓存失效 + 预请求 + 防抖刷新(供 chatView 调用) ─────────
/** 新消息到达:清该 chat 全部 detail 缓存(下次打开重新请求)。 */
export function invalidateChatCache(chatId: number): void {
  for (const key of [...detailCache.keys()]) {
    if (key.startsWith(`${chatId}:`)) detailCache.delete(key);
  }
}

/**
 * 预请求(仅首次打开):并发请求全部 7 个 kind。仅当该 chat 完全无 detail 缓存时
 * 才整批预请求(首次打开/缓存被清);新消息后的重算由 scheduleRefresh 的 60s 窗口驱动,
 * 避免对话中每消息都重算 7 个 detail 浪费 token。
 * 结果经 summary-event 进 detailCache(bindFullscreenEvents 无 popup 也缓存),
 * popup 打开时直接命中显示。
 */
export async function prefetchSummary(chatId: number, msgs: MsgDto[], resolve: (t: string) => string): Promise<void> {
  const { getSummaryPrefs, loadSummaryPrefs } = await import('../utils/summaryPrefs.js');
  await loadSummaryPrefs();
  const prefs = getSummaryPrefs();
  if (prefs.mode !== 'llm') return; // 非 LLM 模式不预请求(词频气泡无面板数据)
  // 已有任一 done 缓存 → 该 chat 已分析过,不整批重算(对话中的更新交给窗口)
  const anyCached = ANALYSIS_TYPES.some((t) => {
    const c = detailCache.get(`${chatId}:${t.kind}`);
    return c && c.status === 'done' && c.text;
  });
  if (anyCached) return;
  const win = buildContextWindow(msgs, resolve, prefs.contextN);
  if (win.length === 0) return;
  const prompt = formatWindowLines(win);
  for (const t of ANALYSIS_TYPES) {
    // 已在请求中的 kind 跳过:等其流式进缓存,不重复入队(60s 刷新边界双请求防浪费)
    const pendingSet = detailPending.get(chatId);
    if (pendingSet && pendingSet.has(t.kind)) continue;
    detailCache.delete(`${chatId}:${t.kind}`);
    beginDetailRequest(chatId, t.kind);
    void call('summary_enqueue', { chatId, lane: 'detail', kind: t.kind, prompt }).catch(() => {
      endDetailRequest(chatId, t.kind);
    });
  }
}

// 防抖计时器:5s 内有新消息则重置
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshChatId: number | null = null;

/**
 * 新消息后 60s 防抖重新请求:60s 内有更多新消息则重置计时器。
 * 启动时气泡右侧显示「Xs总结」读秒(不闲置);到期 → 若该 chat 的 popup 开着则重新入队
 * 刷新,关着则缓存已清,下次打开自然请求。计时被重置 → 读秒从头再来。
 */
export function scheduleRefresh(chatId: number): void {
  refreshChatId = chatId;
  if (refreshTimer) clearTimeout(refreshTimer);
  clearCountdown();
  countdownChatId = chatId;
  countdownRemaining = 60;
  applyBubbleState(chatId); // 立即显示「60s总结」,不闲置
  countdownTimer = setInterval(() => {
    const cid = countdownChatId;
    countdownRemaining -= 1;
    if (countdownRemaining <= 0) {
      clearCountdown();
      // 到期:读秒消失。popup 开着 → refreshTimer 回调稍后入队会显示 loading;
      // 关着 → 恢复绿勾/空(applyBubbleState 评估当前状态)
      if (cid != null && state.currentChatId === cid) applyBubbleState(cid);
      return;
    }
    // detail pending 在途 → loading SVG 优先,不覆盖(读秒冻结在背景,pending 结束由
    // applyBubbleState 恢复剩余秒数)
    const pendingSet = cid != null ? detailPending.get(cid) : undefined;
    if (pendingSet && pendingSet.size > 0) return;
    const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
    const ind = chip?.querySelector<HTMLElement>('.ch-bubble-indicator');
    if (ind) {
      ind.classList.add('cd');
      ind.innerHTML = `<span class="ch-bubble-countdown">${countdownRemaining}s总结</span>`;
    }
  }, 1000);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // 清理缓存后,若 popup 开着则重新入队。用最新 state.messages 重建窗口
    // (含 60s 窗口内到达的新消息),而非打开时的 fsWin 快照。
    invalidateChatCache(chatId);
    const popup = document.querySelector<HTMLElement>('.sd-overlay[data-sd-chat]');
    if (popup && popup.dataset.sdChat === String(chatId)) {
      const prefs = getSummaryPrefs();
      const win = buildContextWindow(state.messages, resolveMessageText, prefs.contextN);
      const prompt = formatWindowLines(win);
      for (const t of ANALYSIS_TYPES) {
        // 重新入队所有 detail(participation 统计也重算)
        const body = popup.querySelector<HTMLElement>(`[data-body="${t.kind}"]`);
        if (t.kind === 'participation') {
          if (body) body.innerHTML = `<div class="sd-p-stat">${renderParticipationStat(win)}</div><div class="sd-p-insight">分析中…</div>`;
          enqueueOverlay(popup, chatId, t.kind, prompt, false);
        } else {
          enqueueOverlay(popup, chatId, t.kind, prompt);
        }
      }
    }
  }, 60000); // 防抖窗口 60s:60s 内有新消息则重置(正常聊天停顿才重算 detail,省 token)
}

/**
 * 词云:真实 jieba 分词(initSegmenter + computeTopWords) → 复用 wordCloud 的 drawWordCloud。
 * drawWordCloud 已做 词频→字号/颜色的瀑布堆叠;这里只负责取词 + DPR 缩放画布。
 * 失败(分词初始化异常)静默留空,不阻断看板。
 */
async function drawCloudAsync(canvas: HTMLCanvasElement, msgs: MsgDto[], resolve: (t: string) => string): Promise<void> {
  try {
    const { initSegmenter, computeTopWords } = await import('../utils/wordAnalysis.js');
    const { drawWordCloud } = await import('./wordCloud.js');
    await initSegmenter(); // 幂等单例
    const words = computeTopWords(msgs, resolve, 14); // 212px 宽画布放 ~14 词合适
    if (words.length === 0) return;
    // DPR 缩放:画布物理分辨率 = CSS 尺寸 × devicePixelRatio,防高分屏模糊(§11)
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr))) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);
    drawWordCloud(canvas, words);
  } catch (err) {
    console.warn('[summary-cloud] 词云绘制失败:', err);
  }
}

/** 词频模式降级:原有锚定词云弹窗。 */
async function openWordAnalysisPopupFallback(anchor: HTMLElement, msgs: MsgDto[], resolve: (t: string) => string): Promise<void> {
  const { openWordAnalysisPopup } = await import('./wordCloud.js');
  const { computeTopics } = await import('../utils/wordAnalysis.js');
  openWordAnalysisPopup(anchor, computeTopics(msgs, resolve, 4));
}
