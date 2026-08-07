// src/app/context/settings.tsx
// SettingsStore：主题/字号/feature flags
// 迁移 src/theme.ts 的主题切换逻辑

import { createContext, useContext, createSignal, type ParentProps } from "solid-js"

interface SettingsStore {
  theme: () => string
  setTheme: (theme: string) => void
  fontScale: () => number
  setFontScale: (scale: number) => void
  featureFlags: {
    useSolidApp: () => boolean
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
  const useSolidApp = () => localStorage.getItem("peyt.useSolidApp") !== "false"

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
  }
}

const SettingsContext = createContext<SettingsStore>()

export function SettingsProvider(props: ParentProps) {
  const store = createSettingsStore()
  return <SettingsContext.Provider value={store}>{props.children}</SettingsContext.Provider>
}

export function useSettings(): SettingsStore {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider")
  return ctx
}
