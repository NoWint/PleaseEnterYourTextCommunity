import { iconSvg, type IconName } from './icon.js';
import { showToast } from '../toast.js';
import { escapeHtml } from './escape.js';
import { createInlineInput } from './inlineInput.js';
import { showInlineConfirm } from './inlineConfirm.js';

/**
 * 统一 UI 组件库 — 所有界面组件从这里创建,形态与动画全局一致。
 * 样式见 styles.css「=== UI 组件库 ===」。
 */

// core Contact::get_color() 返回 u32 → #rrggbb;空值回退主题边框色
export function colorHex(c: number | null | undefined): string {
  if (c == null) return 'var(--border-strong)';
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

// ── 按钮 ──────────────────────────────────────────────
export interface ButtonOpts {
  label?: string;
  icon?: IconName;
  variant?: 'primary' | 'ghost' | 'danger';
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void | Promise<void>;
}
export function button(opts: ButtonOpts): HTMLButtonElement {
  const el = document.createElement('button');
  const size = opts.size ? ` ui-button-${opts.size}` : '';
  el.className = `ui-button${opts.variant ? ` ui-button-${opts.variant}` : ''}${opts.danger ? ' ui-button-danger' : ''}${size}`;
  if (opts.icon) {
    const px = opts.size === 'sm' ? 12 : opts.size === 'lg' ? 16 : 14;
    el.insertAdjacentHTML('afterbegin', iconSvg(opts.icon, { width: px, height: px }));
  }
  if (opts.label) el.appendChild(document.createTextNode(opts.label));
  if (opts.title) el.title = opts.title;
  if (opts.disabled) el.disabled = true;
  if (opts.onClick) el.addEventListener('click', () => void opts.onClick!());
  return el;
}

export function iconButton(opts: { icon: IconName; title?: string; danger?: boolean; size?: 'sm' | 'md'; onClick?: () => void | Promise<void> }): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = `ui-icon-button${opts.danger ? ' ui-icon-button-danger' : ''}${opts.size ? ` ui-icon-button-${opts.size}` : ''}`;
  el.title = opts.title || '';
  el.insertAdjacentHTML('afterbegin', iconSvg(opts.icon, { width: 16, height: 16 }));
  el.addEventListener('click', () => void opts.onClick?.());
  return el;
}

// ── 输入控件 ──────────────────────────────────────────
export function input(opts: { placeholder?: string; value?: string; type?: string; onChange?: (v: string) => void; onEnter?: () => void }): HTMLInputElement {
  const el = document.createElement('input');
  el.className = 'ui-input';
  el.type = opts.type || 'text';
  el.placeholder = opts.placeholder || '';
  el.value = opts.value || '';
  el.addEventListener('input', () => opts.onChange?.(el.value));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') opts.onEnter?.(); });
  return el;
}

export function textarea(opts: { placeholder?: string; value?: string; rows?: number; onChange?: (v: string) => void }): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.className = 'ui-input ui-textarea';
  el.placeholder = opts.placeholder || '';
  el.value = opts.value || '';
  el.rows = opts.rows || 3;
  el.addEventListener('input', () => opts.onChange?.(el.value));
  return el;
}

export function select(opts: { options: Array<{ value: string; label: string }>; value?: string; onChange?: (v: string) => void }): HTMLSelectElement {
  const el = document.createElement('select');
  el.className = 'ui-select';
  for (const o of opts.options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    el.appendChild(opt);
  }
  el.value = opts.value || opts.options[0]?.value || '';
  el.addEventListener('change', () => opts.onChange?.(el.value));
  return el;
}

export function field(opts: { label: string; children: HTMLElement; help?: string }): HTMLLabelElement {
  const el = document.createElement('label');
  el.className = 'ui-field';
  el.innerHTML = `<span class="ui-field-label">${escapeHtml(opts.label)}</span>`;
  el.appendChild(opts.children);
  if (opts.help) el.insertAdjacentHTML('beforeend', `<span class="ui-field-help">${escapeHtml(opts.help)}</span>`);
  return el;
}

export function label(opts: { text: string; htmlFor?: string }): HTMLLabelElement {
  const el = document.createElement('label');
  el.className = 'ui-label';
  if (opts.htmlFor) el.htmlFor = opts.htmlFor;
  el.textContent = opts.text;
  return el;
}

