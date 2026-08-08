// src/app/context/settings.tsx
// SettingsStore：主题/字号/feature flags + opencode 壳层所需的 general/keybinds。
// 照抄 opencode context/settings.tsx 的形状（general 全量返回 newLayoutDesigns 等）。

import { createSignal } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"

interface SettingsStore {
  theme: () => string
  setTheme: (theme: string) => void
  fontScale: () => number
  setFontScale: (scale: number) => void
  featureFlags: {
    useSolidApp: () => boolean
  }
  // opencode settings.general 形状（壳层固定值，后续任务再做设置界面）
  general: {
    showNavigation: () => boolean
    mobileTitlebarPosition: () => "top" | "bottom"
    newLayoutDesigns: () => boolean
    showTerminal: () => boolean
    showSearch: () => boolean
    showStatus: () => boolean
  }
  // opencode settings.keybinds：用户自定义 keybind 覆盖（本地存储）
  keybinds: {
    get: (id: string) => string | undefined
    set: (id: string, value: string) => void
  }
}

const KEYBINDS_STORAGE = "peyt.keybinds"

function loadKeybinds(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYBINDS_STORAGE)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function createSettingsStore(): SettingsStore {
  // 主题：沿用 opencode 的 localStorage key（ThemeProvider 内部用 'opencode-theme-id'）
  const [theme, setThemeState] = createSignal(
    localStorage.getItem("opencode-theme-id") || "oc-2"
  )

  // 字号：沿用现有 peyt.fontScale
  const [fontScale, setFontScaleState] = createSignal(
    Number(localStorage.getItem("peyt.fontScale")) || 1
  )

  // feature flags
  // 注意：peyt.useSolidApp 目前无消费方，是遗留兼容占位，勿据此判断壳层入口。
  // 实际切换机制（Phase 6 前）：
  // - dev：src-tauri/tauri.conf.json 的 devUrl = http://localhost:1420/app.html
  //   → 开发与 Tauri dev 都跑新 Solid 壳（src/app/entry.tsx）；
  // - 生产：frontendDist = ../dist 加载构建产物，当前同时产出 index.html（legacy 壳）
  //   与 app.html（新壳），生产入口在 Phase 6 固定（见 vite.config.ts 注释）。
  const useSolidApp = () => localStorage.getItem("peyt.useSolidApp") !== "false"

  const [keybinds, setKeybinds] = createSignal<Record<string, string>>(loadKeybinds())

  return {
    theme,
    setTheme(t: string) {
      localStorage.setItem("opencode-theme-id", t)
      document.documentElement.setAttribute("data-theme", t)
      setThemeState(t)
    },
    fontScale,
    setFontScale(s: number) {
      localStorage.setItem("peyt.fontScale", String(s))
      setFontScaleState(s)
    },
    featureFlags: { useSolidApp },
    general: {
      showNavigation: () => true,
      mobileTitlebarPosition: () => "top",
      newLayoutDesigns: () => true,
      showTerminal: () => false,
      showSearch: () => true,
      showStatus: () => false,
    },
    keybinds: {
      get: (id) => keybinds()[id],
      set: (id, value) => {
        setKeybinds((current) => {
          const next = { ...current, [id]: value }
          localStorage.setItem(KEYBINDS_STORAGE, JSON.stringify(next))
          return next
        })
      },
    },
  }
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext<SettingsStore, Record<string, any>>({
  name: "Settings",
  gate: false,
  init: () => createSettingsStore(),
})
