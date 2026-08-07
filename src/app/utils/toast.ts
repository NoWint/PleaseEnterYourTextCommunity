// src/app/utils/toast.ts
// 轻量 toast 工具（对齐 opencode utils/toast 的 showToast 形状）。
// 当前走 solid-sonner 已有实例（旧壳使用）；无实例时降级 console。
// TODO(Task 2): 统一到 V2 ToastRegion。

import { toast } from "solid-sonner"

export function showToast(input: { title: string; description?: string }) {
  try {
    toast(input.title, { description: input.description })
  } catch {
    console.warn("[toast]", input.title, input.description ?? "")
  }
}
