// src/app/pages/bots/BotToolsPanel.tsx
// 工具 Tab：list_bot_tools（内置 + 插件已注册工具）→ 开关显式启用集 →
// 保存 update_bot_config（与默认安全集一致时存 null，即默认开放）。
// 插件工具的注册/回写由 src/plugins/api.ts 的 registerTool 桥负责，本页只读展示。

import { createEffect, createSignal, For, onMount, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Tag as BadgeV2 } from "@opencode-ai/ui/v2/badge-v2"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import type { BotConfig, BotDto, BotToolDto } from "./types"

interface BotToolsPanelProps {
  bot: BotDto
  cfg: () => BotConfig | null
  /** 配置是否已就绪（null 也可能是「Bot 无配置」或加载失败，需显式标记）。 */
  cfgReady: () => boolean
  /** 按 botId 写入配置（保存完成时若已切 Bot，旧结果不会污染新 Bot 视图）。 */
  setCfg: (botId: number, next: BotConfig | null) => void
  onSaved: () => void
}

export function BotToolsPanel(props: BotToolsPanelProps) {
  const [tools, setTools] = createSignal<BotToolDto[]>([])
  const [enabled, setEnabled] = createSignal<Set<string>>(new Set())
  const [loading, setLoading] = createSignal(true)
  const [toolsLoaded, setToolsLoaded] = createSignal(false)
  const [initialized, setInitialized] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  onMount(() => {
    void (async () => {
      try {
        const list = await call<BotToolDto[]>("list_bot_tools")
        setTools(list)
      } catch (e) {
        showToast({ title: "加载工具失败", description: e instanceof Error ? e.message : String(e) })
      } finally {
        setLoading(false)
        setToolsLoaded(true)
      }
    })()
  })

  // 启用集初始化：必须等工具列表与配置都就绪后才从 cfg.tools 取显式集，
  // 否则配置未加载时用默认安全集打底，保存会写 null 悄悄丢掉显式工具清单。
  createEffect(() => {
    if (initialized()) return
    if (!props.cfgReady() || !toolsLoaded()) return
    setInitialized(true)
    const defaultSafe = tools().filter((t) => t.safe).map((t) => t.name)
    setEnabled(new Set(props.cfg()?.tools ?? defaultSafe))
  })

  const toggle = (name: string, v: boolean) => {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (v) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const doSave = async () => {
    if (saving()) return
    setSaving(true)
    try {
      const defaultSafe = tools().filter((t) => t.safe).map((t) => t.name)
      const current = props.cfg() ?? {}
      const isDefault =
        defaultSafe.length === enabled().size && defaultSafe.every((n) => enabled().has(n))
      const merged: BotConfig = { ...current, tools: isDefault ? null : [...enabled()] }
      await call("update_bot_config", { botId: props.bot.id, config: merged })
      props.setCfg(props.bot.id, merged)
      showToast({ title: "工具设置已保存" })
      props.onSaved()
    } catch (e) {
      showToast({ title: "保存失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="mx-auto flex w-full max-w-[760px] flex-col gap-4 p-4">
      <div class="text-[12px] leading-relaxed text-v2-text-text-muted">
        安全工具默认开放；启用不安全工具或关闭安全工具会生成显式工具清单。插件工具经 registerTool 注册后自动出现在列表中。
      </div>
      <div>
        <ButtonV2
          variant="contrast"
          disabled={loading() || !initialized() || saving()}
          onClick={() => void doSave()}
        >
          {saving() ? "保存中…" : "保存工具设置"}
        </ButtonV2>
      </div>

      <Show
        when={!loading}
        fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">加载中…</div>}
      >
        <Show
          when={tools().length > 0}
          fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">暂无可用工具</div>}
        >
          <For each={tools()}>
            {(t) => (
              <div class="flex items-center gap-3 rounded-[8px] border border-v2-border-border-weak-base bg-v2-background-bg-raised px-3 py-2.5">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-[13px] font-medium text-v2-text-text-base">{t.name}</span>
                    <BadgeV2 variant={t.safe ? "accent" : "neutral"}>
                      {t.safe ? "默认开放" : "需显式启用"}
                    </BadgeV2>
                  </div>
                  <div class="mt-0.5 text-[12px] text-v2-text-text-muted">{t.description}</div>
                </div>
                <Switch
                  aria-label={`启用 ${t.name}`}
                  checked={enabled().has(t.name)}
                  onChange={(v) => toggle(t.name, v)}
                />
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}
