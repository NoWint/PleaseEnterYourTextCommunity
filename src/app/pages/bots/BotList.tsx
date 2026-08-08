// src/app/pages/bots/BotList.tsx
// 左侧 Bot 列表：新建（create_bot + 引导对话框）、删除（确认对话框）、
// 启停开关（set_bot_io）、状态徽标（bot-activity 实时刷新「思考中」）。

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Avatar } from "@opencode-ai/ui/v2/avatar-v2"
import { Tag as BadgeV2 } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import { onBotActivity } from "./activity"
import { isLlmConfigured, type BotConfig, type BotDto, type PersonaDto } from "./types"

export interface BotRowInfo {
  cfg: BotConfig | null
  scheduleCount: number
}

interface BotListProps {
  bots: BotDto[]
  rowInfo: Record<number, BotRowInfo>
  personas: PersonaDto[]
  selectedId: number | null
  loading?: boolean
  onSelect: (bot: BotDto) => void
  onToggleIo: (bot: BotDto, running: boolean) => void
  onDelete: (bot: BotDto) => void
  onCreated: (bot: BotDto) => void
}

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">
    <path d="M3 6H21M8 6V4H16V6M19 6L18 21H6L5 6M10 10V17M14 10V17" />
  </svg>
)

function CreateBotDialog(props: { onCreated: (bot: BotDto) => void }) {
  const dialog = useDialog()
  const [name, setName] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const submit = async (event: Event) => {
    event.preventDefault()
    const displayName = name().trim()
    if (!displayName || saving()) return
    setSaving(true)
    try {
      const bot = await call<BotDto>("create_bot", { displayName })
      props.onCreated(bot)
    } catch (err) {
      showToast({ title: "创建失败", description: err instanceof Error ? err.message : String(err) })
      setSaving(false)
    }
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader>
          <DialogTitle>新建 Bot</DialogTitle>
        </DialogHeader>
        <DialogBody class="flex w-full min-w-[320px] flex-col gap-4">
          <div class="text-[13px] leading-relaxed text-v2-text-text-muted">
            Bot 是一个独立的 AI 邮箱账号：创建后把它的邮箱发给任何人，对方发消息就会收到 LLM 自动回复。
          </div>
          <TextInputV2
            autofocus
            appearance="large"
            class="!w-full"
            value={name()}
            placeholder="Bot 显示名"
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
            取消
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={saving()}>
            {saving() ? "创建中…" : "创建"}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function CreateGuideDialog(props: { bot: BotDto; onConfigure: () => void }) {
  const dialog = useDialog()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.bot.addr ?? "")
      showToast({ title: "已复制" })
    } catch {
      showToast({ title: "复制失败" })
    }
  }

  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>Bot 已创建</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex w-full min-w-[320px] flex-col gap-4">
        <div class="text-[13px] leading-relaxed text-v2-text-text-muted">
          已创建 <b class="text-v2-text-text-base">{props.bot.display_name}</b>。
          <br />
          Bot 邮箱：<b class="text-v2-text-text-base">{props.bot.addr ?? "—"}</b>
          <br />
          把邮箱发给任何人即可对话，Bot 会用 AI 自动回复。配置 LLM 后自动回复才会生效。
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => void copy()}>
          复制邮箱
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          onClick={() => {
            dialog.close()
            props.onConfigure()
          }}
        >
          配置 LLM
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

