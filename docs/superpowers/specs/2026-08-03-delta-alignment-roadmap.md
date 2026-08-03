# Delta Chat 功能对齐路线图

- 日期: 2026-08-03
- 状态: 已确认，待逐项 spec
- 范围: 全面对齐 Delta Chat 桌面端功能（除账号切换外），核心依赖 deltachat 2.58.0-dev

## 0. 全局设计约束

### 0.1 本地永久留存

**PEYT 不做自动删除旧消息。** 所有消息在本地 SQLite（core 的 deltachat.sqlite + 后端 app 级 db.sqlite）**永久保存**，任何子系统不得引入自动清理逻辑（Delta 的全局 Autodelete、会话级自动过期均不实现）。

**Why**：PEYT 的定位是内部沟通产品的数据资产库，消息是持久记录而非短暂会话。

**How to apply**：
- 路线图明确排除 Autodelete / Disappearing Messages
- 由于数据无限增长，以下子系统必须承担大数据量：
  - 搜索（`search_msgs` 索引要能承受数十万条消息）
  - 虚拟化消息渲染（已用增量 DOM 更新，滚动性能已达标）
  - 数据库（SQLite 常规量级无碍，不需要 WAL 优化之外的干预）
- 后续若真出现性能瓶颈，优先考虑**归档/索引优化**，而非删除数据

### 0.2 桥接优先

deltachat 2.58.0-dev core 已内置绝大多数 Delta 能力（Webxdc、Voice、EphemeralTimer、归档、保存消息、备份、多设备、搜索、Autocrypt E2EE）。**路线图内绝大多数子系统是「桥接 core API + 前端 UI 对齐」，不修改协议核心。** 每个子系统标注 core API 是否已存在。

### 0.3 事件流

所有实时更新经现有事件桥（Rust `events.rs` → Tauri `dc-event` → 前端 `api.ts` `onEvent` 单一 listener 分发）。新增子系统复用此通道，不另开事件通道。

## 1. 目标与非目标

### 目标
把 PEYT 的消息体验、媒体能力、运行时能力、系统集成对齐到 Delta Chat 桌面端的成熟水平。

### 非目标
- **账号切换/多账号管理**（用户明确排除）
- **自动删除旧消息 / 消失消息**（用户明确排除，见 0.1）
- 移动端（Android/iOS）
- Markdown 富文本渲染：**未决**（Delta 从未稳定提供；若做则属自研，见变更记录。待用户确认后可能纳入批次 2）

## 2. 批次划分

按「先易后难」分批，每批内按依赖排序。每个子系统一个独立 spec → plan → 实施循环。

| 批次 | 子系统 | 依赖 | 复杂度 |
|---|---|---|---|
| **1 基础层** | 归档 | 无 | 低 |
| | 保存消息 / 设备聊天 | 无 | 低 |
| | 草稿系统 | 无 | 低 |
| **2 消息体验** | 全局搜索 + 会话内搜索 | 批次1 | 中 |
| | Gallery 相册 | 批次1 | 中 |
| | 命令面板 | 批次1 | 中 |
| | 邮件列表 / 广播列表 | 无 | 低 |
| **3 媒体与运行时** | 语音消息 | 批次2 | 高 |
| | Webxdc 应用 | 批次2 | 高 |
| **4 系统与安全** | 系统通知弹窗回复 | 批次3 | 中 |
| | 验证群 / 保护状态 | 批次3 | 中 |
| | 多设备绑定 | 批次3 | 高 |
| | 备份 / 恢复 | 批次3 | 中 |
| | **通话**（VoIP 音频/视频） | 批次3 | 高 |

## 3. 子系统详细对齐规格

每个子系统的模板字段：功能描述 → 对齐点（复刻哪些 Delta 行为）→ 后端命令清单 → 前端 UI 清单 → 数据模型 → 工作量估算 → 依赖。

### 批次 1 — 基础层

#### 1.1 归档

