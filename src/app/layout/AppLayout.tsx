// src/app/layout/AppLayout.tsx
// 严格对齐 opencode pages/layout-new.tsx 的顶层壳结构。
//
// 对齐点（opencode layout-new.tsx L25-L48）：
// - 外层 div：bg-v2-background-bg-deep + flex-col + select-none + [&_*]:select-text 覆盖
// - safe-area padding（env(safe-area-inset-*)）
// - main：contain-strict + flex-col items-start + overflow-x-hidden
// - Suspense 包裹路由内容
// - 顶层只有 Titlebar + main + ToastRegion，不硬编码 Rail/MainRegion
//
// Rail 和卡片化布局由各 Page 内部决定（通过 PageShell 组件），
// 完全对齐 opencode layout-new.tsx + home.tsx/session.tsx 的 page 自治模式。

import type { Component, ParentProps } from "solid-js"
import { Suspense } from "solid-js"
import Titlebar from "./Titlebar"
import ToastRegion from "./ToastRegion"

const AppLayout: Component<ParentProps> = (props) => {
  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none
             [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      <ToastRegion />
    </div>
  )
}

export default AppLayout
