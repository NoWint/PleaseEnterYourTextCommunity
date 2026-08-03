// 列宽拖动调整:nav-panel 与 right-drawer 支持鼠标拖动调整宽度。
// 流体交互要点 (Apple):pointerdown 即时响应、setPointerCapture 保证 1:1 跟踪、
// 越过 min/max 边界时渐进阻尼 (rubber-band) + 边界反馈条,释放时回弹到边界。
// 宽度通过 CSS 变量写入目标列,持久化到 localStorage (peyt.navWidth / peyt.drawerWidth)。

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

const NAV_MIN = 180;
const NAV_MAX = 460;
const DRAWER_MIN = 220;
const DRAWER_MAX = 520;
const RUBBER_DIM = 400;

// 越过边界后的渐进阻尼:越往外拖,实际跟随越少 (指数衰减形式,贴近 Apple 手感)
function rubberband(overshoot: number): number {
  const k = 0.55;
  return (overshoot * RUBBER_DIM * k) / (RUBBER_DIM + k * Math.abs(overshoot));
}

interface ResizerSpec {
  targetId: string;
  min: number;
  max: number;
  varName: string;
  persistKey: string;
  /** 手柄在目标列左侧时(drawer),dx 需反向:向右拖 = 目标变窄 */
  invert?: boolean;
}

const SPECS: Record<string, ResizerSpec> = {
  nav: {
    targetId: 'channel-tree',
    min: NAV_MIN,
    max: NAV_MAX,
    varName: '--nav-w',
    persistKey: 'peyt.navWidth',
  },
  drawer: {
    targetId: 'right-drawer',
    min: DRAWER_MIN,
    max: DRAWER_MAX,
    varName: '--drawer-w',
    persistKey: 'peyt.drawerWidth',
    invert: true,
  },
};

export function bindColumnResizers(): void {
  document.querySelectorAll<HTMLElement>('.col-resizer').forEach((handle) => {
    const spec = SPECS[handle.dataset.resizer ?? ''];
    if (!spec) return;
    const target = document.getElementById(spec.targetId);
    if (!target) return;

    // 启动时应用持久化的宽度
    try {
      const saved = localStorage.getItem(spec.persistKey);
      if (saved) {
        const w = clamp(Number(saved), spec.min, spec.max);
        if (Number.isFinite(w)) target.style.setProperty(spec.varName, `${Math.round(w)}px`);
      }
    } catch {}

    let dragging = false;
    let startX = 0;
    let startW = 0;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('dragging');
      // 拖动期间禁用宽度过渡,保证 1:1 跟踪 (Apple 直接操控)
      target.classList.add('no-anim');
      try { handle.setPointerCapture(e.pointerId); } catch { /* 合成事件下无活动指针,忽略 */ }
      startX = e.clientX;
      startW = target.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      // 手柄在目标列左侧(invert)时:向右拖 dx>0 → 目标变窄,故取反
      let w = startW + (spec.invert ? -dx : dx);
      if (w < spec.min || w > spec.max) {
        // 越过边界:渐进阻尼 + 边界反馈条 (拖到底/顶时高亮)
        const overshoot = w < spec.min ? spec.min - w : w - spec.max;
        const resisted = rubberband(overshoot);
        w = w < spec.min ? spec.min - resisted : spec.max + resisted;
        handle.classList.add('boundary');
      } else {
        handle.classList.remove('boundary');
      }
      target.style.setProperty(spec.varName, `${Math.round(w)}px`);
    });

    const finish = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging', 'boundary');
      target.classList.remove('no-anim');
      document.body.style.cursor = '';
      // 回弹到 min/max 边界
      const w = clamp(target.getBoundingClientRect().width, spec.min, spec.max);
      target.style.setProperty(spec.varName, `${Math.round(w)}px`);
      try {
        localStorage.setItem(spec.persistKey, String(Math.round(w)));
      } catch {}
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
}
