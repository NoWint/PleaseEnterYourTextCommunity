import { escapeHtml, escapeAttr } from './escape.js';

export interface InlineInputOpts {
  placeholder: string;
  confirmLabel?: string;
  cancelLabel?: string;
  initialValue?: string;
  onConfirm: (value: string) => Promise<void> | void;
  onCancel?: () => void;
  extra?: string;
}

export function createInlineInput(opts: InlineInputOpts): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'inline-input-wrapper';
  const confirmLabel = opts.confirmLabel ?? '创建';
  const cancelLabel = opts.cancelLabel ?? '取消';
  wrapper.innerHTML = `
    <input type="text" class="inline-input" placeholder="${escapeAttr(opts.placeholder)}" value="${escapeAttr(opts.initialValue ?? '')}" />
    <div class="inline-input-actions">
      <button class="inline-input-confirm">${escapeHtml(confirmLabel)}</button>
      <button class="inline-input-cancel">${escapeHtml(cancelLabel)}</button>
    </div>
    ${opts.extra ? `<div class="inline-input-extra">${escapeHtml(opts.extra)}</div>` : ''}
  `;
  const input = wrapper.querySelector<HTMLInputElement>('.inline-input')!;
  const confirmBtn = wrapper.querySelector<HTMLButtonElement>('.inline-input-confirm')!;
  const cancelBtn = wrapper.querySelector<HTMLButtonElement>('.inline-input-cancel')!;

  setTimeout(() => input.focus(), 0);

  async function doConfirm(): Promise<void> {
    const val = input.value.trim();
    if (!val) return;
    confirmBtn.disabled = true;
    try {
      await opts.onConfirm(val);
    } catch {
      confirmBtn.disabled = false;
      input.classList.add('error');
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void doConfirm(); }
    else if (e.key === 'Escape') { opts.onCancel?.(); }
  });
  input.addEventListener('input', () => {
    input.classList.remove('error');
  });
  confirmBtn.addEventListener('click', () => void doConfirm());
  cancelBtn.addEventListener('click', () => opts.onCancel?.());

  return wrapper;
}

