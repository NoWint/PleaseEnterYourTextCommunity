# Delta 对齐批次 4 实施计划（通知 / 保护状态 / 多设备 / 备份）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Delta Chat 对齐批次 4 的 4 个子系统：系统通知增强（合并/聚焦）、验证群/保护状态（指纹）、多设备绑定、备份/恢复。

**Architecture:** 桥接 core + 前端 UI。通知增强现有 `shell.ts` 的 web Notification（队列合并 + 点击聚焦）；保护状态用 `Contact::get_encrinfo` 指纹 + ChatView 头部徽章；多设备/备份用 core `imex`（Export/ImportSelfKeys + Export/ImportBackup）。

**Tech Stack:** Tauri v2 (Rust) + Vanilla TS/Vite + deltachat core 2.58

---

## 文件边界（子代理隔离关键）

| 子系统 | 独占文件 | 共享（主 Agent 收尾） | 不得触碰 |
|---|---|---|---|
| **4.1 通知** | `src/shell/shell.ts`（通知增强） | 无 | 其他 |
| **4.2 保护状态** | `src/components/protectionDialog.ts`（新建） | `src/chat/chatView.ts`（头部徽章）、`src-tauri/src/commands.rs`（get_encrinfo） | 其他 |
| **4.3 多设备** | `src/components/setupMultiDevice.ts`（新建） | `src/pages/settingsPage.ts`（入口）、`src-tauri/src/commands.rs`（imex 命令） | 其他 |
| **4.4 备份** | `src/components/backupDialog.ts`（新建） | `src/pages/settingsPage.ts`（入口）、`src-tauri/src/commands.rs`（imex 命令） | 其他 |

**冲突规避**：
- `src-tauri/src/commands.rs`、`src-tauri/src/lib.rs` 主 Agent 独占（imex 命令 + get_encrinfo + lib.rs 登记）。
- `src/pages/settingsPage.ts` 被 4.3/4.4 共享——主 Agent 统一加入口，子代理不碰。
- `src/chat/chatView.ts` 主 Agent 加保护徽章。
- 每个子代理完成后汇报主 Agent，不自行 commit。

---

## 任务 A：系统通知增强（4.1）

**Files:**
- Modify: `src/shell/shell.ts`

- [ ] **Step 1: 通知队列合并**

Delta 用 queuedNotifications + flush 合并多条新消息成一条聚合通知。PEYT 当前每条 IncomingMsg 弹一条。改为：
```ts
// 模块级通知队列:多条新消息合并成一条聚合通知(对齐 Delta notifications.ts)
interface QueuedNotif { chatId: number; name: string; preview: string; }
let notifQueue: QueuedNotif[] = [];
let notifTimer: ReturnType<typeof setTimeout> | null = null;

function queueNotification(chatId: number, name: string, preview: string): void {
  notifQueue.push({ chatId, name, preview });
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(() => flushNotifications(), 800);
}

function flushNotifications(): void {
  notifTimer = null;
  if (notifQueue.length === 0) return;
  // 合并:同 chat 取最后一条 preview;多 chat 聚合标题 "N 条新消息"
  // 弹一条 Notification,点击聚焦第一个 chat
  const notif = notifQueue[0];
  const body = notifQueue.length === 1 ? notif.preview : `${notifQueue.length} 条新消息`;
  const n = new Notification(notif.name, { body });
  n.onclick = () => { /* 聚焦 notif.chatId 会话 */ };
  notifQueue = [];
}
```
- 把 `handleIncomingMsg` 里的单条 `new Notification` 改为 `queueNotification`
- 聚合通知点击 → 聚焦第一个 chat

- [ ] **Step 2: tsc + build**

---

## 任务 B：验证群 / 保护状态（4.2）

**主 Agent 后端契约**：
- `get_contact_encryption_info(contactId)` → `String`（core `Contact::get_encrinfo` 的指纹/状态文本）
- `get_chat_info` 已暴露 chat_type，可据此判断是否群/单聊

