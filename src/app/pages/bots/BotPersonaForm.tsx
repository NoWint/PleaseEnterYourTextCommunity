// src/app/pages/bots/BotPersonaForm.tsx
// 人设 Tab：list_bot_personas 列表（名称/描述）+ 当前人设高亮 + 「应用」→
// apply_bot_persona（后端同时覆写 system_prompt）→ 重新拉配置刷新。

import { createSignal, For, Show, type Component, type Setter } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag as BadgeV2 } from "@opencode-ai/ui/v2/badge-v2"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import type { BotConfig, BotDto, PersonaDto } from "./types"

interface BotPersonaFormProps {
  bot: BotDto
  cfg: () => BotConfig | null
  setCfg: Setter<BotConfig | null>
  personas: PersonaDto[]
  onChanged: () => void
}

export function BotPersonaForm(props: BotPersonaFormProps) {
  const [applying, setApplying] = createSignal<string | null>(null)

  const current = () => props.cfg()?.persona ?? null

  const doApply = async (persona: PersonaDto) => {
    if (applying()) return
    setApplying(persona.id)
    try {
      await call("apply_bot_persona", { botId: props.bot.id, personaId: persona.id })
      const fresh = await call<BotConfig | null>("get_bot_config", { botId: props.bot.id })
      props.setCfg(fresh)
      showToast({ title: `已应用人设「${persona.name}」` })
      props.onChanged()
    } catch (e) {
      showToast({ title: "应用失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setApplying(null)
    }
  }

  return (
    <div class="mx-auto flex w-full max-w-[760px] flex-col gap-5 p-4">
      <div class="text-[12px] leading-relaxed text-v2-text-text-muted">
        应用人设会覆写 Bot 的系统提示词（system prompt）并记录到配置。
      </div>
      <Show
        when={props.personas.length > 0}
        fallback={<div class="py-4 text-center text-xs text-v2-text-text-faint">暂无可用人设</div>}
      >
        <For each={props.personas}>
          {(persona) => (
            <div class="flex items-center gap-3 rounded-[8px] border border-v2-border-border-weak-base bg-v2-background-bg-raised px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-medium text-v2-text-text-base">{persona.name}</span>
                  <Show when={current() === persona.id}>
                    <BadgeV2 variant="accent">当前</BadgeV2>
                  </Show>
                </div>
                <div class="mt-0.5 text-[12px] leading-relaxed text-v2-text-text-muted">{persona.description}</div>
              </div>
              <ButtonV2
                size="small"
                variant={current() === persona.id ? "ghost-muted" : "contrast"}
                disabled={applying() !== null}
                onClick={() => void doApply(persona)}
              >
                {applying() === persona.id ? "应用中…" : current() === persona.id ? "已应用" : "应用"}
              </ButtonV2>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
