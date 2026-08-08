# @ # / Mention Tag 输入框实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 composer 输入框从 textarea 改为 contenteditable,支持 @成员 / #频道 / /命令 三种有色 tag、Backspace 整块删除;发送序列化回纯文本;接收端 @任意成员高亮 + 点击弹名片。

**Architecture:** 前端 `composer.ts` 核心重写为 contenteditable + `caret.ts`(光标定位)+ `serialize.ts`(序列化)。tag 用 `contenteditable=false` 的 span 实现整块删除。接收端扩展 `highlightMentions` 并复用 chatView 现有点击委托 + memberPicker。后端加 `registry.list()` + `list_commands` IPC 为 `/` 建议面板提供单一事实源。

**Tech Stack:** Vanilla TS (ES2021, strict), Tauri v2, deltachat core。无测试框架,验证用 `npx tsc --noEmit` 类型检查 + `npm run tauri dev` 手动验证。

**验证策略:** 本项目无测试基建(无 vitest/jest)。每任务完成用 `npx tsc --noEmit` 验证类型,Task 末尾统一 `npm run tauri dev` 手动验证清单。

---

### Task 1: 光标定位工具 `src/chat/caret.ts`

**Files:**
- Create: `src/chat/caret.ts`

**背景:** contenteditable 没有 `selectionStart/End`,需要基于 DOM `Range` 的工具函数,供建议面板定位、tag 插入、整块删除复用。

- [ ] **Step 1: 创建 `src/chat/caret.ts`**

```ts
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
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过(新文件独立,无引用错误)。

- [ ] **Step 3: 提交**

```bash
git add src/chat/caret.ts
git commit -m "feat(composer): 新增 caret.ts 光标定位工具(contenteditable Range 封装)"
```

---

### Task 2: 序列化工具 `src/chat/serialize.ts`

**Files:**
- Create: `src/chat/serialize.ts`

**背景:** contenteditable 内容含 tag span + 文本节点 + `<br>`。发送/草稿需要序列化成纯文本,tag 拼回 `@名字` / `#频道` / `/cmd`。

- [ ] **Step 1: 创建 `src/chat/serialize.ts`**

```ts
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
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add src/chat/serialize.ts
git commit -m "feat(composer): 新增 serialize.ts 序列化 contenteditable 为纯文本"
```

---

### Task 3: 后端命令注册表 `list()` + `list_commands` IPC

**Files:**
- Modify: `src-tauri/src/commands/registry.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`(register handler,若需)

**背景:** spec §5.5 —— `/` 建议面板需要单一事实源。后端 `CommandRegistry` 加 `list()` 返回全部已注册命令元数据,经 IPC `list_commands` 暴露。

**注意:** 本任务改 src-tauri。记忆:src-tauri 改动别默认跑 `cargo check`(连带编译 core 5-7 分钟)。因此本任务验证用 `cargo check -p peytchat`(只查本 crate,快),若该命令不可行则跳过编译验证、以人工核对为准。

- [ ] **Step 1: registry.rs 加 `list()` 方法**

在 `CommandRegistry` impl 块(`register` 之后)加:

```rust
/// 列出全部已注册命令元数据(name, scope, description),供 / 建议面板与 /help 使用。
pub fn list(&self) -> Vec<CommandSpec> {
    let mut specs: Vec<CommandSpec> = self.inner.read().unwrap().values().cloned().collect();
    specs.sort_by(|a, b| a.name.cmp(b.name));
    specs
}
```

- [ ] **Step 2: commands.rs 加 `list_commands` IPC**

新增 `#[tauri::command]`,返回简单的可序列化结构(CommandSpec 含 `Arc<dyn CommandHandler>` 不能直接进 JSON):

```rust
/// 列出全部已注册 slash 命令元数据(/ 建议面板单一事实源)。
#[derive(serde::Serialize)]
pub struct CommandInfoDto {
    pub name: String,
    pub scope: &'static str,
    pub description: &'static str,
}

#[tauri::command]
pub async fn list_commands() -> AppResult<Vec<CommandInfoDto>> {
    use crate::commands::registry::{CommandRegistry, CommandScope};
    let reg = CommandRegistry::global();
    let scope_str = |s: &CommandScope| match s {
        CommandScope::Bot => "bot",
        CommandScope::User => "user",
        CommandScope::Both => "both",
    };
    Ok(reg
        .list()
        .into_iter()
        .map(|s| CommandInfoDto {
            name: s.name.to_string(),
            scope: scope_str(&s.scope),
            description: s.description,
        })
        .collect())
}
```

