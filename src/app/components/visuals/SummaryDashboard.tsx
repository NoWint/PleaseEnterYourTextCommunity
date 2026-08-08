// src/app/components/visuals/SummaryDashboard.tsx
// 工作区主题分析看板（Solid 组件版，从 src/components/summaryDashboard.ts 迁移渲染骨架）：
// 左侧玻璃导航（词云 + 分析类型目录），右侧单列内容区（各分析块）。
// 每个块独立「生成中… → 内容」状态 + 刷新 / 折叠。
//
// TODO(Task 4)：本地统计渲染已实现；LLM 流式（summary_enqueue + summary-event 事件
// 增量渲染）为接入占位，当前 refresh 走本地重算（0 token），接入时按块替换
// renderBody 的数据源即可。

import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { WorkIcon } from "../../pages/work/work-icons"
import { CloudSphere } from "./CloudSphere"
import type { CardDto, ActivityDto } from "../../../types"
import type { WordFreq } from "../../../utils/wordAnalysis"
import { STATUS_LABEL, activityMeta, activityTargetLabel, dateKey, isOverdue } from "../../pages/work/work-types"

export type AnalysisKind = "summary" | "participation" | "action_items" | "mood" | "open_questions" | "timeline" | "decisions"

interface AnalysisType {
  kind: AnalysisKind
  title: string
  icon: string
  priority: number
}

const ANALYSIS_TYPES: AnalysisType[] = [
  { kind: "summary", title: "总结", icon: "file-text", priority: 0 },
  { kind: "mood", title: "情绪氛围", icon: "smile", priority: 0 },
  { kind: "action_items", title: "行动项", icon: "check", priority: 0 },
  { kind: "participation", title: "参与度", icon: "users", priority: 0 },
  { kind: "open_questions", title: "悬而未决", icon: "info", priority: 1 },
  { kind: "timeline", title: "话题演变", icon: "clock", priority: 1 },
  { kind: "decisions", title: "决策", icon: "pin", priority: 2 },
]

export interface SummaryDashboardProps {
  words: WordFreq[]
  cards: CardDto[]
  activities: ActivityDto[]
  channelNames: string[]
}

// ── 本地统计渲染 ─────────────────────────────────────────

/** summary：工作区概览文本（markdown 风格的纯文本行）。 */
function renderSummaryText(cards: CardDto[], activities: ActivityDto[], channelCount: number): string {
  const todo = cards.filter((c) => c.status === "todo").length
  const doing = cards.filter((c) => c.status === "in_progress").length
  const done = cards.filter((c) => c.status === "done").length
  const overdue = cards.filter(isOverdue).length
  const today = activities.filter((a) => dateKey(new Date(a.created_at * 1000)) === dateKey(new Date())).length
  const lines = [
    `- 共 ${cards.length} 个卡片：待办 ${todo} · 进行中 ${doing} · 已完成 ${done}`,
    `- ${overdue} 个卡片已逾期，建议优先处理`,
    `- 活动流 ${activities.length} 条（今天 ${today} 条），覆盖 ${channelCount} 个协作频道`,
  ]
  return lines.join("\n")
}

