// src/app/pages/WorkPage.tsx
// 工作页 v2（/work 与 /home/:wsId 复用，Task 4）：
// - 顶部：工作区名 + 统计 + segmented-control-v2 切换 4 视图（看板/列表/日历/时间线）
// - 概览条：3D 球状词云 / 词频词云 / 主题气泡（点击打开分析看板）
// - 主体：视图区 + 活动流（右侧栏）
// - 卡片点击 → CardDetailDialog（v2 对话框，保存/删除走 workspace context）
// 数据：workspace context（invoke 聚合 list_channels + list_cards + list_activities；
// 浏览器 dev 无 invoke 时假数据兜底）。

import { createEffect, createMemo, createSignal, Show, type Component } from "solid-js"
import { useParams } from "@solidjs/router"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody } from "@opencode-ai/ui/v2/dialog-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For } from "solid-js"
import { useLayout } from "../context/layout"
import { useWorkspace, bindChatListSource } from "../context/workspace"
import { useChat } from "../context/chat"
import { base64Decode } from "../utils/base64"
import { showToast } from "../utils/toast"
import { KanbanView } from "./work/views/KanbanView"
import { ListView } from "./work/views/ListView"
import { CalendarView } from "./work/views/CalendarView"
import { TimelineView } from "./work/views/TimelineView"
import { ActivityFeed } from "./work/views/ActivityFeed"
import { CardDetailDialog } from "./work/components/CardDetailDialog"
import { CloudSphere } from "../components/visuals/CloudSphere"
import { WordCloud } from "../components/visuals/WordCloud"
import { SummaryBubble } from "../components/visuals/SummaryBubble"
import { SummaryDashboard } from "../components/visuals/SummaryDashboard"
import { deriveWorkClusters, deriveWorkWords, VIEW_OPTIONS, type WorkView } from "./work/work-types"
import type { CardDto } from "../../types"
import "./work/work.css"

const viewStorageKey = (directory: string) => `peyt.workView:${directory}`

function loadView(directory: string): WorkView {
  const saved = localStorage.getItem(viewStorageKey(directory))
  return saved === "kanban" || saved === "list" || saved === "calendar" || saved === "timeline" ? saved : "kanban"
}

