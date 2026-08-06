# 消息 Markdown 渲染设计

日期:2026-08-06
状态:设计定稿
范围:text/reply 信封 payload 新增 `markdown` 布尔字段;composer-toolbar 加 iOS 风格 markdown 开关;消息体按字段决定是否 md 渲染。

## 1. 背景与动机

### 1.1 现状

- **发送**:`send_text` → 后端 `build_envelope("text", {"text"})` 信封 JSON 发出。`send_reply` 走 core 原生 quote(正文纯文本,**不走信封**)。
- **接收**:前端 `resolveMessageText(text)` 解析信封 → `payload.text`;`renderText` 渲染(代码块高亮/链接/emoji 放大,**非完整 markdown**)。
- **已有 markdown 引擎**:`renderMarkdown`(marked + 白名单清洗 + `<message>`/`<user>` 可点击标签),summary 面板在用。

### 1.2 目标

1. text 信封 payload 加 `markdown` 布尔字段,消息体按字段决定 md 渲染。
2. composer-toolbar 加 iOS 风格 markdown 开关(默认开,localStorage 持久化)。
3. 开关关闭且检测到 md 语法 → 开关组呼吸灯提示(手动开启,不自动改)。
4. reply 改走信封(正文=信封 JSON),保留 core `set_quote`。
5. 引用块遵循被引用消息的 markdown 字段(quote_text 即被引用消息完整信封,前端解析其 payload.markdown)。
6. HTML 未来走独立 `type:"html"` 从类型层面切换,本期不做(见 §8)。

### 1.3 非目标

- 不实现 HTML 渲染(协议预留)。
- 不改 `renderMarkdown` 引擎本身。
- 不做跨设备开关同步。

## 2. 信封协议扩展

### 2.1 text payload

