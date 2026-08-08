// src/app/components/dialogs/i18n.ts
// 对话框/命令面板的文案查询：key 已并入 src/i18n（zh 优先，en 兜底），
// 未命中回落到 key 本身。dialogsT 与 language.t 共用同一份字典。

import { zh } from "../../../i18n/zh"
import { en } from "../../../i18n/en"

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

export type DialogsT = (key: string, params?: Record<string, string | number>) => string

/** 命令面板/设置对话框等 Task 2 组件的文案查询函数（统一字典 src/i18n）。 */
export function dialogsT(key: string, params?: Record<string, string | number>): string {
  return interpolate(zh[key] ?? en[key] ?? key, params)
}
