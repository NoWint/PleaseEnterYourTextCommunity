// src/app/context/workspace.tsx
// WorkspaceStore：workspaces 数据（Task 3 接 list_workspaces invoke）。
// - refreshWorkspaces：list_workspaces → AppWorkspace[]，并同步进 layout.projects
//   （sidebar/home 的项目列表来自 layout context；open/rename 是其公开 API）
// - 拉取失败时保留 Task 1 假数据（fakeWorkspaces）
//
// Task 4（工作页 v2）：
// - chats(directory)/allChats()：会话列表来自 chat context（directory 映射）
// - 协作卡片/活动流：list_channels + list_cards + list_activities invoke 聚合；
//   invoke 不可用（浏览器 dev）时按工作区确定性生成假数据兜底（fake.ts）。

import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AppSession, AppWorkspace } from "../types"
import { fakeWorkspaces, makeFakeActivities, makeFakeCards, makeFakeChannels } from "../data/fake"
import { call } from "../../api"
import type { ActivityDto, CardDto, ChannelDto, WorkspaceDto } from "../../types"
import { useLayout } from "./layout"

// 会话列表由 ChatProvider 提供，而 WorkspaceProvider 挂载在 ChatProvider 外层
// （App.tsx provider 树），init 阶段不能直接 useChat()。WorkPage 挂载时经
// bindChatListSource 把 chat.chatList 桥接进来（惰性解析，无 provider 顺序依赖）。
let chatListSource: (() => AppSession[]) | undefined

export function bindChatListSource(source: () => AppSession[]): void {
  chatListSource = source
}

/** 创建工作卡片入参（create_card 后端固定建为 todo，状态列切换再 update_card）。 */
export interface CreateCardInput {
  chatId: number
  type?: "task" | "card"
  title: string
  description?: string | null
  assigneeContactId?: number | null
  dueDate?: number | null
}

/** update_card 增量补丁（与后端 Clearable 语义对齐：undefined=不动，null=清空）。 */
export interface UpdateCardPatch {
  title?: string
  description?: string | null
  status?: CardDto["status"]
  assigneeContactId?: number | null
  dueDate?: number | null
}

interface WorkState {
  cards: CardDto[]
  channels: ChannelDto[]
  activities: ActivityDto[]
  loading: boolean
  /** true = 后端真实数据；false = 假数据兜底。 */
  real: boolean
  fresh: boolean
}

interface WorkspaceStore {
  workspaces: () => AppWorkspace[]
  loading: () => boolean
  currentWsId: () => string | null
  setCurrentWs: (id: string | null) => void
  /** 指定工作区的会话（directory = AppWorkspace.worktree key）。 */
  chats: (directory: string) => AppSession[]
  allChats: () => AppSession[]
  /** 工作区数字 id（worktree key `ws-<id>` 反解），假数据工作区返回 null。 */
  wsIdFor: (directory: string) => number | null
  channels: (directory: string) => ChannelDto[]
  cards: (directory: string) => CardDto[]
  activities: (directory: string) => ActivityDto[]
  workLoading: (directory: string) => boolean
  workReal: (directory: string) => boolean
  /** 拉取（或假数据兜底）指定工作区的卡片 + 活动流。返回是否拿到真实数据。 */
  refreshWork: (directory: string) => Promise<boolean>
  /** 未加载过则拉取（页面挂载用，避免重复请求）。返回是否拿到真实数据。 */
  ensureWork: (directory: string) => Promise<boolean>
  createCard: (directory: string, input: CreateCardInput) => Promise<CardDto>
  updateCard: (directory: string, cardId: number, patch: UpdateCardPatch) => Promise<CardDto>
  deleteCard: (directory: string, cardId: number) => Promise<void>
  refreshWorkspaces: () => Promise<void>
}

const WORKSPACE_COLORS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const

