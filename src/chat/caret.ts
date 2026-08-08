// 光标定位工具:contenteditable 无 selectionStart/End,统一封装 DOM Range 操作。
// 供建议面板定位(光标处 DOMRect)、tag 插入/删除、textBeforeCaret 匹配复用。

export interface CaretPoint {
  node: Node;
  offset: number;
}

/** 当前光标位置(selection range 的 start)。无 selection 返回 null。 */
export function getCaretPoint(): CaretPoint | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  return { node: r.startContainer, offset: r.startOffset };
}

/** 恢复光标到指定节点+偏移。 */
export function setCaretPoint(node: Node, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 光标处的可见 DOMRect(建议面板锚点)。无 selection 回退到容器 rect。 */
export function caretRect(el: HTMLElement): DOMRect {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    // getClientRects 在文本节点中通常有 1 个;空文本/行尾可能为空 → 回退
    const rects = r.getClientRects();
    if (rects.length > 0) return rects[0];
    const rangeRect = r.getBoundingClientRect();
    if (rangeRect.width > 0 || rangeRect.height > 0) return rangeRect;
  }
  return el.getBoundingClientRect();
}

/** 光标之前的可见文本(建议匹配用)。tag 的可见文本被计入(如 "@张三 ")。 */
export function textBeforeCaret(el: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString();
}
