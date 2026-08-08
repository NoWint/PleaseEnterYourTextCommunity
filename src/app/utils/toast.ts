// src/app/utils/toast.ts
// 轻量 toast 工具（对齐 opencode utils/toast 的 showToast 形状）。
// 实现统一走 V2 ToastRegion：showToastV2（@opencode-ai/ui/v2/toast-v2，
// 内部 solid-sonner Toaster，AppLayout 已挂载 ToastRegion）。
// 环境异常（如 SSR/未挂载 Toaster）时降级 console。

import { showToastV2 } from "@opencode-ai/ui/v2/toast-v2"

export function showToast(input: { title: string; description?: string }) {
  try {
    showToastV2({ title: input.title, description: input.description })
  } catch {
    console.warn("[toast]", input.title, input.description ?? "")
  }
}
