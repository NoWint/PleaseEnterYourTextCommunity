// iMessage Digital Touch 风格「手写消息」—— MP4 方案。
// 发送方用触控板/鼠标在画布书写,点发送时在画布上回放笔迹动画,同时用
// MediaRecorder 把画布流录制为 MP4(canvas.captureStream),再作为视频附件发送
// (send_attachment + hw 标记)。收件方看到的就是自动播放的手写过程视频。

import { call } from '../api.js';
import { showToast } from '../toast.js';

export interface HandwritingStroke {
  c: string;
  wt: number;
  pts: Array<[number, number, number]>;
}

const LOGICAL_W = 640;
const LOGICAL_H = 400;

// ── 绘制 ─────────────────────────────────────────────────────────────
function applyStrokeStyle(ctx: CanvasRenderingContext2D, s: HandwritingStroke, W: number, H: number): void {
  ctx.strokeStyle = s.c;
  ctx.lineWidth = Math.max(1, s.wt * Math.min(W, H) / 200);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function strokeFull(ctx: CanvasRenderingContext2D, s: HandwritingStroke, W: number, H: number): void {
  ctx.beginPath();
  s.pts.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x * W, y * H);
    else ctx.lineTo(x * W, y * H);
  });
  ctx.stroke();
}

/** 按时间轴把笔迹画到 canvas(录制时逐帧调用,直到 el >= totalMs)。 */
function drawAt(ctx: CanvasRenderingContext2D, strokes: HandwritingStroke[], el: number, W: number, H: number): void {
  ctx.clearRect(0, 0, W, H);
  for (const s of strokes) {
    const pts = s.pts;
    applyStrokeStyle(ctx, s, W, H);
    ctx.beginPath();
    let started = false;
    let breakOut = false;
    for (let i = 0; i < pts.length; i++) {
      const t = pts[i][2];
      if (t <= el) {
        const x = pts[i][0] * W;
        const y = pts[i][1] * H;
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
            ctx.lineTo((p0[0] + (p1[0] - p0[0]) * r) * W, (p0[1] + (p1[1] - p0[1]) * r) * H);
          }
        }
        breakOut = true;
        break;
      }
    }
    void breakOut;
    ctx.stroke();
  }
}

/** 在 canvas 上播放完整手写动画(录制时驱动帧),播放完 resolve。 */
function playToCanvas(canvas: HTMLCanvasElement, strokes: HandwritingStroke[], totalMs: number): Promise<void> {
  return new Promise((resolve) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve();
      return;
    }
    const W = canvas.width;
    const H = canvas.height;
    const t0 = performance.now();
    const frame = (now: number): void => {
      const el = now - t0;
      drawAt(ctx, strokes, el, W, H);
      if (el < totalMs) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

// ── 录制 MP4 ─────────────────────────────────────────────────────────
function pickMime(): string {
  if (typeof window.MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* 继续下一个 */
    }
  }
  return '';
}

async function recordToVideo(
  canvas: HTMLCanvasElement,
  strokes: HandwritingStroke[],
  totalMs: number,
): Promise<{ blob: Blob; mime: string } | null> {
  if (typeof MediaRecorder === 'undefined') return null;
  const mime = pickMime();
  if (!mime) return null;
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((r) => {
    rec.onstop = () => r();
  });
  rec.start(50);
  await playToCanvas(canvas, strokes, totalMs);
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: rec.mimeType || mime });
  return { blob, mime: rec.mimeType || mime };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result || '');
      resolve(dataUrl.split(',')[1] || '');
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// ── 发送端手写面板(触控板/鼠标书写 → 录制 MP4 → 发送) ───────────────
const HW_COLORS = ['#1c1c1e', '#3b5cf6', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6'];

export function openHandwritingPanel(chatId: number, onSent: () => void): void {
  const panel = document.createElement('div');
  panel.className = 'hw-panel';
  panel.innerHTML = `
    <div class="hw-panel-inner">
      <div class="hw-panel-head">
        <span class="hw-panel-title">手写</span>
        <span class="hw-rec-status" hidden>正在生成视频…</span>
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
      <div class="hw-hint">用触控板或鼠标书写 · 发送后自动生成并回放手写视频</div>
    </div>
  `;
  document.body.appendChild(panel);

  const canvas = panel.querySelector<HTMLCanvasElement>('.hw-draw-canvas');
  if (!canvas) return;
  const W = LOGICAL_W;
  const H = LOGICAL_H;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 颜色预设
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
  let strokeStart = 0;
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
    strokeStart = performance.now();
    current = [];
    const [x, y] = norm(e);
    current.push([x, y, 0]);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const [x, y] = norm(e);
    const t = performance.now() - strokeStart;
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

  const sendBtn = panel.querySelector<HTMLButtonElement>('.hw-send');
  const recStatus = panel.querySelector<HTMLElement>('.hw-rec-status');
  sendBtn?.addEventListener('click', async () => {
    if (strokes.length === 0) {
      showToast('请先书写内容');
      return;
    }
    if (sendBtn.disabled) return;
    sendBtn.disabled = true;
    if (recStatus) recStatus.hidden = false;

    try {
      // 总时长 = 最后一笔结束 + 收尾停顿(与书写节奏一致)
      const totalMs =
        Math.max(...strokes.map((s) => (s.pts[s.pts.length - 1] ? s.pts[s.pts.length - 1][2] : 0)), 0) + 420;
      const rec = await recordToVideo(canvas, strokes, totalMs);
      if (!rec) {
        showToast('当前环境不支持视频录制,请在桌面 App 中使用');
        return;
      }
      const base64 = await blobToBase64(rec.blob);
      await call('send_attachment', {
        chatId,
        base64,
        filename: 'handwriting.mp4',
        mime: rec.mime,
        hw: true,
      });
      close();
      onSent();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      sendBtn.disabled = false;
      if (recStatus) recStatus.hidden = true;
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
