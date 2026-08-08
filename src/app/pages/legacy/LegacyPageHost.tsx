// src/app/pages/legacy/LegacyPageHost.tsx
// 通用宿主：把 legacy vanilla 页（renderXxxNav/renderXxxMain）挂进 v2 壳层。
// 布局镜像 legacy 壳层：左侧 nav-panel（240px，有 nav 渲染器时）+ 右侧 chat-main。
// 临时方案（Task 3）：页面内容为 legacy DOM，容器保持 v2 底色；后续迁移为 v2 组件。
// legacy 样式（styles.css + 全局还原补丁）仅在挂载期间注入 <link>/<style>，卸载时移除，
// 不随应用启动全局加载 —— v2 壳层不受 styles.css 全局规则影响。
import { onCleanup, onMount } from "solid-js"
import { state } from "@/state"
import type { Page } from "@/types"
import { legacyGlobalFixCss, legacyStylesheetUrl } from "./legacy-style"

interface LegacyPageHostProps {
  page: Page
  nav?: (panel: HTMLElement) => void | Promise<void>
  main: (host: HTMLElement) => void | Promise<void>
}

export default function LegacyPageHost(props: LegacyPageHostProps) {
  let shellRef: HTMLDivElement | undefined
  let navRef: HTMLDivElement | undefined
  let mainRef: HTMLDivElement | undefined
  let styleNodes: HTMLElement[] = []
  let prevPage: Page = state.currentPage

  onMount(async () => {
    // 挂载前记录 legacy state 的页面值，卸载时还原（避免 persist 写入污染 legacy 壳恢复页）
    prevPage = state.currentPage
    state.currentPage = props.page

    // legacy 样式按需注入：styles.css 在前，全局还原补丁在后（补丁需覆盖 styles.css 同优先级规则）
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = legacyStylesheetUrl
    document.head.appendChild(link)
    const patch = document.createElement("style")
    patch.textContent = legacyGlobalFixCss
    document.head.appendChild(patch)
    styleNodes = [link, patch]

    // nav / main 分开尝试：nav 失败不阻塞 main 渲染
    if (props.nav && navRef) {
      try {
        await props.nav(navRef)
      } catch (err) {
        navRef.innerHTML = `<div class="empty">导航加载失败：${String(err)}</div>`
      }
    }
    if (mainRef) {
      try {
        await props.main(mainRef)
      } catch (err) {
        mainRef.innerHTML = `<div class="empty">页面加载失败：${String(err)}</div>`
      }
    }
  })

  onCleanup(() => {
    for (const node of styleNodes) node.remove()
    styleNodes = []
    if (shellRef) shellRef.innerHTML = ""
    state.currentPage = prevPage
  })

  return (
    <div
      ref={shellRef}
      class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
    >
      {props.nav && <div ref={navRef} class="nav-panel shrink-0" />}
      <div ref={mainRef} class="chat-main" />
    </div>
  )
}