- **功能描述**：支持把会话归档（从主列表移出）与取消归档；提供归档视图查看已归档会话。
- **对齐点**：Delta 中栏 ChatListHeader 的「归档视图」切换（`ChatList_SwitchToArchiveView`），ChatListItem 带归档标记、置顶排序规则（归档不置顶）。
- **后端命令清单**：
  - `archive_chat(chatId, archive: bool)` → core `set_chat_visibility` / `archiveChat`
  - `get_chatlist(archive: bool)` → 扩展现有命令带归档过滤
- **前端 UI 清单**：
  - ChatList 头部归档视图切换按钮
  - ChatListItem 归档标记 + 上下文菜单「归档/取消归档」
- **数据模型**：core 已持久化归档状态，无 app 级新表。
- **工作量估算**：小（纯桥接 + 前端）。
- **依赖**：无。

#### 1.2 保存消息 / 设备聊天

- **功能描述**：「保存的消息」— 一个特殊 chat，收藏的消息汇总；「设备聊天」— 本机自聊/系统通知。
- **对齐点**：Delta 中保存消息可右键收藏（`saveMsgs`），保存的消息在导航栏有独立入口（书签图标）；设备聊天是自营 chat（`is_self_talk` / device talk）。
- **后端命令清单**：
  - `save_msg(msgId)` / `unsave_msg(msgId)` → core `save_msgs` / `delete_msgs`
  - 导航已能识别 `is_self_talk`（chatlist filter 已排除），新增入口识别「保存的消息」
- **前端 UI 清单**：
  - 导航栏「保存的消息」入口
  - 消息右键菜单「保存 / 取消保存」
  - 消息 footer 书签图标（`saved` 状态，对齐 `MessageMetaData.tsx` 的 saved-message-icon）
- **数据模型**：core 持久化 savedMessageId，无 app 级新表。
- **工作量估算**：小。
- **依赖**：无。

#### 1.3 草稿系统

- **功能描述**：Composer 输入自动保存草稿，切换会话后回来恢复；会话列表显示「草稿」标记。
- **对齐点**：Delta `useDraft` hook，草稿按会话存储；ChatListItem 显示草稿文本 + 「草稿」标签。
- **后端命令清单**：
  - `get_draft(chatId)` / `set_draft(chatId, text)` → core draft API
- **前端 UI 清单**：
  - Composer textarea 防抖保存草稿
  - 会话切换时读取/恢复草稿
  - ChatListItem 草稿标记
- **数据模型**：core 持久化 draft。
- **工作量估算**：小。
- **依赖**：无。

### 批次 2 — 消息体验

#### 2.1 全局搜索 + 会话内搜索

- **功能描述**：顶部搜索框全局搜（会话/联系人/消息），会话内搜索（`ChatList_SearchInChat`）定位到具体消息并高亮跳转。
- **对齐点**：Delta 全局搜索在当前 `search.ts` 基础上补消息结果 + 跳转；会话内搜索在 ChatView 头部搜索按钮，结果用 `jumpToMessage` 高亮定位。
- **后端命令清单**：
  - 复用现有 `search_msgs`；可能需要 `search_msgs(chatId, query)` 带会话过滤参数
- **前端 UI 清单**：
  - 全局搜索弹层：会话/联系人/消息三 tab 结果
  - 会话内搜索条：ChatView 头部展开
  - 消息高亮跳转（滚动到消息 + 临时高亮）
- **数据模型**：无新表（core 自带 FTS 索引）。
- **工作量估算**：中。
- **依赖**：批次1（消息操作）。

#### 2.2 Gallery 相册

- **功能描述**：会话内媒体网格视图（`Gallery.tsx`），全屏查看（`FullscreenMedia`）、相邻媒体切换。
- **对齐点**：Delta ChatView 头部「apps_and_media」按钮打开 Gallery；媒体按类型过滤（图片/视频/音频/文件），网格 + 全屏。
- **后端命令清单**：
  - `get_chat_media(chatId, viewType)` → core 媒体列表查询
