import { TDESIGN_PATHS, type TDesignPath } from './tdesignIcons.js';

export type IconName =
  | 'message-circle' | 'users' | 'layout-grid' | 'settings'
  | 'user' | 'palette' | 'bell' | 'info'
  | 'plus' | 'x' | 'hash' | 'reply'
  | 'pin' | 'copy' | 'trash' | 'smile'
  | 'chevron-down' | 'chevron-left' | 'chevron-right' | 'check' | 'check-check' | 'send'
  | 'search' | 'log-out' | 'upload' | 'shield'
  | 'volume-2' | 'volume-x' | 'bookmark' | 'more-horizontal'
  | 'forward' | 'file-text' | 'image' | 'paperclip' | 'edit'
  | 'arrow-up' | 'star' | 'alert-circle' | 'thumbs-up' | 'package' | 'terminal' | 'download'
  | 'calendar' | 'list' | 'clock' | 'inbox'
  // SP7: ViewToggle 视图切换图标 (kanban / timeline)
  | 'calendar' | 'list' | 'clock' | 'inbox' | 'columns' | 'timeline'
  // 图标收口: 刷新 / 禁止 (替代 ↻ / ⛔)
  | 'refresh-cw' | 'ban'
  // 置顶 / 取消置顶
  | 'pin-off'
  // 调试: 消息原文列表页
  | 'bug'
  // 反应: 更多表情面板入口
  | 'smile-plus'
  // 语音: 播放/暂停/录音 (TDesign 缺失, 在 tdesignIcons.ts 补充标准路径)
  | 'play' | 'pause' | 'mic'
  // Bot 管理页
  | 'robot';

export interface IconOpts {
  width?: number;
  height?: number;
  strokeWidth?: number;
  fill?: string;
  class?: string;
}

/** SVG 呈现属性 (key 为属性名, 与 lucide 的 SvgProps 形状兼容)。 */
interface SvgProps {
  [key: string]: string | number | undefined;
}

// TDesign Icons (tdesign-icons-svg) 提供 24 viewBox / stroke 模式的图标路径。
const iconMap = TDESIGN_PATHS as Record<IconName, TDesignPath[]>;

const defaultAttributes: SvgProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'square',
  'stroke-linejoin': 'square',
};

function escapeAttr(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderAttrs(attrs: SvgProps): string {
  let result = '';
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value !== undefined) {
      result += ` ${key}="${escapeAttr(value)}"`;
    }
  }
  return result;
}

function renderChildren(paths: TDesignPath[]): string {
  let result = '';
  for (const p of paths) {
    let attrs = `d="${escapeAttr(p.d)}"`;
    if (p.fillRule) attrs += ` fill-rule="${escapeAttr(p.fillRule)}"`;
    result += `<path ${attrs} />`;
  }
  return result;
}

export function iconSvg(name: IconName, opts: IconOpts = {}): string {
  const icon = iconMap[name];
  if (!icon) return '';
  const w = opts.width ?? 24;
  const h = opts.height ?? 24;
  const sw = opts.strokeWidth ?? 2;
  const attrs: SvgProps = {
    ...defaultAttributes,
    width: w,
    height: h,
    'stroke-width': sw,
  };
  if (opts.fill !== undefined) {
    attrs.fill = opts.fill;
  }
  if (opts.class) {
    attrs.class = opts.class;
  }
  return `<svg${renderAttrs(attrs)}>${renderChildren(icon)}</svg>`;
}

export function iconElement(name: IconName, opts: IconOpts = {}): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.style.display = 'inline-flex';
  wrapper.style.alignItems = 'center';
  wrapper.style.justifyContent = 'center';
  wrapper.innerHTML = iconSvg(name, opts);
  return wrapper;
}
