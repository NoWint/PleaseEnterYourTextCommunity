// src/app/pages/intelligence/SummaryPanel.tsx
// LLM 主题总结面板（mode="summary"：会话选择 + 触发 enqueue_summary + 结果展示 + summary-event 订阅；
// mode="settings"：智能设置（模式/来源/档位/下载进度 + download-progress 订阅 + API 测试/保存）。
// summary-event / download-progress 为后端直接 emit 的 Tauri 事件，不走 dc-event 桥，用 listen 直连。

import { createEffect, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { listen } from "@tauri-apps/api/event"
import { call } from "../../../api"
import { resolveMessageText } from "../../../utils/envelope"
import { showToast } from "../../utils/toast"
import type { MsgDto } from "../../../types"
import type { DownloadProgressPayload, IntelligenceSettingsDto, ModelStatusDto, SummaryEventPayload } from "./types"

export interface SummaryPanelProps {
  mode: "summary" | "settings"
  /** 父级刷新计数：变化时重载数据。 */
  refresh?: number
}

interface ChatOption {
  value: string
  label: string
}

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
    <path d="M21.448 13C20.9483 17.7767 16.909 21.5 12 21.5C8.18227 21.5 4.89052 19.248 3.38065 16M2.5 20.5V15.5H5.5M2.55176 11C3.05145 6.22334 7.09079 2.5 11.9998 2.5C15.8175 2.5 19.1092 4.75197 20.6191 8M21.4998 3.5V8.5H18.4998" />
  </svg>
)

const SparklesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 1.5L9.2 5.1L12.8 6.3L9.2 7.5L8 11.1L6.8 7.5L3.2 6.3L6.8 5.1L8 1.5Z" />
    <path d="M12.8 10L13.4 12.2L15.5 12.8L13.4 13.4L12.8 15.5L12.2 13.4L10 12.8L12.2 12.2L12.8 10Z" />
    <path d="M3.5 9.5L3.9 11L5.5 11.4L3.9 11.8L3.5 13.4L3.1 11.8L1.5 11.4L3.1 11L3.5 9.5Z" />
  </svg>
)

// 详情看板分析类型（spec §6 AnalysisKind）
const SUMMARY_KINDS: Array<{ value: string; label: string }> = [
  { value: "summary", label: "摘要" },
  { value: "participation", label: "参与度" },
  { value: "action_items", label: "待办" },
  { value: "resources", label: "资源" },
  { value: "open_questions", label: "开放问题" },
  { value: "timeline", label: "时间线" },
  { value: "decisions", label: "决策" },
]

// 时间格式化：unix 秒 → 'YYYY-MM-DD HH:MM'
function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB"
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return n + " B"
}