export function switch_(opts: { checked?: boolean; onChange?: (v: boolean) => void; disabled?: boolean }): HTMLElement {
  const el = document.createElement('label');
  el.className = 'ui-switch';
  el.innerHTML = `<input type="checkbox" ${opts.checked ? 'checked' : ''} ${opts.disabled ? 'disabled' : ''}><span class="ui-switch-slider"></span>`;
  el.querySelector('input')!.addEventListener('change', () => opts.onChange?.(el.querySelector('input')!.checked));
  return el;
}

// ── 复选 / 分段 / 文件 ────────────────────────────────
export function checkbox(opts: { label?: string; checked?: boolean; disabled?: boolean; onChange?: (v: boolean) => void }): HTMLLabelElement {
  const el = document.createElement('label');
  el.className = 'ui-checkbox';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!opts.checked;
  if (opts.disabled) cb.disabled = true;
  cb.addEventListener('change', () => opts.onChange?.(cb.checked));
  el.appendChild(cb);
  if (opts.label) {
    const span = document.createElement('span');
    span.className = 'ui-checkbox-label';
    span.textContent = opts.label;
    el.appendChild(span);
  }
  return el;
}

export function segmented(opts: { items: Array<{ value: string; label: string }>; value?: string; onChange?: (v: string) => void }): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-segmented';
  for (const it of opts.items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ui-segment${it.value === opts.value ? ' active' : ''}`;
    b.dataset.value = it.value;
    b.textContent = it.label;
    b.addEventListener('click', () => {
      el.querySelectorAll('.ui-segment').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      opts.onChange?.(it.value);
    });
    el.appendChild(b);
  }
  return el;
}

export function file(opts: { accept?: string; multiple?: boolean; onChange?: (files: FileList | null) => void }): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'file';
  el.style.display = 'none';
  if (opts.accept) el.accept = opts.accept;
  if (opts.multiple) el.multiple = true;
  el.addEventListener('change', () => { opts.onChange?.(el.files); el.value = ''; });
  return el;
}

// ── 标签 / 徽章 / 头像 ────────────────────────────────
export function chip(opts: { label: string; icon?: IconName; active?: boolean; onClick?: () => void }): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = `ui-chip${opts.active ? ' active' : ''}`;
  if (opts.icon) el.insertAdjacentHTML('afterbegin', iconSvg(opts.icon, { width: 12, height: 12 }));
  el.appendChild(document.createTextNode(opts.label));
  el.addEventListener('click', () => opts.onClick?.());
  return el;
}

export function badge(opts: { text: string; variant?: 'default' | 'success' | 'danger' | 'muted' }): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `ui-badge${opts.variant ? ` ui-badge-${opts.variant}` : ''}`;
  el.textContent = opts.text;
  return el;
}

export function avatar(opts: { name?: string; url?: string; size?: number; color?: string | null }): HTMLElement {
  const size = opts.size || 32;
  const el = document.createElement('div');
  el.className = 'ui-avatar';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${Math.max(10, Math.round(size / 2.4))}px`;
  if (opts.url) {
    el.innerHTML = `<img src="${escapeHtml(opts.url)}" alt="" />`;
  } else {
    el.style.background = opts.color || 'var(--border-strong)';
    el.textContent = (opts.name || '?').charAt(0).toUpperCase();
  }
  return el;
}

// ── 卡片 / 列表 / 分割线 ──────────────────────────────
export function card(opts: { title?: string; children?: HTMLElement | string; actions?: HTMLElement[] }): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-card';
  if (opts.title || opts.actions) {
    const head = document.createElement('div');
    head.className = 'ui-card-head';
    if (opts.title) {
      const t = document.createElement('span');
      t.className = 'ui-card-title';
      t.textContent = opts.title;
      head.appendChild(t);
    }
    for (const a of opts.actions || []) head.appendChild(a);
    el.appendChild(head);
  }
  if (opts.children) {
    const body = document.createElement('div');
    body.className = 'ui-card-body';
    if (typeof opts.children === 'string') body.innerHTML = opts.children;
    else body.appendChild(opts.children);
    el.appendChild(body);
  }
  return el;
}

export function listItem(opts: { title: string; subtitle?: string; icon?: IconName; onClick?: () => void; danger?: boolean; trailing?: HTMLElement }): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `ui-list-item${opts.danger ? ' ui-list-item-danger' : ''}`;
  if (opts.icon) el.insertAdjacentHTML('afterbegin', iconSvg(opts.icon, { width: 16, height: 16 }));
  const meta = document.createElement('div');
  meta.className = 'ui-list-meta';
  meta.innerHTML = `<div class="ui-list-title">${escapeHtml(opts.title)}</div>${opts.subtitle ? `<div class="ui-list-sub">${escapeHtml(opts.subtitle)}</div>` : ''}`;
  el.appendChild(meta);
  if (opts.trailing) el.appendChild(opts.trailing);
  if (opts.onClick) el.addEventListener('click', () => opts.onClick!());
  return el;
}