（若 `list_commands` 不在 commands.rs 顶层,需 `use` 引入 registry;按 commands.rs 现有模块布局调整。）

- [ ] **Step 3: 注册 IPC handler**

在 lib.rs 的 `invoke_handler` 数组加入 `crate::commands::list_commands`(按现有 `tauri::generate_handler!` 宏内的条目格式)。

- [ ] **Step 4: 编译验证(可选,快路径)**

Run: `cargo check -p peytchat`
Expected: 若成功,无错误。若因 core 连带编译过慢而跳过,标注「未编译验证,人工核对类型」。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/registry.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(commands): registry.list() + list_commands IPC 暴露 slash 命令元数据"
```

---

### Task 4: 插件命令元数据表(前端侧)

**Files:**
- Modify: `src/plugins/api.ts`
- Modify: `src/plugins/types.ts`

**背景:** 前端插件 `onCommand` 目前只存回调,无描述。为让 `/` 建议面板展示插件命令名,前端侧维护一份命令元数据表(与后端 list_commands 合并为候选源)。插件无描述则默认「插件命令」。

- [ ] **Step 1: types.ts 加命令元数据表类型**

在 `declare global` 的 Window 接口加:

```ts
__peytchat_commands_meta?: Record<string, string>; // 命令名 → 描述(空字符串=无描述)
```

- [ ] **Step 2: api.ts onCommand 同步写元数据**

改 `onCommand`:

```ts
onCommand(name, cb) {
  if (!hasPermission(pluginName, 'commands')) return deny(pluginName, 'commands');
  if (!window.__peytchat_commands) window.__peytchat_commands = {};
  if (!window.__peytchat_commands_meta) window.__peytchat_commands_meta = {};
  window.__peytchat_commands[name] = cb;
  window.__peytchat_commands_meta[name] = ''; // 描述占位,插件当前无描述字段
  unloadCallbacks.push(() => {
    delete window.__peytchat_commands![name];
    delete window.__peytchat_commands_meta![name];
  });
},
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add src/plugins/api.ts src/plugins/types.ts
git commit -m "feat(plugins): onCommand 同步维护命令元数据表(供 / 建议面板)"
```

---

### Task 5: composer 核心迁移 textarea → contenteditable

**Files:**
- Modify: `src/chat/composer.ts`(全文大部分重写)

**背景:** 核心改造。textarea 换成 contenteditable div;现有 `input.value`/`selectionStart`/`scrollHeight`/`placeholder` 迁移;两种模式(收起/展开)不再切组件,只调高度(用户已确认)。

**关键设计:**
- 同一 `#composer-input` contenteditable,收起=单行 auto 增高(封顶 120px),展开=固定高度可拖拽。
- Enter 统一发送,Shift+Enter 换行(用户已定)。Ctrl+Enter 也发送。
- placeholder 用 CSS `:empty::before`。
- 高度自适应用 `scrollHeight`(contenteditable 同样有效)。
- 建议面板锚定光标处(`caretRect`)。

- [ ] **Step 1: 修改 composer 的 HTML 结构**

把 `renderComposer` 里 textarea 那行:

```html
<textarea id="composer-input" placeholder="${PLACEHOLDER_COLLAPSED}" rows="1"></textarea>
```

换成:

```html
<div id="composer-input" class="composer-input" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="${PLACEHOLDER_COLLAPSED}"></div>
```

`const input = document.getElementById('composer-input') as HTMLTextAreaElement | null` 改为 `as HTMLElement | null`。

`PLACEHOLDER_COLLAPSED` / `PLACEHOLDER_EXPANDED` 合并为单个 `PLACEHOLDER`(统一组件后提示语语义统一):

```ts
const PLACEHOLDER = '发消息到频道... (@提及 / #频道)';
```

- [ ] **Step 2: 实现 textarea 操作的等价函数**

在 composer.ts 加这几个替代函数(textarea 的 value/selection/高度操作改为 DOM 版):

