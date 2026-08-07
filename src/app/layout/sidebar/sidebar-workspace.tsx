// src/app/layout/sidebar/sidebar-workspace.tsx
// 照抄 opencode pages/layout/sidebar-workspace.tsx 改造：
// - serverSync/@tanstack query 删除 → chat context 假数据
// - InlineEditor 内联改名删除 → 上下文菜单改名（TODO Task 2 恢复内联编辑）
// - 会话 href：/chat/:id

import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { getFilename } from "../../utils/path"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "../../context/language"
import { useChat } from "../../context/chat"
import type { LocalProject } from "../../context/layout"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import { sortedRootSessions } from "./helpers"
import type { AppSession } from "../../types"

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string | undefined>
  navList: Accessor<AppSession[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  clearHoverProjectSoon: () => void
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  // TODO(Task 2): 接入重置/删除工作区对话框（现为 no-op 占位）
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Icon name="branch" size="small" />
    </div>
    <span class="text-14-medium text-text-base shrink-0">
      {props.language.t("workspace.type.local")} :
    </span>
    <span class="text-14-medium text-text-base min-w-0 truncate">{props.workspaceValue()}</span>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  sidebarHovering: Accessor<boolean>
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  root: string
  clearHoverProjectSoon: () => void
  navigateToNewSession: () => void
}): JSX.Element => (
  <div
    class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
    classList={{
      "opacity-100 pointer-events-auto": props.menuOpen(),
      "opacity-0 pointer-events-none": !props.menuOpen(),
      "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
      "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
    }}
  >
    <DropdownMenu
      modal={!props.sidebarHovering()}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButtonV2}
          icon={<IconV2 name="outline-dots" />}
          variant="ghost-muted"
          size="small"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={props.directory}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              const next = window.prompt(props.language.t("common.rename"), props.workspaceValue())
              if (next?.trim()) props.renameWorkspace(props.directory, next.trim())
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButtonV2
          icon={<IconV2 name="edit" size="small" />}
          variant="ghost-muted"
          size="small"
          class="size-6 rounded-md opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto"
          data-action="workspace-new-session"
          data-workspace={props.directory}
          aria-label={props.language.t("command.session.new")}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.clearHoverProjectSoon()
            props.navigateToNewSession()
          }}
        />
      </Tooltip>
    </Show>
  </div>
)

const WorkspaceSessionList = (props: {
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<AppSession[]>
  language: ReturnType<typeof useLanguage>
}): JSX.Element => (
  <nav class="flex flex-col gap-1">
    <Show when={props.showNew()}>
      <NewSessionItem
        mobile={props.mobile}
        sidebarExpanded={props.ctx.sidebarExpanded}
        clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
      />
    </Show>
    <Show when={props.loading()}>
      <SessionSkeleton />
    </Show>
    <For each={props.sessions()}>
      {(session) => (
        <SessionItem
          session={session}
          list={props.sessions()}
          navList={props.ctx.navList}
          mobile={props.mobile}
          showChild
          sidebarExpanded={props.ctx.sidebarExpanded}
          clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
        />
      )}
    </For>
  </nav>
)

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const chat = useChat()
  const language = useLanguage()
  const sortable = createSortable(props.directory)
  const [menuOpen, setMenuOpen] = createStore({ open: false })
  const sessions = createMemo(() => {
    const all = chat
      .chatList()
      .filter((item) => item.directory === props.directory)
    return sortedRootSessions({ session: all, path: { directory: props.directory } }, props.sortNow())
  })
  const local = createMemo(() => props.directory === props.project.worktree)
  const workspaceValue = createMemo(
    () => props.ctx.workspaceName(props.directory, props.project.id) ?? getFilename(props.directory),
  )
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const count = createMemo(() => sessions().length)
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const loading = () => false
  const touch = createMediaQuery("(hover: none)")
  const showNew = createMemo(
    () => !loading() && (touch() || count() === 0 || local()),
  )

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
  }

  return (
    <div
      // @ts-ignore
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        <div class="py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={props.directory}
          >
            <div class="flex items-center gap-1">
              <Collapsible.Trigger
                class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-md hover:bg-surface-raised-base-hover transition-[padding] duration-200 ${
                  menuOpen.open ? "pr-16" : "pr-2"
                } group-hover/workspace:pr-16 group-focus-within/workspace:pr-16`}
                data-action="workspace-toggle"
                data-workspace={props.directory}
              >
                <WorkspaceHeader
                  local={local}
                  busy={busy}
                  open={open}
                  directory={props.directory}
                  language={language}
                  workspaceValue={workspaceValue}
                />
              </Collapsible.Trigger>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menuOpen.open}
                setMenuOpen={(open) => setMenuOpen("open", open)}
                sidebarHovering={props.ctx.sidebarHovering}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                renameWorkspace={props.ctx.renameWorkspace}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                navigateToNewSession={() => navigate("/chat/new")}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content>
          <WorkspaceSessionList
            mobile={props.mobile}
            ctx={props.ctx}
            showNew={showNew}
            loading={loading}
            sessions={sessions}
            language={language}
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const chat = useChat()
  const language = useLanguage()
  const workspace = createMemo(() => {
    const all = chat
      .chatList()
      .filter((item) => item.directory === props.project.worktree)
    return { sessions: sortedRootSessions({ session: all, path: { directory: props.project.worktree } }, props.sortNow()) }
  })
  const showNew = () => true

  return (
    <div
      ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
      class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
    >
      <WorkspaceSessionList
        mobile={props.mobile}
        ctx={props.ctx}
        showNew={showNew}
        loading={() => false}
        sessions={() => workspace().sessions}
        language={language}
      />
    </div>
  )
}