/** action_items：todo/in_progress 卡片 → checkbox 列表，勾选态 localStorage 持久化。 */
function renderActionItems(cards: CardDto[], chatKey: string): string {
  const items = cards.filter((c) => c.status !== "done")
  const storeKey = (i: number) => `sd-action-done:${chatKey}:action_items:${i}`
  const doneCount = items.filter((_, i) => localStorage.getItem(storeKey(i)) === "1").length
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0
  const rows = items
    .map(
      (c, i) => `
      <div class="sd-item" data-action-i="${i}">
        <input type="checkbox" class="sd-check-input" data-action-i="${i}" ${localStorage.getItem(storeKey(i)) === "1" ? "checked" : ""} hidden>
        <span class="sd-checkbox"></span>
        <span class="sd-item-text">${escapeHtml(c.title)}</span>
        <span class="sd-item-meta">${STATUS_LABEL[c.status]}${c.due_date ? `<span class="sd-chip sd-chip-due">${new Date(c.due_date * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</span>` : ""}</span>
      </div>`,
    )
    .join("")
  return `<div class="sd-action-progress"><div class="sd-action-p-fill" style="width:${pct}%"></div><span>${doneCount}/${items.length}</span></div><div class="sd-list">${rows || '<div class="sd-empty">无行动项</div>'}</div>`
}

/** participation：按成员聚合活动 → 条带图。 */
function renderParticipation(activities: ActivityDto[]): string {
  const byActor = new Map<string, number>()
  for (const a of activities) byActor.set(a.actor_name, (byActor.get(a.actor_name) ?? 0) + 1)
  const rows = [...byActor.entries()].sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...rows.map(([, n]) => n))
  const members = rows
    .map(
      ([name, n]) => `<div class="sd-p-m-row"><span class="sd-p-name">${escapeHtml(name)}</span>
      <div class="sd-p-m-track"><div class="sd-p-m-fill" style="width:${(n / max) * 100}%"></div></div>
      <span class="sd-p-nums">${n} 条动态</span></div>`,
    )
    .join("")
  return `<div class="sd-p-members"><div class="sd-p-subtitle">成员活跃</div>${members || '<div class="sd-empty">暂无动态</div>'}</div>`
}

/** mood：由卡片完成率 + 逾期数估算的「氛围分」（启发式，LLM 接入后替换）。 */
function renderMood(cards: CardDto[], overdue: number): string {
  const total = cards.length
  const done = cards.filter((c) => c.status === "done").length
  const score = total ? Math.round((done / total) * 100) : 50
  const tone = score >= 66 ? "positive" : score >= 34 ? "neutral" : "negative"
  const emoji = overdue > 0 ? "😅" : tone === "positive" ? "😀" : tone === "negative" ? "😩" : "😐"
  const overall = tone === "positive" ? "积极" : tone === "negative" ? "消极" : "中立"
  return `<div class="sd-mood">
    <div class="sd-mood-top">
      <div class="sd-mood-emoji sd-mood-${tone}">${emoji}</div>
      <div class="sd-mood-meta">
        <span class="sd-mood-overall">${overall}</span>
        <div class="sd-mood-bar"><div class="sd-mood-bar-fill sd-mood-${tone}" style="width:${score}%"></div></div>
      </div>
    </div>
    <div class="sd-mood-summary">${overdue > 0 ? `有 ${overdue} 个逾期卡片，需尽快跟进。` : total ? `卡片完成率 ${score}%。` : "暂无卡片数据。"}</div>
  </div>`
}

/** open_questions：未指派 / 已逾期的卡片 = 悬而未决。 */
function renderOpenQuestions(cards: CardDto[]): string {
  const questions = cards.filter((c) => c.status !== "done" && (c.assignee_name == null || isOverdue(c)))
  const rows = questions
    .map((c) => {
      const due = c.due_date && isOverdue(c) ? `<span class="sd-chip sd-chip-due">已逾期</span>` : ""
      return `<div class="sd-item"><span class="sd-q-icon">?</span><span class="sd-item-text">${escapeHtml(c.title)}</span><span class="sd-item-meta">${due}${c.assignee_name ? "" : '<span class="sd-chip">待指派</span>'}</span></div>`
    })
    .join("")
  return `<div class="sd-list">${rows || '<div class="sd-empty">无悬而未决</div>'}</div>`
}

/** timeline：活动按天分组 → 垂直时间线。 */
function renderTimeline(activities: ActivityDto[], cards: CardDto[]): string {
  const byDay = new Map<string, ActivityDto[]>()
  for (const a of activities) {
    const key = dateKey(new Date(a.created_at * 1000))
    const arr = byDay.get(key) ?? []
    arr.push(a)
    byDay.set(key, arr)
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10)
  const nodes = days
    .map(
      ([day, acts]) => `<div class="sd-tl-node"><div class="sd-tl-dot"></div><div class="sd-tl-body">
        <div class="sd-tl-period">${escapeHtml(day)}</div>
        <div class="sd-tl-topic">${acts
          .slice(0, 4)
          .map((a) => `${activityMeta(a.action).label}「${escapeHtml(activityTargetLabel(a, cards))}」`)
          .join(" · ")}${acts.length > 4 ? ` 等 ${acts.length} 条` : ""}</div>
      </div></div>`,
    )
    .join("")
  return `<div class="sd-timeline">${nodes || '<div class="sd-empty">无话题演变</div>'}</div>`
}

/** decisions：已完成卡片 = 已拍板的决策。 */
function renderDecisions(cards: CardDto[]): string {
  const decisions = cards.filter((c) => c.status === "done")
  const items = decisions
    .map(
      (c) => `<div class="sd-dec"><span class="sd-dec-status sd-dec-done">✓</span><div class="sd-dec-head">
      <span class="sd-dec-title">${escapeHtml(c.title)}</span>${c.assignee_name ? `<span class="sd-chip">${escapeHtml(c.assignee_name)}</span>` : ""}</div>
      ${c.description ? `<div class="sd-dec-rationale">${escapeHtml(c.description)}</div>` : ""}</div>`,
    )
    .join("")
  return `<div class="sd-list">${items || '<div class="sd-empty">无决策</div>'}</div>`
}

function renderBody(kind: AnalysisKind, cards: CardDto[], activities: ActivityDto[], chatKey: string): string {
  switch (kind) {
    case "summary":
      return `<div class="sd-summary">${renderSummaryText(cards, activities, new Set(cards.map((c) => c.channel_chat_id)).size)}</div>`
    case "action_items":
      return renderActionItems(cards, chatKey)
    case "participation":
      return renderParticipation(activities)
    case "mood":
      return renderMood(cards, cards.filter(isOverdue).length)
    case "open_questions":
      return renderOpenQuestions(cards)
    case "timeline":
      return renderTimeline(activities, cards)
    case "decisions":
      return renderDecisions(cards)
  }
}

// 渲染为 innerHTML 的文本转义（块内容直接插 DOM 前需转义）
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export const SummaryDashboard: Component<SummaryDashboardProps> = (props) => {
  const chatKey = createMemo(() => `work-${props.channelNames.join("-").slice(0, 24)}`)
  // 每块：done 内容 HTML + collapsed
  const [bodies, setBodies] = createSignal<Record<string, string>>({})
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})

  const renderAll = () => {
    const next: Record<string, string> = {}
    for (const t of ANALYSIS_TYPES) {
      next[t.kind] = renderBody(t.kind, props.cards, props.activities, chatKey())
    }
    setBodies(next)
  }

  // 数据变化时重算所有块（本地统计，0 token；LLM 接入后替换为流式入队）
  createEffect(() => {
    void props.cards.length
    void props.activities.length
    renderAll()
  })

  const toggleCollapse = (kind: AnalysisKind) => {
    setCollapsed((draft) => ({ ...draft, [kind]: !draft[kind] }))
  }

  const refresh = (kind: AnalysisKind) => {
    setBodies((draft) => ({ ...draft, [kind]: renderBody(kind, props.cards, props.activities, chatKey()) }))
  }

  // 行动项勾选 → 点击条目切换（input 为隐藏元素不可点击，改由 .sd-item 委托触发）
  // → localStorage 持久化 + 进度条同步
  const onContentClick = (e: MouseEvent) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".sd-item")
    if (!item) return
    const input = item.querySelector<HTMLInputElement>(".sd-check-input")
    if (!input) return
    input.checked = !input.checked
    const i = input.dataset.actionI
    if (i == null) return
    localStorage.setItem(`sd-action-done:${chatKey()}:action_items:${i}`, input.checked ? "1" : "0")
    // 同步进度条
    const root = item.closest<HTMLElement>(".sd-body")
    if (!root) return
    const progress = root.querySelector<HTMLElement>(".sd-action-progress")
    const fill = root.querySelector<HTMLElement>(".sd-action-p-fill")
    if (!progress || !fill) return
    const boxes = root.querySelectorAll<HTMLInputElement>(".sd-check-input")
    const done = [...boxes].filter((b) => b.checked).length
    fill.style.width = `${boxes.length ? Math.round((done / boxes.length) * 100) : 0}%`
    const label = progress.querySelector("span")
    if (label) label.textContent = `${done}/${boxes.length}`
  }

  return (
    <div class="flex h-full min-h-0 w-full" data-component="summary-dashboard" onClick={onContentClick}>
      {/* 左侧玻璃导航 */}
      <div class="flex w-[200px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-v2-border-border-weak-base bg-v2-background-bg-deep p-3">
        <div class="px-1 text-[13px] font-semibold text-v2-text-text-base">工作区主题分析</div>
        <CloudSphere words={props.words} class="size-[160px] self-center" />
        <div class="flex flex-col gap-0.5">
          <For each={ANALYSIS_TYPES}>
            {(t) => (
              <button
                type="button"
                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-raised hover:text-v2-text-text-base"
                onClick={() => document.querySelector(`[data-body="${t.kind}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                <WorkIcon name={t.icon} size={15} />
                <span>{t.title}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* 右侧内容区 */}
      <div class="min-w-0 flex-1 overflow-y-auto">
        <For each={ANALYSIS_TYPES}>
          {(t) => (
            <section class="sd-block" data-kind={t.kind}>
              <div class="sd-block-head">
                <span class="sd-block-title">
                  <WorkIcon name={t.icon} size={15} />
                  {t.title}
                </span>
                <span class="sd-block-actions">
                  <button type="button" class="sd-refresh" title="刷新" onClick={() => refresh(t.kind)}>
                    <WorkIcon name="refresh-cw" size={13} />
                  </button>
                  <button type="button" class="sd-collapse" title="折叠" onClick={() => toggleCollapse(t.kind)}>
                    <WorkIcon name="chevron-down" size={13} />
                  </button>
                </span>
              </div>
              <Show when={!collapsed()[t.kind]}>
                <div class="sd-body" data-body={t.kind} innerHTML={bodies()[t.kind] ?? '<span class="sd-streaming">生成中…</span>'} />
              </Show>
            </section>
          )}
        </For>
      </div>
    </div>
  )
}

export default SummaryDashboard
