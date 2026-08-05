// 会话主题词频: chat-header 气泡 + 已读 popup 同款弹窗(词云 + 词频列表)。
// 复用 readReceiptsPopup 的 mountPopup(锚点定位 + 外部点击/Escape 关闭)。
import { iconSvg } from './icon.js';
import { mountPopup } from './readReceiptsPopup.js';
import { escapeHtml } from './escape.js';
import type { WordFreq, TopicCluster } from '../utils/wordAnalysis.js';

// 词云配色板: 与主题脱钩的中性可读色(亮暗主题均能看清)
const CLOUD_COLORS = ['#4a90d9', '#e06c6c', '#4caf50', '#d9a441', '#8e6cd9', '#2aa0a0', '#e08a3c', '#6ca0e0'];

/**
 * 渲染主题气泡内容(直接作为 .ch-topic-chip 的 innerHTML,无内层 topic-bubble):
 * hash 图标 + Top 主题短语横向排布。
 */
export function renderTopicBubbleHtml(clusters: TopicCluster[]): string {
  const text = clusters.length
    ? clusters.map((c) => escapeHtml(c.words.join(' '))).join(' · ')
    : '暂无主题词';
  return `${iconSvg('hash', { width: 14, height: 14 })}<span>${text}</span>`;
}

/**
 * 点击气泡 → 弹出与已读 popup 同款的会话主题分析弹窗。
 * 左: canvas 词云(全部簇内词); 右: 主题簇列表(短语 + 得分,可展开词频明细)。
 */
export function openWordAnalysisPopup(anchor: HTMLElement, clusters: TopicCluster[]): void {
  // 词云数据:合并所有簇的 wordFreqs(去重,按词加权和)
  const cloudMap = new Map<string, number>();
  for (const c of clusters) {
    for (const f of c.wordFreqs) {
      cloudMap.set(f.word, (cloudMap.get(f.word) ?? 0) + f.weight);
    }
  }
  // 词云仅用 weight 定字号, count 字段词云不读, 占位以满足 WordFreq 契约
  const cloudWords: WordFreq[] = [...cloudMap.entries()]
    .map(([word, weight]) => ({ word, count: 1, weight }))
    .sort((a, b) => b.weight - a.weight);

  const rows = clusters.length
    ? clusters
        .map(
          (c) => `
          <div class="wc-cluster">
            <div class="wc-row wc-cluster-head">
              <span class="wc-word">${escapeHtml(c.words.join(' '))}</span>
              <span class="wc-meta">${c.score.toFixed(2)}</span>
            </div>
            <div class="wc-cluster-detail" style="display:none">
              ${c.wordFreqs.map((f) => `<div class="wc-detail-row"><span>${escapeHtml(f.word)}</span><span>${f.count} 次</span></div>`).join('')}
            </div>
          </div>`,
        )
        .join('')
    : '<div class="wc-empty">暂无主题词</div>';
  mountPopup(
    `<div class="rr-head">会话主题分析</div>
     <div class="rr-cols">
       <div class="rr-col">
         <div class="rr-col-title">词云</div>
         <canvas class="wc-canvas" width="280" height="220"></canvas>
       </div>
       <div class="rr-col">
         <div class="rr-col-title">主题簇</div>
         <div class="wc-list">${rows}</div>
       </div>
     </div>`,
    anchor,
    'rr-popup wc-popup',
  );
  // 弹窗挂载后画词云
  requestAnimationFrame(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.wc-canvas');
    if (canvas) drawWordCloud(canvas, cloudWords);
  });
  // 点击簇头 → 展开/收起词频明细(DOM 导航, 无需索引属性)
  document.querySelectorAll<HTMLElement>('.wc-cluster-head').forEach((head) => {
    head.addEventListener('click', (e) => {
      e.stopPropagation();
      const detail = head.closest('.wc-cluster')?.querySelector<HTMLElement>('.wc-cluster-detail');
      if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });
  });
}

/** 按词频在 canvas 画词云: 词频→字号(12-36px)/颜色, 瀑布式逐行堆叠。 */
export function drawWordCloud(canvas: HTMLCanvasElement, words: WordFreq[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || words.length === 0) return;
  const cssW = canvas.width;
  const cssH = canvas.height;
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.textBaseline = 'alphabetic';

  const maxWeight = words[0].weight || 1;
  const maxFont = 36;
  const minFont = 12;
  let x = 8;
  let y = maxFont + 4; // 首行从顶部 + 首字高度开始
  let maxRowH = 0;

  for (const w of words) {
    const size = minFont + (w.weight / maxWeight) * (maxFont - minFont);
    ctx.font = `${Math.round(size)}px sans-serif`;
    const width = ctx.measureText(w.word).width + 10; // 词间距
    // 换行: 超出右缘 → 下移一行
    if (x + width > cssW - 8) {
      x = 8;
      y += maxRowH + 6;
      maxRowH = 0;
    }
    ctx.fillStyle = CLOUD_COLORS[Math.floor(Math.random() * CLOUD_COLORS.length)];
    ctx.fillText(w.word, x, y);
    x += width;
    maxRowH = Math.max(maxRowH, size);
  }
}
