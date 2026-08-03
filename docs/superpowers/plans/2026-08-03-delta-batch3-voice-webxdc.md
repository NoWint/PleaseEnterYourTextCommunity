# Delta 对齐批次 3 实施计划（语音消息 / Webxdc 应用）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Delta Chat 对齐批次 3 的 2 个子系统：语音消息（录制 + 播放器）、Webxdc 应用（消息卡片 + 沙箱运行时 + StatusUpdate 同步）。

**Architecture:** 桥接 core + 前端 UI。后端统一加 `send_attachment(chatId, filePath, viewtype)` 命令（core `chat::send_msg` + `Message::set_file_and_deduplicate`）；语音前端用 MediaRecorder 录制 WebM/Opus 发送；Webxdc 前端渲染卡片 + iframe 运行时，经 asset 协议加载沙箱资源。

**Tech Stack:** Tauri v2 (Rust) + Vanilla TS/Vite + deltachat core 2.58（assetProtocol 已开启，CSP null）

---

## 文件边界（子代理隔离关键）

| 子系统 | 独占文件 | 共享（主 Agent 收尾） | 不得触碰 |
|---|---|---|---|
| **3.1 语音** | `src/components/voicePlayer.ts`（新建）、`src/chat/composer.ts`（录音按钮） | `src-tauri/src/commands.rs`（send_attachment）、`src/chat/message.ts`（Voice 附件渲染） | webxdc 文件 |
| **3.2 Webxdc** | `src/components/webxdc.ts`（新建） | `src-tauri/src/commands.rs`（webxdc 命令）、`src/chat/message.ts`（Webxdc 卡片渲染） | 语音文件 |

**冲突规避**：
- `src-tauri/src/commands.rs`、`src/chat/message.ts` 由**主 Agent 统一收尾**（send_attachment 命令 + Voice/Webxdc 消息渲染），子代理不碰。
- `src/chat/composer.ts` 语音子代理改（加录音按钮），webxdc 子代理不碰。
- 每个子代理完成后汇报主 Agent，不自行 commit。

---

## 任务 A：语音消息（3.1）

**主 Agent 后端契约**：
- `send_voice(chatId, base64)` — base64 是录音 blob（WebM/Opus）。后端解码 → `Message::new(Viewtype::Voice)` + `set_file_from_bytes` → `chat::send_msg`。无文件系统依赖（Tauri 项目零插件）。

**Files:**
- Create: `src/components/voicePlayer.ts`
- Modify: `src/chat/composer.ts`（录音按钮 + 录音态 UI）
- Modify: `src/chat/message.ts`（Voice 消息渲染为播放器 — 主 Agent 做）
- Modify: `src-tauri/src/commands.rs`（send_attachment — 主 Agent 做）

- [ ] **Step 1: voicePlayer.ts**

```ts
// 消息内语音播放器:波形(可用 canvas 或 CSS 模拟)+ 播放/暂停 + 进度
// 对齐 Delta AudioPlayer。点击播放/暂停,显示当前时间/总时长。
export function renderVoicePlayer(assetUrl: string, durationSec: number): string { ... }
export function bindVoicePlayer(container: HTMLElement): void { ... }
```

- [ ] **Step 2: composer 录音按钮**

在 composer-row 加录音按钮（mic 图标）。点击/按住开始 MediaRecorder 录制，录制态显示计时 + 取消/发送。发送时把 blob 存到临时文件并调 `send_attachment(chatId, filePath, 'Voice')`。

**录音流程**：
1. `navigator.mediaDevices.getUserMedia({ audio: true })`
2. `new MediaRecorder(stream)` → 收集 chunks → `new Blob(chunks, { type: 'audio/webm' })`
3. Blob → base64（`FileReader.readAsDataURL` 或 `arrayBuffer` → `btoa`）→ `call('send_voice', { chatId, base64 })`

- [ ] **Step 3: tsc + build**

Run: `npx tsc --noEmit` + `npx vite build`。

---

## 任务 B：Webxdc 应用（3.2）

**主 Agent 后端契约**：
- `get_webxdc_info(msgId)` → core `get_webxdc_info`
- `get_webxdc_status_updates(msgId)` → core `get_webxdc_status_updates`
- `send_webxdc_status_update(msgId, payload)` → core `send_webxdc_status_update`
- `get_webxdc_blob(name)` → core `get_webxdc_blob`（返回 base64）
- shell.ts 已有 `WebxdcStatusUpdate`/`WebxdcRealtimeData` no-op handler，主 Agent 实现

**Files:**
- Create: `src/components/webxdc.ts`
- Modify: `src/chat/message.ts`（Webxdc 卡片渲染 — 主 Agent 做）
- Modify: `src-tauri/src/commands.rs`（webxdc 命令 — 主 Agent 做）

- [ ] **Step 1: webxdc.ts 消息卡片 + 运行时**

```ts
// 消息内 webxdc 卡片:图标 + 名称 + 摘要 + 启动按钮(对齐 Delta WebxdcMessageContent)
export function renderWebxdcCard(msg: MsgDto): string { ... }

// Webxdc 沙箱运行时:iframe 加载 webxdc.html + 注入 webxdc.js API
// 用 asset 协议(transformBlobURL)加载沙箱资源
export async function openWebxdc(msg: MsgDto): Promise<void> { ... }
```

- [ ] **Step 2: 沙箱 iframe + StatusUpdate**

运行时 iframe 内注入 `window.webxdc` API：
- `sendUpdate(update, desc)` → 调 `send_webxdc_status_update`
- `getNextUpdate()` → 调 `get_webxdc_status_updates`
- 监听 `WebxdcStatusUpdate` 事件 → 推给 iframe 内的 webxdc

**注意**：沙箱安全——iframe `sandbox` 属性 + `src` 用 asset 协议。子代理实现基础版，安全细节主 Agent review。

- [ ] **Step 3: tsc + build**

Run: `npx tsc --noEmit` + `npx vite build`。

---

## 收尾（主 Agent 执行，非子代理）

- [ ] **主 Agent: send_voice 命令**
  - `send_voice(chatId, base64)` → 解码 → `Message::new(Viewtype::Voice)` + `set_file_from_bytes` → `chat::send_msg`
- [ ] **主 Agent: webxdc 命令**
  - `get_webxdc_info` / `get_webxdc_status_updates` / `send_webxdc_status_update` / `get_webxdc_blob`
- [ ] **主 Agent: message.ts 渲染**
  - Voice viewtype → voicePlayer；Webxdc viewtype → webxdc card
- [ ] **主 Agent: lib.rs 登记**所有新命令
- [ ] **主 Agent: shell.ts 实现 WebxdcStatusUpdate handler**
- [ ] **主 Agent: 全量验证**（tsc + vite build + cargo check）
- [ ] **主 Agent: commit**

```bash
git add src/ src-tauri/
git commit -m "feat(chat): Delta batch 3 — voice messages, webxdc apps"
```

---

## 自审记录

- **语音录音的写文件路径**：标为「主 Agent 契约」，子代理按契约实现，避免不确定性。
- **Webxdc 沙箱安全**：基础版子代理实现，主 Agent review 沙箱属性。
- **一致性**：send_attachment 返回 msg_id（u32）；webxdc blob 返回 base64 字符串。
- **隔离**：语音/webxdc 前端文件互斥；message.ts/commands.rs/lib.rs 主 Agent 收尾。
