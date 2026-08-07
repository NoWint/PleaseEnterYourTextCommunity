// src/app/layout/sidebar/sidebar-project.tsx
// 照抄 opencode pages/layout/sidebar-project.tsx 改造：
// - serverSync/notification/permission 删除 → chat context 未读
// - hover 预览（HoverCard）与拖拽排序保留（@thisbeyond/solid-dnd）

import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "../../utils/base64"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Icon } from "@opencode-ai/ui/icon"
import { createSortable } from "@thisbeyond/solid-dnd"
import { useLayout, type LocalProject } from "../../context/layout"
import { useLanguage } from "../../context/language"
import { useChat } from "../../context/chat"
import { ProjectIcon, SessionItem, type SessionItemProps } from "./sidebar-items"
import { displayName, sortedRootSessions } from "./helpers"
import type { AppSession } from "../../types"

export type ProjectSidebarContext = {
  currentDir: Accessor<string | undefined>
  currentProject: Accessor<LocalProject | undefined>
  sidebarOpened: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  hoverProject: Accessor<string | undefined>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  onHoverOpenChanged: (worktree: string, hovered: boolean) => void
  navigateToProject: (directory: string) => void
  openSidebar: () => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  sessionProps: Pick<SessionItemProps, "navList" | "sidebarExpanded" | "clearHoverProjectSoon">
}

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((p) => p.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(p) => (
        <div class="bg-background-base rounded-xl p-1">
          <ProjectIcon project={p()} />
        </div>
      )}
    </Show>
  )
}

