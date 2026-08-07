// src/app/layout/AppLayout.tsx
// 布局骨架组合：Titlebar + Rail + MainRegion + ToastRegion

import type { Component, ParentProps } from "solid-js"
import Titlebar from "./Titlebar"
import Rail from "./Rail"
import MainRegion from "./MainRegion"
import ToastRegion from "./ToastRegion"

const AppLayout: Component<ParentProps> = (props) => {
  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none
             [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
    >
      <Titlebar />
      <div class="flex-1 min-h-0 min-w-0 flex flex-row overflow-hidden">
        <Rail />
        <MainRegion>{props.children}</MainRegion>
      </div>
      <ToastRegion />
    </div>
  )
}

export default AppLayout