```ts
// contenteditable 取值:序列化为纯文本(替代 input.value)
function getInputText(el: HTMLElement): string {
  return serializeComposer(el);
}
// 自适应高度(收起模式):auto → min(scrollHeight, 120)
function autoResize(el: HTMLElement): void {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
// 清空(替代 input.value = '')
function clearInput(el: HTMLElement): void {
  el.textContent = '';
  el.focus();
}
// 在光标处插入文本(替代 insertNewline)
function insertTextAtCaret(el: HTMLElement, text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { el.textContent = (el.textContent ?? '') + text; return; }
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const node = document.createTextNode(text);
  r.insertNode(node);
  r.setStartAfter(node);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  autoResize(el);
}
// 输入内容是否为空(替代 input.value.trim() === '')
function isEmptyInput(el: HTMLElement): boolean {
  return serializeComposer(el).length === 0;
}
```

同时加 import:`import { serializeComposer } from './serialize.js';` `import { caretRect, textBeforeCaret, getCaretPoint, setCaretPoint } from './caret.js';`

- [ ] **Step 3: 迁移 `oninput` / 自适应高度**

把 `input.oninput` 里的 textarea 高度逻辑替换:

```ts
input.oninput = () => {
  autoResize(input);
  handleMentionInput(input);
  updateSendState();
  // 草稿防抖(不变)
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    void call('set_draft', { chatId, text: serializeComposer(input) });
  }, 500);
};
```

- [ ] **Step 4: 迁移键盘逻辑(统一 Enter 发送)**

`input.onkeydown` 改为(替换原有 Enter/Ctrl+Enter 分支):

```ts
input.onkeydown = async (e) => {
  const composing = e.isComposing || e.keyCode === 229;
  // 建议面板导航优先(不变,但基于 getCaretPoint)
  if (mentionList) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionItems.length; updateMentionSelection(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionItems.length) % mentionItems.length; updateMentionSelection(); return; }
    if (e.key === 'Enter' && !composing && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); insertSelectedMention(input); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMentionList(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertSelectedMention(input); return; }
  }
  // 统一 Enter 发送,Shift+Enter 换行(用户已定),Ctrl/Cmd+Enter 也发送
  if (e.key === 'Enter' && !composing && !e.shiftKey) {
    e.preventDefault();
    await send(chatId, input, area, onSent);
    return;
  }
  if (e.key === 'Enter' && !composing && e.shiftKey) {
    e.preventDefault();
    insertTextAtCaret(input, '\n');
    return;
  }
  if (e.key === 'Escape') {
    if (area.dataset.replyTo) {
      delete area.dataset.replyTo;
      renderComposer(chatId, onSent);
    }
  }
};
```

- [ ] **Step 5: 迁移 `applyExpanded` / 拖拽 / 展开按钮**

`applyExpanded` 内:去掉 textarea 专属的 `input.style.height` 重置逻辑,改为:

```ts
const applyExpanded = (next: boolean): void => {
  const changed = expanded !== next;
  expanded = next;
  composerEl?.classList.toggle('expanded', expanded);
  input.dataset.placeholder = PLACEHOLDER;
  if (changed) {
    showToast(expanded ? '已切换:展开输入' : '已切换:单行输入');
  }
  if (!expanded) {
    autoResize(input);
  } else {
    input.style.height = '88px'; // 展开默认高度
  }
  input.focus();
};
```

拖拽 `onMove` 里 `input.style.height = h + 'px'` 保持(对 contenteditable 同样有效),`collapsePending = h <= 46` 判断保留。`oninput` 不再强制 `min(scrollHeight, 120)`(展开时高度锁定),需在 autoResize 里判断:

```ts
function autoResize(el: HTMLElement): void {
  if (expanded) return; // 展开模式高度锁定,不自动增高
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
```

- [ ] **Step 6: 迁移草稿恢复 / send 状态 / md 检测**

- 草稿恢复:`input.value = draft` → `input.textContent = draft; autoResize(input);`
- `updateSendState`:`sendBtn.disabled = !input.value.trim()` → `sendBtn.disabled = isEmptyInput(input)`。
- md 检测 `input.value` → `serializeComposer(input)`(或用 innerText)。
- `insertNewline(input)` 调用替换为 `insertTextAtCaret(input, '\n')`,删除原 insertNewline 函数。

