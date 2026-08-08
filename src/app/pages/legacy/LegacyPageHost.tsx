// src/app/pages/legacy/LegacyPageHost.tsx
// 通用宿主：把 legacy vanilla 页（renderXxxNav/renderXxxMain）挂进 v2 壳层。
// 布局镜像 legacy 壳层：左侧 nav-panel（240px，有 nav 渲染器时）+ 右侧 chat-main。
// 临时方案（Task 3）：页面内容为 legacy DOM，容器保持 v2 底色；后续迁移为 v2 组件。
import { onCleanup, onMount } from "solid-js"
import { state } from "@/state"
import type { Page } from "@/types"
import "./legacy-style"

interface LegacyPageHostProps {
  page: Page
  nav?: (panel: HTMLElement) => void | Promise<void>
  main: (host: HTMLElement) => void | Promise<void>
}

export default function LegacyPageHost(props: LegacyPageHostProps) {
  let shellRef: HTMLDivElement | undefined
  let navRef: HTMLDivElement | undefined
  let mainRef: HTMLDivElement | undefined

  onMount(async () => {
    state.currentPage = props.page
    try {
      if (props.nav && navRef) await props.nav(navRef)
      if (mainRef) await props.main(mainRef)
    } catch (err) {
      if (mainRef) {
        mainRef.innerHTML = `<div class="empty">页面加载失败：${String(err)}</div>`
      }
    }
  })

  onCleanup(() => {
    if (shellRef) shellRef.innerHTML = ""
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