const ProjectTile = (props: {
  project: LocalProject
  mobile?: boolean
  sidebarHovering: Accessor<boolean>
  selected: Accessor<boolean>
  active: Accessor<boolean>
  isWorking: Accessor<boolean>
  overlay: Accessor<boolean>
  suppressHover: Accessor<boolean>
  dirs: Accessor<string[]>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  navigateToProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  closeProject: (directory: string) => void
  setMenu: (value: boolean) => void
  setOpen: (value: boolean) => void
  setSuppressHover: (value: boolean) => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const chat = useChat()
  const layout = useLayout()
  const unseenCount = createMemo(() =>
    props
      .dirs()
      .reduce(
        (total, directory) =>
          total +
          chat
            .chatList()
            .filter((item) => item.directory === directory)
            .reduce((sum, item) => sum + item.unread, 0),
        0,
      ),
  )

  const clear = () =>
    props
      .dirs()
      .forEach((directory) =>
        chat
          .chatList()
          .filter((item) => item.directory === directory && item.unread > 0)
          .forEach((item) => chat.markRead(item.id)),
      )

  return (
    <ContextMenu
      modal={!props.sidebarHovering()}
      onOpenChange={(value) => {
        props.setMenu(value)
        props.setSuppressHover(value)
        if (value) props.setOpen(false)
      }}
    >
      <ContextMenu.Trigger
        as="button"
        type="button"
        aria-label={displayName(props.project)}
        data-action="project-switch"
        data-project={base64Encode(props.project.worktree)}
        classList={{
          "flex items-center justify-center size-10 p-1 rounded-lg overflow-hidden transition-colors cursor-default": true,
          "bg-transparent border-2 border-icon-strong-base hover:bg-surface-base-hover": props.selected(),
          "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-weak-base":
            !props.selected() && !props.active(),
          "bg-surface-base-hover border border-border-weak-base": !props.selected() && props.active(),
        }}
        onPointerDown={(event) => {
          if (event.button === 0 && !event.ctrlKey) {
            props.setOpen(false)
            props.setSuppressHover(true)
            return
          }
          if (!props.overlay()) return
          if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return
          props.setOpen(false)
          props.setSuppressHover(true)
          event.preventDefault()
        }}
        onMouseEnter={(event: MouseEvent) => {
          if (!props.overlay()) return
          if (props.suppressHover()) return
          props.onProjectMouseEnter(props.project.worktree, event)
        }}
        onMouseLeave={() => {
          if (props.suppressHover()) props.setSuppressHover(false)
          if (!props.overlay()) return
          props.onProjectMouseLeave(props.project.worktree)
        }}
        onFocus={() => {
          if (!props.overlay()) return
          if (props.suppressHover()) return
          props.onProjectFocus(props.project.worktree)
        }}
        onClick={() => {
          props.setOpen(false)
          if (props.selected()) {
            layout.sidebar.toggle()
            return
          }
          props.navigateToProject(props.project.worktree)
        }}
        onBlur={() => props.setOpen(false)}
      >
        <ProjectIcon project={props.project} notify working={props.isWorking()} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => props.showEditProjectDialog(props.project)}>
            <ContextMenu.ItemLabel>{props.language.t("common.edit")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-workspaces-toggle"
            data-project={base64Encode(props.project.worktree)}
            disabled={!props.workspacesEnabled(props.project)}
            onSelect={() => props.toggleProjectWorkspaces(props.project)}
          >
            <ContextMenu.ItemLabel>
              {props.workspacesEnabled(props.project)
                ? props.language.t("sidebar.workspaces.disable")
                : props.language.t("sidebar.workspaces.enable")}
            </ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-clear-notifications"
            data-project={base64Encode(props.project.worktree)}
            disabled={unseenCount() === 0}
            onSelect={clear}
          >
            <ContextMenu.ItemLabel>{props.language.t("sidebar.project.clearNotifications")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="project-close-menu"
            data-project={base64Encode(props.project.worktree)}
            onSelect={() => props.closeProject(props.project.worktree)}
          >
            <ContextMenu.ItemLabel>{props.language.t("common.close")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

const ProjectPreviewPanel = (props: {
  project: LocalProject
  mobile?: boolean
  selected: Accessor<boolean>
  workspaceEnabled: Accessor<boolean>
  workspaces: Accessor<string[]>
  label: (directory: string) => string
  projectSessions: Accessor<AppSession[]>
  workspaceSessions: (directory: string) => AppSession[]
  ctx: ProjectSidebarContext
  language: ReturnType<typeof useLanguage>
}): JSX.Element => (
  <div class="-m-3 p-2 flex flex-col w-72">
    <div class="px-4 pt-2 pb-1 flex items-center gap-2">
      <div class="text-14-medium text-text-strong truncate grow">{displayName(props.project)}</div>
    </div>
    <div class="px-4 pb-2 text-12-medium text-text-weak">{props.language.t("sidebar.project.recentSessions")}</div>
    <div class="px-2 pb-2 flex flex-col gap-2">
      <Show
        when={props.workspaceEnabled()}
        fallback={
          <For each={props.projectSessions().slice(0, 2)}>
            {(session) => (
              <SessionItem
                {...props.ctx.sessionProps}
                session={session}
                list={props.projectSessions()}
                slug={base64Encode(props.project.worktree)}
                dense
                showTooltip
                mobile={props.mobile}
              />
            )}
          </For>
        }
      >
        <For each={props.workspaces()}>
          {(directory) => {
            const sessions = createMemo(() => props.workspaceSessions(directory))
            return (
              <div class="flex flex-col gap-1">
                <div class="px-2 py-0.5 flex items-center gap-1 min-w-0">
                  <div class="shrink-0 size-6 flex items-center justify-center">
                    <Icon name="branch" size="small" class="text-icon-base" />
                  </div>
                  <span class="truncate text-14-medium text-text-base">{props.label(directory)}</span>
                </div>
                <For each={sessions().slice(0, 2)}>
                  {(session) => (
                    <SessionItem
                      {...props.ctx.sessionProps}
                      session={session}
                      list={sessions()}
                      slug={base64Encode(directory)}
                      dense
                      showTooltip
                      mobile={props.mobile}
                    />
                  )}
                </For>
              </div>
            )
          }}
        </For>
      </Show>
    </div>
  </div>
)

export const SortableProject = (props: {
  project: LocalProject
  mobile?: boolean
  ctx: ProjectSidebarContext
  sortNow: Accessor<number>
}): JSX.Element => {
  const chat = useChat()
  const language = useLanguage()
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() => props.ctx.currentProject()?.worktree === props.project.worktree)
  const workspaces = createMemo(() => props.ctx.workspaceIds(props.project).slice(0, 2))
  const workspaceEnabled = createMemo(() => props.ctx.workspacesEnabled(props.project))
  const dirs = createMemo(() => props.ctx.workspaceIds(props.project))
  const [state, setState] = createStore({
    menu: false,
    suppressHover: false,
  })

  const isHoverProject = () => props.ctx.hoverProject() === props.project.worktree
  const preview = createMemo(() => !props.mobile && props.ctx.sidebarOpened())
  const overlay = createMemo(() => !props.mobile && !props.ctx.sidebarOpened())
  const active = createMemo(() => state.menu || (preview() ? isHoverProject() : overlay() && isHoverProject()))

  const hoverOpen = () => isHoverProject() && preview() && !selected() && !state.menu

  const label = (directory: string) => {
    const kind = directory === props.project.worktree
      ? language.t("workspace.type.local")
      : language.t("workspace.type.sandbox")
    const name = props.ctx.workspaceLabel(directory, undefined, props.project.id)
    return `${kind} : ${name}`
  }

  const isWorking = createMemo(() =>
    dirs().some((directory) =>
      chat
        .chatList()
        .some((item) => item.directory === directory && item.working),
    ),
  )
  const projectSessions = createMemo(() =>
    sortedRootSessions(
      {
        session: chat.chatList().filter((item) => item.directory === props.project.worktree),
        path: { directory: props.project.worktree },
      },
      props.sortNow(),
    ),
  )
  const workspaceSessions = (directory: string) =>
    sortedRootSessions(
      { session: chat.chatList().filter((item) => item.directory === directory), path: { directory } },
      props.sortNow(),
    )
  const tile = () => (
    <ProjectTile
      project={props.project}
      mobile={props.mobile}
      sidebarHovering={props.ctx.sidebarHovering}
      selected={selected}
      active={active}
      isWorking={isWorking}
      overlay={overlay}
      suppressHover={() => state.suppressHover}
      dirs={dirs}
      onProjectMouseEnter={props.ctx.onProjectMouseEnter}
      onProjectMouseLeave={props.ctx.onProjectMouseLeave}
      onProjectFocus={props.ctx.onProjectFocus}
      navigateToProject={props.ctx.navigateToProject}
      showEditProjectDialog={props.ctx.showEditProjectDialog}
      toggleProjectWorkspaces={props.ctx.toggleProjectWorkspaces}
      workspacesEnabled={props.ctx.workspacesEnabled}
      closeProject={props.ctx.closeProject}
      setMenu={(value) => setState("menu", value)}
      setOpen={(value) => props.ctx.onHoverOpenChanged(props.project.worktree, value)}
      setSuppressHover={(value) => setState("suppressHover", value)}
      language={language}
    />
  )

  return (
    // @ts-ignore
    <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <Show when={preview() && !selected()} fallback={tile()}>
        <HoverCard
          open={!state.suppressHover && hoverOpen() && !state.menu}
          openDelay={0}
          closeDelay={0}
          placement="right-start"
          gutter={6}
          trigger={tile()}
          onOpenChange={(value) => {
            if (state.menu) return
            if (value && state.suppressHover) return
            props.ctx.onHoverOpenChanged(props.project.worktree, value)
          }}
        >
          <ProjectPreviewPanel
            project={props.project}
            mobile={props.mobile}
            selected={selected}
            workspaceEnabled={workspaceEnabled}
            workspaces={workspaces}
            label={label}
            projectSessions={projectSessions}
            workspaceSessions={workspaceSessions}
            ctx={props.ctx}
            language={language}
          />
        </HoverCard>
      </Show>
    </div>
  )
}