// ── 主题总结模式（mode="summary"） ─────────────────────────────────────────
const SummaryTab: Component<{ refresh?: number }> = (props) => {
  const [chats, setChats] = createSignal<ChatOption[]>([])
  const [chatId, setChatId] = createSignal(0)
  const [lane, setLane] = createSignal<"bubble" | "detail">("bubble")
  const [kind, setKind] = createSignal("summary")
  const [count, setCount] = createSignal(50)
  const [running, setRunning] = createSignal(false)
  const [status, setStatus] = createSignal<"idle" | "queued" | "done" | "error">("idle")
  const [result, setResult] = createSignal("")
  const [errMsg, setErrMsg] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)

  const loadChats = async () => {
    try {
      const list = await call<Array<{ chat_id: number; name: string }>>("get_chatlist")
      const opts = list
        .filter((c) => c.chat_id)
        .map((c) => ({ value: String(c.chat_id), label: c.name || `会话 #${c.chat_id}` }))
      setChats(opts)
      if (opts.length > 0 && !chatId()) setChatId(Number(opts[0].value))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  createEffect(() => {
    props.refresh
    void loadChats()
  })

  // summary-event 订阅：只关心当前选中会话（后端 emit 原始事件，需 listen 直连）
  createEffect(() => {
    let un: (() => void) | undefined
    void listen<SummaryEventPayload>("summary-event", (ev) => {
      const p = ev.payload as unknown as SummaryEventPayload
      if (!p || p.chatId !== chatId()) return
      if (p.status === "done") {
        setStatus("done")
        setResult(p.result ?? "")
        setErrMsg("")
      } else if (p.status === "error") {
        setStatus("error")
        setResult("")
        setErrMsg(p.error?.message ?? p.error?.code ?? "未知错误")
      }
    }).then((fn) => {
      un = fn
    })
    onCleanup(() => un?.())
  })

  const trigger = async () => {
    if (running()) return
    const cid = chatId()
    if (!cid) {
      showToast({ title: "请先选择会话" })
      return
    }
    setRunning(true)
    setStatus("queued")
    setResult("")
    setErrMsg("")
    try {
      // 窗口：后端读 core 历史为知识库专用；主题总结窗口由前端组装（spec §3.1）
      const n = Math.max(10, Math.min(200, count() || 50))
      const msgs = await call<MsgDto[]>("get_chat_msgs", { chatId: cid, beforeMsgId: null })
      const lines = msgs
        .slice(-n)
        .filter((m) => m.view_type !== "info" && m.text)
        .map((m) => {
          const text = m.file ? `[附件: ${m.file_name || m.file}]` : resolveMessageText(m.text)
          return `[id=${m.msg_id}] ${m.from_name} [${fmtTime(m.ts)}]: ${text}`
        })
      if (lines.length === 0) {
        setStatus("error")
        setErrMsg("该会话暂无文本消息，无法总结")
        return
      }
      await call("enqueue_summary", {
        chatId: cid,
        lane: lane(),
        kind: lane() === "detail" ? kind() : null,
        context: { lines },
      })
    } catch (e) {
      setStatus("error")
      setErrMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const statusTag = () => {
    switch (status()) {
      case "queued":
        return <Tag variant="accent">处理中</Tag>
      case "done":
        return <Tag variant="accent">已完成</Tag>
      case "error":
        return <Tag variant="neutral">失败</Tag>
      default:
        return <Tag variant="neutral">未触发</Tag>
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[820px] flex-col gap-4 p-4">
        <Show when={error()}>
          <div class="rounded-[10px] bg-v2-background-bg-layer-01 p-4 text-[12px] text-v2-text-text-faint">
            会话列表加载失败：{error()}
          </div>
        </Show>

        {/* 触发区 */}
        <div class="flex flex-col gap-4 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
          <div class="flex items-center gap-2">
            <SparklesIcon />
            <div class="flex flex-col">
              <span class="text-[13px] font-medium text-v2-text-text-base">主题总结</span>
              <span class="text-[11px] text-v2-text-text-faint">选择会话与车道，立即生成短摘要或详情看板</span>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-v2-text-text-base">会话</span>
            <SelectV2
              appearance="base"
              placeholder="选择会话"
              options={chats()}
              value={(o) => o.value}
              label={(o) => o.label}
              current={chats().find((o) => Number(o.value) === chatId())}
              onSelect={(o) => setChatId(o ? Number(o.value) : 0)}
              class="w-[260px]"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-v2-text-text-base">车道</span>
            <SegmentedControlV2 value={lane()} onChange={(v) => v && setLane(v as "bubble" | "detail")}>
              <SegmentedControlItemV2 value="bubble">气泡（一句话）</SegmentedControlItemV2>
              <SegmentedControlItemV2 value="detail">详情看板</SegmentedControlItemV2>
            </SegmentedControlV2>
          </div>

          <Show when={lane() === "detail"}>
            <div class="flex flex-col gap-1.5">
              <span class="text-[12px] text-v2-text-text-base">分析类型</span>
              <SegmentedControlV2 value={kind()} onChange={(v) => v && setKind(v)}>
                <For each={SUMMARY_KINDS}>
                  {(k) => <SegmentedControlItemV2 value={k.value}>{k.label}</SegmentedControlItemV2>}
                </For>
              </SegmentedControlV2>
            </div>
          </Show>

          <div class="flex flex-wrap items-center gap-2">
            <TextInputV2
              class="w-[90px]"
              type="number"
              value={String(count())}
              onInput={(e) => setCount(Number(e.currentTarget.value))}
              title="窗口条数（10-200）"
            />
            <span class="text-[11px] text-v2-text-text-faint">窗口条数（10-200，默认 50）</span>
            <div class="ml-auto">
              <ButtonV2 size="small" variant="contrast" disabled={running()} onClick={trigger}>
                {running() ? "生成中…" : "生成总结"}
              </ButtonV2>
            </div>
          </div>
        </div>

        {/* 结果区 */}
        <div class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
          <div class="flex items-center gap-2">
            <span class="text-[12px] text-v2-text-text-base">结果</span>
            {statusTag()}
          </div>
          <Show when={status() === "done" && result()}>
            <div class="whitespace-pre-wrap rounded-[8px] bg-v2-background-bg-base p-3 text-[12px] leading-relaxed text-v2-text-text-base">
              {result()}
            </div>
          </Show>
          <Show when={status() === "error" && errMsg()}>
            <div class="rounded-[8px] bg-v2-background-bg-base p-3 text-[12px] text-v2-text-text-faint">
              {errMsg()}
            </div>
          </Show>
          <Show when={status() === "idle"}>
            <div class="text-[11px] leading-relaxed text-v2-text-text-faint">
              主题总结在聊天气泡中使用：每轮分析后气泡底部出现一句话短摘要，点击可打开详情看板（摘要 / 参与度 / 待办 / 资源 / 开放问题 / 时间线 / 决策）。
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

// ── 智能设置模式（mode="settings"） ────────────────────────────────────────
const SettingsTab: Component<{ refresh?: number }> = (props) => {
  const [settings, setSettings] = createSignal<IntelligenceSettingsDto | null>(null)
  const [status, setStatus] = createSignal<ModelStatusDto | null>(null)
  const [mode, setMode] = createSignal("off")
  const [source, setSource] = createSignal("local")
  const [modelTier, setModelTier] = createSignal("0.5b")
  const [windowN, setWindowN] = createSignal(50)
  const [baseUrl, setBaseUrl] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [model, setModel] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [testing, setTesting] = createSignal(false)
  const [testResult, setTestResult] = createSignal<{ ok: boolean; text: string } | null>(null)
  const [progress, setProgress] = createSignal<{ id: string; bytesDone: number; total: number; rate: number } | null>(null)

  const load = async () => {
    try {
      const s = await call<IntelligenceSettingsDto>("get_intelligence_settings")
      setSettings(s)
      setMode(s?.mode || "off")
      setSource(s?.source || "local")
      setModelTier(s?.model_tier || "0.5b")
      setWindowN(s?.window_n != null ? s.window_n : 50)
      setBaseUrl(s?.base_url || "")
      setApiKey(s?.api_key || "")
      setModel(s?.model || "")
    } catch {
      // 未接后端：保持默认
    }
    try {
      setStatus(await call<ModelStatusDto>("get_llm_model_status"))
    } catch {
      // 未接后端：保持 null
    }
  }

  createEffect(() => {
    props.refresh
    void load()
  })

  // download-progress 订阅（下载按钮触发后实时回传；面板卸载时退订）
  createEffect(() => {
    let un: (() => void) | undefined
    void listen<DownloadProgressPayload>("download-progress", (ev) => {
      setProgress(ev.payload as unknown as DownloadProgressPayload)
    }).then((fn) => {
      un = fn
    })
    onCleanup(() => un?.())
  })

  const startDownload = async (which: "engine" | "model") => {
    setProgress({ id: which, bytesDone: 0, total: 0, rate: 0 })
    try {
      await call("start_engine_download", { which })
      showToast({ title: which === "engine" ? "引擎下载完成" : "模型下载完成" })
      setStatus(await call<ModelStatusDto>("get_llm_model_status"))
    } catch (e) {
      showToast({ title: "下载失败", description: e instanceof Error ? e.message : String(e) })
    }
  }

  const testConn = async () => {
    if (testing()) return
    setTesting(true)
    setTestResult(null)
    try {
      const reply = await call<string>("test_llm_config", {
        config: {
          base_url: baseUrl().trim() || null,
          api_key: apiKey().trim() || null,
          model: model().trim() || null,
        },
      })
      setTestResult({ ok: true, text: `连接成功：${reply.slice(0, 60)}` })
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (saving()) return
    setSaving(true)
    const isApi = source() === "api"
    try {
      await call("set_intelligence_settings", {
        mode: mode(),
        source: source(),
        modelTier: modelTier(),
        windowN: windowN(),
        baseUrl: isApi ? baseUrl().trim() || null : null,
        apiKey: isApi ? apiKey().trim() || null : null,
        model: isApi ? model().trim() || null : null,
      })
      showToast({ title: "已保存" })
    } catch (e) {
      showToast({ title: "保存失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const modeLabel = () => (mode() === "llm" ? "LLM" : mode() === "wordfreq" ? "词频" : "关闭")
  const engineReady = () => !!status()?.engine_ready
  const modelReady = () => !!status()?.model_ready

  return (
    <div class="flex h-full min-h-0 flex-col overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[820px] flex-col gap-4 p-4">
        {/* 运行状态卡 */}
        <div class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
          <div class="text-[13px] font-medium text-v2-text-text-base">运行状态</div>
          <div class="flex flex-wrap items-center gap-1.5">
            <Tag variant="neutral">模式：{modeLabel()}</Tag>
            <Tag variant={engineReady() ? "accent" : "neutral"}>
              {engineReady() ? `引擎就绪${status()?.engine_version ? ` · v${status()!.engine_version}` : ""}` : "引擎未就绪"}
            </Tag>
            <Tag variant={modelReady() ? "accent" : "neutral"}>
              {modelReady()
                ? `模型就绪${status()?.model_sha256 ? ` · ${status()!.model_sha256!.slice(0, 8)}` : ""}`
                : "模型未就绪"}
            </Tag>
          </div>
        </div>

        {/* 本地模型下载 */}
        <Show when={mode() === "llm" && source() === "local"}>
          <div class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
            <div class="text-[13px] font-medium text-v2-text-text-base">本地模型下载</div>
            <div class="flex flex-wrap items-center gap-2">
              <ButtonV2
                size="small"
                variant="neutral"
                disabled={!!status()?.engine_ready}
                onClick={() => void startDownload("engine")}
              >
                {status()?.engine_ready ? "引擎已就绪" : "下载引擎"}
              </ButtonV2>
              <ButtonV2
                size="small"
                variant="neutral"
                disabled={!!status()?.model_ready}
                onClick={() => void startDownload("model")}
              >
                {status()?.model_ready ? "模型已就绪" : "下载模型"}
              </ButtonV2>
            </div>
            <Show when={progress()}>
              <div class="flex flex-col gap-1.5">
                <div class="h-1.5 overflow-hidden rounded bg-v2-background-bg-base">
                  <div
                    class="h-full bg-v2-background-bg-accent transition-[width] duration-200"
                    style={{
                      width: `${progress() && progress()!.total > 0 ? Math.min(100, Math.round((progress()!.bytesDone / progress()!.total) * 100)) : 0}%`,
                    }}
                  />
                </div>
                <div class="text-[11px] text-v2-text-text-faint">
                  {progress()!.id === "model" ? "模型" : "引擎"} {fmtBytes(progress()!.bytesDone)} /{" "}
                  {fmtBytes(progress()!.total)}
                  {progress()!.rate > 0 ? ` · ${fmtBytes(progress()!.rate)}/s` : ""}
                  {progress()!.total > 0
                    ? ` (${Math.min(100, Math.round((progress()!.bytesDone / progress()!.total) * 100))}%)`
                    : ""}
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* 表单 */}
        <div class="flex flex-col gap-4 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
          <div class="text-[13px] font-medium text-v2-text-text-base">智能设置</div>

          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-v2-text-text-base">智能模式</span>
            <SegmentedControlV2 value={mode()} onChange={(v) => v && setMode(v)}>
              <SegmentedControlItemV2 value="off">关闭</SegmentedControlItemV2>
              <SegmentedControlItemV2 value="wordfreq">词频</SegmentedControlItemV2>
              <SegmentedControlItemV2 value="llm">LLM</SegmentedControlItemV2>
            </SegmentedControlV2>
            <span class="text-[11px] text-v2-text-text-faint">关闭 = 不启用；词频 = 本地统计聚类；LLM = 大模型智能总结</span>
          </div>

          <Show when={mode() === "llm"}>
            <div class="flex flex-col gap-1.5">
              <span class="text-[12px] text-v2-text-text-base">模型来源</span>
              <SegmentedControlV2 value={source()} onChange={(v) => v && setSource(v)}>
                <SegmentedControlItemV2 value="local">本地模型</SegmentedControlItemV2>
                <SegmentedControlItemV2 value="api">API</SegmentedControlItemV2>
              </SegmentedControlV2>
            </div>

            <Show when={source() === "local"}>
              <div class="flex flex-col gap-1.5">
                <span class="text-[12px] text-v2-text-text-base">模型档位</span>
                <SegmentedControlV2 value={modelTier()} onChange={(v) => v && setModelTier(v)}>
                  <SegmentedControlItemV2 value="0.5b">0.5B</SegmentedControlItemV2>
                  <SegmentedControlItemV2 value="1.5b">1.5B</SegmentedControlItemV2>
                </SegmentedControlV2>
                <span class="text-[11px] text-v2-text-text-faint">Q4_K_M 量化，ModelScope 优先</span>
              </div>
            </Show>

            <Show when={source() === "api"}>
              <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-1.5">
                  <span class="text-[12px] text-v2-text-text-base">Base URL</span>
                  <TextInputV2
                    class="!w-full"
                    placeholder="https://api.openai.com/v1"
                    value={baseUrl()}
                    onInput={(e) => setBaseUrl(e.currentTarget.value)}
                  />
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class="text-[12px] text-v2-text-text-base">API Key</span>
                  <TextInputV2
                    class="!w-full"
                    type="password"
                    placeholder="API Key"
                    value={apiKey()}
                    onInput={(e) => setApiKey(e.currentTarget.value)}
                  />
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class="text-[12px] text-v2-text-text-base">模型</span>
                  <TextInputV2
                    class="!w-full"
                    placeholder="如 gpt-4o-mini"
                    value={model()}
                    onInput={(e) => setModel(e.currentTarget.value)}
                  />
                </div>
                <div class="flex items-center gap-2">
                  <ButtonV2 size="small" variant="neutral" disabled={testing()} onClick={testConn}>
                    {testing() ? "测试中…" : "测试连接"}
                  </ButtonV2>
                  <Show when={testResult()}>
                    <span
                      class="text-[11px]"
                      classList={{
                        "text-v2-state-fg-success": testResult()!.ok,
                        "text-v2-state-fg-danger": !testResult()!.ok,
                      }}
                    >
                      {testResult()!.text}
                    </span>
                  </Show>
                </div>
              </div>
            </Show>
          </Show>

          <Show when={mode() !== "off"}>
            <div class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between">
                <span class="text-[12px] text-v2-text-text-base">上下文条数</span>
                <span class="w-12 text-right text-[12px] text-v2-text-text-faint">{windowN()}</span>
              </div>
              <input
                type="range"
                min={10}
                max={200}
                value={windowN()}
                class="w-full accent-v2-background-bg-accent"
                onInput={(e) => setWindowN(Number(e.currentTarget.value))}
              />
              <span class="text-[11px] text-v2-text-text-faint">最近 N 条消息参与总结（10-200）</span>
            </div>
          </Show>

          <div class="flex justify-end">
            <ButtonV2 size="small" variant="contrast" disabled={saving()} onClick={save}>
              {saving() ? "保存中…" : "保存设置"}
            </ButtonV2>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 面板入口 ───────────────────────────────────────────────────────────────
export const SummaryPanel: Component<SummaryPanelProps> = (props) => {
  return (
    <Show when={props.mode === "summary"} fallback={<SettingsTab refresh={props.refresh} />}>
      <SummaryTab refresh={props.refresh} />
    </Show>
  )
}
