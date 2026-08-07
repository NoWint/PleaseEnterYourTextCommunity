// src/app/platform/tauri.ts
// Tauri 平台实现（对齐 opencode context/platform 的桌面部分接口形状）。
// 浏览器 dev 环境回落到 web 行为。TODO(Task 2): 接入 Tauri 原生能力（window 控制/通知插件）。

export type PlatformName = "web" | "desktop"
export type DesktopOS = "macos" | "windows" | "linux"

export interface Platform {
  /** 运行平台。 */
  platform: PlatformName
  /** 桌面操作系统（desktop 平台）。 */
  os?: DesktopOS
  /** 窗口是否全屏（Tauri 运行时）。 */
  windowFullscreen?: () => boolean
  /** webview 缩放（Tauri 运行时）。 */
  webviewZoom?: () => number
  /** 在系统默认应用中打开链接。 */
  openExternal(url: string): void
  /** 发送系统通知。 */
  notify(title: string, description?: string, onClick?: () => void): Promise<void>
}

const isTauri = () =>
  typeof window !== "undefined" &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI_INTERNALS__ !== undefined

const detectOS = (): DesktopOS => {
  const platform = typeof navigator === "object" ? navigator.platform.toLowerCase() : ""
  const ua = typeof navigator === "object" ? navigator.userAgent.toLowerCase() : ""
  if (platform.includes("mac") || ua.includes("mac")) return "macos"
  if (platform.includes("win") || ua.includes("windows")) return "windows"
  return "linux"
}

export function createTauriPlatform(): Platform {
  const tauri = isTauri()

  let fullscreen = false
  if (tauri) {
    // 延迟 require，避免浏览器 dev 环境报错。
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onResized(() => {
        void getCurrentWindow().isFullscreen().then((value) => {
          fullscreen = value
        })
      }))
      .catch(() => {})
  }

  return {
    platform: tauri ? "desktop" : "web",
    os: tauri ? detectOS() : undefined,
    windowFullscreen: () => fullscreen,
    webviewZoom: () => 1,
    openExternal(url: string) {
      if (tauri) {
        // TODO(Task 2): 安装 @tauri-apps/plugin-shell 后改用 openUrl
        window.open(url, "_blank")
        return
      }
      window.open(url, "_blank")
    },
    async notify(title: string, description?: string, onClick?: () => void) {
      // TODO(Task 2): Tauri 通知插件 / 系统通知
      if (typeof Notification === "undefined") return
      if (Notification.permission === "granted") {
        const n = new Notification(title, { body: description })
        n.onclick = () => onClick?.()
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== "granted") return
      const n = new Notification(title, { body: description })
      n.onclick = () => onClick?.()
    },
  }
}
