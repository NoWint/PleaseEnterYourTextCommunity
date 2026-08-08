// src/app/context/language.tsx
// 最小语言 context：t(key, params?) 查 src/i18n（zh 优先，en 兜底），
// 未命中回落到 key 本身。壳层（titlebar/sidebar/home）与 dialogs 文案已并入 src/i18n。

import { createSimpleContext } from "@opencode-ai/ui/context"
import { zh as appZh } from "../../i18n/zh"
import { en as appEn } from "../../i18n/en"

function resolve(dict: Record<string, string>, key: string): string | undefined {
  if (key in dict) return dict[key]
  const parts = key.split(".")
  // 尝试逐级回退（如 command.session.new → command.session → command）
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join(".")
    if (prefix in dict) return dict[prefix]
  }
  return undefined
}

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

interface LanguageStore {
  t: (key: string, params?: Record<string, string | number>) => string
  direction: () => "ltr"
}

function createLanguageStore(): LanguageStore {
  const t = (key: string, params?: Record<string, string | number>) => {
    const value = resolve(appZh, key) ?? resolve(appEn, key) ?? key
    return interpolate(value, params)
  }
  return { t, direction: () => "ltr" }
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext<LanguageStore, Record<string, any>>({
  name: "Language",
  gate: false,
  init: () => createLanguageStore(),
})
