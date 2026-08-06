# 消息 Markdown 渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** text/reply 信封 payload 加 `markdown` 布尔字段;composer-toolbar 加 iOS 风格 markdown 开关(默认开 + localStorage + 关闭时 md 语法呼吸灯提示);消息体按字段决定 md 渲染;引用块遵循被引用消息信封内的 markdown。

**Architecture:** 后端 `send_text`/`send_reply` 加 `markdown` 参数并写入信封 payload;`send_reply` 改为信封正文 + 保留 core `set_quote`。前端 `envelope.ts` 加 `envelopeMarkdown` 读取器;`message.ts` 正文和引用块按 markdown 字段分支到 `renderMarkdown`(已有引擎)/`renderText`;composer 加 toggle(复用现有 `.toggle-switch` 样式)驱动发送参数。

**Tech Stack:** Rust (tauri v2, deltachat core 不改), Vanilla TS, marked, localStorage。

**Spec:** `docs/superpowers/specs/2026-08-06-markdown-message-design.md`

---

### Task 1: 后端 — send_text 加 markdown 参数

**Files:**
- Modify: `src-tauri/src/commands.rs:637-657`
- Test: `src-tauri/src/envelope.rs:29-47` (已有结构测试,扩展)

- [ ] **Step 1: 改 send_text_impl 签名加 markdown 参数**

`send_text_impl`(commands.rs:639) 从 `(ctx, chat_id, text)` 改为 `(ctx, chat_id, text, markdown: bool)`,payload 加字段:

```rust
async fn send_text_impl(ctx: &Context, chat_id: u32, text: String, markdown: bool) -> AppResult<MsgId> {
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let payload = serde_json::json!({ "text": text, "markdown": markdown });
    let envelope = crate::envelope::build_envelope("text", payload)?;
    Ok(chat::send_text_msg(ctx, chat_id, envelope).await?)
}
```

- [ ] **Step 2: 改 send_text 命令透传 markdown**

commands.rs:647 `send_text` 加 `markdown: bool` 参数,调用改 `send_text_impl(&ctx, chat_id, text, markdown)`。

- [ ] **Step 3: 改 bot_send_text 传 false**

commands.rs:3697 `bot_send_text` 调用改 `send_text_impl(&ctx, chat_id, text, false)`——bot AI 回复纯文本,不带 md 标记。

- [ ] **Step 4: 扩展 envelope.rs 测试**

envelope.rs `envelope_structure` 测试后加:

```rust
#[test]
fn envelope_text_with_markdown() {
    let s = build_envelope("text", json!({"text": "**hi**", "markdown": true})).unwrap();
    let json: Value = serde_json::from_str(&s).unwrap();
    assert_eq!(json["payload"]["markdown"], true);
    assert_eq!(json["payload"]["text"], "**hi**");
}
```

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands.rs src-tauri/src/envelope.rs
git commit -m "feat(summary): send_text 加 markdown 参数写入信封 payload"
```

---

### Task 2: 后端 — send_reply 改走信封

**Files:**
- Modify: `src-tauri/src/commands.rs:1165-1178`

- [ ] **Step 1: send_reply 改为信封 + 保留 set_quote**

`send_reply`(commands.rs:1165) 加 `markdown: bool` 参数,正文改信封:

```rust
pub async fn send_reply(
    state: State<'_, AppState>,
    chat_id: u32,
    text: String,
    quote_msg_id: u32,
    markdown: bool,
) -> AppResult<u32> {
    let ctx = state.current().await.ok_or(AppError::Core("no account".into()))?;
    let chat_id = deltachat::chat::ChatId::new(chat_id);
    let payload = serde_json::json!({ "text": text, "quote_msg_id": quote_msg_id, "markdown": markdown });
    let envelope = crate::envelope::build_envelope("reply", payload)?;
    let mut msg = Message::new_text(envelope);
    let quote = Message::load_from_db(&ctx, MsgId::new(quote_msg_id)).await?;
    msg.set_quote(&ctx, Some(&quote)).await?;
    let sent_id = chat::send_msg(&ctx, chat_id, &mut msg).await?;
    Ok(sent_id.to_u32())
}
```

- [ ] **Step 2: 提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(summary): send_reply 改走信封(payload 含 markdown)保留 set_quote"
```

---

### Task 3: 前端 — envelope.ts 加 envelopeMarkdown

**Files:**
- Modify: `src/utils/envelope.ts:34-38` (envelopeText 之后)

- [ ] **Step 1: 加 envelopeMarkdown 读取器**

envelopeText 函数后加:

