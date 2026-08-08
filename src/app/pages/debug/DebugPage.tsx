// src/app/pages/debug/DebugPage.tsx
// 调试页 v2（/debug；Task 4 平移自 src/pages/debugPage.ts，命令测试为新增）：
// - 状态检查：路由 / 账号 / 工作区 / 消息统计（读 legacy state 快照）
// - 会话诊断：debug_chatlist 按类型分组展示
// - 命令测试：任意 invoke 命令 + JSON 参数 → 输出/错误（get_all_messages 等
//   原文分页工具可在此手动调用，替代 legacy 的固定消息原文面板）
// - 事件流：dc-event 实时日志（eventLog 种子 + onEvent 全已知类型订阅，
//   onCleanup 退订；替换 legacy setInterval 轮询）

import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { call, eventLog, onEvent, type DcEvent } from "@/api"
import { state } from "@/state"
import { useChat } from "../../context/chat"
import type { SelfProfile } from "@/types"

// dc-event 已知事件类型全集（grep src 下所有 onEvent 订阅汇总）
const EVENT_TYPES = [
  "ChatDeleted",
  "ChatEphemeralTimerModified",
  "ChatModified",
  "ChatlistItemChanged",
  "ConfigureProgress",
  "ContactsChanged",
  "DeepLink",
  "IncomingMsg",
  "IncomingMsgBunch",
  "IncomingReaction",
  "MsgDeleted",
  "MsgDelivered",
  "MsgFailed",
  "MsgRead",
  "MsgReadCountChanged",
  "MsgsChanged",
  "MsgsNoticed",
  "NotificationClick",
  "ReactionsChanged",
  "SecurejoinInviterProgress",
  "SecurejoinJoinerProgress",
  "SelfavatarChanged",
  "WebxdcInstanceDeleted",
  "WebxdcRealtimeData",
  "WebxdcStatusUpdate",
]

// 会话类型 → 中文标签
const CHAT_TYPE_META: Record<string, string> = {
  Single: "单聊",
  Group: "群组",
  SavedMessages: "保存的消息",
  DeviceChat: "设备",
  MailList: "邮件列表",
  Broadcast: "广播",
  ContactRequest: "新联系人",
}
const CHAT_TYPE_DEFAULT = "会话"

interface ChatListRow {
  chat_id: number
  name: string
  type: string
  is_contact_request: boolean
}

