// src/app/pages/bots/BotConfigForm.tsx
// 配置 Tab（LLM）：Provider 下拉 / Base URL 预设 / API Key（密码）/ 模型 /
// 温度滑条（0–2）/ max_tokens / top_p / 系统提示词 / 「测试连接」→ update_bot_config。
// 保存后合并到现有配置（保留 limits/rule/tools/persona/project_context 等字段）。

import { createEffect, createSignal, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { call } from "@/api"
import { showToast } from "../../utils/toast"
import { LLM_PRESETS, PROVIDERS, type BotConfig, type BotDto, type LlmConfig } from "./types"

interface BotConfigFormProps {
  bot: BotDto
  cfg: () => BotConfig | null
  /** 配置是否已就绪（null 也可能是「Bot 无配置」或加载失败，需显式标记）。 */
  cfgReady: () => boolean
  /** 按 botId 写入配置（保存完成时若已切 Bot，旧结果不会污染新 Bot 视图）。 */
  setCfg: (botId: number, next: BotConfig | null) => void
  onSaved: () => void
}

export function BotConfigForm(props: BotConfigFormProps) {
  const [provider, setProvider] = createSignal<string>(PROVIDERS[0]!.value)
  const [preset, setPreset] = createSignal<string>(LLM_PRESETS[0]!.value)
  const [customUrl, setCustomUrl] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [model, setModel] = createSignal("")
  const [temperature, setTemperature] = createSignal(0.7)
  const [maxTokens, setMaxTokens] = createSignal("")
  const [topP, setTopP] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [testing, setTesting] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [testResult, setTestResult] = createSignal<{ text: string; ok: boolean } | null>(null)

  // 配置到达时回填表单（保存后合并值与原表单一致，幂等）。
  // 表单在 cfgReady 之前不渲染（见下方加载占位），切换 Bot 时组件被 keyed 重挂载，
  // 因此不存在「残留上一 Bot 值」或「回填覆盖用户输入」的窗口。
  createEffect(() => {
    const llm = props.cfg()?.llm
    if (!llm) return
    const prov = PROVIDERS.find((p) => p.value === llm.provider)
    if (prov) setProvider(prov.value)
    if (llm.base_url) {
      const p = LLM_PRESETS.find((x) => x.value === llm.base_url)
      if (p) {
        setPreset(p.value)
      } else {
        setPreset("__custom__")
        setCustomUrl(llm.base_url)
      }
    }
    setApiKey(llm.api_key ?? "")
    setModel(llm.model ?? "")
    setTemperature(llm.temperature ?? 0.7)
    setMaxTokens(llm.max_tokens != null ? String(llm.max_tokens) : "")
    setTopP(llm.top_p != null ? String(llm.top_p) : "")
    setPrompt(llm.system_prompt ?? "")
  })

  const customVisible = () => preset() === "__custom__"

  const collectConfig = (): LlmConfig => {
    const baseUrl = preset() === "__custom__" ? customUrl().trim() : preset()
    const mt = maxTokens().trim()
    const tp = topP().trim()
    return {
      provider: provider(),
      temperature: temperature(),
      system_prompt: prompt().trim() || null,
      base_url: baseUrl || null,
      api_key: apiKey().trim() || null,
      model: model().trim() || null,
      max_tokens: mt ? Number(mt) : null,
      top_p: tp ? Number(tp) : null,
    }
  }

  const doTest = async () => {
    if (testing()) return
    setTesting(true)
    setTestResult({ text: "测试中…", ok: false })
    try {
      const reply = await call<string>("test_llm_config", { config: collectConfig() })
      setTestResult({ text: `✓ 连接成功: ${reply.slice(0, 60)}`, ok: true })
    } catch (e) {
      setTestResult({ text: "✗ " + (e instanceof Error ? e.message : String(e)), ok: false })
    } finally {
      setTesting(false)
    }
  }

  const doSave = async () => {
    if (saving()) return
    setSaving(true)
    try {
      const current = props.cfg() ?? {}
      const merged: BotConfig = { ...current, llm: { ...(current.llm ?? {}), ...collectConfig() } }
      await call("update_bot_config", { botId: props.bot.id, config: merged })
      props.setCfg(props.bot.id, merged)
      showToast({ title: "配置已保存" })
      props.onSaved()
    } catch (e) {
      showToast({ title: "保存失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Show
      when={props.cfgReady()}
      fallback={<div class="p-6 text-center text-xs text-v2-text-text-faint">配置加载中…</div>}
    >
      <div class="mx-auto flex w-full max-w-[760px] flex-col gap-5 p-4">
        <Field>
          <Field.Label>Provider</Field.Label>
          <SelectV2
            options={PROVIDERS}
            current={PROVIDERS.find((o) => o.value === provider())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(o) => o && setProvider(o.value)}
            class="!w-full"
          />
        </Field>

        <Field>
          <Field.Label>Base URL 预设</Field.Label>
          <SelectV2
            options={LLM_PRESETS}
            current={LLM_PRESETS.find((o) => o.value === preset())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(o) => o && setPreset(o.value)}
            class="!w-full"
          />
        </Field>

        <Show when={customVisible()}>
          <Field>
            <Field.Label>自定义 Base URL</Field.Label>
            <TextInputV2
              class="!w-full"
              value={customUrl()}
              placeholder="https://api.example.com/v1"
              onInput={(e) => setCustomUrl(e.currentTarget.value)}
            />
          </Field>
        </Show>

        <Field>
          <Field.Label>API Key</Field.Label>
          <TextInputV2
            class="!w-full"
            type="password"
            value={apiKey()}
            placeholder="sk-…"
            onInput={(e) => setApiKey(e.currentTarget.value)}
          />
        </Field>

        <Field>
          <Field.Label>模型名</Field.Label>
          <TextInputV2
            class="!w-full"
            value={model()}
            placeholder="gpt-4o-mini"
            onInput={(e) => setModel(e.currentTarget.value)}
          />
        </Field>

        <Field>
          <Field.Label>温度</Field.Label>
          <div class="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature()}
              onInput={(e) => setTemperature(Number(e.currentTarget.value))}
              class="w-full accent-v2-accent-accent-strong"
            />
            <span class="w-10 shrink-0 text-right text-[12px] text-v2-text-text-muted">
              {temperature().toFixed(1)}
            </span>
          </div>
          <Field.Prefix>0–2，越高越有创造性</Field.Prefix>
        </Field>

        <Field>
          <Field.Label>Max Tokens</Field.Label>
          <TextInputV2
            class="!w-full"
            value={maxTokens()}
            placeholder="例如 4096"
            onInput={(e) => setMaxTokens(e.currentTarget.value)}
          />
        </Field>

        <Field>
          <Field.Label>Top P</Field.Label>
          <TextInputV2
            class="!w-full"
            value={topP()}
            placeholder="例如 0.9"
            onInput={(e) => setTopP(e.currentTarget.value)}
          />
        </Field>

        <Field>
          <Field.Label>系统提示词</Field.Label>
          <TextareaV2
            class="!w-full"
            rows={4}
            value={prompt()}
            placeholder="你是一个乐于助人的助手…"
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />
        </Field>

        <Show when={testResult()}>
          {(r) => (
            <div
              class="text-[12px] break-all"
              classList={{
                "text-v2-state-fg-success": r().ok,
                "text-v2-danger-danger-base": !r().ok,
              }}
            >
              {r().text}
            </div>
          )}
        </Show>

        <div class="flex gap-2">
          <ButtonV2 variant="ghost" disabled={testing()} onClick={() => void doTest()}>
            {testing() ? "测试中…" : "测试连接"}
          </ButtonV2>
          <ButtonV2 variant="contrast" disabled={saving()} onClick={() => void doSave()}>
            {saving() ? "保存中…" : "保存"}
          </ButtonV2>
        </div>
      </div>
    </Show>
  )
}
