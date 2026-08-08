// src/app/pages/intelligence/types.ts
// 智能中心页类型：后端 DTO（snake_case 响应）+ 事件载荷 + 静态命令注册表。

/** 知识条目（knowledge 表；chat_name 联查，不存在时为空串）。 */
export interface KnowledgeDto {
  id: number
  chat_id: number
  chat_name: string
  date: string
  title: string
  summary: string
  tags: string[]
  msg_count: number
  source: string // 'manual' | 'daily'
  created_at: number
  updated_at: number
}

/** 每会话自动总结配置。 */
export interface KnowledgeConfigDto {
  chat_id: number
  chat_name: string
  daily_enabled: boolean
  daily_time: string
  window_count: number
  auto_store: boolean
}

/** 智能设置（主题总结与知识库共用一份）。 */
export interface IntelligenceSettingsDto {
  mode: string // 'off' | 'wordfreq' | 'llm'
  source: string // 'local' | 'api'
  model_tier: string // '0.5b' | '1.5b'
  window_n: number
  base_url?: string | null
  api_key?: string | null
  model?: string | null
}

/** 引擎/模型运行状态。 */
export interface ModelStatusDto {
  mode: string
  source: string
  engine_ready: boolean
  model_ready: boolean
  engine_path?: string | null
  model_path?: string | null
  engine_version?: string | null
  model_sha256?: string | null
}

/** summary-event 载荷。
 * 后端两条路径 emit 同一事件名：
 * - `summary/queue.rs`（summary_enqueue 流式队列）：streaming 增量 + done + error
 * - `intelligence/queue.rs`（enqueue_summary）：仅 done + error（非流式）
 * 两处字段一致：{chatId, lane, kind, status, delta?/result?/error?}。
 */
export interface SummaryEventPayload {
  chatId: number
  lane: string // 'bubble' | 'detail'
  kind?: string | null
  status: "streaming" | "done" | "error"
  /** status=streaming 时携带的增量文本。 */
  delta?: string
  /** status=done 时的最终结果全文。 */
  result?: string
  error?: { code: string; message?: string }
}

/** download-progress 载荷（两个 emit 路径字段不同，统一可选 + 归一化）：
 * - `intelligence/download.rs`（start_engine_download）：{id, bytesDone, total, rate}
 * - `summary/downloader.rs` / `summary/commands.rs`（summary_download）：{what, status, bytes, total, rate} / {status, message}
 */
export interface DownloadProgressPayload {
  id?: string
  bytesDone?: number
  total?: number
  rate?: number
  what?: string
  status?: string
  bytes?: number
  sha256?: string
  message?: string
}

/** 页内 Tab（与 legacy state.intelligenceTab 对应；持久化到 localStorage）。 */
export type IntelligenceTab = "knowledge" | "summary" | "config" | "settings" | "commands"

/** 静态命令注册表条目（后端无 list_commands，展示文档化清单）。 */
export interface CommandSpec {
  name: string
  scope: "Bot" | "用户" | "双方"
  description: string
  example: string
}
