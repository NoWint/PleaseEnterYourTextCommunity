// src/app/layout/AppLayout.tsx
// 布局骨架：对齐 opencode layout-new.tsx 的外层 + main 结构，
// 内部保留 IM 的 Rail + 三栏（channel-tree + chat + drawer）业务布局。
//
// 对齐点（opencode layout-new.tsx）：
// - 外层 div：bg-v2-background-bg-deep + flex-col + select-none + [&_*]:select-text 覆盖
// - safe-area padding（env(safe-area-inset-*)）
// - main：contain-strict + flex-col items-start + overflow-x-hidden
// - Suspense 包裹路由内容
//
// IM 业务结构（spec/project_memory 约束）：
// - 4 页 rail 全局常驻（messages/groups/work/settings）
// - channel-tree (220px) + chat-main (flex) + right-drawer (200px)

import type { Component, ParentProps } from "solid-js"
import { Suspense } from "solid-js"
import Titlebar from "./Titlebar"
import Rail from "./Rail"
import MainRegion from "./MainRegion"
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
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-stretch contain-strict">
        <Suspense>
          <div class="flex-1 min-h-0 min-w-0 flex flex-row overflow-hidden">
            <Rail />
            <MainRegion>{props.children}</MainRegion>
          </div>
        </Suspense>
      </main>
      <ToastRegion />
    </div>
  )
}

export default AppLayout