- **前端 UI 清单**：
  - Gallery 网格页（图库、文件、视频、音频 tabs）
  - 全屏媒体查看器 + 相邻切换
- **数据模型**：无新表。
- **工作量估算**：中。
- **依赖**：批次1（消息渲染基线）。

#### 2.3 命令面板

- **功能描述**：Cmd/Ctrl+P 打开命令面板，快速执行：新建私聊/群/频道、静音、归档、删除、转设置等。
- **对齐点**：Delta `CommandPalette`，命令带图标 + 快捷键提示 + 模糊搜索。
- **后端命令清单**：复用现有命令（create_chat/create_group/create_channel/archive/delete…），无新命令。
- **前端 UI 清单**：
  - 命令面板组件（现有 `search.ts` 基础扩展）
  - 命令注册表 + 模糊搜索 + 键盘导航
- **数据模型**：无。
- **工作量估算**：中。
- **依赖**：批次1（命令入口）。

#### 2.4 邮件列表 / 广播列表

- **功能描述**：识别并显示 Mailinglist / Broadcast 类型会话（Delta 有独立 profile 视图）。
- **对齐点**：`MailingListProfile` 弹窗、broadcast 已读计数（`MessageMetaData` 的 `ViewCount`）。
- **后端命令清单**：
  - `get_chat_info` 已能返回 chat type，补齐 mailinglist 字段
  - 广播已读数：`get_message_read_receipt_count(msgId)`
- **前端 UI 清单**：
  - MailingList profile 弹窗
  - 广播消息 footer 已读次数（👁 图标 + 数字）
- **数据模型**：无新表。
- **工作量估算**：小-中。
- **依赖**：无。

### 批次 3 — 媒体与运行时

#### 3.1 语音消息

- **功能描述**：Composer 录制语音（按住/点击录音），发送为 Voice viewtype；消息内播放器（波形）+ 全局连续播放。
- **对齐点**：Delta `AudioRecorder`（编码 WebM/Opus）+ `AudioPlayer` 波形 + `GlobalVoiceMessagePlayer` 全局连续播放。
- **后端命令清单**：
  - 复用 `send_text`/`send_file` 路径发 Voice 附件（core 2.58 支持 `Viewtype::Voice`）
  - `get_asset_url` 已能取音频 blob
- **前端 UI 清单**：
  - Composer 录音按钮 + 录音态 UI（计时、取消、发送）
  - 消息内波形播放器（进度、播放/暂停）
  - 全局语音播放器（底部连续播放条，对齐 `GlobalVoiceMessagePlayer`）
- **数据模型**：无新表。
- **工作量估算**：高（录音编码 + 波形渲染 + 全局播放状态机）。
- **依赖**：批次2（消息渲染）。

#### 3.2 Webxdc 应用

- **功能描述**：运行 webxdc 小程序（HTML5 沙箱），消息内应用卡片（图标+名称+摘要+启动）、AppPicker 应用列表、StatusUpdate 同步。
- **对齐点**：Delta `WebxdcMessageContent`、`AppPicker`（左下角应用切换器，从 `https://webxdc.org/apps` 拉取）、`Gallery` 的 webxdc 卡片、`WebxdcStatusUpdate` 实时同步。
- **后端命令清单**：
  - `get_webxdc_info(msgId)` → core `get_webxdc_info`
  - `get_webxdc_status_updates(msgId)` → core `get_webxdc_status_updates`
  - `send_webxdc_status_update(msgId, payload)` → core `send_webxdc_status_update`
  - `get_webxdc_blob(name)` → core `get_webxdc_blob`（前端运行时拉取沙箱资源）
  - 注册 `WebxdcStatusUpdate` / `WebxdcRealtimeData` 事件（shell.ts 已有 no-op handler，需实现）
- **前端 UI 清单**：
  - 消息内 webxdc 卡片（对齐 WebxdcMessageContent）
  - Webxdc 沙箱 iframe 运行时（Tauri 需配置自定义协议/asset 白名单）
  - AppPicker 应用列表（底部左栏或导航入口）
  - StatusUpdate 实时同步