- [ ] **Step 7: 迁移 send() 的取值与清空**

`send()` 开头 `const text = input.value.trim()` → `const text = serializeComposer(input)`(serialize 已 trim)。命令分支判断 `text.startsWith('/')` 不变。发送成功/清空处 `input.value = ''` → `clearInput(input)`。

- [ ] **Step 8: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过(可能仍有对 `input.value`/`selectionStart` 的残留引用报错,需逐处替换)。

- [ ] **Step 9: 手动验证(tauri dev)**

Run: `npm run tauri dev`
- 收起模式单行,输入自动增高,封顶 120px。
- 展开按钮切换高度,拖拽调整,拖回单行自动收起。
- Enter 发送,Shift+Enter 换行。
- 中文输入法 Enter 不触发发送(组合态)。
- 草稿刷新后恢复(纯文本)。

- [ ] **Step 10: 提交**

```bash
git add src/chat/composer.ts
git commit -m "feat(composer): textarea → contenteditable,统一 Enter 发送,收起/展开仅调高度"
```

---

### Task 6: tag 插入 + 建议列表适配(成员/频道)

**Files:**
- Modify: `src/chat/composer.ts`

**背景:** 建议列表选中后插入 tag span(替代纯文本),并适配 contenteditable 的光标定位。

- [ ] **Step 1: 新增插入 tag 函数**

```ts
// 插入单个 tag span,光标移到 tag 后;kind: '@'|'#'|'/'
function insertTag(input: HTMLElement, kind: '@' | '#' | '/', name: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0);
  const span = document.createElement('span');
  span.className = `mention-tag tag-${kind === '@' ? 'member' : kind === '#' ? 'channel' : 'command'}`;
  span.contentEditable = 'false';
  span.dataset.kind = kind === '@' ? 'member' : kind === '#' ? 'channel' : 'command';
  span.dataset.name = name;
  span.textContent = kind + name;
  // 删除 @query 已输入的字符(用 textBeforeCaret 定位)
  const before = textBeforeCaret(input);
  const match = before.match(new RegExp(`\\${kind}(\\w*)$`));
  if (match) {
    // 回退光标到 @ 前,删掉匹配段
    const back = match[0].length;
    // 简化:通过范围删除 —— 向前回溯 back 个字符长度
    try {
      const selRange = sel.getRangeAt(0);
      const node = r.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node as Text;
        if (r.startOffset - back >= 0) {
          selRange.setStart(node, r.startOffset - back);
          selRange.deleteContents();
        }
      }
    } catch { /* 非文本节点起点则跳过删除,直接插入 */ }
  }
  r.deleteContents();
  r.insertNode(span);
  // 光标移到 tag 后 + 补一个可编辑空格
  const space = document.createTextNode(' ');
  r.setStartAfter(span);
  r.insertNode(space);
  r.setStartAfter(space);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  autoResize(input);
  closeMentionList();
  input.focus();
}
```

（注:该函数已合并原 `insertSelectedMention` 的核心逻辑,替换之。原 `insertSelectedMention` 删除,`closeMentionList` 保留。）

- [ ] **Step 2: 适配 `insertSelectedMention`**

删除原 `insertSelectedMention`,`showMentionList` 的点击/键盘回调统一改为调用 `insertTag(input, mentionKind, item.name)`:

```ts
// 键盘 Enter/Tab 与点击选择共用
function insertSelectedMention(input: HTMLElement): void {
  if (!mentionList || mentionItems.length === 0 || mentionKind == null) {
    closeMentionList();
    return;
  }
  const item = mentionItems[mentionSelectedIndex];
  if (!item) { closeMentionList(); return; }
  insertTag(input, mentionKind, item.name);
}
```

`showMentionList` 内点击回调从 `insertSelectedMention(input)` 改为同样逻辑(调 insertTag);`mentionQueryStart` 字段不再需要(插入时用 textBeforeCaret 定位),删除引用。

- [ ] **Step 3: 建议列表定位适配**

`showMentionList` 定位从 `input.getBoundingClientRect()` 改为 `caretRect(input)`:

```ts
const rect = caretRect(input);
mentionList.style.position = 'fixed';
mentionList.style.left = `${rect.left}px`;
mentionList.style.top = `${rect.top - Math.min(items.length, 6) * 28 - 4}px`;
```

