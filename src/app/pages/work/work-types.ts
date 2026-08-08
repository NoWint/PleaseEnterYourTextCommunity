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
  todo: "待办",
  in_progress: "进行中",
  done: "已完成",
}

export function typeLabel(type: CardType): string {
  return type === "task" ? "任务" : "卡片"
}

/** 本地日期 YYYY-MM-DD。 */
export function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** unix 秒 → 本地 YYYY-MM-DD（与 dateKey 一致，用本地 getters，避免 UTC 偏移一天）。 */
export function ymdFromTs(ts: number): string {
  return dateKey(new Date(ts * 1000))
}

/**
 * 本地 YYYY-MM-DD → unix 秒（本地午夜）。与 ymdFromTs 往返一致：
 * 按 YYYY-MM-DD 拆解用本地 Date 构造，避免字符串构造按 UTC 解析导致
 * 负时区（UTC-x）下往返偏移一天。
 */
export function tsFromYmd(ymd: string): number | null {
  if (!ymd) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!match) return null
  return Math.floor(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() / 1000)
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
 *
 * CJK 策略（确定性、可测试）：
 * 1. 整段连续串计 1 次（避免单字碎片）；
 * 2. 再取该串与其它标题共享的「最长公共前缀」（长度 ≥2 且非自身）计 1 次——
 *    多个标题共用的话术会被聚合为高频词（如「首页改版」），而非整标题散词。
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
  const hanRuns: string[] = []
  const scan = (text: string) => {
    const tokens = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    for (const raw of tokens) {
      if (/^[\p{Script=Han}]+$/u.test(raw)) {
        if (raw.length >= 2) hanRuns.push(raw)
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
  // 第二遍：整段 + 跨标题最长公共前缀（须在所有素材扫描完后计算）
  for (const run of hanRuns) {
    bump(run)
    let shared = ""
    for (const other of hanRuns) {
      if (other === run) continue
      let i = 0
      while (i < run.length && i < other.length && run[i] === other[i]) i++
      if (i >= 2 && i > shared.length) shared = run.slice(0, i)
    }
    if (shared && shared !== run) bump(shared)
  }
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