const WorkPage: Component = () => {
  const params = useParams()
  const layout = useLayout()
  const workspace = useWorkspace()
  const chat = useChat()
  const dialog = useDialog()

  // workspace context 的 chats/allChats 由本页桥接（provider 顺序：workspace 在 chat 外层）
  createEffect(() => bindChatListSource(chat.chatList))

  // /home/:wsId 中 wsId 是 base64url 编码的工作区 key（AppLayout navigateToProject 编码）；
  // /work 无参数或参数无对应项目 → 默认取第一个工作区。
  const wsKey = () => {
    if (params.wsId) {
      const key = base64Decode(params.wsId)
      if (layout.projects.list().some((p) => p.worktree === key)) return key
    }
    return layout.projects.list()[0]?.worktree ?? ""
  }
  const project = () => layout.projects.list().find((p) => p.worktree === wsKey())

  const [view, setView] = createSignal<WorkView>(loadView(wsKey()))
  const persistView = (next: WorkView) => {
    setView(next)
    localStorage.setItem(viewStorageKey(wsKey()), next)
  }

  // ── 数据（workspace context 聚合） ────────────────────
  const cards = createMemo(() => workspace.cards(wsKey()))
  const activities = createMemo(() => workspace.activities(wsKey()))
  const channels = createMemo(() => workspace.channels(wsKey()))
  const chats = createMemo(() => workspace.chats(wsKey()))
  const loading = createMemo(() => workspace.workLoading(wsKey()))
  const channelNames = createMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {}
    for (const ch of channels()) map[ch.chat_id] = ch.name
    return map
  })

  // 挂载/切换工作区时拉取一次
  createEffect(() => {
    const key = wsKey()
    if (!key) return
    void workspace.ensureWork(key)
  })

  // ── 可视化数据（确定性轻量分词，见 work-types） ──────
  const words = createMemo(() =>
    deriveWorkWords(cards(), channels().map((c) => c.name), chats().map((c) => c.title)),
  )
  const clusters = createMemo(() => deriveWorkClusters(words()))
  const bubbleText = createMemo(() => {
    const total = cards().length
    const todo = cards().filter((c) => c.status === "todo").length
    const doing = cards().filter((c) => c.status === "in_progress").length
    const done = cards().filter((c) => c.status === "done").length
    const act = activities().length
    return total > 0 || act > 0
      ? `共 ${total} 个卡片（待办 ${todo} · 进行中 ${doing} · 完成 ${done}），活动 ${act} 条`
      : "暂无卡片与活动"
  })

  // ── 交互 ─────────────────────────────────────────────

  const openCard = (card: CardDto) => {
    dialog.show(() => <CardDetailDialog directory={wsKey()} card={card} />)
  }

  const openCardById = (cardId: number) => {
    const card = cards().find((c) => c.id === cardId)
    if (card) openCard(card)
  }

  const openDashboard = () => {
    dialog.show(() => (
      <Dialog size="x-large" class="!p-0">
        <DialogBody class="!p-0">
          <div class="h-[min(640px,calc(100vh-120px))]">
            <SummaryDashboard
              words={words()}
              cards={cards()}
              activities={activities()}
              channelNames={channels().map((c) => c.name)}
            />
          </div>
        </DialogBody>
      </Dialog>
    ))
  }

  const createCard = async (status: CardDto["status"], title: string) => {
    const firstChannel = channels()[0]
    if (!firstChannel) {
      showToast({ title: "创建失败", description: "工作区暂无协作频道" })
      return
    }
    try {
      const card = await workspace.createCard(wsKey(), {
        chatId: firstChannel.chat_id,
        type: "task",
        title,
      })
      if (status !== "todo" && card.id) {
        await workspace.updateCard(wsKey(), card.id, { status })
      }
      showToast({ title: "已创建" })
    } catch (e) {
      showToast({ title: "创建失败", description: e instanceof Error ? e.message : String(e) })
    }
  }

  const updateStatus = async (cardId: number, status: CardDto["status"]) => {
    try {
      await workspace.updateCard(wsKey(), cardId, { status })
    } catch (e) {
      showToast({ title: "更新状态失败", description: e instanceof Error ? e.message : String(e) })
    }
  }

  const refresh = () => {
    void workspace.refreshWork(wsKey()).catch(() => {})
  }

  // 未选中工作区时提示
  if (!project()) {
    return (
      <div class="m-2 flex min-h-0 flex-1 self-stretch items-center justify-center rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
        <span class="text-xs text-v2-text-text-faint">请先在侧边栏打开一个工作区</span>
      </div>
    )
  }

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      {/* 头部：工作区 + 视图切换 */}
      <header class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-v2-border-border-weak-base px-4 py-3">
        <div class="min-w-0">
          <div class="truncate text-[14px] font-semibold tracking-[-0.02em] text-v2-text-text-base">
            {project()!.name ?? project()!.worktree}
          </div>
          <div class="mt-0.5 text-[11px] text-v2-text-text-faint">
            {chats().length} 个会话 · {cards().length} 个卡片 · {activities().length} 条动态
          </div>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <SegmentedControlV2 value={view()} onChange={(next) => next && persistView(next as WorkView)}>
            <For each={VIEW_OPTIONS}>
              {(opt) => (
                <SegmentedControlItemV2 value={opt.value} class="flex items-center gap-1.5">
                  <span class="flex size-3.5 items-center justify-center">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">
                      <path d={VIEW_ICON_PATHS[opt.icon]} />
                    </svg>
                  </span>
                  {opt.label}
                </SegmentedControlItemV2>
              )}
            </For>
          </SegmentedControlV2>
          <IconButtonV2 size="small" variant="ghost-muted" title="刷新" onClick={refresh} icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
              <path d="M21.448 13C20.9483 17.7767 16.909 21.5 12 21.5C8.18227 21.5 4.89052 19.248 3.38065 16M2.5 20.5V15.5H5.5M2.55176 11C3.05145 6.22334 7.09079 2.5 11.9998 2.5C15.8175 2.5 19.1092 4.75197 20.6191 8M21.4998 3.5V8.5H18.4998" />
            </svg>
          } />
        </div>
      </header>

      {/* 概览条：可视化 */}
      <div class="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-v2-border-border-weak-base px-4 py-2.5">
        <div class="flex items-center gap-2">
          <CloudSphere words={words()} class="size-[56px]" />
          <span class="text-[11px] text-v2-text-text-faint">主题词云（拖拽旋转）</span>
        </div>
        <div class="flex items-center gap-2">
          <WordCloud words={words()} width={180} height={56} />
          <span class="text-[11px] text-v2-text-text-faint">词频分布</span>
        </div>
        <SummaryBubble
          status="done"
          text={bubbleText()}
          clusters={clusters()}
          class="max-w-[46ch]"
          onClick={openDashboard}
        />
        <ButtonV2 size="small" variant="ghost" onClick={openDashboard}>
          打开分析看板
        </ButtonV2>
        <Show when={!workspace.workReal(wsKey())}>
          <span class="text-[10px] text-v2-text-text-faint">（演示数据）</span>
        </Show>
      </div>

      {/* 主体：视图 + 活动流 */}
      <div class="flex min-h-0 flex-1">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <Show when={view() === "kanban"} fallback={<></>}>
            <KanbanView
              cards={cards()}
              loading={loading()}
              onCreateCard={createCard}
              onUpdateStatus={updateStatus}
              onOpenCard={openCard}
            />
          </Show>
          <Show when={view() === "list"} fallback={<></>}>
            <ListView cards={cards()} loading={loading()} onOpenCard={openCard} />
          </Show>
          <Show when={view() === "calendar"} fallback={<></>}>
            <CalendarView cards={cards()} loading={loading()} onOpenCard={openCard} />
          </Show>
          <Show when={view() === "timeline"} fallback={<></>}>
            <TimelineView cards={cards()} loading={loading()} onOpenCard={openCard} />
          </Show>
        </div>

        <aside class="hidden w-[280px] shrink-0 p-2 pl-0 lg:block">
          <ActivityFeed
            activities={activities()}
            cards={cards()}
            channelNames={channelNames()}
            loading={loading()}
            onOpenCard={openCardById}
          />
        </aside>
      </div>
    </div>
  )
}

// 视图图标（TDesign 路径子集，同 legacy viewToggle 的 columns/list/calendar/timeline）
const VIEW_ICON_PATHS: Record<string, string> = {
  columns: "M5 21L5 3M12 21L12 3M19 21L19 3",
  list: "M3 5H21M3 12H21M3 19H21",
  calendar: "M3 10H21M3 10V5H21V10M3 10V21H21V10M7 5V1.5M17 5V1.5",
  timeline: "M3 4H21V10H3V4ZM3 14H21V20H3V14Z",
}

export default WorkPage
