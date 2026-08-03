import { iconSvg, type IconName } from './icon.js';
import { escapeHtml, escapeAttr } from './escape.js';

export interface DropdownItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  action: () => void;
}

export interface DropdownOpts {
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  onClose?: () => void;
}

let currentDropdown: HTMLElement | null = null;
let currentAnchor: HTMLElement | null = null;
let closeOnOutsideHandler: ((e: MouseEvent) => void) | null = null;
let closeOnEscHandler: ((e: KeyboardEvent) => void) | null = null;
let currentOnClose: (() => void) | null = null;

export function showDropdown(anchor: HTMLElement, items: DropdownItem[], opts: DropdownOpts = {}): void {
  // 再次点击同一触发按钮:关闭已打开的菜单 (toggle),而非重开
  if (currentDropdown && currentAnchor === anchor) {
    hideDropdown();
    return;
  }
  hideDropdown();
  currentAnchor = anchor;
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';
  menu.innerHTML = items.map((item) => {
    const iconHtml = item.icon ? iconSvg(item.icon, { width: 16, height: 16 }) : '';
    const dangerCls = item.danger ? ' danger' : '';
    return `<div class="dropdown-item${dangerCls}" data-label="${escapeAttr(item.label)}">${iconHtml}<span>${escapeHtml(item.label)}</span></div>`;
  }).join('');
  document.body.appendChild(menu);
  currentDropdown = menu;
  currentOnClose = opts.onClose ?? null;

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const pos = opts.position ?? 'bottom-left';
  if (pos.includes('bottom')) {
    menu.style.top = `${rect.bottom + 4}px`;
  } else {
    menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  }
  if (pos.includes('left')) {
    menu.style.left = `${rect.left}px`;
  } else {
    menu.style.left = `${rect.right - menuRect.width}px`;
  }
  // 入场 transform-origin 锚定触发方向 (材料从触发点浮现)
  const originMap: Record<string, string> = {
    'bottom-left': 'top left',
    'bottom-right': 'top right',
    'top-left': 'bottom left',
    'top-right': 'bottom right',
  };
  menu.style.transformOrigin = originMap[pos] ?? 'top left';

  menu.querySelectorAll<HTMLElement>('.dropdown-item').forEach((el, i) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = items[i];
      hideDropdown();
      item.action();
    });
  });

  // 鼠标移开菜单(含二级弹窗内容)时关闭 — 用户停留在菜单内不关,离开即关
  menu.addEventListener('mouseleave', () => hideDropdown());

  closeOnOutsideHandler = (e: MouseEvent) => {
    if (currentDropdown && !currentDropdown.contains(e.target as Node) && e.target !== anchor) {
      hideDropdown();
    }
  };
  closeOnEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hideDropdown();
  };

  setTimeout(() => {
    if (closeOnOutsideHandler) document.addEventListener('click', closeOnOutsideHandler);
    if (closeOnEscHandler) document.addEventListener('keydown', closeOnEscHandler);
  }, 0);
}

export function hideDropdown(): void {
  if (currentDropdown) {
    const menu = currentDropdown;
    currentDropdown = null;
    currentAnchor = null;
    // 出场:加 .closing 触发 pop-out 动画后延时移除
    menu.classList.add('closing');
    setTimeout(() => menu.remove(), 120);
  }
  if (closeOnOutsideHandler) {
    document.removeEventListener('click', closeOnOutsideHandler);
    closeOnOutsideHandler = null;
  }
  if (closeOnEscHandler) {
    document.removeEventListener('keydown', closeOnEscHandler);
    closeOnEscHandler = null;
  }
  if (currentOnClose) {
    const cb = currentOnClose;
    currentOnClose = null;
    cb();
  }
}

