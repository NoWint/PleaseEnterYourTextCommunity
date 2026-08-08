// src/app/context/closed-tabs.test.ts
// 结构测试：关闭标签页后的导航目标（F3 修复回归）。
// - 关闭非激活（后台）标签 → undefined（不导航）
// - 关闭激活标签 → 优先右邻，其次左邻；仅剩一个 → null（回首页）

import { describe, expect, it } from "vitest"
import { nextTabAfterClose } from "./closed-tabs"
import type { Tab } from "./tabs"

const tabs: Tab[] = [
  { type: "session", chatId: "1" },
  { type: "draft", draftID: "d-1" },
  { type: "session", chatId: "3" },
]

describe("nextTabAfterClose", () => {
  it("关闭后台标签不导航（返回 undefined）", () => {
    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 0, false)).toBeUndefined()
  })

  it("关闭激活标签：优先右邻", () => {
    expect(nextTabAfterClose(tabs, 1, true)).toEqual({ type: "session", chatId: "3" })
  })

  it("关闭激活标签（末位）：取左邻", () => {
    expect(nextTabAfterClose(tabs, 2, true)).toEqual({ type: "draft", draftID: "d-1" })
  })

  it("关闭最后一个激活标签：返回 null（导航回首页）", () => {
    expect(nextTabAfterClose([tabs[0]], 0, true)).toBeNull()
  })
})
