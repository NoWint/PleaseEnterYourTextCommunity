// src/app/platform/index.tsx
// PlatformProvider：注入 Platform 实例到 Solid context

import { createContext, createRoot, useContext, type ParentProps } from "solid-js"
import { createTauriPlatform, type Platform } from "./tauri"

const PlatformContext = createContext<Platform>()

export function PlatformProvider(props: ParentProps) {
  const platform = createRoot(() => createTauriPlatform())
  return (
    <PlatformContext.Provider value={platform}>
      {props.children}
    </PlatformContext.Provider>
  )
}

export function usePlatform(): Platform {
  const ctx = useContext(PlatformContext)
  if (!ctx) throw new Error("usePlatform must be used within PlatformProvider")
  return ctx
}
