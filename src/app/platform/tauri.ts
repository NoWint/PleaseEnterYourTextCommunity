// src/app/platform/tauri.ts
// Tauri 平台实现（对齐 opencode context/platform 的桌面部分接口形状）。
// 浏览器 dev 环境回落到 web 行为。
// 桌面能力：openExternal 走 @tauri-apps/plugin-shell open（延迟加载，失败回落 window.open）；
// 通知走 @tauri-apps/plugin-notification（延迟加载，失败回落 Web Notification API）。

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

  const notifyViaPlugin = async (title: string, description?: string) => {
    const { sendNotification, isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    )
    if (!(await isPermissionGranted())) {
      if (typeof requestPermission !== "function") return
      const permission = await requestPermission()
      if (permission !== "granted") return
    }
    sendNotification({ title, body: description })
  }

  const notifyViaWeb = async (title: string, description?: string, onClick?: () => void) => {
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
  }

  return {
    platform: tauri ? "desktop" : "web",
    os: tauri ? detectOS() : undefined,
    windowFullscreen: () => fullscreen,
    webviewZoom: () => 1,
    openExternal(url: string) {
      if (tauri) {
        // Tauri openUrl：plugin-shell 的 open()（延迟加载，插件未注册/旧版本时回落）
        import("@tauri-apps/plugin-shell")
          .then(({ open }) => open(url))
          .catch(() => window.open(url, "_blank"))
        return
      }
      window.open(url, "_blank")
    },
    async notify(title: string, description?: string, onClick?: () => void) {
      if (tauri) {
        // 通知插件：延迟加载；不可用（插件未注册）时回落到 Web Notification API
        try {
          await notifyViaPlugin(title, description)
          return
        } catch {
          /* 回落 Web Notification */
        }
      }
      await notifyViaWeb(title, description, onClick)
    },
  }
}
