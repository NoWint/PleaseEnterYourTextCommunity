/**
 * HTML 转义工具 — 全库唯一实现。
 * 各文件原本重复定义 escapeHtml/escapeAttr,统一收敛到本模块,
 * 语义与历史实现完全一致:String(s ?? '').replace(...)。
 */

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}

/** 属性上下文转义(等价于 escapeHtml,历史各文件均如此实现)。 */
export function escapeAttr(s: unknown): string {
  return escapeHtml(s);
}
