// src/app/pages/home/home-projects-view.tsx
// 照抄 opencode pages/home/home-projects-view.tsx 改造：
// - @dnd-kit/solid 拖拽删除（单 server 下不排序，TODO Task 2 恢复）
// - 多 server / ServerHealthIndicator / ServerRowMenu 删除（单本地 server）
// - 保留：工作区列表、选择、菜单（MenuV2）、最近关闭、工具导航

import { type Accessor, createMemo, For, type JSX, onCleanup, Show, splitProps } from "solid-js"
import { createStore } from "solid-js/store"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { getProjectAvatarVariant, type HomeProjectSelection, type LocalProject } from "../../context/layout"
import { useLanguage } from "../../context/language"
import { displayName, getProjectAvatarSource } from "../../layout/sidebar/helpers"
import type { ServerConnection } from "../../context/server"

const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"

const projectContextMenuID = (server: ServerConnection.Key, directory: string) =>
  `project:${server}:${directory}`

export type HomeProjectsViewProps = {
  language: ReturnType<typeof useLanguage>
  projects: Accessor<LocalProject[]>
  recentlyClosed: Accessor<LocalProject[]>
  selection: Accessor<HomeProjectSelection>
  homedir: Accessor<string>
  canRevealProject: () => boolean
  unseenCount: (project: LocalProject) => number
  onWheel: (event: WheelEvent) => void
  onChooseProject: () => void
  onSelectProject: (server: ServerConnection.Any, directory: string) => void
  onAddProjects: (server: ServerConnection.Any, directories: string[]) => void
  onOpenProjectNewSession: (server: ServerConnection.Any, directory: string) => void
  onEditProject: (server: ServerConnection.Any, project: LocalProject) => void
  onRevealProject: (server: ServerConnection.Any, project: LocalProject) => void
  onClearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  onCloseProject: (server: ServerConnection.Any, directory: string) => void
  onOpenSettings: () => void
  onOpenHelp: () => void
}

export function HomeProjectsView(props: HomeProjectsViewProps) {
  const [contextMenu, setContextMenu] = createStore({ open: undefined as string | undefined })
  const contextMenuProps = {
    contextMenuOpen: (id: string) => contextMenu.open === id,
    onSetContextMenuOpen: (id: string, open: boolean) => setContextMenu("open", open ? id : undefined),
  }
  return (
    <aside
      class={`
        mt-6 flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden
        lg:sticky lg:top-14 lg:mt-14 lg:h-[calc(100cqh-56px)] lg:self-start lg:pt-[52px]
      `}
      aria-label={props.language.t("home.projects")}
      onWheel={(event) => {
        if (event.target === event.currentTarget) return
        props.onWheel(event)
      }}
    >
      <div class="flex h-7 min-w-0 shrink-0 items-center justify-between pl-1.5 pr-3">
        <div class="text-v2-text-text-muted [font-weight:530]">{props.language.t("home.projects")}</div>
        <Show when={!(props.projects().length === 0 && props.recentlyClosed().length > 0)}>
          <TooltipV2 placement="bottom" value={props.language.t("home.project.add")}>
            <IconButtonV2
              data-action="home-add-project"
              variant="ghost-muted"
              size="large"
              class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
              icon={<IconV2 name="folder-add-left" />}
              onClick={() => props.onChooseProject()}
              aria-label={props.language.t("home.project.add")}
            />
          </TooltipV2>
        </Show>
      </div>
      <ScrollView data-slot="home-projects-scroll" class="min-h-0 min-w-0 shrink">
        <div class="pr-3">
          <Show
            when={props.projects().length > 0}
            fallback={<HomeProjectEmpty {...props} items={props.recentlyClosed()} />}
          >
            <HomeProjectList {...props} {...contextMenuProps} items={props.projects()} />
          </Show>
        </div>
      </ScrollView>
      <HomeUtilityNav
        class="mb-8 mt-4 hidden shrink-0 lg:flex"
        onOpenSettings={props.onOpenSettings}
        onOpenHelp={props.onOpenHelp}
        language={props.language}
      />
    </aside>
  )
}

export function HomeUtilityNav(props: {
  class?: string
  onOpenSettings: () => void
  onOpenHelp: () => void
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <div class={`${props.class ?? ""} min-w-0 flex-col gap-1 pr-3`}>
      <HomeProjectNavButton
        type="button"
        class="text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        onClick={props.onOpenSettings}
      >
        <IconV2 name="settings-gear" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.settings")}</span>
      </HomeProjectNavButton>
      <HomeProjectNavButton
        type="button"
        class="text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        onClick={props.onOpenHelp}
      >
        <IconV2 name="help" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.help")}</span>
      </HomeProjectNavButton>
    </div>
  )
}

type HomeProjectsContextMenuProps = {
  contextMenuOpen: (id: string) => boolean
  onSetContextMenuOpen: (id: string, open: boolean) => void
}

type HomeProjectListProps = HomeProjectsViewProps &
  HomeProjectsContextMenuProps & {
    items: LocalProject[]
  }

function HomeProjectList(props: HomeProjectListProps) {
  return (
    <div class="flex min-w-0 flex-col gap-1">
      {/* Keyed on worktree strings（对齐 opencode 的 keyed 列表，避免 store 更新重挂载） */}
      <For each={props.items.map((project) => project.worktree)}>
        {(worktree, index) => <HomeProjectSlot {...props} worktree={worktree} index={index} />}
      </For>
    </div>
  )
}

