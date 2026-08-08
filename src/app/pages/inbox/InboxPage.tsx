// src/app/pages/inbox/InboxPage.tsx
// 通知中心 v2（/inbox；Task 4 平移自 src/pages/inboxPage.ts，行为等价）：
// - list_inbox_events（limit 100，倒序）渲染通知列表：类型 / 时间 / 未读 badge
// - 单条点击：未读先 mark_inbox_read，再跳转来源频道（卡片频道 → /work，
//   其余 → /chat/:id）；带 msg_id 时用本地 effect 定位消息（轮询 [data-msg]
//   scrollIntoView + 2s 高亮），不再整壳重渲染
// - 全部已读：mark_all_inbox_read + 刷新列表
// - 路由跳转由 v2 Router 承担，state.currentPage/currentChatId 仅作 legacy 兼容写入

import {
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  type Component,
} from "solid-js"
import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { call } from "@/api"
import { state } from "@/state"
import { saveState } from "@/persist"
import { useChat } from "../../context/chat"
import { showToast } from "../../utils/toast"
import type { InboxEventDto } from "@/types"

const EVENT_META: Record<string, { label: string; path: string }> = {
  mention: { label: "提及", path: "M4 7h16M4 17h16M7 4l-2 16M19 4l-2 16" },
  reply: { label: "回复", path: "M9 17l-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4" },
  card_assign: { label: "卡片指派", path: "M4 4h7v7H4V4zM13 4h7v7h-7V4zM4 13h7v7H4v-7zM13 13h7v7h-7v-7z" },
  system: { label: "系统", path: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16h.01" },
}

// 卡片频道判断：复用 legacy shell 的 getSpaceType（navPanel.ts 保留）
async function isCardSpace(chatId: number): Promise<boolean> {
  try {
    const { getSpaceType } = await import("@/shell/navPanel")
    return (await getSpaceType(chatId)) === "card"
  } catch {
    return false
  }
}

function formatTime(ts: number): string {
  const now = Date.now() / 1000
  const diff = now - ts
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  const d = new Date(ts * 1000)
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

const InboxPage: Component = () => {
  const navigate = useNavigate()
  const chat = useChat()

  const [events, setEvents] = createSignal<InboxEventDto[]>([])
  const [loading, setLoading] = createSignal(true)
  const [failed, setFailed] = createSignal(false)

  const unreadCount = createMemo(() => events().filter((e) => e.read_at == null).length)

  const load = async () => {
    setLoading(true)
    setFailed(false)
    try {
      const list = await call<InboxEventDto[]>("list_inbox_events", { limit: 100 })
      setEvents(list)
      // 与 legacy 角标状态同步（v2 壳无 rail；保留 state.inboxUnread 供 legacy 侧复用）
      const unread = list.filter((e) => e.read_at == null).length
      if (state.inboxUnread !== unread) {
        state.inboxUnread = unread
        saveState()
      }
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  onMount(load)

  // 消息定位：跳转后本地 effect（轮询 [data-msg] 直到出现，fire-and-forget，
  // 与 legacy setTimeout 同语义），不重渲染 shell
  const scrollToMessage = (msgId: number) => {
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      const el = document.querySelector<HTMLElement>(`[data-msg="${msgId}"]`)
      if (el) {
        window.clearInterval(timer)
        el.scrollIntoView({ behavior: "smooth", block: "center" })
        el.style.background = "var(--active)"
        window.setTimeout(() => {
          el.style.background = ""
        }, 2000)
        return
      }
      if (attempts > 40) window.clearInterval(timer)
    }, 250)
  }

  const openEvent = async (ev: InboxEventDto) => {
    // 未读 → 先标记已读（失败静默，与 legacy 一致）
    if (ev.read_at == null) {
      try {
        await call("mark_inbox_read", { eventId: ev.id })
        setEvents((list) =>
          list.map((e) => (e.id === ev.id ? { ...e, read_at: Date.now() / 1000 } : e)),
        )
        state.inboxUnread = Math.max(0, state.inboxUnread - 1)
        saveState()
      } catch {}
    }

    if (!ev.source_chat_id) return
    const isCard = await isCardSpace(ev.source_chat_id)
    // legacy 兼容写入（v2 路由才是跳转的真相源）
    state.currentPage = isCard ? "work" : "messages"
    state.currentChatId = ev.source_chat_id
    if (isCard) state.currentView = "kanban"
    saveState()

    navigate(isCard ? "/work" : `/chat/${ev.source_chat_id}`)
    if (ev.msg_id != null && !isCard) scrollToMessage(ev.msg_id)
  }

  const markAllRead = async () => {
    try {
      await call("mark_all_inbox_read")
      state.inboxUnread = 0
      saveState()
      await load()
      showToast({ title: "已全部标记已读" })
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    }
  }

  const channelName = (chatId: number) => {
    const legacy = state.channels.find((c) => c.chat_id === chatId)?.name
    if (legacy) return legacy
    return chat.chatList().find((s) => s.id === String(chatId))?.title ?? "未知频道"
  }

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <header class="flex shrink-0 items-center gap-x-3 border-b border-v2-border-border-weak-base px-4 py-3">
        <div class="min-w-0">
          <div class="text-[14px] font-semibold tracking-[-0.02em] text-v2-text-text-base">通知</div>
          <div class="mt-0.5 text-[11px] text-v2-text-text-faint">
            {unreadCount() > 0 ? `${unreadCount()} 条未读` : "已全部读完"}
          </div>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <ButtonV2
            size="small"
            variant="ghost"
            disabled={unreadCount() === 0}
            onClick={() => void markAllRead()}
          >
            全部已读
          </ButtonV2>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <Show when={!loading()} fallback={<div class="px-2 py-8 text-center text-[12px] text-v2-text-text-faint">加载中…</div>}>
          <Show when={!failed()} fallback={<div class="px-2 py-8 text-center text-[12px] text-v2-text-text-faint">加载失败</div>}>
            <Show when={events().length > 0} fallback={<div class="px-2 py-8 text-center text-[12px] text-v2-text-text-faint">暂无通知</div>}>
              <div class="flex flex-col">
                <For each={events()}>
                  {(ev) => {
                    const meta = EVENT_META[ev.type] ?? EVENT_META.system
                    return (
                      <div
                        class="group flex cursor-pointer items-start gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:bg-v2-background-bg-layer-01"
                        onClick={() => void openEvent(ev)}
                      >
                        <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-v2-background-bg-layer-01 text-v2-text-text-muted">
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="square"
                            aria-hidden="true"
                          >
                            <path d={meta.path} />
                          </svg>
                        </span>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="text-[12px] font-medium text-v2-text-text-base">{meta.label}</span>
                            <span class="text-[11px] text-v2-text-text-faint">{formatTime(ev.created_at)}</span>
                          </div>
                          <div class="mt-0.5 truncate text-[13px] text-v2-text-text-base">{ev.summary}</div>
                          <div class="mt-1 flex items-center gap-2 text-[11px] text-v2-text-text-faint">
                            <span class="truncate">{ev.actor_name}</span>
                            <span class="shrink-0">#{channelName(ev.source_chat_id)}</span>
                          </div>
                        </div>
                        <Show when={ev.read_at == null}>
                          <span class="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: "var(--v2-text-text-accent)" }} />
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default InboxPage
