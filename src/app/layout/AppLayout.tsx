// src/app/layout/AppLayout.tsx
// 顶层壳：Titlebar（tab strip）+ sidebar-shell（rail + aim-peek 面板）+ main + ToastRegion。
// 结构照抄 opencode pages/layout.tsx（legacy 壳）+ layout-new.tsx（V2 背景/主区）。
// Rail.tsx 已删除；侧栏数据 = 工作区/会话（chat/workspace context 真实数据，假数据兜底）。

import type { Component, ParentProps, Accessor } from "solid-js"
import { createEffect, createMemo, For, onCleanup, onMount, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { makeEventListener } from "@solid-primitives/event-listener"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter, type DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "../utils/solid-dnd"
import { base64Encode } from "../utils/base64"
import { getFilename } from "../utils/path"
import { createAim } from "../utils/aim"
import { useLayout, type LocalProject } from "../context/layout"
import { useCommand } from "../context/command"
import { useLanguage } from "../context/language"
import { useChat } from "../context/chat"
import { useTabs } from "../context/tabs"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useSettingsDialog } from "../components/dialogs/settings-dialog"
import { DialogEditWorkspaceV2 } from "../components/dialogs/dialog-edit-workspace-v2"
import { ConfirmWorkspaceDialog, WorkspaceSelectDialog } from "../components/dialogs/workspace-dialogs"
import { HelpDialogContent } from "../components/dialogs/help-button"
import { dialogsT } from "../components/dialogs/i18n"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useWorkspace } from "../context/workspace"
import { showToast } from "../utils/toast"
import { call } from "../../api"
import { Titlebar } from "./titlebar/titlebar"
import { SidebarContent } from "./sidebar/sidebar-shell"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./sidebar/sidebar-project"
import {
  LocalWorkspace,
  SortableWorkspace,
  type WorkspaceSidebarContext,
} from "./sidebar/sidebar-workspace"
import { WorkspaceDragOverlay } from "./sidebar/workspace-drag-overlay"
import ToastRegion from "./ToastRegion"

