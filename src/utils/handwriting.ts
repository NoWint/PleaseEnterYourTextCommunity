// iMessage Digital Touch 风格「手写消息」—— canvas 透明回放方案。
// 发送方用触控板/鼠标在画布书写,笔迹数据(归一化坐标 + 全局时间轴)随 [PEYT] 信封
// (type="handwriting")传输;收件方用 canvas 在聊天背景上按时间轴逐步重绘笔迹,
// 背景完全透明、融入聊天(0 失真)。自动回放一次,点击可重播。

import { call } from '../api.js';
import { showToast } from '../toast.js';
import { escapeHtml } from '../components/escape.js';

export interface HandwritingStroke {
  c: string;
  wt: number;
  pts: Array<[number, number, number]>;
}

export interface HandwritingPayload {
  text?: string;
  strokes: HandwritingStroke[];
}

// ── 解析信封 payload → HandwritingPayload(结构不合法 → null) ────────
export function parseHandwriting(payload: unknown): HandwritingPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.strokes) || p.strokes.length === 0) return null;
  const strokes: HandwritingStroke[] = [];
  for (const s of p.strokes) {
    if (typeof s !== 'object' || s === null) continue;
    const ss = s as Record<string, unknown>;
    if (!Array.isArray(ss.pts) || ss.pts.length < 2) continue;
    const pts: Array<[number, number, number]> = [];
    for (const pt of ss.pts) {
      if (!Array.isArray(pt) || pt.length < 3) continue;
      const x = Number(pt[0]);
      const y = Number(pt[1]);
      const t = Number(pt[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) continue;
      pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), Math.max(0, t)]);
    }
    if (pts.length < 2) continue;
    strokes.push({
      c: typeof ss.c === 'string' && ss.c ? ss.c : '#3b5cf6',
      wt: typeof ss.wt === 'number' && ss.wt > 0 ? ss.wt : 4,
      pts,
    });
  }
  if (strokes.length === 0) return null;
  return { text: typeof p.text === 'string' ? p.text : '', strokes };
}

// ── 笔迹内容边界(归一化),接收端按此取景画布比例 ──────────────────
interface Bounds {
  minX: number;
  minY: number;
  cw: number;
  ch: number;
}

