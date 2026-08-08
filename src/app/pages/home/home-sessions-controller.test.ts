// src/app/pages/home/home-sessions-controller.test.ts
// 结构测试：home 右列会话记录构建（私聊+群聊混排，spec 决策 3）。
// - 未选中项目（全部会话视图）→ 无工作区的 1:1 会话（directory=""）纳入，合成"私聊"项目
// - 选中项目（工作区视图）→ 1:1 会话排除
// - 未知（非空）directory 的会话仍丢弃；按 updated 倒序；searchKey 唯一

import { describe, expect, it } from "vitest"
import type { AppSession } from "../../types"
import type { LocalProject } from "../../context/layout"
import { buildHomeSessionRecords, homeSessionSearchKey } from "./home-sessions-controller"

const now = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function project(worktree: string, name?: string): LocalProject {
  return { worktree, name, expanded: false, icon: { color: "cyan" as const } }
}

function session(overrides: Partial<AppSession> & { id: string }): AppSession {
  return {
    title: `会话 ${overrides.id}`,
    directory: "ws-dev",
    time: { created: now - MIN },
    unread: 0,
    ...overrides,
  }
}

function build(input: {
  sessions: AppSession[]
  projects?: LocalProject[]
  projectDirectories?: string[]
  includeUngrouped?: boolean
  ungroupedProjectName?: string
}) {
  const projects = input.projects ?? [project("ws-dev", "研发团队")]
  return buildHomeSessionRecords({
    sessions: () => input.sessions,
    projectDirectories: () => input.projectDirectories ?? projects.flatMap((p) => [p.worktree, ...(p.sandboxes ?? [])]),
    projects: () => projects,
    projectByID: () => new Map(projects.flatMap((p) => (p.id ? [[p.id, p] as const] : []))),
    includeUngrouped: () => input.includeUngrouped ?? true,
    ungroupedProjectName: () => input.ungroupedProjectName ?? "私聊",
  })
}

describe("buildHomeSessionRecords（全部会话视图）", () => {
  it("纳入无工作区的 1:1 会话，合成中性项目", () => {
    const records = build({
      sessions: [
        session({ id: "g1", title: "群聊", directory: "ws-dev" }),
        session({ id: "p1", title: "小明", directory: "" }),
      ],
    })
    expect(records.map((r) => r.session.id)).toEqual(["g1", "p1"])
    const oneToOne = records.find((r) => r.session.id === "p1")
    expect(oneToOne?.project.worktree).toBe("")
    expect(oneToOne?.project.icon?.color).toBe("gray")
    expect(oneToOne?.projectName).toBe("私聊")
  })

  it("保留 今天/昨天/更早 分组所需的时间字段与排序（updated 倒序）", () => {
    const records = build({
      sessions: [
        session({ id: "old", directory: "", time: { created: now - 6 * DAY } }),
        session({ id: "mid", directory: "", time: { created: now - DAY, updated: now - 5 * HOUR } }),
        session({ id: "new", directory: "", time: { created: now - 2 * HOUR, updated: now - 5 * MIN } }),
      ],
    })
    expect(records.map((r) => r.session.id)).toEqual(["new", "mid", "old"])
  })

  it("unknown 非空 directory 的会话仍丢弃", () => {
    const records = build({
      sessions: [session({ id: "ghost", directory: "ws-ghost" }), session({ id: "p1", directory: "" })],
    })
    expect(records.map((r) => r.session.id)).toEqual(["p1"])
  })
})

describe("buildHomeSessionRecords（选中项目视图）", () => {
  it("排除无工作区的 1:1 会话", () => {
    const records = build({
      includeUngrouped: false,
      sessions: [
        session({ id: "g1", directory: "ws-dev" }),
        session({ id: "p1", directory: "" }),
      ],
    })
    expect(records.map((r) => r.session.id)).toEqual(["g1"])
  })
})

describe("homeSessionSearchKey", () => {
  it("1:1 会话（directory=\"\"）key 唯一且可区分", () => {
    const a = session({ id: "p1", directory: "" })
    const b = session({ id: "p2", directory: "" })
    const keyA = homeSessionSearchKey({ session: a, project: project(""), projectName: "私聊" })
    const keyB = homeSessionSearchKey({ session: b, project: project(""), projectName: "私聊" })
    expect(keyA).toBe(":p1")
    expect(keyB).toBe(":p2")
    expect(keyA).not.toBe(keyB)
  })
})
