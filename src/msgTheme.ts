// QQ 式「消息主题」:发送者账号的配置,随 [PEYT] 信封 payload.theme 跨设备/跨用户传输。
// 职责:
//   - 内置主题库(BUILTIN_MSG_THEMES),设置页选择器按此渲染
//   - 自定义主题编辑器(id='custom',字段全自由填写),与内置主题同一套 MsgTheme 结构
//   - 按发送者缓存主题(from_id → MsgTheme),渲染时统一应用(QQ 语义:该用户所有消息用其最新主题)
//   - msgThemeAttrs 生成气泡的 data-msg-theme 属性 + CSS 变量(--mt-*)内联样式
//   - 设置页 get_msg_theme / set_msg_theme 读写

import { call } from './api.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { ui } from './components/ui.js';
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
    id: 'serif', label: '衬线体',
    font_family: "'Songti SC','SimSun','STSong','Noto Serif CJK SC','Source Han Serif SC','Georgia','Times New Roman',serif",
    text_color: '#b8a88a',
    swatch: '#b8a88a',
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

// ── 自定义主题 ────────────────────────────────────────────────────────
export const CUSTOM_THEME_ID = 'custom';

export interface FontPreset {
  label: string;
  /** font-family 值;'' 表示跟随应用默认 */
  value: string;
}

