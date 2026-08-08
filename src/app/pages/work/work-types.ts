// src/app/pages/work/work-types.ts
// 工作页共享类型与格式化工具（从 src/work/ 旧 vanilla 实现迁移的纯逻辑部分）。
// 文案全部中文（用户可见），状态标签沿用 legacy 的 Todo/Doing/Done。

import type { CardDto, CardStatus, CardType } from "../../../types"
import type { WordFreq } from "../../../utils/wordAnalysis"

export type WorkView = "kanban" | "list" | "calendar" | "timeline"

export const VIEW_OPTIONS: ReadonlyArray<{ value: WorkView; label: string; icon: string }> = [
  { value: "kanban", label: "看板", icon: "columns" },
  { value: "list", label: "列表", icon: "list" },
  { value: "calendar", label: "日历", icon: "calendar" },
  { value: "timeline", label: "时间线", icon: "timeline" },
]

export const STATUS_ORDER: ReadonlyArray<CardStatus> = ["todo", "in_progress", "done"]

export const STATUS_LABEL: Record<CardStatus, string> = {
  todo: "Todo",
  in_progress: "Doing",
  done: "Done",
}

export function typeLabel(type: CardType): string {
  return type === "task" ? "Task" : "Card"
}

/** 本地日期 YYYY-MM-DD。 */
export function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function isOverdue(c: CardDto): boolean {
  return c.due_date != null && c.due_date < Date.now() / 1000 && c.status !== "done"
}

/** 截止日期短标签：M月D日。 */
export function dueLabel(c: CardDto): string {
  return c.due_date ? new Date(c.due_date * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : ""
}

/** 相对时间（活动流/时间线用）：刚刚 / x 分钟前 / x 小时前 / x 天前 / M月D日。 */
export function formatRelativeTs(ts: number): string {
  const now = Date.now() / 1000
  const diff = now - ts
  if (diff < 60) return "刚刚"
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

export interface ActivityMeta {
  icon: string
  label: string
}

const ACTION_META: Record<string, ActivityMeta> = {
  card_created: { icon: "plus", label: "创建了卡片" },
  card_updated: { icon: "edit", label: "更新了卡片" },
  card_deleted: { icon: "trash", label: "删除了卡片" },
  card_status_changed: { icon: "check", label: "变更了卡片状态" },
  channel_created: { icon: "hash", label: "创建了频道" },
  message_pinned: { icon: "pin", label: "置顶了消息" },
}

/** 活动流条目：动作文案 + 图标。 */
export function activityMeta(action: string): ActivityMeta {
  return ACTION_META[action] ?? { icon: "info", label: action }
}

/** 活动目标标题：优先 payload.title/name，其次按 target_id 从卡片列表反查。 */
export function activityTargetLabel(activity: { target_type: string; target_id: number; payload: string | null }, cards: CardDto[]): string {
  if (activity.payload) {
    try {
      const p = JSON.parse(activity.payload) as { title?: string; name?: string }
      if (p.title || p.name) return p.title || p.name || ""
    } catch {
      /* 忽略解析失败 */
    }
  }
  if (activity.target_type === "card") {
    const card = cards.find((c) => c.id === activity.target_id)
    if (card) return card.title
  }
  return activity.target_id.toString()
}

/**
 * 从工作区素材（卡片标题 + 频道名 + 会话标题）提取词频。
 * 迁移自 legacy 会话主题分析：此处用确定性轻量分词（CJK 连续串 / 字母数字词），
 * 不依赖 jieba-wasm（工作页离线可渲染）。
 */
export function deriveWorkWords(
  cards: CardDto[],
  channelNames: string[],
  sessionTitles: string[],
  limit = 16,
): WordFreq[] {
  const count = new Map<string, number>()
  const bump = (word: string) => {
    if (word.length < 2) return
    count.set(word, (count.get(word) ?? 0) + 1)
  }
  const scan = (text: string) => {
    const tokens = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    for (const raw of tokens) {
      // CJK：连续串整体作为词（避免单字碎片）；否则 ≥3 字母的词
      if (/^[\p{Script=Han}]+$/u.test(raw)) {
        if (raw.length >= 2) bump(raw)
      } else if (raw.length >= 3 && !/^\d+$/.test(raw)) {
        bump(raw.toLowerCase())
      }
    }
  }
  for (const c of cards) {
    scan(c.title)
    if (c.assignee_name) scan(c.assignee_name)
  }
  for (const name of channelNames) scan(name)
  for (const title of sessionTitles) scan(title)
  const entries = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  if (entries.length === 0) return []
  const max = entries[0][1] || 1
  return entries.map(([word, n]) => ({ word, count: n, weight: n / max }))
}

/** 工作区主题簇（summaryBubble 降级显示用）：取 Top 词拼短语。 */
export function deriveWorkClusters(words: WordFreq[], clusterCount = 3): Array<{ words: string[]; score: number; wordFreqs: WordFreq[] }> {
  if (words.length === 0) return []
  const clusters: Array<{ words: string[]; score: number; wordFreqs: WordFreq[] }> = []
  const per = Math.ceil(words.length / clusterCount)
  for (let i = 0; i < words.length && clusters.length < clusterCount; i += per) {
    const slice = words.slice(i, i + per)
    clusters.push({
      words: slice.map((w) => w.word),
      score: slice.reduce((s, w) => s + w.weight, 0),
      wordFreqs: slice,
    })
  }
  return clusters
}