function computeBounds(strokes: HandwritingStroke[]): Bounds {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const s of strokes) {
    for (const [x, y] of s.pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cw = maxX - minX;
  const ch = maxY - minY;
  return {
    minX,
    minY,
    cw: cw > 0.01 ? cw : 1,
    ch: ch > 0.01 ? ch : 1,
  };
}

function applyStrokeStyle(ctx: CanvasRenderingContext2D, s: HandwritingStroke, W: number, H: number): void {
  ctx.strokeStyle = s.c;
  ctx.lineWidth = Math.max(1, s.wt * Math.min(W, H) / 160);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

/** 按时间轴把笔迹画到透明 canvas(el 时刻的进度),不 clearRect 前先清。 */
function drawAt(
  ctx: CanvasRenderingContext2D,
  strokes: HandwritingStroke[],
  el: number,
  W: number,
  H: number,
  b: Bounds,
): void {
  const toPx = (x: number, y: number): [number, number] => [
    ((x - b.minX) / b.cw) * W,
    ((y - b.minY) / b.ch) * H,
  ];
  ctx.clearRect(0, 0, W, H);
  for (const s of strokes) {
    const pts = s.pts;
    applyStrokeStyle(ctx, s, W, H);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < pts.length; i++) {
      const t = pts[i][2];
      if (t <= el) {
        const [x, y] = toPx(pts[i][0], pts[i][1]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      } else {
        if (i > 0 && started) {
          const p0 = pts[i - 1];
          const p1 = pts[i];
          if (p1[2] > p0[2]) {
            const r = Math.min(1, Math.max(0, (el - p0[2]) / (p1[2] - p0[2])));
            const [x, y] = toPx(p0[0] + (p1[0] - p0[0]) * r, p0[1] + (p1[1] - p0[1]) * r);
            ctx.lineTo(x, y);
          }
        }
        break;
      }
    }
    ctx.stroke();
  }
}

/** 把 canvas 逻辑尺寸设为内容比例(宽 480,高按内容自适应),透明背景。 */
function setupCanvas(canvas: HTMLCanvasElement, b: Bounds): void {
  canvas.width = 480;
  canvas.height = Math.max(100, Math.round(480 * (b.ch / b.cw)));
}

// ── 接收端笔迹亮度适配 ──────────────────────────────────────────────
// canvas 透明回放时笔迹直接画在聊天背景上:深色主题下深色笔迹不可见。
// 根据当前主题背景明暗,自动提亮(深底)或加深(浅底),保证可见性。色相不变。
let darkBg: boolean | null = null;

function isDarkBg(): boolean {
  if (darkBg != null) return darkBg;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const rgb = parseCssColor(bg);
  darkBg = rgb ? luminance(rgb) < 0.5 : true;
  return darkBg;
}

/** 解析 CSS 颜色(#rgb / #rrggbb / rgb() / rgba()) → [r,g,b](0-255);失败 → null。 */
function parseCssColor(c: string): number[] | null {
  c = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) {
    const v = m[1];
    return [parseInt(v[0] + v[0], 16), parseInt(v[1] + v[1], 16), parseInt(v[2] + v[2], 16)];
  }
  m = /^#([0-9a-f]{6})$/.exec(c);
  if (m) {
    const v = m[1];
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

function luminance([r, g, b]: number[]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function toHex([r, g, b]: number[]): string {
  const h = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 向 target 色方向插值,直到亮度达到 targetLum。 */
function shiftToLum(rgb: number[], targetLum: number, towardWhite: boolean): number[] {
  let cur = [...rgb];
  let lum = luminance(cur);
  let it = 0;
  while (it < 40 && (towardWhite ? lum < targetLum : lum > targetLum)) {
    for (let i = 0; i < 3; i++) cur[i] += (towardWhite ? 255 - cur[i] : -cur[i]) * 0.55;
    lum = luminance(cur);
    it++;
  }
  return cur;
}

/** 接收端适配单个笔迹颜色。 */
function adaptColor(c: string): string {
  const rgb = parseCssColor(c);
  if (!rgb) return c;
  const lum = luminance(rgb);
  if (isDarkBg()) {
    return lum < 0.55 ? toHex(shiftToLum(rgb, 0.75, true)) : c;
  }
  return lum > 0.5 ? toHex(shiftToLum(rgb, 0.3, false)) : c;
}

/** 接收端:对所有笔画做亮度适配(色相不变)。 */
export function adaptStrokes(strokes: HandwritingStroke[]): HandwritingStroke[] {
  return strokes.map((s) => ({ ...s, c: adaptColor(s.c) }));
}

// ── 接收端卡片:自动一步步回放,点击重播 ─────────────────────────────
export function renderHandwritingCard(payload: HandwritingPayload): string {
  return `
    <div class="hw-card" data-hw="${escapeHtml(JSON.stringify(payload))}">
      <canvas class="hw-canvas"></canvas>
      <button type="button" class="hw-replay" title="重播手写">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>
      </button>
      ${payload.text ? `<div class="hw-text">${escapeHtml(payload.text)}</div>` : ''}
    </div>`;
}

/** 在透明 canvas 上按时间轴一步步回放笔迹动画。返回停止函数。 */
export function playHandwriting(
  canvas: HTMLCanvasElement,
  payload: HandwritingPayload,
  onDone?: () => void,
): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const b = computeBounds(payload.strokes);
  const W = canvas.width;
  const H = canvas.height;
  const total =
    Math.max(...payload.strokes.map((s) => (s.pts[s.pts.length - 1] ? s.pts[s.pts.length - 1][2] : 0)), 0) + 300;
  const t0 = performance.now();
  let raf = 0;
  const frame = (now: number): void => {
    const el = now - t0;
    drawAt(ctx, payload.strokes, el, W, H, b);
    if (el < total) raf = requestAnimationFrame(frame);
    else onDone?.();
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/** 画完整笔迹(静止态,重播前停住的最终帧)。 */
export function drawHandwritingStatic(canvas: HTMLCanvasElement, payload: HandwritingPayload): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const b = computeBounds(payload.strokes);
  setupCanvas(canvas, b);
  drawAt(ctx, payload.strokes, Number.MAX_SAFE_INTEGER, canvas.width, canvas.height, b);
}

/** 绑定容器内所有 .hw-card:渲染后自动回放一次,点击重播。 */
export function bindHandwritingCards(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.hw-card').forEach((card) => {
    const raw = card.dataset.hw;
    if (!raw) return;
    let payload: HandwritingPayload;
    try {
      payload = JSON.parse(raw) as HandwritingPayload;
    } catch {
      return;
    }
    // 深色聊天背景 → 提亮笔迹;浅色背景 → 加深,保证可见
    const adapted: HandwritingPayload = { ...payload, strokes: adaptStrokes(payload.strokes) };
    const canvas = card.querySelector<HTMLCanvasElement>('.hw-canvas');
    if (!canvas) return;
    const b = computeBounds(adapted.strokes);
    setupCanvas(canvas, b);
    const replayBtn = card.querySelector<HTMLElement>('.hw-replay');
    let playing = false;
    const start = (): void => {
      if (playing) return;
      playing = true;
      replayBtn?.classList.add('playing');
      playHandwriting(canvas, adapted, () => {
        playing = false;
        replayBtn?.classList.remove('playing');
      });
    };
    replayBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      start();
    });
    // 渲染即自动回放一次(iMessage 手写感)
    start();
  });
}

// ── 发送端手写面板(触控板/鼠标书写 → 发送笔迹数据) ─────────────────
const HW_COLORS = ['#1c1c1e', '#3b5cf6', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6'];

export function openHandwritingPanel(chatId: number, onSent: () => void): void {
  const panel = document.createElement('div');
  panel.className = 'hw-panel';
  panel.innerHTML = `
    <div class="hw-panel-inner">
      <div class="hw-panel-head">
        <span class="hw-panel-title">手写</span>
        <button type="button" class="hw-panel-close" title="关闭"></button>
      </div>
      <div class="hw-draw-wrap">
        <canvas class="hw-draw-canvas"></canvas>
      </div>
      <div class="hw-panel-tools">
        <button type="button" class="hw-tool" data-act="undo">撤销</button>
        <button type="button" class="hw-tool" data-act="clear">清空</button>
        <span class="hw-colors"></span>
        <span class="hw-panel-actions">
          <button type="button" class="hw-cancel">取消</button>
          <button type="button" class="hw-send">发送</button>
        </span>
      </div>
      <div class="hw-hint">用触控板或鼠标书写 · 对方将看到笔迹一步步回放</div>
    </div>
  `;
  document.body.appendChild(panel);

  const canvas = panel.querySelector<HTMLCanvasElement>('.hw-draw-canvas');
  if (!canvas) return;
  const W = 640;
  const H = 400;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const colorWrap = panel.querySelector<HTMLElement>('.hw-colors');
  if (colorWrap) {
    for (const c of HW_COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'hw-color' + (c === HW_COLORS[0] ? ' active' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        currentColor = c;
        colorWrap.querySelectorAll('.hw-color').forEach((e) => e.classList.remove('active'));
        sw.classList.add('active');
      });
      colorWrap.appendChild(sw);
    }
  }

  let strokes: HandwritingStroke[] = [];
  let current: Array<[number, number, number]> = [];
  let drawing = false;
  let globalT0 = 0; // 第一笔开始时间:全局相对时间轴,回放时各笔画按书写顺序逐步出现
  let currentColor = HW_COLORS[0];

  const redraw = (): void => {
    ctx.clearRect(0, 0, W, H);
    for (const s of strokes) {
      applyStrokeStyle(ctx, s, W, H);
      strokeFull(ctx, s, W, H);
    }
    if (current.length > 1) {
      const s: HandwritingStroke = { c: currentColor, wt: 4, pts: current };
      applyStrokeStyle(ctx, s, W, H);
      strokeFull(ctx, s, W, H);
    }
  };

  function strokeFull(c: CanvasRenderingContext2D, s: HandwritingStroke, w: number, h: number): void {
    c.beginPath();
    s.pts.forEach(([x, y], i) => {
      if (i === 0) c.moveTo(x * w, y * h);
      else c.lineTo(x * w, y * h);
    });
    c.stroke();
  }

  const norm = (e: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ];
  };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drawing = true;
    if (strokes.length === 0 && current.length === 0) globalT0 = performance.now();
    current = [];
    const [x, y] = norm(e);
    current.push([x, y, 0]);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const [x, y] = norm(e);
    const t = performance.now() - globalT0;
    const last = current[current.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < 0.0015) return;
    current.push([x, y, t]);
    redraw();
  });
  canvas.addEventListener('pointerup', () => {
    if (!drawing) return;
    drawing = false;
    if (current.length >= 2) strokes.push({ c: currentColor, wt: 4, pts: current });
    current = [];
    redraw();
  });
  canvas.addEventListener('pointercancel', () => {
    drawing = false;
    current = [];
  });

  panel.querySelector('[data-act="undo"]')?.addEventListener('click', () => {
    strokes.pop();
    redraw();
  });
  panel.querySelector('[data-act="clear"]')?.addEventListener('click', () => {
    strokes = [];
    current = [];
    redraw();
  });
  panel.querySelector<HTMLElement>('.hw-panel-close')?.addEventListener('click', close);
  panel.querySelector<HTMLElement>('.hw-cancel')?.addEventListener('click', close);
  panel.querySelector<HTMLElement>('.hw-send')?.addEventListener('click', async () => {
    if (strokes.length === 0) {
      showToast('请先书写内容');
      return;
    }
    const payload: HandwritingPayload = { text: '', strokes };
    try {
      console.log('[hw] sending:', JSON.stringify(payload).slice(0, 300));
      await call('send_handwriting', { chatId, payload });
      close();
      onSent();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  });

  function close(): void {
    panel.classList.add('closing');
    setTimeout(() => panel.remove(), 150);
  }

  panel.addEventListener('pointerdown', (e) => {
    if (e.target === panel) close();
  });
}
