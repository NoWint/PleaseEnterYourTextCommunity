// src/app/pages/bots/BotDetail.tsx
// 详情容器：顶栏（返回/头像/名称/状态徽标/启停）+ tabs-v2 六个 Tab。
// 打开时并行拉 get_bot_config + get_bot_stats（b5 §3.5）；Tab 内容按需挂载。
// bot-activity 事件驱动打字指示器：thinking → 显示「正在输入…」；reply_sent/llm_error → 隐藏。

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Avatar } from "@opencode-ai/ui/v2/avatar-v2"
import { Tag as BadgeV2 } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import { onBotActivity } from "./activity"
import { BotConfigForm } from "./BotConfigForm"
import { BotScheduleForm } from "./BotScheduleForm"
import { BotPersonaForm } from "./BotPersonaForm"
import { BotToolsPanel } from "./BotToolsPanel"
import { BotTimeline } from "./BotTimeline"
import { BotStats } from "./BotStats"
import { DETAIL_TABS, type BotConfig, type BotDto, type BotStatsDto, type DetailTab, type PersonaDto } from "./types"

const ChevronLeftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">
    <path d="M15 4L7 12L15 20" />
  </svg>
)

interface BotDetailProps {
  bot: BotDto
  personas: PersonaDto[]
  onBack: () => void
  onToggleIo: (bot: BotDto, running: boolean) => void
  onChanged: (bot: BotDto) => void
}