const AppLayout: Component<ParentProps> = (props) => {
  const layout = useLayout()
  const language = useLanguage()
  const command = useCommand()
  const chat = useChat()
  const tabs = useTabs()
  const navigate = useNavigate()
  const dialog = useDialog()
  const workspace = useWorkspace()

  const [state, setState] = createStore({
    hoverProject: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    sizing: false,
    peek: undefined as string | undefined,
    peeked: false,
  })

  let navLeave: number | undefined
  let peekt: number | undefined
  let sizet: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined

  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    if (navLeave !== undefined) clearTimeout(navLeave)
    clearTimeout(sortNowTimeout)
    if (sortNowInterval !== undefined) clearInterval(sortNowInterval)
    if (sizet !== undefined) clearTimeout(sizet)
    if (peekt !== undefined) clearTimeout(peekt)
    aim.reset()
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    const blur = () => reset()
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "blur", blur)
    makeEventListener(document, "visibilitychange", hide)
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const setHoverProject = (value: string | undefined) => {
    setState("hoverProject", value)
    if (value !== undefined) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(undefined))

  const disarm = () => {
    if (navLeave === undefined) return
    clearTimeout(navLeave)
    navLeave = undefined
  }

  const reset = () => {
    disarm()
    setHoverProject(undefined)
  }

  const arm = () => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    disarm()
    navLeave = window.setTimeout(() => {
      navLeave = undefined
      setHoverProject(undefined)
    }, 300)
  }

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      if (peekt !== undefined) {
        clearTimeout(peekt)
        peekt = undefined
      }
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    if (peekt !== undefined) clearTimeout(peekt)
    peekt = window.setTimeout(() => {
      peekt = undefined
      setState("peek", undefined)
    }, 180)
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(undefined)
  })

  createEffect(() => {
    document.documentElement.style.setProperty(
      "--dialog-left-margin",
      `${layout.sidebar.opened() ? layout.sidebar.width() : 48}px`,
    )
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))

  // 当前目录：route 反推（session → 所属工作区；workspace → wsId）
  const currentDir = createMemo(() => {
    const route = layout.route()
    if (route.type === "session") return chat.session(route.chatId)?.directory
    if (route.type === "workspace") return route.wsId
    if (route.type === "draft") return undefined
    return undefined
  })

  const currentProject = createMemo(() =>
    layout.projects.list().find((project) => project.worktree === currentDir()),
  )

  const currentSessions = createMemo(() => {
    const dir = currentDir()
    const all = chat.chatList()
    return dir ? all.filter((item) => item.directory === dir) : all
  })

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    workspaceName: (directory) => layout.projects.list().find((p) => p.worktree === directory)?.name,
    renameWorkspace: (directory, next) => layout.projects.rename(directory, next),
    isBusy: () => false,
    workspaceExpanded: (directory, local) =>
      layout.projects.list().find((p) => p.worktree === directory)?.expanded ?? local,
    setWorkspaceExpanded: (directory, value) => {
      if (value) layout.projects.expand(directory)
      else layout.projects.collapse(directory)
    },
    // 重置/删除：重置无后端命令（本地清空 + toast）；删除走后端 delete_workspace。
    showResetWorkspaceDialog: (root, directory) => {
      void dialog.show(() => (
        <ConfirmWorkspaceDialog
          title={dialogsT("dialog.workspace.reset.title")}
          description={dialogsT("dialog.workspace.reset.description")}
          confirmLabel={dialogsT("dialog.workspace.reset.confirm")}
          onConfirm={() => {
            // TODO(Task 6): 后端无 reset_workspace 命令，仅本地清空（见 clearLocalWorkspaceData 注释）
            clearLocalWorkspaceData(directory)
            showToast({ title: dialogsT("dialog.workspace.toast.reset") })
          }}
        />
      ))
    },
    showDeleteWorkspaceDialog: (root, directory) => {
      void dialog.show(() => (
        <ConfirmWorkspaceDialog
          title={dialogsT("dialog.workspace.delete.title")}
          description={dialogsT("dialog.workspace.delete.description")}
          confirmLabel={dialogsT("dialog.workspace.delete.confirm")}
          onConfirm={() => {
            const wsId = workspace.wsIdFor(directory)
            // 真实工作区：后端 delete_workspace（退出关联 channel/master chat + 删本地元数据）。
            // 假数据/浏览器 dev 工作区（wsId 为 null）：仅本地移除。
            if (wsId != null) {
              call("delete_workspace", { id: wsId }).catch(() => {
                // 失败回滚：恢复侧栏/左列条目，避免下次 refreshWorkspaces 把已删工作区再开回来
                layout.projects.open(directory)
                workspace.reopen(directory)
                showToast({ title: dialogsT("dialog.workspace.toast.deleteFailed") })
              })
            }
            clearLocalWorkspaceData(directory)
            layout.projects.close(directory)
            workspace.close(directory)
            if (currentDir() === directory) navigate("/home")
            showToast({ title: dialogsT("dialog.workspace.toast.delete") })
          }}
        />
      ))
    },
    setScrollContainerRef: () => {},
  }

  // 重置/删除：本地近似清理 —— 仅清零该工作区会话的未读并把项目从侧栏/左列移除；
  // 会话本身仍在 chat 列表（后端无批量删除会话命令，delete_workspace 只退出并删除
  // 工作区元数据，不删消息）。真实删除请求由调用方（delete handler）先发后端。
  const clearLocalWorkspaceData = (directory: string) => {
    for (const session of chat.chatList()) {
      if (session.directory === directory && session.unread > 0) chat.markRead(session.id)
    }
    layout.projects.close(directory)
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir,
    currentProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setHoverProject(hoverOpen ? worktree : undefined)
    },
    navigateToProject: (directory) => navigate(`/home/${base64Encode(directory)}`),
    openSidebar: () => layout.sidebar.open(),
    closeProject: (directory) => {
      layout.projects.close(directory)
      if (currentDir() === directory) navigate("/home")
    },
    // 工作区编辑对话框（edit 模式：重命名/启动命令经 dialog-edit-workspace-v2 持久化）
    showEditProjectDialog: (project) => {
      void dialog.show(() => <DialogEditWorkspaceV2 project={project} />)
    },
    toggleProjectWorkspaces: (project) => layout.sidebar.toggleWorkspaces(project.worktree),
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds: (project) => [project.worktree, ...(project.sandboxes ?? [])],
    workspaceLabel: (directory) =>
      layout.projects.list().find((p) => p.worktree === directory)?.name ?? getFilename(directory),
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
    },
  }

  // 工作区选择对话框：列出当前工作区，选中后导航 /home/<wsId>（base64 编码）
  const chooseProject = () => {
    const list = workspace.orderedWorkspaces()
    if (list.length === 0) {
      navigate("/home")
      return
    }
    void dialog.show(() => (
      <WorkspaceSelectDialog
        workspaces={list.map((ws) => ({ worktree: ws.worktree, name: ws.name ?? ws.worktree }))}
        onSelect={(worktree) => navigate(`/home/${base64Encode(worktree)}`)}
      />
    ))
  }

  // 设置统一走对话框（settings-v2），无 /settings 页面路由。
  const openSettings = useSettingsDialog()

  command.register(() => [
    {
      id: "settings.open",
      title: language.t("sidebar.settings"),
      keybind: "mod+,",
      hidden: true,
      onSelect: openSettings,
    },
    {
      id: "project.open",
      title: language.t("command.project.open"),
      keybind: "mod+o",
      hidden: true,
      onSelect: chooseProject,
    },
  ])

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !currentDir() && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const worktree = createMemo(() => project()?.worktree ?? "")
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return projectSidebarCtx.workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce(
        (total, directory) =>
          total +
          chat
            .chatList()
            .filter((item) => item.directory === directory)
            .reduce((sum, item) => sum + item.unread, 0),
        0,
      ),
    )
    const clearNotifications = () =>
      workspaces().forEach((directory) =>
        chat
          .chatList()
          .filter((item) => item.directory === directory && item.unread > 0)
          .forEach((item) => chat.markRead(item.id)),
      )
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
          "border border-b-0 border-border-weak-base": !merged(),
          "border-l border-t border-border-weaker-base": merged(),
          "bg-background-base": merged() || hover(),
          "bg-background-stronger": !merged() && !hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={{
          width: panelProps.mobile ? undefined : `${panel()}px`,
        }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          }
          keyed
        >
          {(project) => (
            <>
              <div class="shrink-0 pl-1 py-1">
                <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                  <div class="flex flex-col min-w-0">
                    <span class="text-14-medium text-text-strong truncate">{projectName()}</span>
                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">{worktree()}</span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            projectSidebarCtx.showEditProjectDialog(project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-workspaces-toggle"
                          disabled={!workspacesEnabled()}
                          onSelect={() => {
                            projectSidebarCtx.toggleProjectWorkspaces(project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>
                            {workspacesEnabled()
                              ? language.t("sidebar.workspaces.disable")
                              : language.t("sidebar.workspaces.enable")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            projectSidebarCtx.closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div class="shrink-0 py-4">
                        <Button
                          size="large"
                          class="w-full"
                          onClick={() => {
                            const dir = worktree()
                            if (!dir) return
                            void tabs.newDraft({ directory: dir })
                          }}
                        >
                          <IconV2 name="edit" size="small" />
                          {language.t("command.session.new")}
                        </Button>
                      </div>
                      <div class="flex-1 min-h-0">
                        <LocalWorkspace
                          ctx={workspaceSidebarCtx}
                          project={project}
                          sortNow={() => state.sortNow}
                          mobile={panelProps.mobile}
                        />
                      </div>
                    </>
                  }
                >
                  <div class="relative flex-1 min-h-0">
                    <DragDropProvider
                      onDragStart={handleWorkspaceDragStart}
                      onDragEnd={handleWorkspaceDragEnd}
                      onDragOver={handleWorkspaceDragOver}
                      collisionDetector={closestCenter}
                    >
                      <DragDropSensors />
                      <ConstrainDragXAxis />
                      <div
                        ref={(el) => {
                          if (!panelProps.mobile) workspaceSidebarCtx.setScrollContainerRef(el)
                        }}
                        class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                      >
                        <SortableProvider ids={workspaces()}>
                          <For each={workspaces()}>
                            {(directory) => (
                              <SortableWorkspace
                                ctx={workspaceSidebarCtx}
                                directory={directory}
                                project={project}
                                sortNow={() => state.sortNow}
                                mobile={panelProps.mobile}
                              />
                            )}
                          </For>
                        </SortableProvider>
                      </div>
                      <DragOverlay>
                        <WorkspaceDragOverlay
                          sidebarProject={currentProject}
                          activeWorkspace={() => state.hoverProject}
                          workspaceLabel={projectSidebarCtx.workspaceLabel}
                        />
                      </DragOverlay>
                    </DragDropProvider>
                  </div>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    )
  }

  const handleWorkspaceDragStart = (event: unknown) => {
    void event
  }
  // 工作区面板拖拽排序：按当前项目 workspaceIds 列表算出落点 index，写入 workspace order（持久化）。
  // 面板列表 = [worktree, ...sandboxes]，与 orderedWorkspaces 均为工作区 key，index 可直接复用。
  const handleWorkspaceDragEnd = (event?: DragEvent) => {
    if (!event) return
    const from = event.draggable.id
    const over = event.droppable?.id
    if (over == null || from === over) return
    const project = currentProject()
    const list = project ? projectSidebarCtx.workspaceIds(project) : []
    const toIndex = list.indexOf(String(over))
    if (toIndex === -1) return
    workspace.move(String(from), toIndex)
  }
  const handleWorkspaceDragOver = (_event: unknown) => {}

  const handleDragStart = (event: unknown) => {
    void event
  }
  // rail 项目（工作区）拖拽排序：toIndex 在 workspace order 空间计算（与首页左列共用同一
  // peyt.workspaceOrder 持久化顺序），唯一写入口 workspace.move；rail 视觉重排由
  // workspace.tsx 的顺序同步 effect（layout.projects.reorder）负责，无需直接改 rail 列表。
  const handleDragEnd = (event?: DragEvent) => {
    if (!event) return
    const from = event.draggable.id
    const over = event.droppable?.id
    if (over == null || from === over) return
    const toIndex = workspace.orderedWorkspaces().findIndex((ws) => ws.worktree === over)
    if (toIndex === -1) return
    workspace.move(String(from), toIndex)
  }
  const handleDragOver = (_event: unknown) => {}

  const projects = () => layout.projects.list()
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => state.hoverProject} />
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => layout.sidebar.opened()}
      aimMove={aim.move}
      projects={projects}
      renderProject={(project) => (
        <SortableProject ctx={projectSidebarCtx} project={project} sortNow={() => state.sortNow} mobile={mobile} />
      )}
      handleDragStart={handleDragStart}
      handleDragEnd={handleDragEnd}
      handleDragOver={handleDragOver}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={chooseProject}
      renderProjectOverlay={projectOverlay}
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      onOpenSettings={openSettings}
      helpLabel={() => language.t("sidebar.help")}
      onOpenHelp={() => {
        void dialog.show(() => <HelpDialogContent />)
      }}
      renderPanel={() =>
        mobile ? <SidebarPanel project={currentProject} mobile /> : <SidebarPanel project={currentProject} merged />
      }
    />
  )

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none
             [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar />
      <div class="flex-1 min-h-0 min-w-0 flex">
        <div class="flex-1 min-h-0 relative">
          <div class="size-full relative overflow-x-hidden">
            <nav
              aria-label={language.t("sidebar.nav.projectsAndSessions")}
              data-component="sidebar-nav-desktop"
              classList={{
                "hidden xl:block": true,
                "absolute inset-y-0 start-0": true,
                "z-10": true,
              }}
              style={{ width: `${side()}px` }}
              ref={(el) => {
                setState("nav", el)
              }}
              onMouseEnter={() => {
                disarm()
              }}
              onMouseLeave={() => {
                aim.reset()
                if (!sidebarHovering()) return
                arm()
              }}
            >
              <div class="@container w-full h-full contain-strict">{sidebarContent()}</div>
            </nav>

            <Show when={layout.sidebar.opened()}>
              <div
                class="hidden xl:block absolute inset-y-0 z-30 w-0 overflow-visible"
                style={{ "inset-inline-start": `${side()}px` }}
                onPointerDown={() => setState("sizing", true)}
              >
                <ResizeHandle
                  direction="horizontal"
                  size={layout.sidebar.width()}
                  min={244}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64}
                  onResize={(w) => {
                    setState("sizing", true)
                    if (sizet !== undefined) clearTimeout(sizet)
                    sizet = window.setTimeout(() => setState("sizing", false), 120)
                    layout.sidebar.resize(w)
                  }}
                />
              </div>
            </Show>

            <div
              class="hidden xl:block pointer-events-none absolute top-0 end-0 z-0 border-t border-border-weaker-base"
              style={{ "inset-inline-start": "calc(4rem + 12px)" }}
            />

            <div class="xl:hidden">
              <div
                classList={{
                  "fixed inset-x-0 top-10 bottom-0 z-40 transition-opacity duration-200": true,
                  "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                  "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                }}
              />
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-mobile"
                classList={{
                  "@container fixed top-10 bottom-0 start-0 z-50 w-full max-w-[400px] overflow-hidden border-e border-border-weaker-base bg-background-base transition-transform duration-200 ease-out": true,
                  "translate-x-0": layout.mobileSidebar.opened(),
                  "-translate-x-full": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {sidebarContent(true)}
              </nav>
            </div>

            <div
              classList={{
                "absolute inset-0": true,
                "xl:inset-y-0 xl:end-0 xl:start-[var(--main-left)]": true,
                "z-20": true,
                "transition-[inset-inline-start] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[inset-inline-start] motion-reduce:transition-none":
                  !state.sizing,
              }}
              style={{
                "--main-left": layout.sidebar.opened() ? `${side()}px` : "4rem",
              }}
            >
              <main
                classList={{
                  "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t border-border-weak-base bg-v2-background-bg-deep xl:border-s xl:rounded-ss-[12px]": true,
                }}
              >
                <Suspense>{props.children}</Suspense>
              </main>
            </div>

            <div
              classList={{
                "hidden xl:flex absolute inset-y-0 start-16 z-30": true,
                "opacity-100 translate-x-0 pointer-events-auto": state.peeked && !layout.sidebar.opened(),
                "opacity-0 -translate-x-2 pointer-events-none":
                  !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              onMouseMove={disarm}
              onMouseEnter={() => {
                disarm()
                aim.reset()
              }}
              onPointerDown={disarm}
              onMouseLeave={() => {
                arm()
              }}
            >
              <Show when={peekProject()}>
                <SidebarPanel project={peekProject} merged={false} />
              </Show>
            </div>

            <div
              classList={{
                "hidden xl:block pointer-events-none absolute inset-y-0 end-0 z-25 overflow-hidden": true,
                "opacity-100 translate-x-0": state.peeked && !layout.sidebar.opened(),
                "opacity-0 -translate-x-2": !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              style={{ "inset-inline-start": `calc(4rem + ${panel()}px)` }}
            >
              <div class="h-full w-px" style={{ "box-shadow": "var(--shadow-sidebar-overlay)" }} />
            </div>
          </div>
        </div>
      </div>
      <ToastRegion />
    </div>
  )
}

export default AppLayout
