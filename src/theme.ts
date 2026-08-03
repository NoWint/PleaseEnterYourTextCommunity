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
  | 'blush';

export type AnyTheme = ThemeName | string;

/** 内置主题元数据 — 设置页外观选择器的唯一数据源 (swatch 为 CSS 渐变色串)。 */
export interface BuiltinTheme {
  id: string;
  label: string;
  swatch: string;
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
