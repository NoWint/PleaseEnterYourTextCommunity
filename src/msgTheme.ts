// QQ 式「消息主题」:发送者账号的配置,随 [PEYT] 信封 payload.theme 跨设备/跨用户传输。
// 职责:
//   - 内置主题库(BUILTIN_MSG_THEMES),设置页选择器按此渲染
//   - 按发送者缓存主题(from_id → MsgTheme),渲染时统一应用(QQ 语义:该用户所有消息用其最新主题)
//   - msgThemeAttrs 生成气泡的 data-msg-theme 属性 + CSS 变量(--mt-*)内联样式
//   - 设置页 get_msg_theme / set_msg_theme 读写

import { call } from './api.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { escapeHtml } from './components/escape.js';
import type { MsgTheme } from './types.js';

export interface MsgThemeDef extends MsgTheme {
  /** 设置页展示名 */
  label: string;
  /** 选择器卡片主色(预览用) */
  swatch: string;
}

export const BUILTIN_MSG_THEMES: MsgThemeDef[] = [
  { id: 'default', label: '默认', swatch: '#8e8e93' },
  {
    id: 'handwriting', label: '手写体',
    font_family: "'Kaiti SC','KaiTi','STKaiti','楷体',cursive",
    swatch: '#9a7bd8',
  },
  {
    id: 'pixel', label: '像素',
    font_family: "'SF Mono','Menlo','Consolas',monospace",
    text_color: '#4ade80',
    bubble_bg: '#1c1c1e',
    bubble_text_color: '#4ade80',
    radius: 2,
    swatch: '#4ade80',
  },
  {
    id: 'sunset', label: '落日',
    bubble_bg: 'linear-gradient(135deg,#ff7e5f,#feb47b)',
    bubble_text_color: '#ffffff',
    radius: 14,
    swatch: '#ff7e5f',
  },
  {
    id: 'ocean', label: '海洋',
    bubble_bg: 'linear-gradient(135deg,#2193b0,#6dd5ed)',
    bubble_text_color: '#ffffff',
    radius: 14,
    swatch: '#2193b0',
  },
  {
    id: 'mint', label: '薄荷',
    bubble_bg: 'linear-gradient(135deg,#a8e6cf,#d4edda)',
    bubble_text_color: '#1f3d2b',
    radius: 12,
    swatch: '#a8e6cf',
  },
  {
    id: 'graphite', label: '炭黑',
    bubble_bg: '#2c2c2e',
    bubble_text_color: '#f5f5f7',
    radius: 12,
    swatch: '#2c2c2e',
  },
  {
    id: 'sakura', label: '樱粉',
    bubble_bg: 'linear-gradient(135deg,#ffc3a0,#ffafbd)',
    bubble_text_color: '#5a2a35',
    radius: 14,
    swatch: '#ffc3a0',
  },
];

// ── 按发送者缓存(from_id → 最新主题) ────────────────────────────────
// 模块级,跨会话/跨渲染持久;切换账号时清空(不同账号的 from_id 会冲突)。
const senderThemes = new Map<number, MsgTheme>();

export function registerSenderTheme(fromId: number | null | undefined, theme: MsgTheme): void {
  if (fromId == null) return;
  senderThemes.set(fromId, theme);
}

export function themeForSender(fromId: number | null | undefined): MsgTheme | null {
  if (fromId == null) return null;
  return senderThemes.get(fromId) ?? null;
}

export function clearSenderThemes(): void {
  senderThemes.clear();
}

// 启动时把当前账号配置的主题预填到发送者缓存:
// 让乐观消息(发送中的临时气泡)与首条回显消息立即按主题渲染,无需等信封回传。
export async function seedSelfMsgTheme(): Promise<void> {
  try {
    const theme = await call<MsgTheme | null>('get_msg_theme');
    if (theme && state.self) registerSenderTheme(state.self.id, theme);
  } catch {
    /* 未接后端(纯浏览器 preview)时静默跳过 */
  }
}

