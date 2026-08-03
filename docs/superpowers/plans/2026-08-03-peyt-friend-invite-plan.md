# PEYT 便捷好友邀请 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 4 个便捷加好友入口：①从通讯录添加、②陌生人来信一键接受、③短邀请链接分享（纯前端解析）、④从群成员添加。全部复用现有后端命令，零后端改动。

**Architecture:** 纯前端实现。核心复用 `create_chat_by_email`（幂等建会话）、`get_contacts`（通讯录）、`get_chatlist` 的 `is_contact_request`（陌生来信）、`get_chat_info.members`（群成员）。邀请链接 `peyt://invite/<base64url(email)>?n=<name>` 前端 decode。

**Tech Stack:** Vanilla TS/Vite + Tauri v2，无新依赖。

---

## 文件边界（子代理隔离关键）

| 子系统 | 独占文件 | 共享 | 不得触碰 |
|---|---|---|---|
| **① 通讯录** | `src/components/contactsPicker.ts`（新建） | `src/pages/messagesPage.ts`（＋下拉加入口） | 其他 |
| **② 陌生来信** | `src/pages/messagesPage.ts`（新请求分区） | 无 | 其他 |
| **③ 短链接** | `src/utils/inviteLink.ts`（新建）、`src/components/inviteDialog.ts`（新建） | `src/pages/messagesPage.ts`（QR 输入框升级） | 其他 |
| **④ 群成员** | `src/shell/rightDrawer.ts`（成员行 hover 加好友） | 无 | 其他 |

**冲突规避**：
- `src/pages/messagesPage.ts` 涉及 ①②③ 三个入口，由**主 Agent 统一收尾**，子代理只写各自新建的独立文件。
- ① ③ 的新建组件由各自子代理写，互不依赖。
- 每个子代理完成后汇报主 Agent，不自行 commit。

---

## 任务 A：邀请链接工具模块（③ 的基础，主 Agent）

**Files:**
- Create: `src/utils/inviteLink.ts`

- [ ] **Step 1: inviteLink.ts** — 生成/解析 `peyt://invite/` 链接

```ts
// peyt://invite/<base64url(email)>?n=<encodeURIComponent(name)>
export function buildInviteLink(email: string, name?: string): string {
  const b64 = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const nameQuery = name ? `?n=${encodeURIComponent(name)}` : '';
  return `peyt://invite/${b64}${nameQuery}`;
}

export function parseInviteLink(link: string): string | null {
  try {
    const m = link.trim().match(/^peyt:\/\/invite\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const email = atob(b64);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  } catch { return null; }
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
```

- [ ] **Step 2: tsc 校验** `npx tsc --noEmit`

## 任务 B：从通讯录添加（①）

**Files:**
- Create: `src/components/contactsPicker.ts`

- [ ] **Step 1: contactsPicker.ts** — 通讯录选择器弹窗

```ts
import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { ui } from './ui.js';
import { renderAvatarHtml } from './avatar.js';
import type { ContactDto } from '../types.js';

// 从通讯录添加好友:列表选择 → create_chat_by_email → 打开会话
export async function openContactsPicker(): Promise<void> {
  const contacts = await call<ContactDto[]>('get_contacts');
  const existingAddrs = new Set(state.messages
    .map((m) => m.from_name) // 近似判断已添加,见注释
    .filter(Boolean));

  // 过滤 self
  const list = contacts.filter((c) => c.addr !== state.self?.addr);

  const dlg = ui.dialog({
    title: '从通讯录添加',
    size: 'lg',
    body: `
      <div class="ui-search" id="cp-search"></div>
      <div id="cp-list" style="display:flex;flex-direction:column;gap:2px;margin-top:12px"></div>
    `,
  });
  // ... 渲染列表 + 搜索 + 点击建会话
}
```

- [ ] **Step 2: 列表项** — 头像 + 名字 + 邮箱 + 「已添加」标记 + 点击 → `create_chat_by_email(addr)` → 打开会话

## 任务 C：陌生人来信一键接受（②）

**Files:**
- Modify: `src/pages/messagesPage.ts`（新请求分区）

- [ ] **Step 1:** `renderMessageList` 里把 `is_contact_request` 的会话从 filter 里拿出来，单独渲染「新请求」分区在列表顶部
- [ ] **Step 2:** 每项显示头像 + 名字 + 邮箱 + 消息预览 + 「接受」「拒绝」按钮
  - 接受 → `call('accept_chat', { chatId })` → 重拉列表
  - 拒绝 → `call('block_chat', { chatId })` → 重拉列表
- [ ] **Step 3:** 空态「暂无新请求」或分区隐藏

## 任务 D：短邀请链接分享（③ UI）

**Files:**
- Create: `src/components/inviteDialog.ts`

- [ ] **Step 1:** 邀请分享弹窗 — 显示 `buildInviteLink(state.self.addr, state.self.name)` + 复制按钮
- [ ] **Step 2:** QR 输入框升级 — 依次尝试：邮箱 → `parseInviteLink` → 老 securejoin 链接（`secure_join`）

## 任务 E：从群成员添加（④）

**Files:**
- Modify: `src/shell/rightDrawer.ts`

- [ ] **Step 1:** renderMembers 非 self 成员行 hover 显示「添加为好友」
- [ ] **Step 2:** 点击 → `create_chat_by_email(m.addr)` → toast 已添加

## 任务 F：消息页「＋」下拉收尾（主 Agent）

**Files:**
- Modify: `src/pages/messagesPage.ts`

- [ ] **Step 1:** ＋下拉新增：从通讯录添加 / 分享我的邀请
- [ ] **Step 2:** 保留：添加好友(邮箱) / 通过 QR 加入 / 创建群 / 加入 PEYT Studio
- [ ] **Step 3:** 全量验证 `tsc --noEmit` + `npm run build`

---

## 验收（对应 spec）

- [ ] ＋下拉有「从通讯录添加」「分享我的邀请」
- [ ] 通讯录列表点选联系人直接开会话
- [ ] 陌生人来信出现在「新请求」分区，可接受/拒绝
- [ ] 复制 `peyt://` 短链接；粘贴短链接/邮箱/老 QR 都能加好友
- [ ] 群成员 hover 可添加为好友
- [ ] `tsc --noEmit` 与 `npm run build` 通过
