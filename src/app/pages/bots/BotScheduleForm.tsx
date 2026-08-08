// src/app/pages/bots/BotScheduleForm.tsx
// 定时 Tab：会话下拉（bot_get_chatlist）+ minute/hour/dayOfWeek（-1=任意）+ 消息 →
// bot_add_schedule / bot_delete_schedule / bot_list_schedules（下次触发列表）。

import { createSignal, For, onMount, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Tag as BadgeV2 } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import { cronLabel, truncateText, type BotDto, type ScheduleDto } from "./types"

interface ChatOption {
  chat_id: number
  name: string
}

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">
    <path d="M3 6H21M8 6V4H16V6M19 6L18 21H6L5 6M10 10V17M14 10V17" />
  </svg>
)

interface BotScheduleFormProps {
  bot: BotDto
}

export function BotScheduleForm(props: BotScheduleFormProps) {
  const [chats, setChats] = createSignal<ChatOption[]>([])
  const [chatId, setChatId] = createSignal<number | null>(null)
  const [minute, setMinute] = createSignal("")
  const [hour, setHour] = createSignal("")
  const [dow, setDow] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [schedules, setSchedules] = createSignal<ScheduleDto[]>([])
  const [loading, setLoading] = createSignal(true)
  const [adding, setAdding] = createSignal(false)

  const loadSchedules = async () => {
    try {
      const list = await call<ScheduleDto[]>("bot_list_schedules", { botId: props.bot.id })
      setSchedules(list)
    } catch (e) {
      showToast({ title: "加载定时失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void (async () => {
      try {
        const list = await call<ChatOption[]>("bot_get_chatlist", { botId: props.bot.id })
        setChats(list)
        if (list.length > 0) setChatId(list[0]!.chat_id)
      } catch {
        // 无会话时仅禁用添加按钮
      }
      await loadSchedules()
    })()
  })

  const toInt = (s: string): number => {
    const n = Number(s)
    return s.trim() === "" || !Number.isFinite(n) ? -1 : Math.trunc(n)
  }

  const doAdd = async () => {
    const chat = chatId()
    const msg = message().trim()
    if (chat == null) {
      showToast({ title: "该 Bot 还没有会话" })
      return
    }
    if (!msg) {
      showToast({ title: "请输入消息内容" })
      return
    }
    if (adding()) return
    setAdding(true)
    try {
      await call("bot_add_schedule", {
        botId: props.bot.id,
        chatId: chat,
        minute: toInt(minute()),
        hour: toInt(hour()),
        dayOfWeek: toInt(dow()),
        message: msg,
      })
      setMessage("")
      showToast({ title: "定时已添加" })
      await loadSchedules()
    } catch (e) {
      showToast({ title: "添加失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAdding(false)
    }
  }

  const doDelete = async (s: ScheduleDto) => {
    try {
      await call("bot_delete_schedule", { scheduleId: s.id })
      showToast({ title: "已删除" })
      await loadSchedules()
    } catch (e) {
      showToast({ title: "删除失败", description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div class="mx-auto flex w-full max-w-[760px] flex-col gap-5 p-4">
      <Field>
        <Field.Label>发送到会话</Field.Label>
        <SelectV2
          options={chats()}
          current={chats().find((c) => c.chat_id === chatId())}
          value={(c) => String(c.chat_id)}
          label={(c) => c.name}
          onSelect={(c) => c && setChatId(c.chat_id)}
          placeholder={chats().length === 0 ? "暂无会话" : "选择会话…"}
          disabled={chats().length === 0}
          class="!w-full"
        />
      </Field>

      <Field>
        <Field.Label>时间（UTC 时区 · 分钟 / 小时 / 星期）</Field.Label>
        <div class="grid grid-cols-3 gap-2">
          <TextInputV2
            class="!w-full"
            value={minute()}
            placeholder="分钟 0-59"
            onInput={(e) => setMinute(e.currentTarget.value)}
          />
          <TextInputV2
            class="!w-full"
            value={hour()}
            placeholder="小时 0-23"
            onInput={(e) => setHour(e.currentTarget.value)}
          />
          <TextInputV2
            class="!w-full"
            value={dow()}
            placeholder="星期 0-6"
            onInput={(e) => setDow(e.currentTarget.value)}
          />
        </div>
        <Field.Prefix>
          小时按 UTC 计：例如 UTC+8 的本地 17:00 应填 9。留空或 -1 表示任意；dayOfWeek 0=周日
        </Field.Prefix>
      </Field>

      <Field>
        <Field.Label>消息内容</Field.Label>
        <TextInputV2
          class="!w-full"
          value={message()}
          placeholder="要定时发送的内容"
          onInput={(e) => setMessage(e.currentTarget.value)}
        />
      </Field>

      <div>
        <ButtonV2 variant="contrast" icon="plus" disabled={chats().length === 0 || adding()} onClick={() => void doAdd()}>
          {adding() ? "添加中…" : "添加定时"}
        </ButtonV2>
      </div>

      <div class="flex flex-col gap-2">
        <div class="text-[13px] font-semibold text-v2-text-text-base">已设定时</div>
        <Show
          when={!loading}
          fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">加载中…</div>}
        >
          <Show
            when={schedules().length > 0}
            fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">暂无定时任务</div>}
          >
            <For each={schedules()}>
              {(s) => (
                <div class="flex items-center gap-3 rounded-[8px] border border-v2-border-border-weak-base bg-v2-background-bg-raised px-3 py-2.5">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[13px] text-v2-text-text-base" title={s.message}>
                      {truncateText(s.message, 60)}
                    </div>
                    <div class="mt-0.5 text-[11px] text-v2-text-text-muted">
                      下次（本地时间）：{new Date(s.next_run_at * 1000).toLocaleString()} · 规则（UTC）：{cronLabel(s.minute, s.hour, s.day_of_week)}
                    </div>
                  </div>
                  <Show when={!s.enabled}>
                    <BadgeV2>已停用</BadgeV2>
                  </Show>
                  <button
                    type="button"
                    title="删除定时"
                    aria-label="删除定时"
                    class="shrink-0 text-v2-icon-icon-muted transition-colors hover:text-v2-danger-danger-base"
                    onClick={() => void doDelete(s)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