// ── 样式生成 ─────────────────────────────────────────────────────────
// 返回 { id, style }:id 用于气泡的 data-msg-theme 属性,null=默认不设;
// style 为 CSS 变量串(--mt-bg / --mt-color / --mt-radius / --mt-font / --mt-weight / --mt-style)。
// 网络主题(只带 id + 少量显式字段)与内置定义合并,显式字段优先。
export function msgThemeAttrs(theme: MsgTheme | null | undefined): { id: string | null; style: string } {
  if (!theme || theme.id === 'default') return { id: null, style: '' };
  const def = BUILTIN_MSG_THEMES.find((t) => t.id === theme.id);
  const merged: MsgTheme = { ...(def ?? {}), ...theme };
  const vars: string[] = [];
  if (merged.bubble_bg) vars.push(`--mt-bg:${merged.bubble_bg}`);
  const color = merged.bubble_text_color || merged.text_color;
  if (color) vars.push(`--mt-color:${color}`);
  if (typeof merged.radius === 'number') vars.push(`--mt-radius:${merged.radius}px`);
  if (merged.font_family) vars.push(`--mt-font:${merged.font_family}`);
  if (merged.bold) vars.push('--mt-weight:700');
  if (merged.italic) vars.push('--mt-style:italic');
  return { id: theme.id, style: vars.join(';') };
}

// 内置定义 → 网络 DTO(只带样式字段,去掉 label/swatch 展示字段)。
function toThemeDto(def: MsgThemeDef): MsgTheme {
  const dto: MsgTheme = { id: def.id };
  if (def.font_family) dto.font_family = def.font_family;
  if (def.text_color) dto.text_color = def.text_color;
  if (def.bubble_bg) dto.bubble_bg = def.bubble_bg;
  if (def.bubble_text_color) dto.bubble_text_color = def.bubble_text_color;
  if (def.radius != null) dto.radius = def.radius;
  if (def.bold != null) dto.bold = def.bold;
  if (def.italic != null) dto.italic = def.italic;
  return dto;
}

// 设置页切换主题后,就地更新当前聊天里自己发出的气泡(无需重渲染整屏)。
function applyRenderedThemeForSelf(theme: MsgTheme | null): void {
  const { id, style } = msgThemeAttrs(theme);
  document.querySelectorAll<HTMLElement>('.msg[data-is-out="1"] .msg-bubble').forEach((el) => {
    if (id) el.setAttribute('data-msg-theme', id);
    else el.removeAttribute('data-msg-theme');
    el.style.cssText = style;
  });
}

// 预览气泡内联样式:数据驱动,与真实气泡同一套字段。
function msgThemePreviewStyle(def: MsgThemeDef): string {
  const bg = def.bubble_bg || 'var(--surface-layer-01)';
  const fg = def.bubble_text_color || def.text_color || 'var(--text-body)';
  const radius = def.radius != null ? `${def.radius}px` : 'var(--bubble-radius)';
  const font = def.font_family ? `font-family:${def.font_family}` : '';
  const weight = def.bold ? 'font-weight:700' : '';
  const ital = def.italic ? 'font-style:italic' : '';
  return `background:${bg};color:${fg};border-radius:${radius};${font};${weight};${ital}`;
}

// ── 设置页选择器 ─────────────────────────────────────────────────────
// 渲染内置主题网格到 container,点击选中并写入后端 get/set_msg_theme。
export async function renderMsgThemePicker(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  let current: MsgTheme | null = null;
  try {
    current = await call<MsgTheme | null>('get_msg_theme');
  } catch {
    current = null;
  }
  const currentId = current?.id || 'default';
  const grid = document.createElement('div');
  grid.className = 'settings-msg-themes';
  for (const def of BUILTIN_MSG_THEMES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'settings-msg-theme' + (currentId === def.id ? ' active' : '');
    card.dataset.themeId = def.id;
    card.setAttribute('aria-label', def.label);
    card.innerHTML = `
      <span class="msg-theme-preview">
        <span class="msg-theme-preview-bubble" style="${msgThemePreviewStyle(def)}">Aa</span>
      </span>
      <span class="msg-theme-name">${escapeHtml(def.label)}</span>
    `;
    card.addEventListener('click', async () => {
      try {
        const selfId = state.self?.id ?? -1;
        if (def.id === 'default') {
          await call('set_msg_theme', { config: null });
          senderThemes.delete(selfId);
          applyRenderedThemeForSelf(null);
        } else {
          const dto = toThemeDto(def);
          await call('set_msg_theme', { config: dto });
          registerSenderTheme(selfId, dto);
          applyRenderedThemeForSelf(dto);
        }
        grid.querySelectorAll('.settings-msg-theme').forEach((e) => e.classList.remove('active'));
        card.classList.add('active');
        showToast(`消息主题已切换:${def.label}`);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    });
    grid.appendChild(card);
  }
  container.appendChild(grid);
}