```ts
/** 取信封 md 标记:payload.markdown === true 才 true(布尔严格校验)。 */
export function envelopeMarkdown(env: Envelope): boolean {
  return env.payload.markdown === true;
}
```

- [ ] **Step 2: 提交**

```bash
git add src/utils/envelope.ts
git commit -m "feat(markdown): envelope.ts 加 envelopeMarkdown 读取器"
```

---

### Task 4: 前端 — message.ts 正文 + 引用块按 markdown 渲染

**Files:**
- Modify: `src/chat/message.ts:185-193`

- [ ] **Step 1: 改正文渲染分支**

第 193 行 `const textHtml = renderText(resolveMessageText(msg.text));` 改为:

```ts
// 正文:信封带 markdown:true → md 渲染;否则纯文本
const env = tryParseEnvelope(msg.text);
const isMd = env ? envelopeMarkdown(env) : false;
const textHtml = isMd
  ? renderMarkdown(resolveMessageText(msg.text))
  : renderText(resolveMessageText(msg.text));
```

- [ ] **Step 2: 改引用块渲染(遵循被引用消息 markdown)**

第 186-191 行 quoteBlock 改为:

```ts
// 引用块:遵循被引用消息信封内的 markdown 字段(quote_text 即被引用消息完整信封)
const qEnv = msg.quote_text ? tryParseEnvelope(msg.quote_text) : null;
const qIsMd = qEnv ? envelopeMarkdown(qEnv) : false;
const qText = msg.quote_text ? resolveMessageText(msg.quote_text).slice(0, 80) : '';
const quoteBlock = msg.quote_text
  ? `<div class="msg-quote" data-quote-msg="${msg.quote_msg_id ?? ''}" title="点击跳转原文">
      <span class="msg-quote-name">${escapeHtml(msg.quote_from || '')}</span>
      <span class="msg-quote-text">${qIsMd ? renderMarkdown(qText) : escapeHtml(qText)}</span>
    </div>`
  : '';
```

- [ ] **Step 3: 补 import**

message.ts 顶部加 `import { renderMarkdown } from '../utils/markdown.js';`(若未引入)。现有 `tryParseEnvelope`/`envelopeMarkdown` 来自 envelope.ts——检查 envelope 导入是否含这两个(当前只 import resolveMessageText,需扩展)。

将 message.ts:2 `import { resolveMessageText } from '../utils/envelope.js';` 改为 `import { resolveMessageText, tryParseEnvelope, envelopeMarkdown } from '../utils/envelope.js';`

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出(通过)

- [ ] **Step 5: 提交**

```bash
git add src/chat/message.ts
git commit -m "feat(markdown): 正文/引用块按 markdown 字段分支渲染"
```

---

### Task 5: 前端 — composer 加 md 开关 + 检测 + 发送传参

**Files:**
- Modify: `src/chat/composer.ts` (工具栏 DOM 95-99、send 701-705、输入监听)
- Modify: `src/styles.css` (开关组样式 + 呼吸灯)

- [ ] **Step 1: 工具栏加 Markdown 开关 DOM**

`.composer-tools` 里 attach 按钮后加 iOS 风格 toggle(复用现有 `.toggle-switch`):

```ts
<div class="composer-tools">
  <button type="button" class="composer-tool" id="composer-attach" title="附件">${iconSvg('paperclip', { width: 18, height: 18 })}</button>
  <label class="composer-md-toggle" title="Markdown 渲染">
    <span class="composer-md-label">M↓</span>
    <span class="toggle-switch">
      <input type="checkbox" id="composer-md" ${mdEnabled ? 'checked' : ''} />
      <span class="toggle-slider"></span>
    </span>
  </label>
  <button type="button" class="composer-tool" id="composer-more" title="更多">${iconSvg('more-horizontal', { width: 18, height: 18 })}</button>
</div>
```

- [ ] **Step 2: 加 localStorage 读写 + 状态**

renderComposer 开头(或工具条绑定区)加:

```ts
// md 开关:默认开,localStorage 持久化
const MD_KEY = 'peyt.md.enabled';
const getMdEnabled = (): boolean => localStorage.getItem(MD_KEY) !== '0';
const setMdEnabled = (v: boolean): void => localStorage.setItem(MD_KEY, v ? '1' : '0');
let mdEnabled = getMdEnabled();
```

- [ ] **Step 3: 绑定开关切换 + 输入 md 语法检测**

工具条绑定区加:

