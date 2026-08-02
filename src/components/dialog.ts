import { showToast } from '../toast.js';

/** 通用输入弹窗 — 标题 + 输入框 + 取消/确认。 */
export interface InputDialogOpts {
  title: string;
  placeholder?: string;
  confirmLabel?: string;
  value?: string;
  /** 输入框类型，如 'text' | 'email' */
  type?: string;
  onConfirm: (value: string) => Promise<void> | void;
  onCancel?: () => void;
}

export function showInputDialog(opts: InputDialogOpts): void {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="dialog">
      <h2>${escapeHtml(opts.title)}</h2>
      <input type="${opts.type || 'text'}"
        class="dialog-field"
        placeholder="${escapeHtml(opts.placeholder || '')}"
        value="${escapeHtml(opts.value || '')}" />
      <div class="dialog-actions">
        <button class="btn dialog-cancel">取消</button>
        <button class="btn btn-primary dialog-confirm">${escapeHtml(opts.confirmLabel || '确定')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>('.dialog-field')!;
  const close = (): void => overlay.remove();

  const confirm = async (): Promise<void> => {
    const val = input.value.trim();
    if (!val) return;
    close();
    try {
      await opts.onConfirm(val);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  overlay.querySelector('.dialog-cancel')!.addEventListener('click', () => {
    close();
    opts.onCancel?.();
  });
  overlay.querySelector('.dialog-confirm')!.addEventListener('click', () => {
    void confirm();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
      opts.onCancel?.();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void confirm();
  });
  input.focus();
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]!);
}