function DeleteBotDialog(props: { bot: BotDto; onConfirm: () => void }) {
  const dialog = useDialog()
  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>删除 Bot</DialogTitle>
      </DialogHeader>
      <DialogBody class="w-full min-w-[320px]">
        <div class="text-[13px] leading-relaxed text-v2-text-text-muted">
          删除后该 Bot 账号及其数据将彻底移除，无法恢复。
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          取消
        </ButtonV2>
        <ButtonV2
          variant="danger"
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          删除
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export function BotList(props: BotListProps) {
  const dialog = useDialog()
  const [thinkingIds, setThinkingIds] = createSignal<Record<number, boolean>>({})

  onMount(() => {
    const off = onBotActivity((a) => {
      setThinkingIds((prev) => {
        if (a.kind === "thinking") {
          if (prev[a.bot_id]) return prev
          return { ...prev, [a.bot_id]: true }
        }
        if (a.kind === "reply_sent" || a.kind === "llm_error" || a.kind === "reply_skipped" || a.kind === "reply_rate_limited") {
          if (!prev[a.bot_id]) return prev
          const next = { ...prev }
          delete next[a.bot_id]
          return next
        }
        return prev
      })
    })
    onCleanup(off)
  })

  const openCreate = () => {
    dialog.show(() => (
      <CreateBotDialog
        onCreated={(bot) => {
          props.onCreated(bot)
          dialog.show(() => (
            <CreateGuideDialog bot={bot} onConfigure={() => props.onSelect(bot)} />
          ))
        }}
      />
    ))
  }

  const openDelete = (bot: BotDto) => {
    dialog.show(() => (
      <DeleteBotDialog
        bot={bot}
        onConfirm={() => {
          props.onDelete(bot)
        }}
      />
    ))
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-v2-border-border-weak-base px-4 py-3">
        <div class="min-w-0">
          <div class="text-[14px] font-semibold tracking-[-0.02em] text-v2-text-text-base">机器人</div>
          <div class="mt-0.5 truncate text-[11px] text-v2-text-text-faint">由 LLM 自动回复的 Bot 账号</div>
        </div>
        <ButtonV2 size="small" variant="contrast" icon="plus" onClick={openCreate}>
          新建 Bot
        </ButtonV2>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show when={!props.loading} fallback={<div class="py-6 text-center text-xs text-v2-text-text-faint">加载中…</div>}>
          <Show
            when={props.bots.length > 0}
            fallback={
            <div class="flex h-full items-center justify-center p-6">
              <div class="whitespace-pre-line text-center text-xs leading-relaxed text-v2-text-text-faint">
                {"还没有 Bot。\nBot 是一个独立的 AI 邮箱账号：创建后把它的邮箱发给任何人，对方发消息就会收到 LLM 自动回复。"}
              </div>
            </div>
          }
        >
          <For each={props.bots}>
            {(bot) => {
              const info = () => props.rowInfo[bot.id]
              const personaName = () => {
                const pid = info()?.cfg?.persona
                if (!pid) return null
                return props.personas.find((p) => p.id === pid)?.name ?? pid
              }
              const thinking = () => !!thinkingIds()[bot.id]
              const statusText = () => (thinking() ? "思考中" : bot.io_running ? "运行中" : "已停止")
              const statusAccent = () => thinking() || bot.io_running
              const hasRule = () => {
                const rule = info()?.cfg?.rule
                if (!rule) return false
                return rule.rules.some((r) => r.enabled) || !!rule.welcome || !!rule.fallback
              }

              return (
                <div
                  class="flex cursor-pointer items-center gap-2.5 border-b border-v2-border-border-weaker-base px-3 py-2.5 transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                  classList={{ "bg-v2-overlay-simple-overlay-hover": props.selectedId === bot.id }}
                  onClick={() => props.onSelect(bot)}
                >
                  <Avatar fallback={bot.display_name} size="small" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[13px] font-medium text-v2-text-text-base">{bot.display_name}</div>
                    <div class="truncate text-[11px] text-v2-text-text-faint">{bot.addr ?? "地址未知"}</div>
                  </div>
                  <div class="flex shrink-0 flex-col items-end gap-1">
                    <div class="flex flex-wrap items-center justify-end gap-1">
                      <BadgeV2 variant={statusAccent() ? "accent" : "neutral"}>{statusText()}</BadgeV2>
                      <Show when={isLlmConfigured(info()?.cfg?.llm)}>
                        <BadgeV2 variant="accent">已配 LLM</BadgeV2>
                      </Show>
                      <Show when={personaName()}>
                        <BadgeV2>{personaName()}</BadgeV2>
                      </Show>
                      <Show when={hasRule()}>
                        <BadgeV2>规则</BadgeV2>
                      </Show>
                      <Show when={(info()?.scheduleCount ?? 0) > 0}>
                        <BadgeV2>{info()?.scheduleCount} 定时</BadgeV2>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <ButtonV2
                        size="small"
                        variant="ghost-muted"
                        onClick={(event: MouseEvent) => {
                          event.stopPropagation()
                          props.onSelect(bot)
                        }}
                      >
                        配置
                      </ButtonV2>
                      <Switch
                        aria-label="启停"
                        checked={bot.io_running}
                        onChange={(v) => props.onToggleIo(bot, v)}
                      />
                      <button
                        type="button"
                        title="删除"
                        aria-label="删除"
                        class="text-v2-icon-icon-muted transition-colors hover:text-v2-danger-danger-base"
                        onClick={(e) => {
                          e.stopPropagation()
                          openDelete(bot)
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                </div>
              )
            }}
          </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

