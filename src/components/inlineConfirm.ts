import { showToast } from '../toast.js';
import { escapeHtml } from './escape.js';

export interface InlineConfirmOpts {
  message: string;
  confirmLabel?: string;
  undoLabel?: string;
  // 成功后 toast 文案;默认 "已删除"。同时用于撤销 toast 的前缀文案。
  // 调用方 onConfirm 内部若已自行 showToast,应传 successLabel 与之相同并移除内部 showToast,避免重复。
  successLabel?: string;
  onConfirm: () => Promise<void> | void;
  onUndo?: () => Promise<void> | void;
  autoCancelMs?: number;
}

export function showInlineConfirm(el: HTMLElement, opts: InlineConfirmOpts): void {
  const originalHtml = el.innerHTML;
  const confirmLabel = opts.confirmLabel ?? '确认删除';
  el.classList.add('inline-confirm-active');
  el.innerHTML = `
    <div class="inline-confirm-msg">${escapeHtml(opts.message)}</div>
    <div class="inline-confirm-actions">
      <button class="inline-confirm-yes">${escapeHtml(confirmLabel)}</button>
      <button class="inline-confirm-no">取消</button>
    </div>
  `;
  const yesBtn = el.querySelector<HTMLButtonElement>('.inline-confirm-yes')!;
  const noBtn = el.querySelector<HTMLButtonElement>('.inline-confirm-no')!;

  const timer = setTimeout(cancel, opts.autoCancelMs ?? 3000);

  function cancel(): void {
    clearTimeout(timer);
    el.classList.remove('inline-confirm-active');
    el.innerHTML = originalHtml;
  }

  yesBtn.addEventListener('click', async () => {
    clearTimeout(timer);
    el.innerHTML = originalHtml;
    el.classList.remove('inline-confirm-active');
    try {
      await opts.onConfirm();
      const successLabel = opts.successLabel ?? '已删除';
      if (opts.onUndo) {
        showUndoToast(successLabel, opts.undoLabel ?? '撤销', opts.onUndo);
      } else {
        showToast(successLabel);
      }
    } catch (e) {
      // 调用方 onConfirm 失败应 throw (而非自行吞错),此处显示具体错误,
      // 避免 onConfirm 内 catch 后不 throw 导致外层误显 successLabel。
      showToast(e instanceof Error ? e.message : '操作失败');
    }
  });
  noBtn.addEventListener('click', cancel);
}

function showUndoToast(successLabel: string, undoLabel: string, onUndo: () => Promise<void> | void): void {
  const toast = document.createElement('div');
  toast.className = 'toast toast-with-action';
  toast.innerHTML = `<span>${escapeHtml(successLabel)}</span><button class="toast-action">${escapeHtml(undoLabel)}</button>`;
  document.body.appendChild(toast);
  toast.classList.add('show');
  const btn = toast.querySelector<HTMLButtonElement>('.toast-action')!;
  const dismiss = (): void => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  };
  btn.addEventListener('click', async () => {
    try {
      await onUndo();
    } catch {
      showToast('撤销失败');
    }
    dismiss();
  });
  setTimeout(dismiss, 5000);
}

