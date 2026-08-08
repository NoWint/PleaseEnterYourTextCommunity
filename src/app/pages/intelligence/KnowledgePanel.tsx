// src/app/pages/intelligence/KnowledgePanel.tsx
// 知识库面板（mode="library"：条目列表 + 过滤 + 总结本会话入库 + 编辑/删除对话框；
// mode="config"：每会话自动总结配置）。数据走现有 invoke 命令，不新增后端命令。

import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { call } from "../../../api"
import { showToast } from "../../utils/toast"
import type { KnowledgeConfigDto, KnowledgeDto } from "./types"

export interface KnowledgePanelProps {
  mode: "library" | "config"
  /** 父级刷新计数：变化时重载数据。 */
  refresh?: number
}

// 刷新图标（inline SVG，同 WorkPage 风格）
const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
    <path d="M21.448 13C20.9483 17.7767 16.909 21.5 12 21.5C8.18227 21.5 4.89052 19.248 3.38065 16M2.5 20.5V15.5H5.5M2.55176 11C3.05145 6.22334 7.09079 2.5 11.9998 2.5C15.8175 2.5 19.1092 4.75197 20.6191 8M21.4998 3.5V8.5H18.4998" />
  </svg>
)

// 标签解析：中文/英文逗号 + 顿号分隔，去空白去重
function parseTags(raw: string): string[] {
  return [...new Set(raw.split(/[,，、]/).map((t) => t.trim()).filter(Boolean))]
}

function sourceLabel(source: string): string {
  return source === "daily" ? "每日自动" : "手动"
}

// ── 知识条目编辑对话框（dialog-v2；保存 update_knowledge / 删除 delete_knowledge） ──
interface KnowledgeEditDialogProps {
  entry: KnowledgeDto
  onChanged: () => void
}

