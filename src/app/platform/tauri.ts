// src/app/platform/tauri.ts
// Platform 接口：封装 Tauri invoke 为统一抽象层
// 借鉴 opencode createPlatform，裁剪 AI 专有能力

import { call, onEvent, transformBlobURL } from "../../api"

export interface Platform {
  // 通用能力
  openExternal(url: string): Promise<void>
  setTitlebar(mode: "light" | "dark"): Promise<void>
  setZoomFactor(factor: number): Promise<void>
  // 存储层
  storage: {
    get(key: string): Promise<string | null>
    set(key: string, val: string): Promise<void>
    delete(key: string): Promise<void>
  }
  // 草稿存储（每会话输入草稿）
  draftStore: {
    get(chatId: number): Promise<string | null>
    set(chatId: number, val: string): Promise<void>
    delete(chatId: number): Promise<void>
  }
  // IM 事件流
  onEvent(typ: string, cb: (payload: { typ: string; [k: string]: unknown }) => void): Promise<() => void>
  // blob URL 转换
  transformBlobURL(path: string): Promise<string>
}

// 创建 Tauri 平台实例
export function createTauriPlatform(): Platform {
  return {
    async openExternal(url: string) {
      // @tauri-apps/plugin-shell 尚未安装；Phase 1 不实际调用，try/catch 容错
      try {
        // @ts-expect-error - 模块未安装，Phase 3+ 接入 shell 插件后移除此注释
        const { open } = await import("@tauri-apps/plugin-shell")
        await open(url)
      } catch (e) {
        console.warn("[platform] openExternal failed, fallback to window.open", e)
        window.open(url, "_blank")
      }
    },
    async setTitlebar(mode) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().setTheme(mode)
    },
    async setZoomFactor(factor) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      await getCurrentWebview().setZoom(factor)
    },
    storage: {
      async get(key) {
        return localStorage.getItem(key)
      },
      async set(key, val) {
        localStorage.setItem(key, val)
      },
      async delete(key) {
        localStorage.removeItem(key)
      },
    },
    draftStore: {
      async get(chatId) {
        return localStorage.getItem(`peyt.draft.${chatId}`)
      },
      async set(chatId, val) {
        localStorage.setItem(`peyt.draft.${chatId}`, val)
      },
      async delete(chatId) {
        localStorage.removeItem(`peyt.draft.${chatId}`)
      },
    },
    async onEvent(typ, cb) {
      return onEvent(typ, cb)
    },
    async transformBlobURL(path) {
      return transformBlobURL(path)
    },
  }
}