- **数据模型**：core 持久化 webxdc 消息与状态。
- **工作量估算**：高（沙箱运行时 + 安全白名单 + StatusUpdate 协议）。
- **依赖**：批次2（消息渲染）。

### 批次 4 — 系统与安全

#### 4.1 系统通知弹窗回复

- **功能描述**：新消息弹系统通知，macOS 支持直接回复，Windows 通知按钮点击聚焦会话。
- **对齐点**：Delta `system-integration/notifications.ts`（`user_notify` crate，macOS 回复回调）。
- **后端命令清单**：
  - 现有 `IncomingMsg` 事件 → 系统通知已实现（shell.ts `handleIncomingMsg`），补平台级回复回调（Tauri 插件或 Rust 集成）
- **前端 UI 清单**：
  - 通知点击聚焦会话（已实现）
  - macOS 通知直接回复（平台 API）
- **数据模型**：无。
- **工作量估算**：中（平台绑定，Windows 上仅聚焦、macOS 上回复）。
- **依赖**：批次3。

#### 4.2 验证群 / 保护状态

- **功能描述**：显示会话 E2EE 保护状态（已验证/未验证）、群验证徽章、加密指纹详情。
- **对齐点**：Delta `ProtectionStatusDialog`、`EncryptionInfo` 指纹展示、群成员加密状态。
- **后端命令清单**：
  - `get_chat_encryption_info(chatId)` → core 提供指纹/状态
  - `get_contact_encryption_info(contactId)`
- **前端 UI 清单**：
  - ChatView 头部保护状态徽章/对话框
  - 群设置页验证状态
  - 指纹详情对话框（QR 对照）
- **数据模型**：无新表。
- **工作量估算**：中。
- **依赖**：批次3。

#### 4.3 多设备绑定

- **功能描述**：通过扫码/账号在第二台设备登录，同步密钥与消息。
- **对齐点**：Delta `SetupMultiDevice` 对话框（利用 Autocrypt + SecureJoin 绑定）。
- **后端命令清单**：
  - 复用 `secure_join` + `get_securejoin_qr`；core 提供多设备绑定 API
- **前端 UI 清单**：
  - 设置页「多设备」入口 + 绑定二维码/扫码对话框
- **数据模型**：core 管理密钥同步。
- **工作量估算**：高（协议级，涉及密钥导出导入）。
- **依赖**：批次3。

#### 4.4 备份 / 恢复

- **功能描述**：导出完整备份（含密钥），恢复迁移到新设备/新实例。
- **对齐点**：Delta `Backup.tsx` 设置项 + core backup API（`export_backup` / `import_backup`）。
- **后端命令清单**：
  - `export_backup(dest)` → core
  - `import_backup(src)` → core
- **前端 UI 清单**：
  - 设置页「备份与恢复」入口 + 导出/导入对话框
- **数据模型**：core 生成加密备份文件。
- **工作量估算**：中。
- **依赖**：批次3。

#### 4.5 通话（VoIP 音频/视频）

- **功能描述**：音频/视频通话。消息体内渲染通话消息（发起/接听/已结束/未接），点击通话气泡可回拨；接听时弹出独立通话窗口；呼叫支持振铃、来电通知、通话时长显示。
- **对齐点**：Delta 采用 **WebRTC + 信令消息** 架构：
  - core 通话 API 完整存在（`core/src/calls.rs`）：`place_outgoing_call` / `accept_incoming_call` / `end_call` / `call_state` / `ice_servers` / `load_call_by_id`，`CallInfo` / `CallState`（Alerting/Active/Completed/Missed/Declined/Canceled）
  - 来电事件 `IncomingCall` / `IncomingCallAccepted`（`core/src/events/payload.rs`）
  - Delta 前端 `packages/target-electron/src/windows/video-call.ts`：**独立通话 BrowserWindow**，内跑 `calls-webapp`（WebRTC 网页应用），通过 `MessageChannelMain` 与主进程交换信令（offer/answer/iceServers），再经 `placeOutgoingCall` 把 offer 作为消息发出
  - 通话消息体渲染在 `Message.tsx`（`CallIconButton` 回拨按钮）+ `_message-calls.scss`
