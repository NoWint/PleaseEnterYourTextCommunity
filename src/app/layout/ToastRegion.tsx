// src/app/layout/ToastRegion.tsx
// Toast 区域：复用 @opencode-ai/ui/v2/toast-v2
//
// 注意：toast-v2 模块未导出 Toaster（brief 假设的导出名）。
// 实际导出为 ToastV2（其 .Region 子组件即 ToastV2Region，内部包装 solid-sonner Toaster）。
// ToastV2.Region 调用 useI18n()，但 i18n context 有 fallback（locale=en），
// 无需 I18nProvider 也能渲染。

import type { Component } from "solid-js"
import { ToastV2 } from "@opencode-ai/ui/v2/toast-v2"

const ToastRegion: Component = () => {
  return <ToastV2.Region />
}

export default ToastRegion
