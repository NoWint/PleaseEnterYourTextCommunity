// src/app/pages/chat/session-page.tsx
// 聊天会话页（照抄 opencode pages/session.tsx 的核心骨架改造）：
// 滚动状态机（overflow/bottom/jump + autoScroll）、历史加载（loadOlder + prepend 锚点）、
// 消息跳转（#message- 锚点）、timeline + composer + side panel 组合。
// AI 能力（followup/revert/todo/permission 等）删除。

import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useParams } from "@solidjs/router"
import { useChat } from "../../context/chat"
import { MessageTimeline } from "./message-timeline"
import { SessionComposerRegion } from "./session-composer-region"
import { createSessionComposerControls } from "./session-composer-controls"
import { SessionSidePanel } from "./session-side-panel"
import { SESSION_PANEL_WIDTH_MIN } from "./session-panel-width"
import { messageIdFromHash } from "./message-id-from-hash"

export function ChatPage() {
  const params = useParams()
  const chat = useChat()
  const chatId = createMemo(() => (params.id ? String(params.id) : null))

  // 打开会话：加载消息/信息/置顶 + 标记已读
  createEffect(
    on(
      chatId,
      (id, prev) => {
        if (!id) return
        void chat.ensureLoaded(id)
        if (id !== prev) chat.setCurrentChat(id)
      },
      { defer: true },
    ),
  )

  // 切换会话自动回到底部（无锚点/跳转目标时）
  const [ui, setUi] = createStore({
    scrollGesture: 0,
    messageId: undefined as string | undefined,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "none",
  })

  const [sidePanelOpen, setSidePanelOpen] = createSignal(false)
  const [historyLoading, setHistoryLoading] = createSignal(false)

  const composerControls = createSessionComposerControls({
    chatId,
    onSent: () => {
      const id = chatId()
      if (id) void chat.reloadMessages(id)
    },
  })

  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let scrollToEnd = () => {}
  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined
  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = (_done: boolean) => {}
  let historyContinuationFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)
    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return
    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined
      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return
      updateScrollState(target)
    })
  }

  const clearMessageHash = () => {
    if (!window.location.hash) return
    window.history.replaceState(null, "", window.location.pathname + window.location.search)
  }

  const resumeScroll = () => {
    setUi("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()
    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // 用户回到底部 → 视为"最新"
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setUi("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    setUi("scrollGesture", Date.now())
  }

  const markScrollGesture = () => {
    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < 250

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const historyMore = createMemo(() => {
    const id = chatId()
    if (!id) return false
    return chat.hasMore(id)
  })

  const loadOlder = async () => {
    const id = chatId()
    if (!id) return
    if (historyLoading() || !historyMore()) return
    setHistoryLoading(true)
    const before = chat.messages(id).length
    try {
      captureHistoryAnchor()
      await chat.loadOlder(id)
      restoreHistoryAnchor(chat.messages(id).length > before)
    } finally {
      setHistoryLoading(false)
    }
    if (chat.messages(id).length <= before) return
    if (!autoScroll.userScrolled() || !scroller || scroller.scrollTop >= 200 || !historyMore()) return
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
    historyContinuationFrame = requestAnimationFrame(() => {
      historyContinuationFrame = undefined
      onHistoryScroll()
    })
  }

  const onHistoryScroll = () => {
    const id = chatId()
    if (!id) return
    if (historyLoading() || !autoScroll.userScrolled() || !scroller || scroller.scrollTop >= 200) return
    void loadOlder()
  }

  onCleanup(() => {
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  const fill = () => {
    if (fillFrame !== undefined) return
    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined
      const id = chatId()
      if (!id || historyLoading()) return
      if (autoScroll.userScrolled()) return
      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return
      void loadOlder()
    })
  }

  createEffect(
    on(
      () => [chatId(), historyMore(), historyLoading(), autoScroll.userScrolled()] as const,
      ([id, more, loading, scrolled]) => {
        if (!id || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  // #message-xxx 锚点：跳转到指定消息
  createEffect(() => {
    const id = chatId()
    if (!id) return
    const msgId = messageIdFromHash(window.location.hash)
    if (!msgId || Number.isNaN(Number(msgId))) return
    setUi("messageId", msgId)
    revealMessage(Number(msgId))
  })

  // 消息跳转（引用/置顶点击）
  const revealMessage = (msgId: number) => {
    const id = chatId()
    if (!id) return
    const loaded = chat.messages(id).some((m) => m.msg_id === msgId)
    if (!loaded) {
      // TODO(Task 3): 目标消息未加载时先 loadOlder 直到命中（legacy jumpToMessage 行为）
      return
    }
    revealRef?.(String(msgId))
  }

  let revealRef: ((id: string) => void) | undefined

  const session = createMemo(() => {
    const id = chatId()
    return id ? chat.session(id) : undefined
  })
  const info = createMemo(() => {
    const id = chatId()
    return id ? chat.chatInfo(id) : undefined
  })
  const memberCount = createMemo(() => info()?.members?.length ?? 0)
  const isGroup = createMemo(() => {
    const id = chatId()
    return id ? chat.isGroup(id) : false
  })

  const header = (
    <div class="h-12 w-full flex items-center justify-between gap-2">
      <div class="flex items-center min-w-0 flex-1 pl-2.5">
        <div class="flex items-center min-w-0 flex-1">
          <h1
            data-slot="session-title"
            class="truncate text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base"
          >
            {session()?.title ?? "会话"}
          </h1>
          <Show when={isGroup() && memberCount() > 0}>
            <span class="ml-2 text-[11px] font-medium text-v2-text-text-faint">{memberCount()} 成员</span>
          </Show>
        </div>
      </div>
      <div class="shrink-0 flex items-center gap-1 pr-1">
        <TooltipV2 value={sidePanelOpen() ? "关闭侧栏" : "会话信息"}>
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            state={sidePanelOpen() ? "pressed" : undefined}
            icon={<IconV2 name="outline-sliders" />}
            aria-label="侧栏"
            onClick={() => setSidePanelOpen((v) => !v)}
          />
        </TooltipV2>
      </div>
    </div>
  )

  return (
    <div class="flex flex-1 min-h-0 min-w-0 self-stretch p-2">
      <div
        data-component="chat-page"
        class="flex flex-1 min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      >
        <div class="flex flex-1 min-w-0 h-full min-h-0">
          <div
            class="flex flex-col min-h-0 min-w-0"
            style={{ "min-width": `${SESSION_PANEL_WIDTH_MIN}px` }}
          >
            <div class="flex-1 min-h-0 min-w-0">
              <MessageTimeline
                sessionKey={chatId}
                scroll={ui.scroll}
                onResumeScroll={resumeScroll}
                setScrollRef={setScrollRef}
                onScheduleScrollState={scheduleScrollState}
                onAutoScrollHandleScroll={autoScroll.handleScroll}
                onMarkScrollGesture={markScrollGesture}
                hasScrollGesture={hasScrollGesture}
                onUserScroll={markUserScroll}
                onHistoryScroll={onHistoryScroll}
                onAutoScrollInteraction={autoScroll.handleInteraction}
                shouldAnchorBottom={() => !autoScroll.userScrolled()}
                centered={false}
                setContentRef={(el) => {
                  content = el
                  autoScroll.contentRef(el)
                }}
                anchor={(id) => `#message-${id}`}
                setRevealMessage={(fn) => {
                  revealRef = fn
                }}
                setScrollToEnd={(fn) => {
                  scrollToEnd = fn
                }}
                setHistoryAnchor={(handlers) => {
                  captureHistoryAnchor = handlers.capture
                  restoreHistoryAnchor = handlers.restore
                }}
                onReply={(msgId) => composerControls.setReply(msgId)}
                onJumpToMessage={revealMessage}
                header={header}
              />
            </div>
            <SessionComposerRegion
              chatId={chatId}
              centered={false}
              onSent={() => {
                const id = chatId()
                if (id) void chat.reloadMessages(id)
              }}
              controls={composerControls}
            />
          </div>
        </div>
        <Show when={sidePanelOpen() && chatId()}>
          <SessionSidePanel
            chatId={chatId}
            onClose={() => setSidePanelOpen(false)}
            onJumpToMessage={revealMessage}
          />
        </Show>
      </div>
    </div>
  )
}