- [ ] **Step 4: `handleMentionInput` 支持 '/' 命令(候选源合并)**

在 `handleMentionInput` 中,`@` 与 `#` 分支之后加 `/` 分支(复用同一列表渲染)。候选源 = 后端 `list_commands` + 前端插件命令元数据。先用静态内置命令表(后端那 4 个),并在命令加载时合并 IPC 结果:

```ts
// 命令候选:内置静态表 + 插件命令
const BUILTIN_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'whoami', description: '查看 Bot 身份与所属工作区' },
  { name: 'roll', description: '随机 1-N(默认 100)' },
  { name: 'summarize', description: '总结最近消息' },
  { name: 'ask', description: '向知识库提问' },
];
let remoteCommands: Array<{ name: string; description: string }> = [];
// 模块加载时拉一次(失败静默)
call<Array<{ name: string; description: string }>>('list_commands').then((list) => {
  if (Array.isArray(list)) remoteCommands = list;
}).catch(() => {});

function commandSuggestions(query: string): Array<{ name: string; type: 'command'; description: string }> {
  const pluginMeta = window.__peytchat_commands_meta || {};
  const pluginNames = Object.keys(window.__peytchat_commands || {});
  const merged = new Map<string, string>();
  for (const c of [...remoteCommands, ...BUILTIN_COMMANDS]) if (!merged.has(c.name)) merged.set(c.name, c.description);
  for (const n of pluginNames) if (!merged.has(n)) merged.set(n, pluginMeta[n] || '插件命令');
  return [...merged.entries()]
    .filter(([name]) => name.toLowerCase().includes(query))
    .map(([name, description]) => ({ name, type: 'command' as const, description }));
}
```

`/` 分支在 `handleMentionInput`:

```ts
const slashMatch = before.match(/\/(\w*)$/);
if (slashMatch) {
  const query = slashMatch[1].toLowerCase();
  const cmds = commandSuggestions(query);
  if (cmds.length > 0) {
    showMentionList(cmds, '/', input);
  } else {
    closeMentionList();
  }
  return;
}
```

`showMentionList` 的 items 类型扩展为 `{ name; type: 'member'|'channel'|'command'; description? }`,渲染时 command 项展示描述(小字)。

- [ ] **Step 5: 整块删除(Backspace/Delete)**

在 `input.onkeydown` 的 Enter 分支前加:

```ts
// 整块删除:光标紧邻 tag 时,Backspace/Delete 删整个 span
if (e.key === 'Backspace' || e.key === 'Delete') {
  if (deleteAdjacentTag(input, e.key === 'Backspace' ? 'before' : 'after')) {
    e.preventDefault();
    autoResize(input);
    return;
  }
}
```

新增函数:

```ts
// 光标前后是否紧邻 mention-tag;是则删除该 tag 并返回 true
function deleteAdjacentTag(input: HTMLElement, dir: 'before' | 'after'): boolean {
  const pt = getCaretPoint();
  if (!pt) return false;
  const { node, offset } = pt;
  // 在文本节点内:offset 指向 tag 边界
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (dir === 'before' && offset === 0) {
      // 光标在文本开头,前一个兄弟若是 tag → 删
      const prev = previousElementSiblingSkipSpaces(node);
      if (prev && prev.classList.contains('mention-tag')) { prev.remove(); return true; }
    }
    if (dir === 'after' && offset === text.length) {
      const next = nextElementSiblingSkipSpaces(node);
      if (next && next.classList.contains('mention-tag')) { next.remove(); return true; }
    }
    return false;
  }
  // 在元素节点内:offset 指向子节点
  const child = node.childNodes[offset];
  if (child && (child as HTMLElement).classList?.contains?.('mention-tag')) {
    (child as HTMLElement).remove();
    return true;
  }
  return false;
}

function previousElementSiblingSkipSpaces(node: Node): HTMLElement | null {
  let n: Node | null = node.previousSibling;
  while (n && n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()) n = n.previousSibling;
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : null;
}
function nextElementSiblingSkipSpaces(node: Node): HTMLElement | null {
  let n: Node | null = node.nextSibling;
  while (n && n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()) n = n.nextSibling;
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : null;
}
```

（整块删除后,删除的 tag 位置的光标语义:浏览器会回退到删除点附近,可接受。）

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 7: 手动验证(tauri dev)**

