export type ThemeName =
  | 'nowint'
  | 'violet'
  | 'goldenhour'
  | 'forest'
  | 'midnight'
  | 'ember'
  | 'graphite'
  | 'paper'
  | 'frost'
  | 'sage'
  | 'blush'
  | 'brutal'
  | 'crt'
  | 'toon';

export type AnyTheme = ThemeName | string;

/** 内置主题元数据 — 设置页外观选择器的唯一数据源 (swatch 为 CSS 渐变色串)。 */
export interface BuiltinTheme {
  id: string;
  label: string;
  swatch: string;
  preview?: string;
}

export const BUILTIN_THEMES: BuiltinTheme[] = [
  { id: 'nowint', label: 'Nowint', swatch: 'linear-gradient(135deg,#0d0d0d,#1a1a1a)' },
  { id: 'violet', label: 'Violet', swatch: 'linear-gradient(135deg,#1a0d2e,#6b3fa0)' },
  { id: 'goldenhour', label: 'GoldenHour', swatch: 'linear-gradient(135deg,#2e1a0d,#d4a043)' },
  { id: 'forest', label: 'Forest', swatch: 'linear-gradient(135deg,#0a2318,#2f9e6e)' },
  { id: 'midnight', label: 'Midnight', swatch: 'linear-gradient(135deg,#0a1630,#3f7bd9)' },
  { id: 'ember', label: 'Ember', swatch: 'linear-gradient(135deg,#230a12,#c23a4d)' },
  { id: 'graphite', label: 'Graphite', swatch: 'linear-gradient(135deg,#121419,#3f4a5c)' },
  { id: 'paper', label: 'Paper', swatch: 'linear-gradient(135deg,#f5efe6,#fbf7f0)' },
  { id: 'frost', label: 'Frost', swatch: 'linear-gradient(135deg,#eef3f8,#f7fafc)' },
  { id: 'sage', label: 'Sage', swatch: 'linear-gradient(135deg,#eef3ec,#f8faf4)' },
  { id: 'blush', label: 'Blush', swatch: 'linear-gradient(135deg,#f7eef1,#fcf8f9)' },
  { id: 'brutal', label: 'Brutalism', swatch: 'linear-gradient(135deg,#0d0d0d,#f5f5f5)', preview: 'border-radius:0;border:2px solid #111' },
  { id: 'crt', label: 'CRT', swatch: 'linear-gradient(135deg,#0a0e0a,#33ff66)', preview: 'border-radius:2px;box-shadow:0 0 10px rgba(51,255,102,.5)' },
  { id: 'toon', label: 'Toon', swatch: 'linear-gradient(135deg,#FFE156,#ff4fd8)', preview: 'border-radius:16px;box-shadow:0 4px 0 rgba(0,0,0,.35)' },
];

export function getCurrentTheme(): AnyTheme {
  return localStorage.getItem('peyt.theme') || 'nowint';
}

export function applyTheme(theme: AnyTheme): void {
  localStorage.setItem('peyt.theme', theme);
  const el = document.documentElement;
  if (theme === 'nowint') {
    el.removeAttribute('data-theme');
  } else {
    el.setAttribute('data-theme', theme);
  }
}

export function initTheme(): void {
  applyTheme(getCurrentTheme());
}

// ── 全局字体缩放 ──────────────────────────────────────
// 通过 <html data-font-scale="sm|md|lg|xl"> 覆盖 :root 的 --font-scale-* 变量。
// md 为默认(不设属性),其余级别在 styles.css 的 html[data-font-scale] 块中定义。

export type FontScale = 'sm' | 'md' | 'lg' | 'xl';

export interface FontScaleOption {
  id: FontScale;
  label: string;
}

export const FONT_SCALES: FontScaleOption[] = [
  { id: 'sm', label: '紧凑' },
  { id: 'md', label: '默认' },
  { id: 'lg', label: '大' },
  { id: 'xl', label: '特大' },
];

export function getCurrentFontScale(): FontScale {
  const v = localStorage.getItem('peyt.fontScale');
  return v === 'sm' || v === 'lg' || v === 'xl' ? v : 'md';
}

export function applyFontScale(scale: FontScale): void {
  localStorage.setItem('peyt.fontScale', scale);
  const el = document.documentElement;
  if (scale === 'md') {
    el.removeAttribute('data-font-scale');
  } else {
    el.setAttribute('data-font-scale', scale);
  }
}

export function initFontScale(): void {
  applyFontScale(getCurrentFontScale());
}