// 事件名 hash → 色相，给每类事件一个稳定颜色点
function eventColor(typ: string): string {
  let h = 0
  for (let i = 0; i < typ.length; i++) h = (h * 31 + typ.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 65% 62%)`
}

function eventBrief(e: DcEvent): string {
  if (e.msg_id != null) return `msg=${e.msg_id}`
  if (e.chat_id != null) return `chat=${e.chat_id}`
  return ""
}

function formatClock(ts: number): string {
  if (!ts) return ""
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const DebugPage: Component = () => {
  const chat = useChat()

  // ── 状态检查（legacy state 快照） ────────────────────────────────
  const [snap, setSnap] = createSignal<{
    page: string
    wsId: number | null
    chatId: number | null
    self: SelfProfile | null
    wsCount: number
    channelCount: number
    msgCount: number
    oldest: number | null
    noMore: boolean
  }>({ page: "", wsId: null, chatId: null, self: null, wsCount: 0, channelCount: 0, msgCount: 0, oldest: null, noMore: false })

  const takeSnapshot = () => {
    const self = state.self
    setSnap({
      page: state.currentPage,
      wsId: state.currentWsId,
      chatId: state.currentChatId,
      self: self ? { ...self } : null,
      wsCount: state.workspaces.length,
      channelCount: state.channels.length,
      msgCount: state.messages.length,
      oldest: state.messagesOldestId,
      noMore: state.noMoreMsgs,
    })
  }

  // ── 会话诊断（debug_chatlist） ───────────────────────────────────
  const [chatGroups, setChatGroups] = createSignal<Array<[string, ChatListRow[]]>>([])
  const [chatErr, setChatErr] = createSignal<string | null>(null)

  const loadChatlist = async () => {
    setChatErr(null)
    try {
      const chats = await call<ChatListRow[]>("debug_chatlist")
      const groups = new Map<string, ChatListRow[]>()
      for (const c of chats) {
        const label = c.is_contact_request
          ? CHAT_TYPE_META.ContactRequest
          : CHAT_TYPE_META[c.type] ?? CHAT_TYPE_DEFAULT
        if (!groups.has(label)) groups.set(label, [])
        groups.get(label)!.push(c)
      }
      setChatGroups([...groups.entries()])
    } catch (e) {
      setChatErr(e instanceof Error ? e.message : String(e))
    }
  }

  // ── 命令测试（任意 invoke） ──────────────────────────────────────
  const [cmd, setCmd] = createSignal("")
  const [args, setArgs] = createSignal("{}")
  const [running, setRunning] = createSignal(false)
  const [output, setOutput] = createSignal<{ ok: boolean; text: string } | null>(null)

  const runTest = async () => {
    const name = cmd().trim()
    if (!name) {
      setOutput({ ok: false, text: "请输入命令名" })
      return
    }
    let parsed: Record<string, unknown> = {}
    const raw = args().trim()
    if (raw) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        setOutput({ ok: false, text: "参数不是合法 JSON" })
        return
      }
    }
    setRunning(true)
    try {
      const res = await call(name, parsed)
      setOutput({ ok: true, text: res === undefined ? "undefined" : JSON.stringify(res, null, 2) })
    } catch (e) {
      setOutput({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setRunning(false)
    }
  }

  // ── 事件流（eventLog 种子 + onEvent 全类型订阅） ─────────────────
  const [entries, setEntries] = createSignal<DcEvent[]>(eventLog.slice(-40))
  let logRef: HTMLDivElement | undefined
  const unlistens: Array<() => void> = []
  let disposed = false

  onMount(() => {
    for (const t of EVENT_TYPES) {
      void onEvent(t, (e) => {
        setEntries((prev) => [...prev.slice(-39), e])
      }).then((un) => {
        if (disposed) un()
        else unlistens.push(un)
      })
    }
  })

  onCleanup(() => {
    disposed = true
    for (const un of unlistens) un()
    unlistens.length = 0
  })

  // 新事件自动滚到底
  createEffect(() => {
    entries()
    if (logRef) logRef.scrollTop = logRef.scrollHeight
  })

  onMount(() => {
    takeSnapshot()
    void loadChatlist()
  })

  const refreshAll = () => {
    takeSnapshot()
    void loadChatlist()
  }

  const kv = (k: string, v: string) => (
    <div class="flex items-center justify-between gap-2 py-0.5">
      <span class="text-[11px] text-v2-text-text-faint">{k}</span>
      <span class="max-w-[60%] truncate font-mono text-[11px] text-v2-text-text-base">{v}</span>
    </div>
  )

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <header class="flex shrink-0 items-center gap-x-3 border-b border-v2-border-border-weak-base px-4 py-3">
        <div class="min-w-0">
          <div class="text-[14px] font-semibold tracking-[-0.02em] text-v2-text-text-base">调试</div>
          <div class="mt-0.5 text-[11px] text-v2-text-text-faint">事件流 · 命令测试 · 会话诊断</div>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <ButtonV2 size="small" variant="ghost" onClick={refreshAll}>
            刷新
          </ButtonV2>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <div class="grid gap-4 lg:grid-cols-2">
          {/* 状态检查 */}
          <section class="rounded-lg border border-v2-border-border-weak-base p-3">
            <div class="mb-2 text-[12px] font-semibold text-v2-text-text-base">状态检查</div>
            <div class="grid grid-cols-2 gap-3">
              <div class="rounded-md bg-v2-background-bg-layer-01 px-2.5 py-2">
                {kv("页面", snap().page || "—")}
                {kv("工作区", String(snap().wsId ?? "—"))}
                {kv("会话", String(snap().chatId ?? "—"))}
              </div>
              <div class="rounded-md bg-v2-background-bg-layer-01 px-2.5 py-2">
                {kv("名称", snap().self?.name ?? "—")}
                {kv("邮箱", snap().self?.addr ?? "—")}
                {kv("会话数", String(chat.chatList().length))}
              </div>
              <div class="rounded-md bg-v2-background-bg-layer-01 px-2.5 py-2">
                {kv("工作区数", String(snap().wsCount))}
                {kv("频道数", String(snap().channelCount))}
                {kv("已加载消息", String(snap().msgCount))}
              </div>
              <div class="rounded-md bg-v2-background-bg-layer-01 px-2.5 py-2">
                {kv("最旧 id", String(snap().oldest ?? "—"))}
                {kv("noMore", snap().noMore ? "是" : "否")}
                {kv("未读", String(chat.chatList().reduce((s, c) => s + c.unread, 0)))}
              </div>
            </div>
          </section>

          {/* 会话诊断 */}
          <section class="rounded-lg border border-v2-border-border-weak-base p-3">
            <div class="mb-2 text-[12px] font-semibold text-v2-text-text-base">会话诊断</div>
            <Show
              when={!chatErr()}
              fallback={<div class="py-3 text-[12px] text-v2-text-text-faint">诊断失败：{chatErr()}</div>}
            >
              <Show when={chatGroups().length > 0} fallback={<div class="py-3 text-[12px] text-v2-text-text-faint">(空)</div>}>
                <div class="flex max-h-[260px] flex-col gap-2 overflow-y-auto">
                  <For each={chatGroups()}>
                    {([label, list]) => (
                      <div>
                        <div class="flex items-center gap-1.5 text-[11px] font-medium text-v2-text-text-muted">
                          {label}
                          <span class="rounded bg-v2-background-bg-layer-01 px-1 text-[10px] text-v2-text-text-faint">{list.length}</span>
                        </div>
                        <For each={list}>
                          {(c) => (
                            <div class="flex items-center gap-2 py-0.5 pl-2">
                              <span class="truncate text-[12px] text-v2-text-text-base">{c.name || "(unnamed)"}</span>
                              <span class="ml-auto shrink-0 font-mono text-[10px] text-v2-text-text-faint">#{c.chat_id}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </section>

          {/* 命令测试 */}
          <section class="rounded-lg border border-v2-border-border-weak-base p-3 lg:col-span-2">
            <div class="mb-2 text-[12px] font-semibold text-v2-text-text-base">命令测试</div>
            <div class="flex flex-col gap-2">
              <div class="flex gap-2">
                <TextInputV2
                  class="min-w-0 flex-1"
                  placeholder="命令名，如 get_self_profile"
                  value={cmd()}
                  onInput={(e) => setCmd(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runTest()
                  }}
                />
                <ButtonV2 size="small" variant="neutral" disabled={running()} onClick={() => void runTest()}>
                  {running() ? "运行中…" : "运行"}
                </ButtonV2>
              </div>
              <TextareaV2
                rows={2}
                placeholder='JSON 参数，如 {"limit": 20}'
                class="font-mono"
                value={args()}
                onInput={(e) => setArgs(e.currentTarget.value)}
              />
              <Show when={output()}>
                <pre
                  classList={{
                    "max-h-[220px] overflow-auto rounded-md bg-v2-background-bg-layer-01 px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all font-mono":
                      true,
                    "text-v2-text-text-base": output()!.ok,
                    "text-[var(--v2-state-fg-danger)]": !output()!.ok,
                  }}
                >
                  {output()!.text}
                </pre>
              </Show>
            </div>
          </section>

          {/* 事件流 */}
          <section class="rounded-lg border border-v2-border-border-weak-base p-3 lg:col-span-2">
            <div class="mb-2 flex items-center gap-2">
              <span class="text-[12px] font-semibold text-v2-text-text-base">事件流</span>
              <span class="rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[10px] text-v2-text-text-faint">{entries().length}</span>
            </div>
            <div ref={logRef} class="flex max-h-[280px] flex-col gap-0.5 overflow-y-auto">
              <Show when={entries().length > 0} fallback={<div class="py-3 text-[12px] text-v2-text-text-faint">(无事件)</div>}>
                <For each={entries()}>
                  {(e) => (
                    <div class="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-v2-background-bg-layer-01">
                      <span class="size-1.5 shrink-0 rounded-full" style={{ background: eventColor(e.typ) }} />
                      <span class="shrink-0 font-mono text-[11px] text-v2-text-text-base">{e.typ}</span>
                      <span class="truncate font-mono text-[10px] text-v2-text-text-faint">{eventBrief(e)}</span>
                      <span class="ml-auto shrink-0 font-mono text-[10px] text-v2-text-text-faint">{formatClock((e.ts as number) ?? 0)}</span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default DebugPage