- 输入 `@张` → 弹成员建议,选中插入蓝色 tag `@张三 `,整块删除。
- 输入 `#` → 频道建议,选中插入绿色 tag。
- 输入 `/` → 命令建议(内置 4 个 + 插件),选中插入橙色 tag。
- Backspace 在 tag 边界整块删除;Delete 在 tag 开头删除。
- 建议面板弹在光标处,键盘上下/Enter/Tab/Esc 正常。

- [ ] **Step 8: 提交**

```bash
git add src/chat/composer.ts
git commit -m "feat(composer): @ # / 有色 tag 插入 + 整块删除 + 建议列表适配 contenteditable"
```

---

### Task 7: 发送序列化 + 命令分发

**Files:**
- Modify: `src/chat/composer.ts`

**背景:** send() 已改用 `serializeComposer`(Task 5 Step 7)。本任务确认 tag 序列化后的文本正确走现有命令/文本分发,并处理 `/` tag 与纯文本 `/cmd` 的一致。

- [ ] **Step 1: 确认 send() 命令分发**

`send()` 现有逻辑:`text.startsWith('/')` → 拆分 cmd/args → `window.__peytchat_commands[cmd]`。序列化后 `@张三 /ai 帮我` → 文本 `@张三 /ai 帮我` → `/` 开头 → cmd=`ai` → 查插件命令。**这会把「前面有 @tag 再输入 /」误判为命令**。

修复:命令判定改为「文本以 `/` 开头且命令名在已知命令集内」才分发,否则当普通文本:

```ts
if (text.startsWith('/')) {
  const sp = text.indexOf(' ');
  const cmd = sp === -1 ? text.slice(1) : text.slice(1, sp);
  const handler = window.__peytchat_commands?.[cmd];
  if (handler) {
    // ...现有命令执行分支不变
    return;
  }
  // 未命中已知命令 → 落为普通文本发送(去掉纯 '/' 误触发)
}
```

同时,若序列化结果以 `@` 或 `#` tag 开头(如 `@张三 你好`),`startsWith('/')` 为 false → 正常文本发送,无需额外处理。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 手动验证(tauri dev)**

- 只输入 `/ai x`(插件已注册时)→ 执行命令。
- 输入 `@张三 /ai x`(tag 后跟 /)→ 作为普通文本发送(不误判命令)。
- 纯文本、含 tag、多行含 `<br>` → 序列化后发送内容正确、换行保留。
- 发送后输入框清空、草稿清空。

- [ ] **Step 4: 提交**

```bash
git add src/chat/composer.ts
git commit -m "feat(composer): send 序列化分发,命令仅以 / 开头且命中已知命令才执行"
```

---

### Task 8: 接收端 @成员高亮扩展

**Files:**
- Modify: `src/chat/message.ts`

**背景:** `highlightMentions` 只高亮 `@自己/@角色`。扩展为 @任意当前聊天成员都高亮成 tag(`.mention-tag.tag-member`)。

- [ ] **Step 1: 修改 highlightMentions**

`message.ts:663` 的 `highlightMentions`:

```ts
function highlightMentions(html: string): string {
  const myName = state.self?.name || '';
  const roleNames = (state.roles || []).map((r) => r.name).filter(Boolean);
  const memberNames = (state.currentMembers || []).map((m) => m.name).filter(Boolean);
  const targets = [...new Set([myName, ...roleNames, ...memberNames])].filter(Boolean).map(escapeRegex);
  if (targets.length === 0) return html;
  const re = new RegExp(`@(${targets.join('|')})`, 'g');
  return html.replace(re, (match, name: string) => {
    // 成员高亮成可点击 tag;self/角色保持旧 msg-mention(点击逻辑一致可复用,统一成 tag)
    return `<span class="mention-tag tag-member" data-kind="member" data-name="${escapeAttr(name)}">${match}</span>`;
  });
}
```

