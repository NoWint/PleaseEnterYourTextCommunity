// 主题分析看板:popup 平铺全部分析类型,每类独立入队/流式/状态/刷新。
// participation 走前端纯统计(local_stats)+ LLM 解读(stats_plus_llm)。
import { mountPopup } from './readReceiptsPopup.js';
import { iconSvg } from './icon.js';
import { escapeHtml } from './escape.js';
import { call } from '../api.js';
import type { MsgDto } from '../types.js';
import { buildContextWindow, formatWindowLines } from '../utils/summaryContext.js';
import { computeParticipation } from '../utils/participation.js';
import { getSummaryPrefs, loadSummaryPrefs } from '../utils/summaryPrefs.js';
import { parseTags, renderParsed } from '../utils/tagParser.js';

export type AnalysisKind = 'summary' | 'participation' | 'action_items'
  | 'resources' | 'open_questions' | 'timeline' | 'decisions';

interface AnalysisType {
  kind: AnalysisKind;
  title: string;
  engine: 'llm' | 'local_stats' | 'stats_plus_llm';
  priority: number;
}

const ANALYSIS_TYPES: AnalysisType[] = [
  { kind: 'summary', title: '总结', engine: 'llm', priority: 0 },
  { kind: 'participation', title: '参与度', engine: 'stats_plus_llm', priority: 0 },
  { kind: 'action_items', title: '行动项', engine: 'llm', priority: 0 },
  { kind: 'resources', title: '资源', engine: 'llm', priority: 1 },
  { kind: 'open_questions', title: '悬而未决', engine: 'llm', priority: 1 },
  { kind: 'timeline', title: '话题演变', engine: 'llm', priority: 1 },
  { kind: 'decisions', title: '决策', engine: 'llm', priority: 2 },
];

// 每 chat 每 kind 的状态:done 内容缓存 + 显示
const detailCache = new Map<string, { kind: AnalysisKind; status: string; text: string }>();

export async function openSummaryDashboard(anchor: HTMLElement, chatId: number, msgs: MsgDto[], resolve: (t: string) => string): Promise<void> {
  await loadSummaryPrefs(); // 拉最新偏好(后端 SQL)
  const prefs = getSummaryPrefs();
  if (prefs.mode !== 'llm') { await openWordAnalysisPopupFallback(anchor, msgs, resolve); return; }
  const window = buildContextWindow(msgs, resolve, prefs.contextN);
  const prompt = formatWindowLines(window); // 含绝对时间;participation 用结构化 window 本地统计

  const blocks = ANALYSIS_TYPES
    .sort((a, b) => a.priority - b.priority)
    .map((t) => `
      <div class="sd-block" data-kind="${t.kind}">
        <div class="sd-head">
          <span class="sd-title">${escapeHtml(t.title)}</span>
          <button class="sd-refresh" data-refresh="${t.kind}" title="刷新">${iconSvg('refresh-cw', { width: 14, height: 14 })}</button>
        </div>
        <div class="sd-body" data-body="${t.kind}">加载中…</div>
      </div>`)
    .join('');

  mountPopup(
    `<div class="rr-head">会话主题分析<button class="sd-refresh-all" data-refresh-all="1">${iconSvg('refresh-cw', { width: 14, height: 14 })} 全部刷新</button></div>
     <div class="sd-dashboard">${blocks}</div>`,
    anchor,
    'rr-popup sd-popup',
  );
  // 标记当前看板归属会话(单例监听靠 data-sd-chat 匹配,避免旧弹窗流污染)
  document.querySelector<HTMLElement>('.sd-popup')!.dataset.sdChat = String(chatId);

  const enqueue = (kind: AnalysisKind, force: boolean) => {
    const popup = document.querySelector<HTMLElement>('[data-sd-chat]');
    const body = popup?.querySelector<HTMLElement>(`[data-body="${kind}"]`);
    if (body) body.textContent = '分析中…';
    void call('summary_enqueue', { chatId, lane: 'detail', kind, prompt }).catch(() => {
      if (body) body.textContent = '分析失败';
    });
  };

  // participation 走本地统计,即时显示
  const pBody = document.querySelector<HTMLElement>(`[data-body="participation"]`);
  if (pBody) {
    const p = computeParticipation(window);
    pBody.innerHTML = renderParticipation(p);
    // 统计即时出;LLM 解读通过 detail 车道(同一 kind 'participation',由 LLM 输出解读文本)
    enqueue('participation', false);
  }
  // summary 首个默认入队
  enqueue('summary', false);
  // 其余懒加载:点击块头刷新时入队
  document.querySelectorAll<HTMLElement>('[data-refresh]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.refresh as AnalysisKind;
      enqueue(kind, true);
    });
  });

  bindDetailEvents();
}

function renderParticipation(p: { per_member: Array<{ name: string; msg_count: number; char_count: number; active_days: number }> }): string {
  const rows = p.per_member
    .map((m) => `<div class="sd-p-row"><span>${escapeHtml(m.name)}</span><span>${m.msg_count} 条 · ${m.char_count} 字 · ${m.active_days} 天</span></div>`)
    .join('');
  return `<div class="sd-p-stat">${rows}</div>`;
}

let detailBound = false;
function bindDetailEvents(): void {
  if (detailBound) return;
  detailBound = true;
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen('summary-event', (ev) => {
      const p = ev.payload as { chatId: number; lane: string; kind: string; status: string; delta?: string; result?: string; error?: { code: string } };
      if (p.lane !== 'detail') return;
      // 单例监听:只更新当前打开的看板(mountPopup 每次重建,data-sd-chat 恒为最新)
      const popup = document.querySelector<HTMLElement>('[data-sd-chat]');
      if (!popup || popup.dataset.sdChat !== String(p.chatId)) return;
      const key = `${p.chatId}:${p.kind}`;
      const cur = detailCache.get(key) ?? { kind: p.kind as AnalysisKind, status: 'idle', text: '' };
      if (p.status === 'streaming') { cur.status = 'streaming'; cur.text += p.delta ?? ''; }
      else if (p.status === 'done') { cur.status = 'done'; cur.text = p.result ?? cur.text; }
      else if (p.status === 'error') { cur.status = 'error'; }
      detailCache.set(key, cur);
      const body = popup.querySelector<HTMLElement>(`[data-body="${p.kind}"]`);
      if (!body) return;
      if (cur.status === 'done') body.innerHTML = renderDetailBody(p.kind as AnalysisKind, cur.text);
      else if (cur.status === 'error') body.innerHTML = '<div class="wc-empty">分析失败,点击刷新重试</div>';
      else body.textContent = cur.text || '分析中…';
    });
  });
}

function renderDetailBody(kind: AnalysisKind, text: string): string {
  // summary:XML 段落,支持标签;其余按 JSON 字符串展示(后续按 schema 渲染)
  if (kind === 'summary') {
    const segs = parseTags(text);
    return `<div class="sd-summary">${renderParsed(segs, () => {})}</div>`;
  }
  return `<pre class="sd-json">${escapeHtml(text)}</pre>`;
}

async function openWordAnalysisPopupFallback(anchor: HTMLElement, msgs: MsgDto[], resolve: (t: string) => string): Promise<void> {
  const { openWordAnalysisPopup } = await import('./wordCloud.js');
  const { computeTopics } = await import('../utils/wordAnalysis.js');
  openWordAnalysisPopup(anchor, computeTopics(msgs, resolve, 4));
}