**Files:**
- Create: `src/components/protectionDialog.ts`
- Modify: `src/chat/chatView.ts`（头部保护徽章 — 主 Agent 做）
- Modify: `src-tauri/src/commands.rs`（get_encrinfo — 主 Agent 做）

- [ ] **Step 1: protectionDialog.ts**

```ts
// 保护状态对话框:显示当前会话/联系人的加密指纹与验证状态(对齐 Delta ProtectionStatusDialog)
export async function openProtectionDialog(chatId: number): Promise<void>
```
- 拉 `get_chat_info` 拿 chat_type + 成员
- 对每个成员调 `get_contact_encryption_info(contactId)` 显示指纹
- E2EE 状态文本(已验证/未验证)+ 指纹 monospace 展示

- [ ] **Step 2: tsc + build**

---

## 任务 C：多设备绑定（4.3）

**主 Agent 后端契约**：
- `export_self_keys(path)` → core `imex(ExportSelfKeys)`
- `import_self_keys(path)` → core `imex(ImportSelfKeys)`
- `get_appdata_dir()` → String（供前端找导出路径）

**Files:**
- Create: `src/components/setupMultiDevice.ts`
- Modify: `src/pages/settingsPage.ts`（入口 — 主 Agent 做）
- Modify: `src-tauri/src/commands.rs`（imex — 主 Agent 做）

- [ ] **Step 1: setupMultiDevice.ts**

```ts
// 多设备绑定:导出本机密钥(扫码/文件) → 第二设备导入(对齐 Delta SetupMultiDevice)
export function renderMultiDeviceSetup(): HTMLElement
```
- 说明文字 + 「导出密钥」按钮(调 export_self_keys,展示导出路径)
- 导入区域:输入路径 → import_self_keys

- [ ] **Step 2: tsc + build**

---

## 任务 D：备份 / 恢复（4.4）

**主 Agent 后端契约**：
- `export_backup(path, passphrase)` → core `imex(ExportBackup)`
- `import_backup(path, passphrase)` → core `imex(ImportBackup)`
- `has_backup(dir)` → String

**Files:**
- Create: `src/components/backupDialog.ts`
- Modify: `src/pages/settingsPage.ts`（入口 — 主 Agent 做）
- Modify: `src-tauri/src/commands.rs`（imex — 主 Agent 做）

- [ ] **Step 1: backupDialog.ts**

```ts
// 备份与恢复:导出加密备份(带密码) → 导入迁移(对齐 Delta Backup.tsx)
export async function openBackupDialog(): Promise<void>
```
- 导出:选路径 + 输入密码 → export_backup
- 导入:选备份文件 + 密码 → import_backup
- 成功后提示重启

- [ ] **Step 2: tsc + build**

---

## 收尾（主 Agent 执行，非子代理）

- [ ] **主 Agent: imex 命令**（4.3/4.4 共用）
  - `export_self_keys` / `import_self_keys` / `export_backup` / `import_backup` / `has_backup` / `get_appdata_dir`
- [ ] **主 Agent: get_encrinfo 命令**（4.2）
- [ ] **主 Agent: lib.rs 登记**所有新命令
- [ ] **主 Agent: chatView 头部保护徽章**（4.2）
- [ ] **主 Agent: settingsPage 入口**（4.3/4.4）
- [ ] **主 Agent: 全量验证**（tsc + vite build + cargo check）
- [ ] **主 Agent: commit**

```bash
git add src/ src-tauri/
git commit -m "feat(chat): Delta batch 4 — notifications, protection, multidevice, backup"
```

---

## 自审记录

- **imex 阻塞性**：core imex 会暂停调度器 + 可能耗时（备份导出）。后端命令应在 spawn_blocking 或标注耗时。
- **路径选择**：前端无文件系统插件，导出路径用 `get_appdata_dir()` 默认目录 + 输入框自定义。
- **一致性**：imex 命令返回 `()`,成功靠 `ImexProgress` 事件(1000)感知。
- **隔离**：4 个子系统前端文件互斥；commands.rs/lib.rs/chatView/settingsPage 主 Agent 收尾。
