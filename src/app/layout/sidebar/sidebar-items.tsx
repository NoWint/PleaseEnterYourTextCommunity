// src/app/layout/sidebar/sidebar-items.tsx
// 照抄 opencode pages/layout/sidebar-items.tsx 改造：
// - Session 类型 → 本地 AppSession；serverSync/notification/permission 删除
// - 未读/工作中来自 chat context（假数据）
// - href：/chat/:id

import type { AppSession } from "../../types"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { A } from "@solidjs/router"
import { type Accessor, createMemo, For, type JSX, Match, Show, Switch } from "solid-js"
import { useLanguage } from "../../context/language"
import { getAvatarColors, type LocalProject } from "../../context/layout"
import { useChat } from "../../context/chat"
import { useTabs } from "../../context/tabs"
import { getProjectAvatarSource } from "./helpers"

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  notify?: boolean
  working?: boolean
}): JSX.Element => {
  const chat = useChat()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce(
      (total, directory) =>
        total +
        chat
          .chatList()
          .filter((item) => item.directory === directory)
          .reduce((sum, item) => sum + item.unread, 0),
      0,
    ),
  )
  const notify = createMemo(() => props.notify && unseenCount() > 0)
  const name = createMemo(() => props.project.name || props.project.worktree)

  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div class="absolute top-px right-px size-1.5 rounded-full z-10 bg-text-interactive-base" />
      </Show>
      <Show when={props.working}>
        <div class="absolute bottom-px right-px size-3 rounded-full bg-background-base z-10 flex items-center justify-center">
          <Spinner class="size-[9px]" />
        </div>
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: AppSession
  list: AppSession[]
  navList?: Accessor<AppSession[]>
  slug?: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}

const SessionRow = (props: {
  session: AppSession
  dense?: boolean
  isWorking: Accessor<boolean>
  unseenCount: Accessor<number>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
}): JSX.Element => {
  const title = () => props.session.title

  return (
    <A
      href={`/chat/${props.session.id}`}
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <Show when={props.isWorking() || props.unseenCount() > 0}>
        <div class="shrink-0 size-6 flex items-center justify-center">
          <Switch>
            <Match when={props.isWorking()}>
              <Spinner class="size-[15px]" />
            </Match>
            <Match when={props.unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
      </Show>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{title()}</span>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const language = useLanguage()
  const chat = useChat()
  const tabs = useTabs()
  const unseenCount = createMemo(() => chat.unreadFor(props.session.id))
  const isWorking = createMemo(() => !!chat.session(props.session.id)?.working)
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const title = createMemo(() => props.session.title)

  const archive = () => {
    chat.archive(props.session.id)
    tabs.removeSessionTab({ chatId: props.session.id })
  }

  const item = (
    <SessionRow
      session={props.session}
      dense={props.dense}
      isWorking={isWorking}
      unseenCount={unseenCount}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={props.sidebarExpanded}
    />
  )

  return (
    <div
      data-session-id={props.session.id}
      class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
      style={{ "padding-left": `${8 + (props.level ?? 0) * 16}px` }}
    >
      <div class="flex min-w-0 items-center gap-1">
        <div class="min-w-0 flex-1">
          <Show
            when={!tooltip()}
            fallback={
              <Tooltip
                placement={props.mobile ? "bottom" : "right"}
                value={title()}
                gutter={10}
                class="min-w-0 w-full"
              >
                {item}
              </Tooltip>
            }
          >
            {item}
          </Show>
        </div>

        <Show when={!props.level}>
          <div
            class="shrink-0 overflow-hidden transition-[width,opacity]"
            classList={{
              "w-6 opacity-100 pointer-events-auto": !!props.mobile,
              "w-0 opacity-0 pointer-events-none": !props.mobile,
              "group-hover/session:w-6 group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
              "group-focus-within/session:w-6 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
            }}
          >
            <Tooltip value={language.t("common.archive")} placement="top">
              <IconButton
                icon="archive"
                variant="ghost"
                class="size-6 rounded-md"
                aria-label={language.t("common.archive")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  archive()
                }}
              />
            </Tooltip>
          </div>
        </Show>
      </div>
    </div>
  )
}

export const NewSessionItem = (props: {
  slug?: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href="/chat/new"
      end
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        if (props.sidebarExpanded()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <IconV2 name="edit" size="small" class="text-icon-weak" />
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
