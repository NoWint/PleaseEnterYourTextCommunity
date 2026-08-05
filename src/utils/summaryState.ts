// 主题总结双车道状态机 + 上下文窗口序列化(spec §9 / §4.5.1)。
// 状态机纯前端维护,前端只收 summary-event 事件驱动(后端不碰 DOM);
// 上下文行由前端从 state.messages 截取交给后端,后端只管推理。
import type { DcEvent } from '../api.js';

export type BubbleStatus = 'idle' | 'summarizing' | 'done' | 'error' | 'fallback';

/** summary-event 事件负载(lane=bubble/detail,status 由后端决定)。 */
export interface SummaryEvent {
  chatId: number;
  lane: 'bubble' | 'detail';
  kind?: string;
  status: string;
  delta?: string;
  result?: string;
  error?: { code: string; message: string };
}

interface ChatSummary {
  status: BubbleStatus;
  text: string;
}

/**
 * 每聊天气泡状态存储。转移规则:
 * - idle→summarizing→done/error/fallback;
 * - done→summarizing:旧摘要保留(不传 text 即不清空),新结果回来再覆盖,不闪空;
 * - error→fallback 允许。
 */
export class SummaryStore {
  private map = new Map<number, ChatSummary>();

  get(chatId: number): ChatSummary | undefined {
    return this.map.get(chatId);
  }

  transition(chatId: number, status: BubbleStatus, text?: string): void {
    const cur = this.map.get(chatId);
    this.map.set(chatId, { status, text: text ?? cur?.text ?? '' });
  }

  clear(chatId: number): void {
    this.map.delete(chatId);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** unix 秒 → 'YYYY-MM-DD HH:MM'(本地时区;非法时间返回空串,调用方省略该段)。 */
export function fmtAbsTime(ts: unknown): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 组装 LLM 上下文行(spec §4.5.1):最近 windowN 条(排除 is_info 系统消息),
 * 每行 `[id=<msg_id>] <from_name> [YYYY-MM-DD HH:MM]: <text>`。
 * 信封消息经 resolveText 取 payload.text;text 空且有 file → `[附件: <file_name>]`;无文本跳过。
 */
export function buildContextLines(
  messages: any[],
  resolveText: (m: any) => string,
  windowN: number,
): string[] {
  if (!Array.isArray(messages)) return [];
  const lines: string[] = [];
  const recent = messages.filter((m) => m && !m.is_info).slice(-Math.max(0, windowN));
  for (const m of recent) {
    const text = resolveText ? String(resolveText(m) ?? '') : '';
    const content = text || (m.file ? `[附件: ${m.file_name || '附件'}]` : '');
    if (!content) continue;
    const time = fmtAbsTime(m.ts);
    lines.push(`[id=${m.msg_id}] ${m.from_name ?? '未知'}${time ? ` [${time}]` : ''}: ${content}`);
  }
  return lines;
}

/**
 * 包装 src/api.ts 事件桥:监听 summary-event 并按 SummaryEvent 形状回调,返回注销函数。
 * 事件桥是单一 dc-event 桥按 typ 分发(onEvent 机制),summary-event 的 payload
 * 直接携带 SummaryEvent 字段(chatId/lane/kind/status/delta/result/error)。
 */
export async function listenSummaryEvents(handler: (e: SummaryEvent) => void): Promise<() => void> {
  const { onEvent } = await import('../api.js');
  return onEvent('summary-event', (payload: DcEvent) => {
    handler(payload as unknown as SummaryEvent);
  });
}