- **后端命令清单**（全部桥接 core）：
  - `place_outgoing_call(chatId, offer, startWithCameraEnabled)` → core
  - `accept_incoming_call(msgId)` → core
  - `end_call(msgId)` → core
  - `call_state(msgId)` → core `call_state`
  - `ice_servers()` → core（返回 TURN/STUN 服务器列表）
  - `call_info(msgId)` → core `load_call_by_id`
  - 转发 `IncomingCall` / `IncomingCallAccepted` / `MsgsChanged`（call 状态变更）事件给前端
- **前端 UI 清单**：
  - 独立通话窗口（Tauri 新 WebviewWindow，内嵌 WebRTC 呼叫应用）
  - 通话信令桥（offer/answer/ice 交换，经 Tauri IPC）
  - 来电通知 + 振铃 + 接听/拒接
  - 通话消息体渲染（发起/接听/结束/未接，含时长）
  - 通话气泡回拨按钮（对齐 `CallIconButton`）
  - 麦克风/摄像头开关、画面切换
- **数据模型**：通话消息即普通消息（Viewtype::Call），core 持久化 call_id 与状态；无 app 级新表。
- **工作量估算**：高（独立窗口 + WebRTC + 信令状态机 + 来电通知）。
- **依赖**：批次3（消息渲染 + 系统通知）。

## 4. 实施顺序与验收

每个批次完成标准：

### 批次 1 验收
- [ ] 会话可归档/取消归档，归档视图可切换
- [ ] 消息可保存/取消保存，「保存的消息」入口可访问
- [ ] Composer 草稿在会话切换间保留，列表显示草稿标记

### 批次 2 验收
- [ ] 全局搜索返回会话/联系人/消息，可跳转高亮
- [ ] Gallery 网格 + 全屏媒体查看可用
- [ ] Cmd+P 命令面板可执行主要命令
- [ ] 广播/邮件列表会话正确识别并显示已读计数

### 批次 3 验收
- [ ] 可录制并发送语音消息，消息内波形播放 + 全局连续播放
- [ ] webxdc 应用卡片可打开运行，StatusUpdate 实时同步

### 批次 4 验收
- [ ] 系统通知可点击聚焦会话（Windows），macOS 可回复
- [ ] 会话/联系人加密状态与指纹可查看
- [ ] 第二设备扫码绑定成功同步消息
- [ ] 备份导出/导入往返成功
- [ ] 音频/视频通话：发起 → 对端振铃接听 → 双向音画 → 挂断显示时长；未接显示 Missed；通话气泡可回拨

## 5. 后续步骤

每个子系统遵循：`写 spec` → `写 plan` → `实施` → `tsc + build 验证`。按批次顺序推进，每批完成后进入下一批。

## 6. 变更记录

- 2026-08-03 初稿。移除「自动删除旧消息 / 消失消息」（用户决定本地永久留存，见 0.1）；移除「账号切换」（用户明确排除）。
- 2026-08-03 补录：
  - 新增子系统 **4.5 通话（VoIP 音频/视频）**（用户要求纳入）。core 2.58 已内置完整通话 API（place/accept/end/ice_servers + IncomingCall 事件），前端采用 Delta 同款架构：独立通话窗口 + WebRTC + 信令消息。复杂度高，列入批次 4。
  - Markdown 富文本渲染：经查证 Delta Chat 从未稳定提供（仅 1.33/1.34 实验期后移除，官方标注"未来回归"，当前 core 2.58 与前端均无）。Delta 当前仅支持 Markdown 链接 `[label](url)`。PEYT 若做则属自研前端渲染层，不受 Delta 约束，需单独定范围（语法子集 / 渲染库 / 与现有代码块高亮关系）。**待用户确认是否纳入路线图**。
