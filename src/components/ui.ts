import { iconSvg, type IconName } from './icon.js';
import { showToast as toast } from '../toast.js';

/**
 * 统一 UI 组件库 — 所有界面组件从这里创建,形态与动画全局一致。
 * 样式见 styles.css「=== UI 组件库 ===」。
 */

// ── 按钮 ──────────────────────────────────────────────
export interface ButtonOpts {
  label?: string;
  icon?: IconName;
  variant?: 'primary' | 'ghost' | 'danger';
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void | Promise<void>;
}
export function button(opts: ButtonOpts): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = `ui-button${opts.variant ? ` ui-button-${opts.variant}` : ''}${opts.danger ? ' ui-button-danger' : ''}`;
  if (opts.icon) el.insertAdjacentHTML('afterbegin', iconSvg(opts.icon, { width: 14, height: 14 }));
  if (opts.label) el.appendChild(document.createTextNode(opts.label));
  if (opts.title) el.title = opts.title;
  if (opts.disabled) el.disabled = true;
  if (opts.onClick) el.addEventListener('click', () => void opts.onClick!());
  return el;
}

export function iconButton(opts: { icon: IconName; title?: string; danger?: boolean; onClick?: () => void | Promise<void> }): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = `ui-icon-button${opts.danger ? ' ui-icon-button-danger' : ''}`;
  el.title = opts.title || '';
  el.insertAdjacentHTML('afterbegin', iconSvg(opts.icon, { width: 16, height: 16 }));
  el.addEventListener('click', () => void opts.onClick?.());
  return el;
}

// ── 遮罩 / 弹窗 ───────────────────────────────────────
export function overlay(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-overlay';
  document.body.appendChild(el);
  return el;
}

export interface DialogOpts {
  title: string;
  /** 可为 HTML 字符串 */
  body?: string;
  /** 底部动作按钮 */
  actions?: HTMLElement[];
  onClose?: () => void;
}
export function dialog(opts: DialogOpts): { overlay: HTMLDivElement; close: () => void } {
  const ov = overlay();
  ov.innerHTML = `
    <div class="ui-dialog">
      <h2>${escapeHtml(opts.title)}</h2>
      ${opts.body ? `<div class="ui-dialog-body">${opts.body}</div>` : ''}
      <div class="ui-dialog-actions"></div>
    </div>
  `;
  const actions = ov.querySelector('.ui-dialog-actions')!;
  for (const a of opts.actions || []) actions.appendChild(a);
  const close = (): void => ov.remove();
  ov.addEventListener('click', (e) => {
    if (e.target === ov) {
      close();
      opts.onClose?.();
    }
  });
  return { overlay: ov, close };
}

// ── 输入弹窗（标题 + 输入 + 确认）────────────────────
export interface InputDialogOpts {
  title: string;
  placeholder?: string;
  confirmLabel?: string;
  value?: string;
  type?: string;
  onConfirm: (value: string) => Promise<void> | void;
  onCancel?: () => void;
}
export function inputDialog(opts: InputDialogOpts): void {
  const input = document.createElement('input');
  input.className = 'ui-input';
  input.type = opts.type || 'text';
  input.placeholder = opts.placeholder || '';
  input.value = opts.value || '';

  const cancel = button({ label: '取消', variant: 'ghost', onClick: () => { dlg.close(); opts.onCancel?.(); } });
  const confirm = button({
    label: opts.confirmLabel || '确定',
    variant: 'primary',
    onClick: async () => {
      const val = input.value.trim();
      if (!val) return;
      dlg.close();
      try {
        await opts.onConfirm(val);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const dlg = dialog({ title: opts.title, actions: [cancel, confirm] });
  dlg.overlay.querySelector('.ui-dialog')!.append(input);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm.click(); });
  input.focus();
}

// ── 确认弹窗 ──────────────────────────────────────────
export function confirm(opts: { title?: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void> }): void {
  const dlg = dialog({
    title: opts.title || '确认',
    body: `<div class="ui-confirm-msg">${escapeHtml(opts.message)}</div>`,
    actions: [],
  });
  const cancel = button({ label: '取消', variant: 'ghost', onClick: () => dlg.close() });
  const ok = button({
    label: opts.confirmLabel || '确认',
    variant: 'primary',
    danger: opts.danger,
    onClick: async () => {
      dlg.close();
      try {
        await opts.onConfirm();
      } catch { /* 调用方处理 */ }
    },
  });
  dlg.overlay.querySelector('.ui-dialog-actions')!.append(cancel, ok);
}

// ── 加载指示 ──────────────────────────────────────────
export function spinner(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-spinner';
  return el;
}

// ── 空状态 ────────────────────────────────────────────
export function empty(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-empty';
  el.textContent = text;
  return el;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}

/** 聚合导出 */
export const ui = { button, iconButton, overlay, dialog, inputDialog, confirm, spinner, empty };
export default ui;
