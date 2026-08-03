import { showToast } from '../toast.js';
import { escapeHtml } from '../components/escape.js';

/**
 * Lightweight floating confirm for small icon buttons (delete/uninstall).
 * Does not replace the anchor element, so listeners survive cancellation.
 */
// 记录当前打开确认卡片的触发按钮,用于同按钮再次点击时 toggle 关闭
let openCardAnchor: HTMLElement | null = null;

export function showPluginConfirm(
  anchor: HTMLElement,
  message: string,
  onConfirm: () => Promise<void> | void,
): void {
  // 再次点击同一触发按钮:关闭已打开的确认卡片 (toggle)
  const existing = document.querySelector<HTMLElement>('.plugin-confirm');
  if (existing && openCardAnchor === anchor) {
    existing.classList.add('closing');
    setTimeout(() => existing.remove(), 120);
    openCardAnchor = null;
    return;
  }

  // Remove any existing confirm card
  document.querySelectorAll('.plugin-confirm').forEach((e) => e.remove());
  openCardAnchor = anchor;

  const card = document.createElement('div');
  card.className = 'plugin-confirm';
  card.innerHTML = `
    <span class="plugin-confirm-msg">${escapeHtml(message)}</span>
    <div class="plugin-confirm-actions">
      <button class="plugin-confirm-yes">确认</button>
      <button class="plugin-confirm-no">取消</button>
    </div>
  `;
  document.body.appendChild(card);

  // Position just below the anchor, right-aligned to it
  const rect = anchor.getBoundingClientRect();
  card.style.top = `${rect.bottom + 6}px`;
  card.style.right = `${window.innerWidth - rect.right}px`;

  const close = (): void => {
    if (openCardAnchor === anchor) openCardAnchor = null;
    card.classList.add('closing');
    setTimeout(() => card.remove(), 120);
    document.removeEventListener('click', outside);
  };
  const outside = (e: MouseEvent): void => {
    if (!card.contains(e.target as Node)) close();
  };
  setTimeout(() => document.addEventListener('click', outside), 0);

  // 鼠标移开确认卡片时关闭
  card.addEventListener('mouseleave', close);

  card.querySelector('.plugin-confirm-yes')!.addEventListener('click', async () => {
    close();
    try {
      await onConfirm();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  });
  card.querySelector('.plugin-confirm-no')!.addEventListener('click', close);
}

