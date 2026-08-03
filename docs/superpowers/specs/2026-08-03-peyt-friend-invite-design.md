# PEYT 便捷好友邀请 — 设计规格

> 目标：告别 `https://i.delta.chat/#...` 长链接，用 PEYT 自己的便捷方式加好友。核心复用已验证的邮箱直连路径（`create_chat_by_email`），不依赖 securejoin 握手。

## 背景与现状

PEYT 现有 4 条加好友路径全部走 deltachat core：

| 路径 | 入口 | 底层 |
|---|---|---|
| 邮箱加好友 | 消息页「＋」→「添加好友(邮箱)」 | `create_chat_by_email`（**不走 securejoin**） |
| 个人/群 QR | `get_my_qr` / `get_securejoin_qr` | securejoin 长链接 |
| 粘贴 QR | 消息页「通过 QR 加入」 | securejoin 握手 |
| 群邀请分享 | groups 右键「复制邀请链接」 | securejoin 长链接 |

**关键事实**（研究结论）：
- `create_chat_by_email` = `Contact::create` + `ChatId::create_for_contact`，**不经过 securejoin**，建 1:1 会话后 Autocrypt 自动交换公钥加密。
- 用户嫌弃的长链接来自 securejoin（指纹验证 + 防中间人）。方案 A 明确放弃指纹验证，接受 Autocrypt TOFU（首次使用即信任），换取最短最简体验。
- 信封协议 `[PEYT]` 接收端未实现——本设计**不依赖信封协议**，用纯前端解析。

## 目标

消息页「＋」新增 4 个便捷入口，全部复用现有后端命令（**零后端改动**）：

1. **从通讯录添加** — 列表点选，不手动输邮箱
2. **陌生人来信一键接受** — 修掉 contact request 被过滤的隐藏 bug
3. **短邀请链接分享** — 生成 `peyt://` 短链接，不再用 securejoin 长链接
4. **从群成员添加** — 右侧成员列表 hover 加好友

## 设计

### ① 从通讯录添加

- **入口**：消息页「＋」下拉新增「从通讯录添加」
- **数据**：`get_contacts`（已有）→ `{id, name, addr}` 全量联系人
- **交互**：新建 `contactsPicker.ts` 弹窗（Apple 风格）：
  - 顶部搜索框（过滤 name/addr）
  - 联系人分组列表：头像 + 名字 + 邮箱
  - 已是好友的标「已添加」（通过已存在会话判断，或点选后 `create_chat_by_email` 返回已存在 chat_id 直接打开）
  - 点选 → `create_chat_by_email(addr)` → 打开会话
- **复用**：`ui.dialog`（弹窗基座）、`renderAvatarHtml`、`get_contacts`、`create_chat_by_email`

### ② 陌生人来信一键接受

- **现状 bug**：`messagesPage` 的 filter `!c.is_contact_request` 把 contact request 会话全过滤掉了——陌生人发消息你完全看不到。
- **改动**：消息列表顶部加「新请求」分区，显示 contact request 会话：
  - 每项：头像 + 名字 + 邮箱 + 消息预览 + 「接受」「拒绝」按钮
  - 接受 → `accept_chat(chatId)`（已有）；拒绝 → `block_chat(chatId)`（已有）
  - 接受/拒绝后重拉列表刷新
- **chatlist 契约**：`ChatListItem` 已有 `is_contact_request` 字段，`get_chatlist` 返回它（含 contact request 会话），前端 filter 放开即可。

### ③ 短邀请链接分享（纯前端解析）

- **链接格式**：`peyt://invite/<base64url(email)>?n=<encodeURIComponent(名字)>`
  - 例：`peyt://invite/ZXhhbXBsZUBnbWFpbC5jb20?n=Bob`
  - base64url 编码邮箱（URL-safe，去 `+` `/` `=`），前端 `atob` 解码
- **生成入口**：消息页「＋」→「分享我的邀请」→ 弹窗显示链接 + 复制按钮 + 二维码（可选，用已有 qrcode 依赖）
- **解析入口**：消息页「通过 QR 加入」输入框升级——粘贴的内容依次尝试：
  1. 邮箱格式 → `create_chat_by_email`
  2. `peyt://invite/` 链接 → 前端 decode 邮箱 → `create_chat_by_email`
  3. 老 securejoin 链接（`https://i.delta.chat/#` / `OPENPGP4FPR:` / `dcaccount:`）→ 兼容走 `secure_join`（保留）
- **纯前端**：不新增后端命令，decode 逻辑放 `inviteLink.ts` 工具模块（可单测）。

### ④ 从群成员添加

- **位置**：右侧成员抽屉（`rightDrawer.ts` renderMembers）每个非 self 成员
- **交互**：成员行 hover 出「添加为好友」按钮 → `create_chat_by_email(m.addr)` → toast 已添加
- **复用**：`MemberDto.addr`、`create_chat_by_email`
- 已在通讯录的显示「已添加」（`get_contacts` 判断 addr 是否已存在）

## 数据流

```
[①通讯录] get_contacts ──────────┐
[②陌生来信] get_chatlist(filter) ─┤→ create_chat_by_email(addr) → ChatId → 打开会话
[③短链接] peyt://invite/解码 ─────┘
[④群成员] get_chat_info.members ──┘
```

## 错误处理

- `create_chat_by_email` 已是幂等：联系人/会话已存在时返回既有 chat_id，不会重复建。
- 邀请链接 decode 失败 → toast「无效的邀请链接」。
- contact request 接受/拒绝失败 → toast 错误。

## 范围外（YAGNI）

- 不实现 `[PEYT]` 信封接收端（邀请不依赖它）
- 不做 securejoin 指纹验证（方案 A 明确放弃）
- 不做邀请码 + token 存储（方案 B 被否）

## 验收清单

- [ ] 消息页「＋」下拉有 4 个入口
- [ ] 从通讯录添加：列表点选联系人直接开会话
- [ ] 陌生人来信出现在「新请求」分区，可一键接受/拒绝
- [ ] 分享我的邀请：复制 `peyt://` 短链接
- [ ] 粘贴短链接/邮箱/老 QR 都能加好友
- [ ] 群成员 hover 可添加为好友
- [ ] `tsc --noEmit` 与 `npm run build` 通过
