// 会话主题词频: chat-header 气泡 + 已读 popup 同款弹窗(词云 + 词频列表)。
// 复用 readReceiptsPopup 的 mountPopup(锚点定位 + 外部点击/Escape 关闭)。
import { iconSvg } from './icon.js';
import { mountPopup } from './readReceiptsPopup.js';
import { escapeHtml, escapeAttr } from './escape.js';
import type { WordFreq } from '../utils/wordAnalysis.js';

// 词云配色板: 与主题脱钩的中性可读色(亮暗主题均能看清)
const CLOUD_COLORS = ['#4a90d9', '#e06c6c', '#4caf50', '#d9a441', '#8e6cd9', '#2aa0a0', '#e08a3c', '#6ca0e0'];

/** 渲染主题气泡 HTML: 专业 SVG(hash) + Top 词横向排布。 */
export function renderTopicBubbleHtml(words: WordFreq[]): string {
  const text = words.length
    ? words.map((w) => escapeHtml(w.word)).join(' · ')
    : '暂无主题词';
  return `<div class="topic-bubble" data-topic-bubble="1">${iconSvg('hash', { width: 14, height: 14 })}<span>${text}</span></div>`;
}

/**
 * 点击气泡 → 弹出与已读 popup 同款的词频分析弹窗。
 * 左: canvas 词云; 右: 词频列表(词 + 次数 + 权重)。
 */
export function openWordAnalysisPopup(anchor: HTMLElement, words: WordFreq[]): void {
  const rows = words.length
    ? words
        .map(
          (w) => `
          <div class="wc-row">
            <span class="wc-word">${escapeHtml(w.word)}</span>
            <span class="wc-meta">${w.count} 次 · ${w.weight.toFixed(2)}</span>
          </div>`,
        )
        .join('')
    : '<div class="wc-empty">暂无主题词</div>';
  const wordsJson = JSON.stringify(words);
  mountPopup(
    `<div class="rr-head">会话词频分析</div>
     <div class="rr-cols">
       <div class="rr-col">
         <div class="rr-col-title">词云</div>
         <canvas class="wc-canvas" width="280" height="220"></canvas>
       </div>
       <div class="rr-col">
         <div class="rr-col-title">词频</div>
         <div class="wc-list" data-wc-json="${escapeAttr(wordsJson)}">${rows}</div>
       </div>
     </div>`,
    anchor,
    'rr-popup wc-popup',
  );
  // 弹窗挂载后画词云(canvas 已在 DOM)
  requestAnimationFrame(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.wc-canvas');
    if (canvas) drawWordCloud(canvas, words);
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