注意:原实现 `@$1` 直接用已转义的 html 替换;现在需 `escapeAttr`(escape.js 已有导出,message.ts 已 import)。self/角色也统一成 tag(点击弹名片逻辑一致,self 分支在 chatView 处理)。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add src/chat/message.ts
git commit -m "feat(message): 接收端 @任意当前成员高亮成 tag(数据源 currentMembers)"
```

---

### Task 9: 接收端点击弹名片(chatView 委托)

**Files:**
- Modify: `src/chat/chatView.ts`

**背景:** 复用 `bindTopicChipClick` 的 document 级点击委托,新增 `.mention-tag[data-kind="member"]` 分支 → openUserPicker/self 名片。

- [ ] **Step 1: bindTopicChipClick 加 member tag 分支**

在 `chatView.ts:796` 的委托开头(`const mention = ...` 之前)加:

```ts
// @成员 tag 点击 → 弹成员名片(复用 memberPicker 模糊匹配,self 走 self 名片)
const memberTag = (e.target as HTMLElement).closest<HTMLElement>('.mention-tag[data-kind="member"]');
if (memberTag) {
  e.stopPropagation();
  const name = memberTag.dataset.name || '';
  if (name === (state.self?.name || '')) {
    void import('../components/contactCard.js').then(({ openContactCard }) =>
      openContactCard({ contactId: state.self!.id, name: state.self!.name, addr: state.self!.addr, avatar: state.self!.avatar ?? null, anchor: memberTag }));
  } else {
    void import('../components/memberPicker.js').then(({ openUserPicker }) => openUserPicker(name, memberTag));
  }
  return;
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 手动验证(tauri dev)**

- 接收端消息里 `@成员名` 高亮成蓝色 tag。
- 点击成员 tag → 弹名片(1 人直接弹,多人弹列表)。
- 点击 @自己 → 弹 self 名片。
- 点击 tag 不触发消息看板(chip 委托正常)。

- [ ] **Step 4: 提交**

```bash
git add src/chat/chatView.ts
git commit -m "feat(chat): @成员 tag 点击弹名片(复用 memberPicker 委托)"
```

---

### Task 10: 样式

**Files:**
- Modify: `src/styles.css`

**背景:** `.mention-tag` 三色 tag、输入框 placeholder、输入框内与接收端统一样式。

- [ ] **Step 1: 新增 tag 样式**

在 `.msg-mention`(styles.css:1799)附近加:

```css
/* @ # / mention tag(输入框 + 接收端共用) */
.mention-tag {
  display: inline-block;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  font-weight: 500;
  line-height: 1.5;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  vertical-align: baseline;
}
.tag-member { background: color-mix(in srgb, #0a84ff 18%, transparent); color: #0a84ff; }
.tag-channel { background: color-mix(in srgb, #34c759 16%, transparent); color: #34c759; }
.tag-command { background: color-mix(in srgb, #ff9f0a 16%, transparent); color: #ff9f0a; }
.mention-tag:active { filter: brightness(0.92); }
/* 深色主题下 tag 文字更亮(色相不变,参照 msg-theme 亮度适配思路) */
@media (prefers-color-scheme: dark) {
  .tag-member { color: #5ab5ff; }
  .tag-channel { color: #5ee87e; }
  .tag-command { color: #ffb84d; }
}
```

- [ ] **Step 2: contenteditable 输入框样式迁移**

原 `.composer textarea` 规则(styles.css:1443)改为 `.composer-input`(contenteditable div),并把 `::placeholder` 换成 `:empty::before`:

```css
.composer-input {
  flex: 1;
  width: 100%;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 9px 30px 7px 4px;
  font-size: var(--font-scale-body);
  color: var(--text);
  font-family: var(--font);
  outline: none;
  min-height: 38px;
  max-height: 120px;
  line-height: 1.5;
  overflow-y: auto;
  overflow-x: hidden;
  word-break: break-word;
  white-space: pre-wrap;
}
/* placeholder:contenteditable 无原生 placeholder,用 :empty::before */
.composer-input:empty::before {
  content: attr(data-placeholder);
  color: var(--text-mute);
  pointer-events: none;
}
/* 展开时高度可调(替换原 .composer.expanded textarea) */
.composer.expanded .composer-input {
  min-height: 88px;
  max-height: 320px;
}
/* 输入框内 tag 不可选编辑(整块删除依赖) */
.composer-input .mention-tag {
  cursor: text;
}
/* 隐藏滚动条 */
.composer-input { scrollbar-width: none; }
.composer-input::-webkit-scrollbar { display: none; }
```

原 `.composer textarea ~ .composer-toolbar .composer-send` 兼容选择器(styles.css:1493)保留即可(textarea 已移除,不影响)。

- [ ] **Step 3: 类型检查(无 TS 变更,跳过)/ 构建**

Run: `npm run build`(vite build,验证 CSS 无语法错误)
Expected: 构建成功。

- [ ] **Step 4: 手动验证(tauri dev)**

- 收起单行有 placeholder;输入后消失(内容非 :empty)。
- 三种 tag 颜色正确、深浅色主题均可见。
- 展开模式高度可拖、tag 整块删除、样式不破。

- [ ] **Step 5: 提交**

```bash
git add src/styles.css
git commit -m "feat(style): mention-tag 三色样式 + contenteditable 输入框 CSS(placeholder/高度/滚动)"
```

---

### Task 11: 全量验证 + 收尾

**Files:**
- 无新增

- [ ] **Step 1: 类型检查全量**

Run: `npx tsc --noEmit`
Expected: 无错误(0 error)。

- [ ] **Step 2: 前端构建**

Run: `npm run build`
Expected: `vite build` 成功,dist 生成。

- [ ] **Step 3: 全量手动回归(tauri dev)**

对照 spec 走一遍:
- **输入**:@ / # / / 三类建议列表、键盘导航、选中插入 tag、光标后空格可编辑。
- **删除**:Backspace/Delete 整块删 tag,普通文本逐字删。
- **两种模式**:收起 auto 增高 / 展开拖拽,切换不丢已输入内容。
- **发送**:tag 序列化回 `@名 #频道 /cmd`;`/` 命令命中才执行,否则文本;回复/引用/附件/录音/手写不受影响。
- **草稿**:刷新恢复纯文本,不重建 tag。
- **接收端**:@任意成员高亮 tag,点击弹名片(self/成员/多人列表);`#`、`/` 接收端保持纯文本。
- **粘贴**:粘贴含 HTML 内容只取文本(如未实现拦截,记录为已知边界,后续补)。

- [ ] **Step 4: 处理已知边界(若手动验证发现)**

- 粘贴带格式:若未拦截,`paste` 事件里 `e.preventDefault()` + `document.execCommand('insertText', false, text)` 取纯文本。计划 Task 5/6 未含,若验证暴露则补一个最小拦截。

- [ ] **Step 5: 提交收尾**

```bash
git add -A
git commit -m "chore: mention tag 输入框功能收尾"
```

- [ ] **Step 6: 更新任务状态**

TaskList 中相关任务标记 completed(由执行者更新)。

---

## 自审记录

**1. Spec 覆盖:**
- §2 contenteditable 迁移 → Task 5;§2.2 光标工具 → Task 1;§2.3 两种模式 → Task 5 Step 5;§2.4 统一 Enter → Task 5 Step 4。
- §3 tag 结构/整块删除 → Task 6。
- §4 建议列表(@ # / 候选 + 定位) → Task 6 Step 3/4。
- §5 序列化/发送/草稿/md → Task 2, Task 5 Step 7, Task 7。
- §5.5 命令规范化 → Task 3(后端 list_commands)+ Task 4(插件元数据)+ Task 6 Step 4(候选合并)。
- §6 接收端高亮 → Task 8;点击名片 → Task 9。
- §7 样式 → Task 10。

**2. 占位符扫描:** 无 TODO/TBD。所有代码块完整。Task 3 编译验证标注「可选快路径」,因记忆约定不默认跑 cargo check(连带 core 编译)。

**3. 类型一致性:**
- `serializeComposer(el: HTMLElement)` 在 Task 2 定义,Task 5/6/7 一致使用。
- `caretRect`/`textBeforeCaret`/`getCaretPoint`/`setCaretPoint` 在 Task 1 定义,Task 5/6 引用,签名一致。
- `insertTag(input, kind, name)` Task 6 定义,`insertSelectedMention` 调用。
- `showMentionList(items, kind, input)` 第三参从 `queryStart: number` 改为 `input: HTMLElement`(Task 6),内部 `mentionQueryStart` 删除。
- `highlightMentions` 签名不变,输出结构改为 tag。
- `.mention-tag.tag-member` 在 Task 6(输入)/Task 8(接收)/Task 9(委托)/Task 10(样式)四处以同一 class 名出现,一致。