export function BotDetail(props: BotDetailProps) {
  const [tab, setTab] = createSignal<DetailTab>("config")
  // 详情数据按 bot.id 绑定：id 不匹配时读取返回 null/未就绪，
  // 切换 Bot 时子组件同步进入加载态，不会短暂读到上一 Bot 的数据。
  const [cfgState, setCfgState] = createSignal<{ id: number; cfg: BotConfig | null; ready: boolean }>({
    id: -1,
    cfg: null,
    ready: false,
  })
  const [statsState, setStatsState] = createSignal<{ id: number; stats: BotStatsDto | null; loading: boolean }>({
    id: -1,
    stats: null,
    loading: true,
  })
  const [typing, setTyping] = createSignal(false)

  const botId = () => props.bot.id
  const cfg = () => (cfgState().id === botId() ? cfgState().cfg : null)
  const cfgReady = () => cfgState().id === botId() && cfgState().ready
  const stats = () => (statsState().id === botId() ? statsState().stats : null)
  const statsLoading = () => statsState().id !== botId() || statsState().loading

  // setCfg 按 botId 落位：表单保存/人设应用完成时若已切换 Bot，旧请求的完成结果直接丢弃
  // （load effect 已按 botId 重载，当前 Bot 的槽位只接受当前 Bot 的写入）。
  // 否则旧请求会把共享槽位盖成旧 id，而读取侧按 botId 过滤 → cfg()/cfgReady() 恒为未就绪，
  // 且 load effect 只追踪 botId 不会重跑 → 当前 Bot 的配置页永久卡在加载态。
  const setCfg = (forId: number, next: BotConfig | null) => {
    if (botId() !== forId) return
    setCfgState({ id: forId, cfg: next, ready: true })
  }

  // 打开详情：并行拉配置 + 统计（b5 §3.5）。仅随 bot.id 重载，
  // 顶栏启停等就地更新（同一对象引用替换）不会触发重载、不会覆盖表单未保存输入。
  createEffect(() => {
    const id = botId()
    setTyping(false)
    void (async () => {
      let c: BotConfig | null = null
      try {
        c = await call<BotConfig | null>("get_bot_config", { botId: id })
      } catch (e) {
        showToast({ title: "加载配置失败", description: e instanceof Error ? e.message : String(e) })
      }
      if (botId() !== id) return
      setCfgState({ id, cfg: c, ready: true })
      let s: BotStatsDto | null = null
      try {
        s = await call<BotStatsDto>("get_bot_stats", { botId: id })
      } catch (e) {
        showToast({ title: "加载统计失败", description: e instanceof Error ? e.message : String(e) })
      }
      if (botId() !== id) return
      setStatsState({ id, stats: s, loading: false })
    })()
  })

  // 打字指示器：仅当前 bot 的活动
  onMount(() => {
    const off = onBotActivity((a) => {
      if (a.bot_id !== props.bot.id) return
      if (a.kind === "thinking") {
        setTyping(true)
      } else if (a.kind === "reply_sent" || a.kind === "llm_error") {
        setTyping(false)
      }
    })
    onCleanup(off)
  })

  const personaName = () => {
    const pid = cfg()?.persona
    if (!pid) return null
    return props.personas.find((p) => p.id === pid)?.name ?? pid
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 顶栏 */}
      <div class="flex shrink-0 items-center gap-3 border-b border-v2-border-border-weak-base px-4 py-2.5">
        <ButtonV2 size="small" variant="ghost-muted" onClick={props.onBack} class="gap-1">
          <ChevronLeftIcon />
          返回列表
        </ButtonV2>
        <Avatar fallback={props.bot.display_name} size="small" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[14px] font-semibold tracking-[-0.02em] text-v2-text-text-base">
            {props.bot.display_name}
          </div>
          <div class="truncate text-[11px] text-v2-text-text-faint">{props.bot.addr ?? ""}</div>
        </div>
        <Show when={typing()}>
          <div class="flex shrink-0 items-center gap-1.5 text-[11px] text-v2-text-text-muted">
            <span class="size-1.5 animate-pulse rounded-full bg-v2-text-text-muted" />
            正在输入…
          </div>
        </Show>
        <BadgeV2 variant={props.bot.io_running ? "accent" : "neutral"}>
          {props.bot.io_running ? "运行中" : "已停止"}
        </BadgeV2>
        <Show when={personaName()}>
          <BadgeV2>{personaName()}</BadgeV2>
        </Show>
        <Switch
          aria-label="启停"
          checked={props.bot.io_running}
          onChange={(v) => props.onToggleIo(props.bot, v)}
        />
      </div>

      {/* Tab 栏 */}
      <TabsV2 value={tab()} onChange={(next) => setTab(next as DetailTab)} class="flex min-h-0 min-w-0 flex-1 flex-col">
        <TabsV2.List>
          <For each={DETAIL_TABS}>
            {(t) => <TabsV2.Trigger value={t.id}>{t.label}</TabsV2.Trigger>}
          </For>
        </TabsV2.List>

        {/* 每个 Tab 内容以 bot.id 为 key：切换 Bot 时重挂载，
            onMount 加载的数据（时间线/定时/工具/表单）不会残留上一 Bot 的旧值。
            注意不可用整个 bot 对象做 key（io 切换会换对象引用 → 误重挂载）。 */}
        <TabsV2.Content value="config" class="min-h-0 flex-1 overflow-y-auto">
          <Show when={botId()} keyed>
            {(id) => (
              <BotConfigForm
                bot={props.bot}
                cfg={cfg}
                cfgReady={cfgReady}
                setCfg={(botId, next) => setCfg(botId, next)}
                onSaved={() => props.onChanged(props.bot)}
              />
            )}
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="schedule" class="min-h-0 flex-1 overflow-y-auto">
          <Show when={botId()} keyed>
            {(id) => <BotScheduleForm bot={props.bot} />}
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="persona" class="min-h-0 flex-1 overflow-y-auto">
          <Show when={botId()} keyed>
            {(id) => (
              <BotPersonaForm
                bot={props.bot}
                cfg={cfg}
                setCfg={(botId, next) => setCfg(botId, next)}
                personas={props.personas}
                onChanged={() => props.onChanged(props.bot)}
              />
            )}
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="tools" class="min-h-0 flex-1 overflow-y-auto">
          <Show when={botId()} keyed>
            {(id) => (
              <BotToolsPanel
                bot={props.bot}
                cfg={cfg}
                cfgReady={cfgReady}
                setCfg={(botId, next) => setCfg(botId, next)}
                onSaved={() => props.onChanged(props.bot)}
              />
            )}
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="timeline" class="min-h-0 flex-1 overflow-y-auto">
          <Show when={botId()} keyed>
            {(id) => <BotTimeline bot={props.bot} />}
          </Show>
        </TabsV2.Content>
        <TabsV2.Content value="stats" class="min-h-0 flex-1 overflow-y-auto">
          <Show when={botId()} keyed>
            {(id) => <BotStats stats={stats} loading={statsLoading} />}
          </Show>
        </TabsV2.Content>
      </TabsV2>
    </div>
  )
}
