// src/app/data/fake.ts
// Task 1 假数据：工作区 + 聊天会话。
// Task 3：真实数据经 chat/workspace context 的 invoke 接入；拉取失败（浏览器 dev）时
// 以下假数据兜底展示壳层。makeFakeMessages 仅为 dev 预览 timeline 用。

import type { AppSession, AppWorkspace } from "../types"
import type { ChatInfoDto, MemberDto, MsgDto } from "@/types"

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

// ── dev 兜底：invoke 不可用时给假会话造几条消息/成员，让 timeline 可预览 ──
const FAKE_NAMES = ["小明", "阿伟", "组长", "客服-小雨"]

export function makeFakeMembers(): MemberDto[] {
  return FAKE_NAMES.map((name, i) => ({
    contact_id: 100 + i,
    name,
    addr: `${name}@example.org`,
    avatar: null,
    color: 0x4a7dff + i * 0x102030,
    is_self: false,
    last_seen: Math.floor(Date.now() / 1000) - i * 3600,
  }))
}

export function makeFakeInfo(chatId: string, title: string): ChatInfoDto {
  return {
    chat_id: Number(chatId) || 1,
    name: title,
    is_group: true,
    is_contact_request: false,
    is_self_talk: false,
    chat_type: "group",
    is_encrypted: false,
    members: makeFakeMembers(),
    description: "",
    avatar: null,
    color: null,
    past_members: [],
    can_send: true,
    self_in_group: true,
  }
}

export function makeFakeMessages(chatId: string): MsgDto[] {
  const base = Number(chatId) || 1
  const selfId = 1
  const seed = [
    { from: 101, text: "早上好，昨天的方案我看了，整体没问题 👌" },
    { from: 102, text: "有个小建议：第三部分的接口时序可以再对齐一下。" },
    { from: 101, text: "好的，我下午更新一版发出来。" },
    { from: selfId, text: "收到，辛苦啦！大家看完记得在群里确认 🙏" },
    { from: 103, text: "```ts\nexport function ping(): string {\n  return \"pong\"\n}\n```\n代码片段供参考 @小明" },
    { from: 102, text: "https://example.com/docs 这里有份文档，也可以看看。" },
    { from: 104, text: "会议纪要已归档到共享盘，需要的人自取 🗂️" },
    { from: selfId, text: "好的，我把待办同步到看板了 ✅" },
  ]
  const now = Math.floor(Date.now() / 1000)
  return seed.map((item, i) => {
    const from = item.from === selfId ? 1 : item.from
    const member = makeFakeMembers().find((m) => m.contact_id === from)
    return {
      msg_id: base * 1000 + i,
      chat_id: Number(chatId),
      from_id: from,
      from_name: member?.name ?? "成员",
      from_avatar: null,
      from_color: member?.color ?? null,
      text: item.text,
      ts: now - (seed.length - i) * 300,
      state: "read",
      view_type: "Text",
      file: null,
      file_mime: null,
      file_name: null,
      file_bytes: null,
      quote_text: null,
      quote_from: null,
      quote_msg_id: null,
      quote_from_id: null,
      reactions: null,
      is_info: false,
      is_out: from === 1,
    }
  })
}