const KnowledgeEditDialog: Component<KnowledgeEditDialogProps> = (props) => {
  const dialog = useDialog()
  const [title, setTitle] = createSignal(props.entry.title)
  const [summary, setSummary] = createSignal(props.entry.summary)
  const [tags, setTags] = createSignal((props.entry.tags ?? []).join(", "))
  const [saving, setSaving] = createSignal(false)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)

  const save = async () => {
    if (saving()) return
    if (!title().trim()) {
      showToast({ title: "标题不能为空" })
      return
    }
    setSaving(true)
    try {
      await call("update_knowledge", {
        id: props.entry.id,
        title: title().trim(),
        summary: summary().trim(),
        tags: parseTags(tags()),
      })
      showToast({ title: "已保存" })
      props.onChanged()
      dialog.close()
    } catch (e) {
      showToast({ title: "保存失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (confirmingDelete()) {
      setSaving(true)
      try {
        await call("delete_knowledge", { id: props.entry.id })
        showToast({ title: "已删除" })
        props.onChanged()
        dialog.close()
      } catch (e) {
        showToast({ title: "删除失败", description: e instanceof Error ? e.message : String(e) })
      } finally {
        setSaving(false)
      }
      return
    }
    setConfirmingDelete(true)
    setTimeout(() => setConfirmingDelete(false), 3000)
  }

  return (
    <Dialog size="normal">
      <DialogHeader>
        <DialogTitle>知识条目</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full flex-col gap-5 px-4 py-4">
        <div class="flex flex-col gap-1.5">
          <span class="text-[12px] text-v2-text-text-faint">
            {props.entry.chat_name || `会话 #${props.entry.chat_id}`} · {props.entry.date} ·{" "}
            {props.entry.msg_count} 条消息 · {sourceLabel(props.entry.source)}入库
          </span>
        </div>
        <Field>
          <Field.Label>标题</Field.Label>
          <TextInputV2
            autofocus
            class="!w-full"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </Field>
        <Field>
          <Field.Label>摘要</Field.Label>
          <TextareaV2
            class="!w-full"
            rows={8}
            value={summary()}
            onInput={(e) => setSummary(e.currentTarget.value)}
          />
        </Field>
        <Field>
          <Field.Label>标签</Field.Label>
          <TextInputV2
            class="!w-full"
            placeholder="多个标签用逗号分隔"
            value={tags()}
            onInput={(e) => setTags(e.currentTarget.value)}
          />
        </Field>
      </DialogBody>
      <DividerV2 />
      <DialogFooter>
        <div class="flex items-center justify-between px-4 py-3">
          <ButtonV2
            size="small"
            variant="danger"
            disabled={saving()}
            onClick={remove}
            classList={{ "bg-v2-state-bg-danger": confirmingDelete() }}
          >
            {confirmingDelete() ? "确认删除？" : "删除"}
          </ButtonV2>
          <div class="flex items-center gap-2">
            <ButtonV2 size="small" variant="neutral" onClick={() => dialog.close()} disabled={saving()}>
              取消
            </ButtonV2>
            <ButtonV2 size="small" variant="contrast" onClick={save} disabled={saving()}>
              {saving() ? "保存中…" : "保存"}
            </ButtonV2>
          </div>
        </div>
      </DialogFooter>
    </Dialog>
  )
}

// ── 知识库面板 ─────────────────────────────────────────────────────────────
export const KnowledgePanel: Component<KnowledgePanelProps> = (props) => {
  const dialog = useDialog()
  const [entries, setEntries] = createSignal<KnowledgeDto[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [chatId, setChatId] = createSignal(0)
  const [tagFilter, setTagFilter] = createSignal("")
  const [keyword, setKeyword] = createSignal("")
  const [summarizing, setSummarizing] = createSignal(false)
  const [sumChatId, setSumChatId] = createSignal(0)
  const [sumCount, setSumCount] = createSignal(30)
  const [configs, setConfigs] = createSignal<KnowledgeConfigDto[]>([])
  const [configLoading, setConfigLoading] = createSignal(true)
  const [configError, setConfigError] = createSignal<string | null>(null)

  const load = async () => {
    if (props.mode === "config") {
      setConfigLoading(true)
      setConfigError(null)
      try {
        setConfigs(await call<KnowledgeConfigDto[]>("list_knowledge_config"))
      } catch (e) {
        setConfigError(e instanceof Error ? e.message : String(e))
      } finally {
        setConfigLoading(false)
      }
      return
    }
    setLoading(true)
    setError(null)
    try {
      const list = await call<KnowledgeDto[]>("list_knowledge", { page: 1, pageSize: 200 })
      setEntries(list)
      // 总结入库卡片默认选中第一个有条目的会话
      if (!sumChatId() && list.length > 0) setSumChatId(list[0].chat_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    props.refresh
    void load()
  })

  // 会话选项（从条目提取 chat_id/chat_name 去重；供过滤 + 总结入库共用）
  const chatOptions = createMemo(() => {
    const map = new Map<number, string>()
    for (const k of entries()) {
      if (!map.has(k.chat_id)) map.set(k.chat_id, k.chat_name || `会话 #${k.chat_id}`)
    }
    return [...map.entries()].map(([id, name]) => ({ value: String(id), label: name }))
  })

  const filtered = createMemo(() => {
    const kw = keyword().trim().toLowerCase()
    const tg = tagFilter().trim()
    return entries().filter((k) => {
      if (chatId() && k.chat_id !== chatId()) return false
      if (tg && !(k.tags ?? []).some((t) => t.includes(tg))) return false
      if (kw && !k.title.toLowerCase().includes(kw) && !k.summary.toLowerCase().includes(kw)) return false
      return true
    })
  })

  const openEdit = (entry: KnowledgeDto) => {
    dialog.show(() => <KnowledgeEditDialog entry={entry} onChanged={() => void load()} />)
  }

  const summarizeNow = async () => {
    if (summarizing()) return
    const cid = sumChatId()
    if (!cid) {
      showToast({ title: "请先选择会话" })
      return
    }
    const n = Math.max(1, Math.min(200, sumCount() || 30))
    setSummarizing(true)
    try {
      const k = await call<KnowledgeDto>("summarize_store_now", { chatId: cid, count: n })
      showToast({ title: `已入库：${k.title}` })
      void load()
    } catch (e) {
      showToast({ title: "总结失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSummarizing(false)
    }
  }

  // ── 自动总结配置模式 ───────────────────────────────────────────────────
  if (props.mode === "config") {
    return (
      <div class="flex h-full min-h-0 flex-col">
        <Show when={configError()}>
          <div class="m-6 flex flex-1 items-center justify-center rounded-[10px] bg-v2-background-bg-base">
            <span class="text-xs text-v2-text-text-faint">{configError()}</span>
          </div>
        </Show>
        <Show when={!configError() && configLoading()}>
          <div class="m-6 flex flex-1 items-center justify-center rounded-[10px] bg-v2-background-bg-base">
            <span class="text-xs text-v2-text-text-faint">加载中…</span>
          </div>
        </Show>
        <Show when={!configError() && !configLoading()}>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <Show
              when={configs().length > 0}
              fallback={
                <div class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-6">
                  <div class="text-[13px] font-medium text-v2-text-text-base">暂无可配置会话</div>
                  <div class="text-[12px] leading-relaxed text-v2-text-text-faint">
                    先在知识库 Tab 或聊天中使用 /summarize 后配置。每个会话可独立设置每日自动总结：开关 / 触发时间 / 窗口条数 / 是否自动入库。
                  </div>
                  <div>
                    <ButtonV2 size="small" variant="neutral" onClick={() => void load()}>
                      刷新
                    </ButtonV2>
                  </div>
                </div>
              }
            >
              <div class="mx-auto flex max-w-[820px] flex-col gap-3">
                <For each={configs()}>
                  {(cfg) => <ConfigCard cfg={cfg} onSaved={() => void load()} />}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    )
  }

  // ── 知识库模式 ─────────────────────────────────────────────────────────
  return (
    <div class="flex h-full min-h-0 flex-col">
      {/* 工具条：会话过滤 + 标签过滤 + 搜索 + 刷新 */}
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-v2-border-border-muted px-4 py-3">
        <SelectV2
          appearance="base"
          placeholder="全部会话"
          options={[{ value: "0", label: "全部会话" }, ...chatOptions()]}
          value={(o) => o.value}
          label={(o) => o.label}
          current={chatOptions().some((o) => Number(o.value) === chatId()) ? chatOptions().find((o) => Number(o.value) === chatId())! : { value: "0", label: "全部会话" }}
          onSelect={(o) => setChatId(o ? Number(o.value) : 0)}
          class="w-[150px]"
        />
        <TextInputV2
          class="w-[130px]"
          placeholder="标签过滤"
          showClearButton
          value={tagFilter()}
          onInput={(e) => setTagFilter(e.currentTarget.value)}
          onClearClick={() => setTagFilter("")}
        />
        <TextInputV2
          class="w-[150px]"
          placeholder="搜索标题/摘要"
          showClearButton
          value={keyword()}
          onInput={(e) => setKeyword(e.currentTarget.value)}
          onClearClick={() => setKeyword("")}
        />
        <IconButtonV2 size="small" variant="ghost-muted" title="刷新" onClick={() => void load()} icon={<RefreshIcon />} />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <Show when={error()}>
          <div class="flex flex-1 items-center justify-center py-16">
            <span class="text-xs text-v2-text-text-faint">{error()}</span>
          </div>
        </Show>
        <Show when={!error() && loading()}>
          <div class="flex flex-1 items-center justify-center py-16">
            <span class="text-xs text-v2-text-text-faint">加载中…</span>
          </div>
        </Show>
        <Show when={!error() && !loading()}>
          <div class="mx-auto flex max-w-[860px] flex-col gap-3">
            {/* 总结本会话入库 */}
            <Show when={chatOptions().length > 0}>
              <div class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
                <div class="text-[13px] font-medium text-v2-text-text-base">总结本会话入库</div>
                <div class="flex flex-wrap items-center gap-2">
                  <SelectV2
                    appearance="base"
                    placeholder="选择会话"
                    options={chatOptions()}
                    value={(o) => o.value}
                    label={(o) => o.label}
                    current={chatOptions().find((o) => Number(o.value) === sumChatId())}
                    onSelect={(o) => setSumChatId(o ? Number(o.value) : 0)}
                    class="w-[220px]"
                  />
                  <TextInputV2
                    class="w-[80px]"
                    type="number"
                    value={String(sumCount())}
                    onInput={(e) => setSumCount(Number(e.currentTarget.value))}
                    title="条数（1-200）"
                  />
                  <ButtonV2
                    size="small"
                    variant="contrast"
                    disabled={summarizing()}
                    onClick={summarizeNow}
                  >
                    {summarizing() ? "总结中…" : "立即总结入库"}
                  </ButtonV2>
                </div>
                <div class="text-[11px] text-v2-text-text-faint">
                  窗口条数 1-200（默认 30）；入库条目按会话 + 日期去重，同日再次总结会替换。
                </div>
              </div>
            </Show>

            {/* 条目列表 */}
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="rounded-[10px] bg-v2-background-bg-layer-01 p-6 text-center text-[12px] text-v2-text-text-faint">
                  {entries().length === 0
                    ? "暂无知识条目，可用「总结本会话入库」或聊天中 /summarize 存入"
                    : "无匹配条目"}
                </div>
              }
            >
              <For each={filtered()}>
                {(k) => (
                  <div
                    role="button"
                    tabindex={0}
                    class="cursor-pointer rounded-[10px] bg-v2-background-bg-layer-01 p-4 transition-colors hover:bg-v2-background-bg-base"
                    onClick={() => openEdit(k)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        openEdit(k)
                      }
                    }}
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 text-[13px] font-medium text-v2-text-text-base">{k.title}</div>
                      <div class="flex shrink-0 items-center gap-1.5">
                        <Tag variant={k.source === "daily" ? "accent" : "neutral"}>{sourceLabel(k.source)}</Tag>
                        <Tag variant="neutral">{k.msg_count} 条</Tag>
                      </div>
                    </div>
                    <div class="mt-1 text-[11px] text-v2-text-text-faint">
                      {k.chat_name || `会话 #${k.chat_id}`} · {k.date}
                    </div>
                    <Show when={(k.tags ?? []).length > 0}>
                      <div class="mt-2 flex flex-wrap gap-1.5">
                        <For each={k.tags ?? []}>
                          {(t) => <Tag variant="neutral">{t}</Tag>}
                        </For>
                      </div>
                    </Show>
                    <Show when={k.summary}>
                      <div class="mt-2 text-[12px] leading-relaxed text-v2-text-text-faint">
                        {k.summary.length > 160 ? k.summary.slice(0, 160) + "…" : k.summary}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ── 每会话自动总结配置卡片 ────────────────────────────────────────────────
interface ConfigCardProps {
  cfg: KnowledgeConfigDto
  onSaved: () => void
}

const ConfigCard: Component<ConfigCardProps> = (props) => {
  const [enabled, setEnabled] = createSignal(!!props.cfg.daily_enabled)
  const [time, setTime] = createSignal(props.cfg.daily_time || "00:00")
  const [windowCount, setWindowCount] = createSignal(props.cfg.window_count || 100)
  const [autoStore, setAutoStore] = createSignal(!!props.cfg.auto_store)
  const [saving, setSaving] = createSignal(false)

  const save = async () => {
    if (saving()) return
    setSaving(true)
    try {
      await call("set_knowledge_config", {
        chatId: props.cfg.chat_id,
        dailyEnabled: enabled(),
        dailyTime: time() || "00:00",
        windowCount: windowCount(),
        autoStore: autoStore(),
      })
      showToast({ title: "已保存" })
      props.onSaved()
    } catch (e) {
      showToast({ title: "保存失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex flex-col gap-4 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
      <div class="text-[13px] font-medium text-v2-text-text-base">
        {props.cfg.chat_name || `会话 #${props.cfg.chat_id}`}
      </div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-[12px] text-v2-text-text-base">每日自动总结</span>
          <span class="text-[11px] text-v2-text-text-faint">每天到点自动总结本会话并入库</span>
        </div>
        <Switch checked={enabled()} onChange={(v) => setEnabled(v)} aria-label="每日自动总结" />
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-[12px] text-v2-text-text-base">触发时间</span>
        <TextInputV2 class="w-[140px]" type="time" value={time()} onInput={(e) => setTime(e.currentTarget.value)} />
      </div>

      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[12px] text-v2-text-text-base">窗口条数</span>
          <span class="w-12 text-right text-[12px] text-v2-text-text-faint">{windowCount()}</span>
        </div>
        <input
          type="range"
          min={10}
          max={200}
          value={windowCount()}
          class="w-full accent-v2-background-bg-accent"
          onInput={(e) => setWindowCount(Number(e.currentTarget.value))}
        />
        <span class="text-[11px] text-v2-text-text-faint">最近 N 条消息参与总结（10-200）</span>
      </div>

      <div class="flex items-center justify-between gap-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-[12px] text-v2-text-text-base">自动入库</span>
          <span class="text-[11px] text-v2-text-text-faint">总结结果同时写入知识库（关闭则仅回复摘要）</span>
        </div>
        <Switch checked={autoStore()} onChange={(v) => setAutoStore(v)} aria-label="自动入库" />
      </div>

      <div class="flex justify-end">
        <ButtonV2 size="small" variant="contrast" disabled={saving()} onClick={save}>
          {saving() ? "保存中…" : "保存"}
        </ButtonV2>
      </div>
    </div>
  )
}
