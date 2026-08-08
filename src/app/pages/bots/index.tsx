// src/app/pages/bots/index.tsx
// Bot 管理中心（/bots）：左侧列表（BotList）+ 右侧详情容器（BotDetail）。
// 数据：list_bots / list_bot_personas / get_bot_config / bot_list_schedules（列表徽标）；
// 选中 Bot 后详情内并行拉 get_bot_config + get_bot_stats（b5 §3.5）。

import { createSignal, onMount, Show, type Component } from "solid-js"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import { BotDetail } from "./BotDetail"
import { BotList, type BotRowInfo } from "./BotList"
import type { BotConfig, BotDto, PersonaDto, ScheduleDto } from "./types"

const BotsPage: Component = () => {
  const [bots, setBots] = createSignal<BotDto[]>([])
  const [personas, setPersonas] = createSignal<PersonaDto[]>([])
  const [rowInfo, setRowInfo] = createSignal<Record<number, BotRowInfo>>({})
  const [selected, setSelected] = createSignal<BotDto | null>(null)
  const [loading, setLoading] = createSignal(true)

  const loadRowInfo = async (botId: number): Promise<BotRowInfo> => {
    let cfg: BotConfig | null = null
    let scheduleCount = 0
    try {
      cfg = await call<BotConfig | null>("get_bot_config", { botId })
    } catch {
      // 单个 Bot 徽标失败不影响列表
    }
    try {
      scheduleCount = (await call<ScheduleDto[]>("bot_list_schedules", { botId })).filter((s) => s.enabled).length
    } catch {
      // 忽略
    }
    return { cfg, scheduleCount }
  }

  const refreshRow = async (botId: number) => {
    const info = await loadRowInfo(botId)
    setRowInfo((prev) => ({ ...prev, [botId]: info }))
  }

  const refresh = async () => {
    setLoading(true)
    try {
      const list = await call<BotDto[]>("list_bots")
      const ps = await call<PersonaDto[]>("list_bot_personas").catch(() => [] as PersonaDto[])
      setBots(list)
      setPersonas(ps)
      const infos: Record<number, BotRowInfo> = {}
      await Promise.all(list.map(async (b) => (infos[b.id] = await loadRowInfo(b.id))))
      setRowInfo(infos)
    } catch (e) {
      showToast({ title: "加载 Bot 列表失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
  })

  const patchBot = (botId: number, patch: Partial<BotDto>) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, ...patch } : b)))
    const sel = selected()
    if (sel && sel.id === botId) setSelected({ ...sel, ...patch })
  }

  const toggleIo = async (bot: BotDto, running: boolean) => {
    try {
      const updated = await call<BotDto>("set_bot_io", { botId: bot.id, running })
      patchBot(bot.id, { io_running: updated.io_running })
    } catch (e) {
      showToast({ title: "操作失败", description: e instanceof Error ? e.message : String(e) })
    }
  }

  const removeBot = async (bot: BotDto) => {
    try {
      await call("delete_bot", { botId: bot.id })
      showToast({ title: "已删除" })
      if (selected()?.id === bot.id) setSelected(null)
      await refresh()
    } catch (e) {
      showToast({ title: "删除失败", description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleCreated = (bot: BotDto) => {
    setSelected(bot)
    void refresh()
  }

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <aside class="flex w-[300px] shrink-0 flex-col border-r border-v2-border-border-weak-base">
        <BotList
          bots={bots()}
          rowInfo={rowInfo()}
          personas={personas()}
          selectedId={selected()?.id ?? null}
          loading={loading()}
          onSelect={(bot) => setSelected(bot)}
          onToggleIo={(bot, running) => void toggleIo(bot, running)}
          onDelete={(bot) => void removeBot(bot)}
          onCreated={handleCreated}
        />
      </aside>
      <main class="flex min-h-0 min-w-0 flex-1 flex-col">
        <Show
          when={selected()}
          fallback={
            <div class="flex flex-1 items-center justify-center p-6 text-center text-xs leading-relaxed text-v2-text-text-faint">
              从左侧选择一个 Bot 查看详情
            </div>
          }
        >
          {(sel) => (
            <BotDetail
              bot={sel()}
              personas={personas()}
              onBack={() => setSelected(null)}
              onToggleIo={(bot, running) => void toggleIo(bot, running)}
              onChanged={(bot) => void refreshRow(bot.id)}
            />
          )}
        </Show>
      </main>
    </div>
  )
}

export default BotsPage
