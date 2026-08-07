// src/app/data/fake.ts
// Task 1 假数据：工作区 + 聊天会话。
// TODO(Task 3): 替换为 Tauri invoke 真实数据（list_workspaces / list_chats）。

import type { AppSession, AppWorkspace } from "../types"

const now = Date.now()
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const fakeWorkspaces: AppWorkspace[] = [
  { id: "ws-design", name: "设计小组", worktree: "ws-design", expanded: true, icon: { color: "pink" }, vcs: "git", sandboxes: [] },
  { id: "ws-dev", name: "研发团队", worktree: "ws-dev", expanded: false, icon: { color: "cyan" }, vcs: "git", sandboxes: [] },
  { id: "ws-market", name: "市场部", worktree: "ws-market", expanded: false, icon: { color: "orange" }, vcs: "git", sandboxes: [] },
  { id: "ws-default", name: "默认工作区", worktree: "ws-default", expanded: false, icon: { color: "mint" }, vcs: "git", sandboxes: [] },
]

export function makeFakeChats(): AppSession[] {
  return [
    // 今天
    { id: "c1", title: "首页改版讨论", directory: "ws-design", time: { created: now - 3 * HOUR, updated: now - 12 * MIN }, unread: 3, working: false },
    { id: "c2", title: "设计规范同步", directory: "ws-design", time: { created: now - 5 * HOUR, updated: now - 40 * MIN }, unread: 0 },
    { id: "c3", title: "发布计划核对", directory: "ws-dev", time: { created: now - 2 * HOUR, updated: now - 5 * MIN }, unread: 1 },
    { id: "c4", title: "线上故障排查", directory: "ws-dev", time: { created: now - 8 * HOUR, updated: now - 20 * MIN }, unread: 7, working: true },
    // 昨天
    { id: "c5", title: "Q3 市场活动排期", directory: "ws-market", time: { created: now - DAY - 2 * HOUR, updated: now - DAY + 3 * HOUR }, unread: 0 },
    { id: "c6", title: "素材交接", directory: "ws-market", time: { created: now - DAY - 6 * HOUR, updated: now - DAY + 1 * HOUR }, unread: 2 },
    { id: "c7", title: "内部测试反馈", directory: "ws-dev", time: { created: now - DAY - 4 * HOUR, updated: now - DAY + 2 * HOUR }, unread: 0 },
    // 更早
    { id: "c8", title: "入职欢迎", directory: "ws-default", time: { created: now - 6 * DAY }, unread: 0 },
    { id: "c9", title: "周报模板讨论", directory: "ws-default", time: { created: now - 9 * DAY, updated: now - 8 * DAY }, unread: 0 },
    { id: "c10", title: "品牌物料归档", directory: "ws-market", time: { created: now - 12 * DAY, updated: now - 11 * DAY }, unread: 0 },
  ]
}