function createWorkspaceStore(): WorkspaceStore {
  const layout = useLayout()
  const [state, setState] = createStore({
    workspaces: fakeWorkspaces,
    currentWsId: fakeWorkspaces[0]?.id ?? null,
    loading: false,
    // Task 4：按工作区聚合的协作数据
    work: {} as Record<string, WorkState>,
  })

  async function refreshWorkspaces(): Promise<void> {
    setState("loading", true)
    try {
      const list = await call<WorkspaceDto[]>("list_workspaces")
      const workspaces: AppWorkspace[] = list.map((ws, index) => ({
        id: String(ws.id),
        name: ws.name || `工作区 ${ws.id}`,
        worktree: `ws-${ws.id}`,
        expanded: false,
        icon: { color: WORKSPACE_COLORS[index % WORKSPACE_COLORS.length] },
        vcs: "git",
        sandboxes: [],
      }))
      // 同步进 layout.projects（open 去重追加 + rename 更新名称）
      for (const ws of workspaces) {
        layout.projects.open(ws.worktree)
        layout.projects.rename(ws.worktree, ws.name ?? "")
      }
      setState("workspaces", workspaces)
      if (!state.currentWsId && workspaces[0]?.id) setState("currentWsId", workspaces[0].id)
    } catch {
      // invoke 不可用（浏览器 dev）→ 保留假数据
    } finally {
      setState("loading", false)
    }
  }

  // ── Task 4：协作数据（卡片 + 频道 + 活动流） ─────────────

  const workState = (directory: string): WorkState | undefined => state.work[directory]

  async function ensureWork(directory: string): Promise<boolean> {
    const st = workState(directory)
    if (st?.fresh) return st.real
    return refreshWork(directory)
  }

  function wsIdFor(directory: string): number | null {
    const match = /^ws-(\d+)$/.exec(directory)
    return match ? Number(match[1]) : null
  }

  /** 返回是否拿到后端真实数据（false = 假数据兜底，调用方可提示）。 */
  async function refreshWork(directory: string): Promise<boolean> {
    setState("work", directory, { ...(workState(directory) ?? {}), loading: true } as WorkState)
    try {
      const wsId = wsIdFor(directory)
      if (wsId == null) throw new Error(`工作区 ${directory} 无数字 id（假数据工作区）`)
      const channels = await call<ChannelDto[]>("list_channels", { workspaceId: wsId })
      const cards: CardDto[] = []
      // 单频道失败不影响其余（频道无卡片是常态）
      for (const ch of channels) {
        try {
          cards.push(...(await call<CardDto[]>("list_cards", { workspaceId: wsId, chatId: ch.chat_id })))
        } catch {
          /* 单频道跳过 */
        }
      }
      const activities = await call<ActivityDto[]>("list_activities", { channelChatId: null, limit: 100 })
      setState("work", directory, {
        cards,
        channels,
        activities,
        loading: false,
        real: true,
        fresh: true,
      })
      return true
    } catch {
      // invoke 不可用（浏览器 dev）→ 假数据兜底，保证 4 视图可预览
      setState("work", directory, {
        cards: makeFakeCards(directory),
        channels: makeFakeChannels(directory),
        activities: makeFakeActivities(directory),
        loading: false,
        real: false,
        fresh: true,
      })
      return false
    }
  }

  /** 刷新后用卡片刷新（mutations 后调用）；未加载过则全量拉取。 */
  async function reloadCards(directory: string): Promise<void> {
    const st = workState(directory)
    if (!st?.fresh) {
      await refreshWork(directory)
      return
    }
    const wsId = wsIdFor(directory)
    if (wsId == null || !st.real) {
      // 假数据环境：本地状态已是最新（假数据仅兜底展示）
      return
    }
    try {
      const channels = await call<ChannelDto[]>("list_channels", { workspaceId: wsId })
      const cards: CardDto[] = []
      for (const ch of channels) {
        try {
          cards.push(...(await call<CardDto[]>("list_cards", { workspaceId: wsId, chatId: ch.chat_id })))
        } catch {
          /* 单频道跳过 */
        }
      }
      setState("work", directory, { cards, channels } as Partial<WorkState>)
    } catch {
      /* 刷新失败保留旧数据 */
    }
  }

  // TODO(Task 4): 写操作已接后端 invoke（create_card/update_card/delete_card），
  // 但浏览器 dev（假数据工作区 wsId 为 null / 无 Tauri invoke）会抛错，由页面 toast；
  // 待桌面端数据接入后此注释可移除。
  async function createCard(directory: string, input: CreateCardInput): Promise<CardDto> {
    const wsId = wsIdFor(directory)
    if (wsId == null) throw new Error("工作区未接入后端，无法创建卡片")
    const card = await call<CardDto>("create_card", {
      workspaceId: wsId,
      chatId: input.chatId,
      type_: input.type ?? "task",
      title: input.title,
      description: input.description ?? null,
      assigneeContactId: input.assigneeContactId ?? null,
      dueDate: input.dueDate ?? null,
    })
    await reloadCards(directory)
    return card
  }

  async function updateCard(directory: string, cardId: number, patch: UpdateCardPatch): Promise<CardDto> {
    // TODO(Task 4): 同 createCard —— 无 Tauri invoke 时抛错由页面 toast（见上方注释）
    const card = await call<CardDto>("update_card", { cardId, ...patch })
    await reloadCards(directory)
    return card
  }

  async function deleteCard(directory: string, cardId: number): Promise<void> {
    // TODO(Task 4): 同 createCard —— 无 Tauri invoke 时抛错由页面 toast（见上方注释）
    await call("delete_card", { cardId })
    await reloadCards(directory)
  }

  // 初始化拉取
  void refreshWorkspaces()

  return {
    workspaces: createMemo(() => state.workspaces),
    loading: () => state.loading,
    currentWsId: () => state.currentWsId,
    setCurrentWs: (id) => setState("currentWsId", id),
    // Task 4：会话列表来自 chat context（经 bindChatListSource 桥接，惰性解析）
    chats: (directory: string) => (chatListSource?.() ?? []).filter((c) => c.directory === directory),
    allChats: () => chatListSource?.() ?? [],
    wsIdFor,
    channels: (directory: string) => workState(directory)?.channels ?? [],
    cards: (directory: string) => workState(directory)?.cards ?? [],
    activities: (directory: string) => workState(directory)?.activities ?? [],
    workLoading: (directory: string) => workState(directory)?.loading ?? false,
    workReal: (directory: string) => workState(directory)?.real ?? false,
    refreshWork,
    ensureWork,
    createCard,
    updateCard,
    deleteCard,
    refreshWorkspaces,
  }
}

export const { use: useWorkspace, provider: WorkspaceProvider } = createSimpleContext<WorkspaceStore, Record<string, any>>({
  name: "Workspace",
  gate: false,
  init: () => createWorkspaceStore(),
})