export function divider(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-divider';
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
  body?: string;
  actions?: HTMLElement[];
  onClose?: () => void;
  /** 尺寸档位:sm 窄表单单选 / md 默认 / lg 内容密集(指纹/成员列表) */
  size?: 'sm' | 'md' | 'lg';
  /** 是否显示右上角 ✕ (默认 true) */
  closeable?: boolean;
}
export function dialog(opts: DialogOpts): { overlay: HTMLDivElement; close: () => void } {
  const ov = overlay();
  const sizeCls = opts.size === 'lg' ? ' ui-dialog-lg' : opts.size === 'sm' ? ' ui-dialog-sm' : '';
  ov.innerHTML = `
    <div class="ui-dialog${sizeCls}">
      <div class="ui-dialog-head">
        <h2>${escapeHtml(opts.title)}</h2>
        ${opts.closeable === true ? `<button class="ui-dialog-close" title="关闭">${iconSvg('x', { width: 14, height: 14 })}</button>` : ''}
      </div>
      ${opts.body ? `<div class="ui-dialog-body">${opts.body}</div>` : ''}
      <div class="ui-dialog-actions"></div>
    </div>
  `;
  const actions = ov.querySelector('.ui-dialog-actions')!;
  // 出场与入场对称:overlay 淡出 + dialog 缩回,120ms 后移除 (Apple §7 对称路径)
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    ov.classList.add('closing');
    setTimeout(() => { ov.remove(); opts.onClose?.(); }, 120);
  };
  // 无操作按钮 → 自动补「关闭」,保证弹窗始终有明确退出途径 (Apple §16 Wayfinding)
  if (!opts.actions || opts.actions.length === 0) {
    actions.appendChild(ui.button({ label: '关闭', variant: 'ghost', onClick: close }));
  } else {
    for (const a of opts.actions) actions.appendChild(a);
  }
  ov.querySelector<HTMLElement>('.ui-dialog-close')?.addEventListener('click', close);
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close();
  });
  return { overlay: ov, close };
}

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
  const inputEl = input({ placeholder: opts.placeholder, value: opts.value, type: opts.type });
  const cancel = button({ label: '取消', variant: 'ghost', onClick: () => { dlg.close(); opts.onCancel?.(); } });
  const confirm = button({
    label: opts.confirmLabel || '确定',
    variant: 'primary',
    onClick: async () => {
      const val = inputEl.value.trim();
      if (!val) return;
      dlg.close();
      try {
        await opts.onConfirm(val);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    },
  });
  const dlg = dialog({ title: opts.title, actions: [cancel, confirm] });
  // 输入框必须插到按钮组之前(dialog 的 DOM 顺序是 head → actions,
  // append 会把它追加到按钮组后面 → 按钮出现在输入框上方)
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(inputEl, actionsEl);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm.click(); });
  inputEl.focus();
}

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
    onClick: async () => { dlg.close(); try { await opts.onConfirm(); } catch { /* 调用方处理 */ } },
  });
  dlg.overlay.querySelector('.ui-dialog-actions')!.append(cancel, ok);
}

// ── 标签页 ────────────────────────────────────────────
export function tabs(opts: { items: Array<{ id: string; label: string; icon?: IconName }>; active: string; onChange: (id: string) => void }): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-tabs';
  for (const it of opts.items) {
    const t = document.createElement('button');
    t.className = `ui-tab${it.id === opts.active ? ' active' : ''}`;
    t.dataset.id = it.id;
    if (it.icon) t.insertAdjacentHTML('afterbegin', iconSvg(it.icon, { width: 14, height: 14 }));
    t.appendChild(document.createTextNode(it.label));
    t.addEventListener('click', () => opts.onChange(it.id));
    el.appendChild(t);
  }
  return el;
}