```json
{
  "type": "text",
  "id": "<uuid>",
  "payload": { "text": "你好", "markdown": true }
}
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `markdown` | bool | `true` → 前端 md 渲染;缺失/`false` → 纯文本 |

**markdown 字段语义(重要)**:`markdown` 字段只描述**这条消息自身正文**是否 md 渲染。composer 的 Switch 只控制发送时给 text 消息写入的 `markdown` 值;**引用块不随 Switch 状态变化**——引用块渲染遵循被引用消息信封内的 `markdown` 字段(见 §4.2)。两者独立。

兼容性:老端忽略新字段(读不懂 markdown 时按纯文本渲染);`markdown: true` 但正文非 md 语法 → 渲染结果与纯文本几乎一致(marked 幂等)。

### 2.2 reply payload

reply 改走信封,正文=`{"type":"reply","payload":{...}}`,同时保留 core `set_quote`:

```json
{
  "type": "reply",
  "id": "<uuid>",
  "payload": { "text": "回复", "quote_msg_id": 150, "markdown": true }
}
```

`quote_msg_id` 与信封 `id` 并存:`id` 是发送端幂等键,`quote_msg_id` 是前端跳转原文用。core `set_quote` 保留(引用关系通知/跨端)。

### 2.3 识别规则(不变)

text 以 `{` 开头 → JSON.parse 成功 → type/id/payload 齐全 → 信封。`type ∈ {text, reply}` 才渲染;未知 → 原文兜底。

## 3. 后端改动

### 3.1 send_text

`send_text(chat_id, text, markdown: bool)` 新增参数。payload 构造:

```rust
let payload = serde_json::json!({ "text": text, "markdown": markdown });
```

### 3.2 send_reply

`send_reply(chat_id, text, quote_msg_id, markdown: bool)` 新增参数。改为信封 + core quote:

```rust
let payload = serde_json::json!({ "text": text, "quote_msg_id": quote_msg_id, "markdown": markdown });
let envelope = crate::envelope::build_envelope("reply", payload)?;
let mut msg = Message::new_text(envelope);
let quote = Message::load_from_db(&ctx, MsgId::new(quote_msg_id)).await?;
msg.set_quote(&ctx, Some(&quote)).await?;
let sent_id = chat::send_msg(&ctx, chat_id, &mut msg).await?;
```

### 3.3 bot_send_text

`send_text_impl(ctx, chat_id, text, markdown)` 签名加 `markdown` 参数。`bot_send_text`(commands.rs:3697)调用时传 `false`——bot AI 回复是纯文本,不带 md 标记。

## 4. 前端改动

### 4.1 envelope.ts

新增 `envelopeMarkdown(env)`:

```ts
/** 取信封 md 标记:payload.markdown === true 才 true(布尔严格校验)。 */
export function envelopeMarkdown(env: Envelope): boolean {
  return env.payload.markdown === true;
}
```

### 4.2 message.ts 渲染分支

`renderMessage` 解析信封后:

```ts
// 正文
const env = tryParseEnvelope(msg.text);
const isMd = env ? envelopeMarkdown(env) : false;
const textHtml = isMd ? renderMarkdown(resolveMessageText(msg.text)) : renderText(resolveMessageText(msg.text));
// 引用块:遵循被引用消息的 markdown 字段。
// core 的 get_text() 对信封消息返回完整信封 JSON —— quote_text 即被引用消息的原始信封串。
// 前端 tryParseEnvelope(quote_text) 解析出被引用消息的 payload.markdown,决定引用块是否 md 渲染。
const qEnv = msg.quote_text ? tryParseEnvelope(msg.quote_text) : null;
const qIsMd = qEnv ? envelopeMarkdown(qEnv) : false;
const qText = msg.quote_text ? resolveMessageText(msg.quote_text).slice(0, 80) : '';
const quoteHtml = qIsMd ? renderMarkdown(qText) : escapeHtml(qText);
```

关键洞察:`quote_text` = core `q.get_text()` = 被引用消息的**完整信封 JSON**。前端已用 `resolveMessageText(quote_text)` 剥出 text;再 `tryParseEnvelope(quote_text)` 即可读被引用消息的 `markdown` 字段——**引用块自动遵循被引用消息的 md 状态,零额外后端字段**。

### 4.3 composer 开关

- composer-toolbar 左侧加「Markdown」label + iOS 风格 switch(仿 iPhone 设置 toggle)。
- 默认开,状态存 localStorage(key 如 `peyt.md.enabled`)。
- 发送时传 `markdown` 状态给 `send_text`/`send_reply`,写入**本条消息**信封的 markdown 字段。
- **Switch 只管发送方**:只控制本条 text 消息是否带 md 渲染。**不控制引用块**——引用块渲染遵循被引用消息信封内的 markdown 字段(见 §4.2),与 Switch 状态无关。
- 自动检测:开关关时,输入文本检测 md 语法(`#`/`**`/`` ` ``/`-`/`>`/`|`/`[text](url)` 等) → 开关组加呼吸灯 class;手动点开开关 → 熄灭。

### 4.4 呼吸灯

CSS:开关组 `@keyframes` 呼吸(透明度 0.5→1 循环),参考现有 `bubble-breathe-detail`。`prefers-reduced-motion` 禁用。

## 5. 数据流

```
发送:composer Switch 状态 → send_text/send_reply(markdown) → 后端信封 JSON(本条消息字段) → core 存储
接收:renderMessage → tryParseEnvelope → envelopeMarkdown → renderMarkdown/renderText → 气泡 DOM
引用:quote_text = 被引用消息完整信封 → tryParseEnvelope → 被引用消息的 markdown 字段决定引用块渲染(与 Switch 无关)
```
```

## 6. 错误处理

- 信封解析失败 → `resolveMessageText` 原文兜底(现有逻辑不变)。
- 引用块 `quote_text` 解析失败(非信封)→ `resolveMessageText` 原文兜底,纯文本显示。
- `markdown: true` 但正文非 md → 渲染结果接近纯文本(marked 幂等)。
- 老端收 md 信封 → 忽略 markdown 字段,按纯文本显示(正文是原文 text,不丢内容)。
- 开关持久化失败 → 默认开回退。

## 7. 测试

- 后端:`send_text`/`send_reply` payload 含 markdown 字段;reply 信封结构 + set_quote 保留。
- 前端:envelopeMarkdown 布尔严格校验(true/缺失/非布尔);渲染分支(md/纯文本)。
- 引用块:被引用消息是 md 信封 → 引用块 md 渲染;纯文本消息 → 引用块纯文本(遵循被引用消息)。
- **Switch 不控制引用块**:发送方 Switch 状态只写本条消息 markdown 字段;引用块渲染完全由被引用消息信封内的 markdown 决定,与 Switch 无关。
- 引用块 quote_text 非信封(旧消息)→ 原文兜底纯文本。

## 8. 未来预留(本期不做)

HTML 渲染走独立 `type:"html"`,从类型层面切换,不进 text payload。届时:

```json
{ "type": "html", "payload": { "html": "<p>...</p>" } }
```

复用 `renderMarkdown` 的清洗层(白名单/scheme 校验/on* 剥除)做 HTML 安全。本期仅确保协议结构不冲突(type 独立,payload 字段名 html 不与 text 的 markdown 冲突)。

## 9. 兼容性

- 老消息(无 markdown 字段) → 纯文本渲染,不变。
- 老客户端收新信封 → 忽略 markdown,显示纯文本。
- 新客户端收旧信封 → 无 markdown 字段,纯文本。
