import {
  MessageCircle, Users, LayoutGrid, Settings, User, Palette, Bell, Info,
  Plus, X, Hash, Reply, Pin, Copy, Trash, Smile, ChevronDown, ChevronLeft, ChevronRight,
  Check, CheckCheck, Send, Search, LogOut, Upload, Shield, Volume2, VolumeX, BookMarked,
  MoreHorizontal, Forward, FileText, Image as ImageIcon, Paperclip, Edit3,
  ArrowUp, Star, AlertCircle, ThumbsUp, Package, Terminal, Download,
  Calendar, List, Clock, Inbox,
  Columns3, GitCommitHorizontal,
  RefreshCw, Ban, PinOff, Bug, SmilePlus,
} from 'lucide';
import type { IconNode, SVGProps } from 'lucide';

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
  | 'smile-plus';

export interface IconOpts {
  width?: number;
  height?: number;
  strokeWidth?: number;
  fill?: string;
  class?: string;
}

const iconMap: Record<IconName, IconNode> = {
  'message-circle': MessageCircle,
  'users': Users,
  'layout-grid': LayoutGrid,
  'settings': Settings,
  'user': User,
  'palette': Palette,
  'bell': Bell,
  'info': Info,
  'plus': Plus,
  'x': X,
  'hash': Hash,
  'reply': Reply,
  'pin': Pin,
  'copy': Copy,
  'trash': Trash,
  'smile': Smile,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'check': Check,
  'check-check': CheckCheck,
  'send': Send,
  'search': Search,
  'log-out': LogOut,
  'upload': Upload,
  'shield': Shield,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  'bookmark': BookMarked,
  'more-horizontal': MoreHorizontal,
  'forward': Forward,
  'file-text': FileText,
  'image': ImageIcon,
  'paperclip': Paperclip,
  'edit': Edit3,
  'arrow-up': ArrowUp,
  'star': Star,
  'alert-circle': AlertCircle,
  'thumbs-up': ThumbsUp,
  'package': Package,
  'terminal': Terminal,
  'download': Download,
  'calendar': Calendar,
  'list': List,
  'clock': Clock,
  'inbox': Inbox,
  'columns': Columns3,
  'timeline': GitCommitHorizontal,
  'refresh-cw': RefreshCw,
  'ban': Ban,
  'pin-off': PinOff,
  'bug': Bug,
  'smile-plus': SmilePlus,
};

const defaultAttributes: SVGProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.5,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

function escapeAttr(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderAttrs(attrs: SVGProps): string {
  let result = '';
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value !== undefined) {
      result += ` ${key}="${escapeAttr(value)}"`;
    }
  }
  return result;
}

function renderChildren(node: IconNode): string {
  let result = '';
  for (const [tag, attrs] of node) {
    result += `<${tag}${renderAttrs(attrs)} />`;
  }
  return result;
}

export function iconSvg(name: IconName, opts: IconOpts = {}): string {
  const icon = iconMap[name];
  if (!icon) return '';
  const w = opts.width ?? 24;
  const h = opts.height ?? 24;
  const sw = opts.strokeWidth ?? 1.5;
  const attrs: SVGProps = {
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