export const FONT_PRESETS: FontPreset[] = [
  { label: '跟随应用', value: '' },
  { label: '系统圆体', value: "'PingFang SC','Hiragino Sans GB','Heiti SC',sans-serif" },
  { label: '手写体', value: "'Kaiti SC','KaiTi','STKaiti','楷体',cursive" },
  { label: '衬线体', value: "'Songti SC','SimSun','STSong','Noto Serif CJK SC','Georgia','Times New Roman',serif" },
  { label: '等宽像素', value: "'SF Mono','Menlo','Consolas',monospace" },
  { label: '粗黑', value: "'PingFang SC','Hiragino Sans GB',sans-serif" },
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

// 把主题写入后端 + 更新自己发送者的缓存 + 就地更新当前聊天里自己的气泡。
async function applyMsgTheme(theme: MsgTheme | null): Promise<void> {
  const selfId = state.self?.id ?? -1;
  await call('set_msg_theme', { config: theme });
  if (theme) registerSenderTheme(selfId, theme);
  else senderThemes.delete(selfId);
  applyRenderedThemeForSelf(theme);
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
export function msgThemePreviewStyle(theme: MsgTheme): string {
  const bg = theme.bubble_bg || 'var(--surface-layer-01)';
  const fg = theme.bubble_text_color || theme.text_color || 'var(--text-body)';
  const radius = theme.radius != null ? `${theme.radius}px` : 'var(--bubble-radius)';
  const font = theme.font_family ? `font-family:${theme.font_family}` : '';
  const weight = theme.bold ? 'font-weight:700' : '';
  const ital = theme.italic ? 'font-style:italic' : '';
  return `background:${bg};color:${fg};border-radius:${radius};${font};${weight};${ital}`;
}

// ── 自定义主题编辑器 ────────────────────────────────────────────────
// 打开弹窗编辑自定义主题。onSave(theme) 保存(theme=null 表示恢复默认)。
export function openCustomThemeEditor(opts: {
  theme: MsgTheme | null;
  onSave: (theme: MsgTheme | null) => void | Promise<void>;
}): void {
  const cur = opts.theme && opts.theme.id === CUSTOM_THEME_ID ? opts.theme : null;
  const hexVal = (v: string | undefined, fb: string) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fb);

  // ── 预览 ──
  const preview = document.createElement('div');
  preview.className = 'msg-theme-editor-preview';
  preview.innerHTML = `<span class="msg-theme-editor-bubble">Aa 预览</span>`;

  // ── 字体 ──
  const presetHit = cur?.font_family && FONT_PRESETS.some((p) => p.value && p.value === cur.font_family)
    ? cur.font_family
    : cur?.font_family
      ? '__custom__'
      : '';
  const fontSel = ui.select({
    options: [
      ...FONT_PRESETS.map((p) => ({ value: p.value, label: p.label })),
      { value: '__custom__', label: '自定义…' },
    ],
    value: presetHit || '',
    onChange: () => {
      fontInput.style.display = fontSel.value === '__custom__' ? '' : 'none';
      update();
    },
  });
  const fontInput = ui.input({
    placeholder: "font-family,如 'Georgia', serif",
    value: cur?.font_family && !FONT_PRESETS.some((p) => p.value && p.value === cur!.font_family) ? cur.font_family : '',
  });
  fontInput.style.display = fontSel.value === '__custom__' ? '' : 'none';
  fontInput.addEventListener('input', update);

  // ── 字色(同时作用于正文与气泡内文字) ──
  const colorInput = ui.input({
    type: 'color',
    value: hexVal(cur?.text_color ?? cur?.bubble_text_color, '#888888'),
  });
  colorInput.addEventListener('input', update);

  // ── 气泡背景(color 纯色 + 文本支持渐变) ──
  const bgText = ui.input({
    value: cur?.bubble_bg && /^(#|linear-gradient|radial-gradient|conic-gradient)/i.test(cur.bubble_bg) ? cur.bubble_bg : '',
    placeholder: '#hex 或 linear-gradient(...)',
  });
  bgText.addEventListener('input', update);
  const bgColor = ui.input({ type: 'color', value: hexVal(cur?.bubble_bg, '#888888') });
  bgColor.addEventListener('input', () => {
    bgText.value = bgColor.value;
    update();
  });

  // ── 圆角 ──
  const radiusInput = document.createElement('input');
  radiusInput.type = 'range';
  radiusInput.min = '0';
  radiusInput.max = '24';
  radiusInput.step = '1';
  radiusInput.value = String(cur?.radius ?? 12);
  radiusInput.addEventListener('input', update);
  const radiusVal = document.createElement('span');
  radiusVal.className = 'msg-theme-editor-radius-val';

  // ── 粗体 / 斜体 ──
  let boldOn = !!cur?.bold;
  let italicOn = !!cur?.italic;
  const boldSwitch = ui.switch_({ checked: boldOn, onChange: (v) => { boldOn = v; update(); } });
  const italicSwitch = ui.switch_({ checked: italicOn, onChange: (v) => { italicOn = v; update(); } });

  // 汇总当前控件状态 → MsgTheme(只填有值的字段,保证信封小体积)
  function build(): MsgTheme {
    const t: MsgTheme = { id: CUSTOM_THEME_ID };
    const font = fontSel.value === '__custom__' ? fontInput.value.trim() : fontSel.value;
    if (font) t.font_family = font;
    if (colorInput.value) t.text_color = colorInput.value;
    const bg = bgText.value.trim();
    if (bg) t.bubble_bg = bg;
    const r = Number(radiusInput.value);
    if (!Number.isNaN(r)) t.radius = r;
    if (boldOn) t.bold = true;
    if (italicOn) t.italic = true;
    return t;
  }

  function update(): void {
    const bubble = preview.querySelector<HTMLElement>('.msg-theme-editor-bubble');
    if (bubble) bubble.style.cssText = msgThemePreviewStyle(build());
    radiusVal.textContent = `${radiusInput.value}px`;
  }
  update();

  // ── 弹窗 ──
  const saveBtn = ui.button({
    label: '保存',
    variant: 'primary',
    onClick: async () => {
      try {
        await opts.onSave(build());
        dlg.close();
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    },
  });
  const resetBtn = ui.button({
    label: '恢复默认',
    variant: 'ghost',
    onClick: async () => {
      try {
        await opts.onSave(null);
        dlg.close();
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const dlg = ui.dialog({
    title: '自定义消息主题',
    body: '<div></div>',
    size: 'md',
    closeable: false,
    autoCloseButton: false,
    actions: [resetBtn, saveBtn],
  });
  const bodyEl = dlg.overlay.querySelector<HTMLElement>('.ui-dialog-body');
  if (!bodyEl) return;

  const wrap = document.createElement('div');
  wrap.className = 'msg-theme-editor';
  wrap.appendChild(preview);
  wrap.appendChild(ui.field({ label: '字体', children: fontSel, help: '选「自定义」可输入任意 font-family' }));
  wrap.appendChild(ui.field({ label: '', children: fontInput }));
  wrap.appendChild(ui.field({ label: '文字颜色', children: colorInput }));
  const bgRow = document.createElement('div');
  bgRow.className = 'msg-theme-editor-row';
  bgRow.append(bgText, bgColor);
  wrap.appendChild(ui.field({ label: '气泡背景', children: bgRow, help: '支持纯色 #hex 或渐变 linear-gradient(...)' }));
  const radiusRow = document.createElement('div');
  radiusRow.className = 'msg-theme-editor-row';
  radiusRow.append(radiusInput, radiusVal);
  wrap.appendChild(ui.field({ label: '气泡圆角', children: radiusRow }));
  wrap.appendChild(ui.field({ label: '粗体', children: boldSwitch }));
  wrap.appendChild(ui.field({ label: '斜体', children: italicSwitch }));
  bodyEl.appendChild(wrap);
}

// ── 设置页选择器 ─────────────────────────────────────────────────────
// 渲染内置主题网格 + 自定义入口,点击选中并写入后端 get/set_msg_theme。
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
        await applyMsgTheme(def.id === 'default' ? null : toThemeDto(def));
        grid.querySelectorAll('.settings-msg-theme').forEach((e) => e.classList.remove('active'));
        card.classList.add('active');
        showToast(`消息主题已切换:${def.label}`);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    });
    grid.appendChild(card);
  }

  // 自定义入口
  const customCard = document.createElement('button');
  customCard.type = 'button';
  customCard.className = 'settings-msg-theme msg-theme-custom' + (currentId === CUSTOM_THEME_ID ? ' active' : '');
  customCard.dataset.themeId = CUSTOM_THEME_ID;
  customCard.setAttribute('aria-label', '自定义');
  const customPreview: MsgTheme = currentId === CUSTOM_THEME_ID ? current! : { id: CUSTOM_THEME_ID };
  customCard.innerHTML = `
    <span class="msg-theme-preview">
      <span class="msg-theme-preview-bubble" style="${msgThemePreviewStyle(customPreview)}">Aa</span>
    </span>
    <span class="msg-theme-name">自定义</span>
  `;
  customCard.addEventListener('click', () => {
    openCustomThemeEditor({
      theme: current,
      onSave: async (t) => {
        try {
          await applyMsgTheme(t);
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
          return;
        }
        showToast(t ? '自定义主题已保存' : '已恢复默认主题');
        await renderMsgThemePicker(container);
      },
    });
  });
  grid.appendChild(customCard);

  container.appendChild(grid);
}
