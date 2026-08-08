// contenteditable 序列化:tag span + 文本 + <br>/块元素 → 纯文本。
// tag 按 data-kind 拼前缀(@/#/),data-name 为内容;文本节点原样;<br> → \n;
// 块级元素(div/p/li 等)边界补 \n,粘贴富文本不再挤成一行。
// 空白规则:普通文本的连续空格原样保留(代码缩进等);仅 tag 后的邻接空白归一为单空格。

/** 序列化 contenteditable 内容为纯文本。tag 文本拼上前缀,<br>/块元素 换行。 */
export function serializeComposer(el: HTMLElement): string {
  const parts: string[] = [];
  // 上个产出是否为 tag(其后若紧跟空白则压缩为单空格)
  let lastWasTag = false;
  const pushText = (s: string): void => {
    if (lastWasTag && s.startsWith(' ')) s = s.replace(/^ +/, ' '); // tag 后多空格 → 单空格
    parts.push(s);
    lastWasTag = false;
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const elNode = node as HTMLElement;
    if (elNode.classList.contains('mention-tag')) {
      const kind = elNode.dataset.kind;
      const name = elNode.dataset.name || elNode.textContent || '';
      const prefix = kind === 'channel' ? '#' : kind === 'command' ? '/' : '@';
      parts.push(prefix + name);
      lastWasTag = true;
      return;
    }
    if (elNode.tagName === 'BR') {
      pushText('\n');
      return;
    }
    // 块级元素边界补换行,避免粘贴富文本(div/p 分隔)内容挤成一行
    const BLOCK = ['DIV', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
    if (BLOCK.includes(elNode.tagName)) {
      const last = parts[parts.length - 1] ?? '';
      if (last !== '' && !last.endsWith('\n')) pushText('\n');
    }
    for (const child of Array.from(elNode.childNodes)) visit(child);
    if (BLOCK.includes(elNode.tagName)) {
      const last = parts[parts.length - 1] ?? '';
      if (last !== '' && !last.endsWith('\n')) pushText('\n');
    }
  };

  for (const child of Array.from(el.childNodes)) visit(child);

  // 首尾 trim(与旧 textarea 的 .trim() 行为一致)
  return parts.join('').trim();
}