```ts
const mdToggle = document.getElementById('composer-md') as HTMLInputElement | null;
const mdWrap = composerEl?.querySelector('.composer-md-toggle');
// iOS 开关:true 仅控制本条消息发送的 markdown 字段(不碰引用块渲染)
mdToggle?.addEventListener('change', () => {
  mdEnabled = mdToggle.checked;
  setMdEnabled(mdEnabled);
  mdWrap?.classList.remove('md-hint');
});
// 关闭时检测 md 语法 → 呼吸灯提示(手动开启才熄灭,不自动改)
const MD_RE = /#{1,6}\s|\*\*|`{1,3}|^\s*[-*>|]\s|\[.+\]\(.+\)/m;
input.addEventListener('input', () => {
  if (mdEnabled || !mdToggle) return;
  const hasMd = MD_RE.test(input.value);
  mdWrap?.classList.toggle('md-hint', hasMd);
});
```

- [ ] **Step 4: send 传 markdown 参数**

send 函数 701-705 改:

```ts
// md 开关状态从 localStorage 读(发送时取最新,跨重渲染一致)
const mdOn = localStorage.getItem('peyt.md.enabled') !== '0';
if (replyTo) {
  await call('send_reply', { chatId, text, quoteMsgId: Number(replyTo), markdown: mdOn });
  delete area.dataset.replyTo;
} else {
  await call('send_text', { chatId, text, markdown: mdOn });
}
```

> 注:send 是文件级函数,从 localStorage 读 md 状态避免给 4 处调用点(131/269/274/730)逐个传参。renderComposer 内的 `mdEnabled` 变量仅驱动开关 UI + 检测;发送时统一读 localStorage 保证一致(开关 change 时已写入)。

- [ ] **Step 5: CSS — 开关组样式 + 呼吸灯**

styles.css 加(工具栏区):

```css
/* md 开关组:label + iOS toggle 内联 */
.composer-md-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 0 4px; cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 140ms var(--ease-out);
}
.composer-md-toggle:hover { background: var(--active); }
.composer-md-label { font-size: 11px; font-weight: 600; color: var(--text-mute); }
/* 关闭时检测到 md 语法 → 呼吸灯 */
.composer-md-toggle.md-hint { animation: md-breathe 1.6s ease-in-out infinite; }
@keyframes md-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(74, 144, 217, 0.5); }
  50% { box-shadow: 0 0 0 4px rgba(74, 144, 217, 0.18); }
}
@media (prefers-reduced-motion: reduce) {
  .composer-md-toggle.md-hint { animation: none; }
}
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出(通过)

- [ ] **Step 7: 提交**

```bash
git add src/chat/composer.ts src/styles.css
git commit -m "feat(markdown): composer md 开关(iOS toggle)+ md 语法呼吸灯 + 发送传参"
```

---

### Task 6: 验证 + 收尾

**Files:** 无新增

- [ ] **Step 1: 前端全量类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出(通过)

- [ ] **Step 2: 前端 vite 构建**

Run: `npx vite build`
Expected: 构建成功,无错误

- [ ] **Step 3: 后端编译(可选,需 5-7 分钟)**

Run: `cargo check` (在 src-tauri 下)
Expected: 无 error;若环境缺 Strawberry Perl 需 `export PATH="/c/Strawberry/perl/bin:$PATH"`

- [ ] **Step 4: 人工验收点**

- 发送 `**粗体**` 文本(md 开关开)→ 气泡内粗体渲染
- 关开关发同文本 → 纯文本显示 `**粗体**`
- 关开关输入 `# 标题` → 开关组呼吸灯,点开熄灭
- md 消息被引用 → 引用块 md 渲染;纯文本消息被引用 → 引用块纯文本(与 Switch 无关)
- 重启应用 → md 开关保持上次状态

---

## Self-Review

**Spec 覆盖检查:**
- §3.1 send_text markdown 参数 → Task 1 ✓
- §3.2 send_reply 信封 + set_quote → Task 2 ✓
- §3.3 bot_send_text false → Task 1 Step 3 ✓
- §4.1 envelopeMarkdown → Task 3 ✓
- §4.2 正文 + 引用块分支 → Task 4 ✓
- §4.3 composer 开关 + 检测 → Task 5 ✓
- §4.4 呼吸灯 + reduced-motion → Task 5 Step 5 ✓
- Switch 只控制发送方、引用块独立 → Task 4 Step 2 + Task 5 Step 3 ✓
- §7 测试 → envelope.rs 扩展 (Task 1) + tsc/build (Task 6) ✓

**Type 一致性:** `mdEnabled` 在 Task 5 定义并在 send 调用点引用;send 签名需同步改(Step 4 已注明)。`envelopeMarkdown`/`tryParseEnvelope` 在 Task 3 定义、Task 4 引用、message.ts import 扩展在 Task 4 Step 3。✓

**占位符检查:** 无 TBD/TODO;每个步骤含实际代码/命令。✓
