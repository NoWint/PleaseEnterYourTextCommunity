// src/app/context/closed-tabs.ts
// 照抄 opencode context/closed-tabs.ts 的 nextTabAfterClose（纯函数，便于测试）：
// 关闭标签页后的导航目标。仅在关闭的是当前（最近激活）标签时导航，
// 后台标签关闭不改变路由。

import type { Tab } from "./tabs"

export function nextTabAfterClose(tabs: Tab[], index: number, active: boolean): Tab | undefined | null {
  if (!active) return undefined
  return tabs[index + 1] ?? tabs[index - 1] ?? null
}