// ── 下拉菜单 ──────────────────────────────────────────
export interface MenuItem {
  label?: string;
  icon?: IconName;
  danger?: boolean;
  action?: () => void | Promise<void>;
  /** 渲染为分组分隔线,忽略 label/action */
  separator?: boolean;
}
export interface MenuOpts {
  /** 关闭方式:'click' 外部点击关闭(默认);'hover' 额外在鼠标离开菜单时关闭(dropdown.ts 行为) */
  closeOn?: 'click' | 'hover';
  /** 同 anchor 再次触发时关闭已开菜单(toggle) */
  toggle?: boolean;
  /** 菜单关闭后回调 */
  onClose?: () => void;
}
let activeMenuHide: (() => void) | null = null;
let activeMenuAnchor: HTMLElement | null = null;
export function menu(anchor: HTMLElement, items: MenuItem[], position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' = 'bottom-left', opts?: MenuOpts): void {
  const closeOn = opts?.closeOn ?? 'click';
  if (opts?.toggle && activeMenuAnchor === anchor) {
    activeMenuHide?.();
    return;
  }
  activeMenuHide?.();
  activeMenuAnchor = anchor;
  document.querySelectorAll('.ui-menu').forEach((m) => m.remove());
  const el = document.createElement('div');
  el.className = 'ui-menu';
  el.innerHTML = items.map((it, i) => it.separator
    ? `<div class="ui-menu-sep"></div>`
    : `<button class="ui-menu-item${it.danger ? ' ui-menu-item-danger' : ''}" data-i="${i}">
      ${it.icon ? iconSvg(it.icon, { width: 15, height: 15 }) : ''}
      <span>${escapeHtml(it.label ?? '')}</span>
    </button>`).join('');
  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  el.style.position = 'fixed';
  if (position.startsWith('bottom')) el.style.top = `${rect.bottom + 6}px`;
  else el.style.top = `${rect.top - el.offsetHeight - 6}px`;
  if (position.endsWith('right')) el.style.right = `${window.innerWidth - rect.right}px`;
  else el.style.left = `${rect.left}px`;
  el.style.zIndex = '200';
  // 入场 transform-origin 锚定触发方向 (与 dropdown.ts 一致:材料从触发点浮现)
  const originMap: Record<string, string> = {
    'bottom-left': 'top left',
    'bottom-right': 'top right',
    'top-left': 'bottom left',
    'top-right': 'bottom right',
  };
  el.style.transformOrigin = originMap[position] ?? 'top left';

  let closing = false;
  const hide = (): void => {
    if (closing) return;
    closing = true;
    if (activeMenuHide === hide) activeMenuHide = null;
    if (activeMenuAnchor === anchor) activeMenuAnchor = null;
    el.classList.add('closing');
    setTimeout(() => {
      el.remove();
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', onEsc);
      el.removeEventListener('mouseleave', onLeave);
      opts?.onClose?.();
    }, 120);
  };
  activeMenuHide = hide;
  el.querySelectorAll<HTMLButtonElement>('.ui-menu-item').forEach((b) => {
    b.addEventListener('click', () => {
      const it = items[Number(b.dataset.i)];
      hide();
      void it.action?.();
    });
  });
  const outside = (e: MouseEvent): void => {
    if (!el.contains(e.target as Node) && e.target !== anchor) hide();
  };
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') hide();
  };
  const onLeave = (): void => hide();
  if (closeOn === 'hover') el.addEventListener('mouseleave', onLeave);
  setTimeout(() => {
    document.addEventListener('click', outside);
    document.addEventListener('keydown', onEsc);
  }, 0);
}

// ── 搜索框 ────────────────────────────────────────────
export function search(opts: { placeholder?: string; value?: string; onChange?: (v: string) => void }): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-search';
  el.innerHTML = iconSvg('search', { width: 14, height: 14 });
  const inp = document.createElement('input');
  inp.className = 'ui-search-input';
  inp.placeholder = opts.placeholder || '搜索…';
  inp.value = opts.value || '';
  inp.addEventListener('input', () => opts.onChange?.(inp.value));
  el.appendChild(inp);
  return el;
}

// ── 加载 / 空状态 ─────────────────────────────────────
export function spinner(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-spinner';
  return el;
}

export function empty(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'ui-empty';
  el.textContent = text;
  return el;
}

export function toast(msg: string): void {
  showToast(msg);
}

/** 聚合导出 */
export const ui = {
  button, iconButton,
  input, textarea, select, field, label, switch_, checkbox, segmented, file,
  chip, badge, avatar,
  card, listItem, divider,
  overlay, dialog, inputDialog, confirm,
  tabs, menu, search,
  spinner, empty, toast,
  inlineInput: createInlineInput,
  inlineConfirm: showInlineConfirm,
};
export default ui;
