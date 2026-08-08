// src/app/pages/bots/types.ts
// Bot 管理中心类型定义（与 src-tauri/src/dto.rs 字段一一对应）。

export interface BotDto {
  id: number
  bot_account_id: number
  display_name: string
  addr: string | null
  io_running: boolean
  created_at: number
}

export interface LlmConfig {
  system_prompt?: string | null
  base_url?: string | null
  api_key?: string | null
  model?: string | null
  provider?: string | null
  temperature?: number
  max_tokens?: number | null
  top_p?: number | null
  timeout_secs?: number
  max_retries?: number
}

export interface BotLimits {
  max_concurrent?: number
  reply_min_interval_secs?: number
  allow_bot_interaction?: boolean
  interaction_max_rounds?: number
}

export interface RuleDef {
  id: number
  pattern: string
  is_regex: boolean
  replies: string[]
  enabled: boolean
}

export interface RuleConfig {
  rules: RuleDef[]
  welcome?: string | null
  fallback?: string | null
}

export interface ProjectContext {
  workspace_id?: number | null
  chat_ids: number[]
  description?: string | null
  repo_path?: string | null
  repo_local_path?: string | null
  sandbox_mode?: string | null
  github_token?: string | null
}

export interface BotConfig {
  llm?: LlmConfig | null
  limits?: BotLimits
  tools?: string[] | null
  rule?: RuleConfig | null
  persona?: string | null
  project_context?: ProjectContext | null
}

export interface ScheduleDto {
  id: number
  bot_id: number
  chat_id: number
  minute: number
  hour: number
  day_of_week: number
  message: string
  enabled: boolean
  next_run_at: number
}

export interface BotStatsDto {
  total_activities: number
  reply_sent: number
  rule_reply: number
  schedule_sent: number
  tool_called: number
  llm_error: number
  rate_limited: number
  last_activity_at?: number | null
  first_seen_at?: number | null
}

export interface BotActivityDto {
  id: number
  bot_id: number
  kind: string
  chat_id?: number | null
  msg_id?: number | null
  summary: string
  detail_json?: string | null
  created_at: number
}

export interface BotToolDto {
  name: string
  description: string
  safe: boolean
}

export interface PersonaDto {
  id: string
  name: string
  description: string
}

export type DetailTab = "config" | "schedule" | "persona" | "tools" | "timeline" | "stats"

export const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "config", label: "配置" },
  { id: "schedule", label: "定时" },
  { id: "persona", label: "人设" },
  { id: "tools", label: "工具" },
  { id: "timeline", label: "时间线" },
  { id: "stats", label: "统计" },
]

export const PROVIDERS: Array<{ value: string; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "openai-compatible", label: "OpenAI 兼容" },
]

export const LLM_PRESETS: Array<{ value: string; label: string }> = [
  { value: "https://api.openai.com/v1", label: "OpenAI" },
  { value: "https://api.deepseek.com", label: "DeepSeek" },
  { value: "http://localhost:11434/v1", label: "Ollama" },
  { value: "__custom__", label: "自定义" },
]

export const KIND_LABELS: Record<string, string> = {
  reply_sent: "自动回复",
  reply_skipped: "跳过回复",
  reply_rate_limited: "被限流",
  llm_error: "LLM 错误",
  no_config: "未配置 LLM",
  driver_disabled: "驱动停用",
  thinking: "思考中",
  tool_called: "工具调用",
  schedule_sent: "定时消息",
  rule_reply: "规则回复",
}

export type ActivityVariant = "default" | "success" | "danger" | "muted"

export function kindVariant(kind: string): ActivityVariant {
  if (kind === "reply_sent" || kind === "rule_reply" || kind === "tool_called" || kind === "schedule_sent")
    return "success"
  if (kind === "llm_error" || kind === "reply_rate_limited") return "danger"
  if (kind === "thinking") return "default"
  return "muted"
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

export function cronLabel(minute: number, hour: number, dow: number): string {
  const m = minute < 0 ? "*" : String(minute).padStart(2, "0")
  const h = hour < 0 ? "*" : String(hour).padStart(2, "0")
  const d = dow < 0 ? "*" : `周${["日", "一", "二", "三", "四", "五", "六"][dow] ?? dow}`
  return `${m}:${h} ${d} UTC`
}

export function isLlmConfigured(cfg: LlmConfig | null | undefined): boolean {
  return !!cfg && !!cfg.base_url && !!cfg.api_key && !!cfg.model
}

export function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
