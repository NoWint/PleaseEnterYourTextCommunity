// contenteditable 序列化:tag span + 文本 + <br> → 纯文本。
// tag 按 data-kind 拼前缀(@/#/),data-name 为内容;文本节点原样;<br> → \n。

/** 序列化 contenteditable 内容为纯文本。tag 文本拼上前缀,<br> 换行。 */
export function serializeComposer(el: HTMLElement): string {
  const parts: string[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const elNode = node as HTMLElement;
    if (elNode.classList.contains('mention-tag')) {
      const kind = elNode.dataset.kind;
      const name = elNode.dataset.name || elNode.textContent || '';
      const prefix = kind === 'channel' ? '#' : kind === 'command' ? '/' : '@';
      parts.push(prefix + name);
      return;
    }
    if (elNode.tagName === 'BR') {
      parts.push('\n');
      return;
    }
    // 其余元素递归子节点(div 内换行由 <br> 控制,div 本身不补换行)
    for (const child of Array.from(elNode.childNodes)) visit(child);
  };

  for (const child of Array.from(el.childNodes)) visit(child);

  // tag 后自带空格 + 文本节点多余空格 → 合并连续空白为单空格(保留换行)
  let raw = parts.join('');
  raw = raw.replace(/[ \t]+/g, ' ');
  // 首尾 trim(与旧 textarea 的 .trim() 行为一致)
  return raw.trim();
}