function HomeProjectSlot(
  props: HomeProjectListProps & {
    worktree: string
    index: () => number
  },
) {
  const initial = props.items.find((item) => item.worktree === props.worktree)
  if (!initial) return
  const project = createMemo<LocalProject>(
    (previous) => props.items.find((item) => item.worktree === props.worktree) ?? previous,
    initial,
  )

  return (
    <HomeProjectRow
      {...props}
      project={project()}
      index={props.index}
      selected={props.selection().directory === props.worktree}
      unseen={props.unseenCount(project())}
    />
  )
}

function HomeProjectEmpty(
  props: HomeProjectsViewProps & {
    items: LocalProject[]
  },
) {
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <HomeProjectNavButton
        type="button"
        data-action="home-add-project-row"
        onClick={() => props.onChooseProject()}
      >
        <IconV2 name="folder-add-left" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("home.project.add")}</span>
      </HomeProjectNavButton>
      <Show when={props.items.length > 0}>
        <div class="mt-3 flex h-7 min-w-0 shrink-0 items-center pl-1.5 pr-3">
          <div class="text-v2-text-text-faint [font-weight:530]">{props.language.t("home.recentlyClosed")}</div>
        </div>
        <For each={props.items}>
          {(project) => <HomeRecentlyClosedRow {...props} project={project} />}
        </For>
      </Show>
    </div>
  )
}

function HomeRecentlyClosedRow(
  props: HomeProjectsViewProps & {
    project: LocalProject
  },
) {
  const path = () => {
    const home = props.homedir()
    const worktree = props.project.worktree
    if (home && (worktree === home || worktree.startsWith(`${home}/`))) return `~${worktree.slice(home.length)}`
    return worktree
  }
  return (
    <TooltipV2 placement="right" value={path()}>
      <HomeProjectNavButton
        type="button"
        data-component="home-recently-closed-row"
        onClick={() => props.onAddProjects({ key: "local" }, [props.project.worktree])}
      >
        <HomeProjectAvatar project={props.project} outline />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </HomeProjectNavButton>
    </TooltipV2>
  )
}

function HomeProjectRow(
  props: HomeProjectsViewProps &
    HomeProjectsContextMenuProps & {
      project: LocalProject
      index: () => number
      selected: boolean
      unseen: number
    },
) {
  const serverKey = () => "local" as ServerConnection.Key
  const contextMenuID = () => projectContextMenuID(serverKey(), props.project.worktree)
  onCleanup(() => {
    const id = contextMenuID()
    if (props.contextMenuOpen(id)) props.onSetContextMenuOpen(id, false)
  })
  return (
    <div class="group/project relative flex h-7 min-w-0 items-center rounded-[6px]">
      <HomeProjectNavButton
        type="button"
        data-component="home-project-row"
        class="pr-16"
        data-selected={props.selected ? "" : undefined}
        aria-current={props.selected ? "page" : undefined}
        onClick={() => props.onSelectProject({ key: serverKey() }, props.project.worktree)}
      >
        <HomeProjectAvatar project={props.project} />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </HomeProjectNavButton>
      <div
        class={`
          hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1
          group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100
        `}
        data-menu={props.contextMenuOpen(contextMenuID())}
      >
        <MenuV2
          gutter={6}
          modal={false}
          placement="bottom-end"
          open={props.contextMenuOpen(contextMenuID())}
          onOpenChange={(open) => props.onSetContextMenuOpen(contextMenuID(), open)}
        >
          <MenuV2.Trigger
            as={IconButtonV2}
            data-action="home-project-menu"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-dots" />}
            aria-label={props.language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={() => props.onOpenProjectNewSession({ key: serverKey() }, props.project.worktree)}>
                {props.language.t("command.session.new")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => props.onEditProject({ key: serverKey() }, props.project)}>
                {props.language.t("dialog.project.edit.title")}
              </MenuV2.Item>
              <Show when={props.canRevealProject()}>
                <MenuV2.Item onSelect={() => props.onRevealProject({ key: serverKey() }, props.project)}>
                  {props.language.t("sidebar.project.reveal")}
                </MenuV2.Item>
              </Show>
              <MenuV2.Item
                disabled={props.unseen === 0}
                onSelect={() => props.onClearNotifications({ key: serverKey() }, props.project)}
              >
                {props.language.t("sidebar.project.clearNotifications")}
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => props.onCloseProject({ key: serverKey() }, props.project.worktree)}>
                {props.language.t("common.close")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
        <IconButtonV2
          data-action="home-project-new-session"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="edit" />}
          aria-label={props.language.t("command.session.new")}
          onClick={() => props.onOpenProjectNewSession({ key: serverKey() }, props.project.worktree)}
        />
      </div>
    </div>
  )
}

function HomeProjectNavButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <button
      {...rest}
      class={`
        flex h-7 min-w-0 w-full shrink-0 cursor-default items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
        data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base
        data-[selected]:hover:bg-v2-background-bg-layer-03
        focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:outline-none
        focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]
        ${local.class ?? ""}
      `}
      classList={local.classList}
    >
      {local.children}
    </button>
  )
}

function HomeProjectAvatar(props: { project: LocalProject; outline?: boolean }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={props.outline ? undefined : getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={props.outline ? "outline" : getProjectAvatarVariant(props.project.icon?.color)}
    />
  )
}
