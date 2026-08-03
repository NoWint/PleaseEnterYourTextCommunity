# 事件流（deltachat 核心 → 前端）

```
核心 EventEmitter（tokio broadcast）
  → events.rs spawn_event_forwarder()（tokio::spawn 循环，match 22 个变体）
  → app.emit("dc-event", EventPayload)
  → 前端 onEvent(typ, cb)（api.ts，按 payload.typ 过滤）
  → 各处理器（全部订阅集中在 shell/shell.ts）
```

`EventPayload`：`{ typ, chat_id?, msg_id?, contact_id?, progress?, comment?, text? }`（null 字段会作为 `null` 序列化，不省略）。`IncomingMsg` 的 `text` 是消息前 80 字符（空则 viewtype 标签如 `"[image]"`）。未匹配的事件变体静默丢弃。

## 转发的 22 个事件

| typ | 前端处理 |
|---|---|
| `IncomingMsg` | `handleIncomingMsg`——核心路由：[CARD]/[PEYT_INVITE] 前缀拦截（见 conventions.md）、@提及记录、通知。属于当前聊天则 `refreshCurrentChat`（增量），否则桌面 Notification 点击跳转 |
| `MsgsChanged` | `refreshCurrentChat` + `refreshSidebar` + `updateBadge` |
| `ChatlistItemChanged` / `ChatModified` / `ContactsChanged` | `refreshSidebar` + `updateBadge` |
| `SelfavatarChanged` | 重取 self profile + 重渲染 rail |
| `MsgDelivered` / `MsgFailed` / `MsgRead` | `updateMsgState(msgId, state)` DOM 补丁 |
| `MsgDeleted` | `removeMsg(msgId)` |
| `ReactionsChanged` / `IncomingReaction` | `refreshMsgReactions(msgId)`（含 reactionsCache 更新） |
| `ChatDeleted` | 从 state 移除频道 + 重渲染 |
| `MsgsNoticed` / `IncomingMsgBunch` / `SecurejoinJoinerProgress` / `SecurejoinInviterProgress` / `WebxdcStatusUpdate` / `WebxdcRealtimeData` / `WebxdcInstanceDeleted` / `ChatEphemeralTimerModified` | no-op |
| `ConfigureProgress` | 登录页进度条（`create_chatmail_account`/`login` 期间） |

## 关键处理器

- `handleIncomingMsg(e)`（shell.ts）：**按顺序**先查 `[CARD]`、再查 `[PEYT_INVITE]`，都命中即 return（不渲染为普通消息）。否则正常流程：@提及检测 → 当前聊天则增量刷新 → 其他聊天则桌面通知。
- `refreshSidebar()`：**150ms 防抖包装**（合并 realtime 事件风暴），触发后 `doRefreshSidebar()` 重拉 chatlist / channels / workspaces，重渲染 rail + navPanel。
- `refreshCurrentChat()`：当前聊天实时增量（chatView.appendNewMessages）。
- `updateBadge()`：chatlist 未读求和 → `window.__TAURI__.app.setBadgeCount`（Dock 徽标）。

## 修改事件处理时的注意

- **新增事件订阅**：加在 `shell/shell.ts` 的订阅区（保持集中），`onEvent(typ, cb)` 返回 unlisten 函数。
- 事件名是 `payload.typ` 字符串，与 Rust `EventType` 变体一一对应（events.rs 里映射）。
- 核心事件 `_` 变体不转发——需要新事件时要在 `events.rs` 加 match 分支。
