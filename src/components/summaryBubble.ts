// 主题气泡状态机:idle / summarizing(流式) / done / error / fallback。
// 由 summary-event 驱动,呼吸灯只在 summarizing 亮。后端只发数据不碰 DOM。
import type { MsgDto } from '../types.js';
import { buildContextWindow, formatWindowLines } from '../utils/summaryContext.js';
import { getSummaryPrefs, loadSummaryPrefs } from '../utils/summaryPrefs.js';
import { renderTopicBubbleHtml } from './wordCloud.js';
import type { TopicCluster } from '../utils/wordAnalysis.js';
import { parseTags, renderParsed } from '../utils/tagParser.js';
import { escapeHtml } from './escape.js';
import { iconSvg } from './icon.js';
import { state } from '../state.js';

export type BubbleStatus = 'idle' | 'summarizing' | 'done' | 'error' | 'fallback';
export interface BubbleState { status: BubbleStatus; text: string; }

const store = new Map<number, BubbleState>();
let chatId: number | null = null;
let resolveFn: ((t: string) => string) | null = null;

export function initSummaryBubble(cid: number, resolve: (t: string) => string): void {
  chatId = cid;
  resolveFn = resolve;
  if (!store.has(cid)) {
    store.set(cid, { status: 'idle', text: '' });
    // 从 summary_cache 恢复上次气泡摘要(done),不重新生成(§8.4)
    void import('../api.js').then(({ call }) =>
      call<string | null>('summary_load_cache', { chatId: cid, kind: 'bubble' })
        .then((cached) => {
          // 仅当仍是 idle 时恢复缓存;期间若已开始新的 summarizing(done 前在途),
          // 用旧缓存覆盖会打断新任务 → 保留新状态。
          if (cached) {
            const cur = store.get(cid);
            if (cur && cur.status === 'idle') store.set(cid, { status: 'done', text: cached });
          }
        })
        .catch(() => {}));
  }
}

/** LLM 模式下:防抖入队 bubble 总结。词频模式直接走 computeTopics(现状)。 */
export async function scheduleSummary(
  msgs: MsgDto[],
  resolve: (t: string) => string,
  n: number,
): Promise<BubbleState | null> {
  // 入口先捕获 chatId:下方 await loadSummaryPrefs 期间可能切会话,
  // 若 await 后才读模块级 chatId,会拿「新 chatId + 旧 msgs」错配入队。
  const cid = chatId;
  await loadSummaryPrefs(); // 拉最新偏好(后端 SQL;防抖后调用,频率可接受)
  const prefs = getSummaryPrefs();
  if (prefs.mode !== 'llm') return null; // 词频/off 走原 computeTopics
  if (cid == null) return null;
  // 前端去重 + 防抖:同 chat 已有 summarizing 则不重复
  const st = store.get(cid);
  if (st && st.status === 'summarizing') return st;
  const win = buildContextWindow(msgs, resolve, prefs.contextN);
  if (win.length === 0) return { status: 'fallback', text: '暂无主题词' };
  // 方式2(§4.4):上次分析 + 最近 N 条。prev 分析拼在 prompt 开头作历史上下文块。
  const prev = st && st.status === 'done' ? st.text : null;
  const prompt = (prev ? `历史上下文(之前的分析结果):\n${prev}\n\n` : '') + formatWindowLines(win);
  store.set(cid, { status: 'summarizing', text: prev ?? '' });
  try {
    const { call } = await import('../api.js');
    await call('summary_enqueue', { chatId: cid, lane: 'bubble', kind: 'bubble', prompt });
  } catch {
    // 入队失败:把 fallback 写回 store,否则 status 卡在 summarizing → 去重挡住后续重试
    store.set(cid, { status: 'fallback', text: '暂无主题词' });
    return store.get(cid)!;
  }
  return store.get(cid)!;
}

/** 处理 summary-event(delta 流式追加 / done / error)。返回新状态。 */
export function applySummaryEvent(ev: { chatId: number; lane: string; status: string; delta?: string; result?: string; error?: { code: string } }): BubbleState | null {
  if (ev.lane !== 'bubble') return null;
  // 先推进 store(后台会话也要 done/保存缓存),最后才决定是否驱动当前 DOM
  const st = store.get(ev.chatId) ?? { status: 'idle', text: '' };
  let changed = false;
  if (ev.status === 'streaming') {
    if (st.status !== 'summarizing') { st.status = 'summarizing'; }
    st.text += ev.delta ?? '';
    changed = true;
  } else if (ev.status === 'done') {
    st.status = 'done';
    st.text = ev.result ?? st.text;
    changed = true;
    // 落盘到 summary_cache 表(重启恢复 done 状态,§8.4)
    void import('../api.js').then(({ call }) =>
      call('summary_save_cache', { chatId: ev.chatId, kind: 'bubble', text: st.text }).catch(() => {}));
  } else if (ev.status === 'error') {
    if (ev.error?.code === 'cancelled') {
      // 正常中断(被新任务取代):有已流文本 → done,否则 fallback,不降级到词频
      // (后端今天无 cancel 路径,此为防御性;显式落 done/fallback 避免呼吸灯常亮)
      st.status = st.text ? 'done' : 'fallback';
      if (!st.text) st.text = '暂无主题词';
      changed = true;
    } else {
      st.status = 'error';
      if (!st.text) st.text = '暂无主题词';
      changed = true;
    }
  }
  store.set(ev.chatId, st);
  // 仅当事件属于当前激活会话才返回(驱动 DOM 重渲染);否则只更新 store,不碰当前气泡
  if (ev.chatId !== chatId) return null;
  return changed ? st : null;
}

/** 最近一次词频簇(LLM 失败时降级显示用)。scheduleTopicRefresh 前置填充。 */
let fallbackClusters: TopicCluster[] = [];
export function setFallbackClusters(c: TopicCluster[]): void { fallbackClusters = c; }

/** 状态指示器 span(空壳):loading 旋转/绿勾 由 dashboard 的呼吸灯逻辑注入。 */
export function indicatorSpan(): string {
  return `<span class="ch-bubble-indicator"></span>`;
}

/** 渲染气泡内容(直接作为 .ch-topic-chip 的 innerHTML,无内层 topic-bubble)。
 * 文字 span flex:1 填满;右侧指示器由 dashboard 按请求状态注入(加载旋转/完成绿勾)。 */
export function renderBubbleHtml(st: BubbleState): string {
  if (st.status === 'summarizing') {
    const body = st.text ? escapeHtml(st.text) : '总结中…';
    return `${iconSvg('hash', { width: 14, height: 14 })}<span>${body}</span>${indicatorSpan()}`;
  }
  if (st.status === 'done') {
    const html = renderParsed(parseTags(st.text), () => {});
    return `${iconSvg('hash', { width: 14, height: 14 })}<span>${html}</span>${indicatorSpan()}`;
  }
  // idle / error / fallback → 降级显示词频簇短语
  return renderTopicBubbleHtml(fallbackClusters) + indicatorSpan();
}

/**
 * 打开主题分析看板(LLM 模式)。点击委托由 chatView 统一管理(bindTopicChipClick),
 * 此处只负责打开;动态导入避免循环依赖。
 */
export function openSummaryBubbleView(chip: HTMLElement): void {
  void import('./summaryDashboard.js').then((m) => {
    void m.openSummaryDashboard(chip, chatId!, state.messages, resolveFn!);
  }).catch(() => {});
}
