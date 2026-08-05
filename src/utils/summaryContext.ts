// 主题总结上下文窗口:把已加载消息还原成供 LLM 的行(只传 text + id,附件隔离)。
// 每行 [id=<msg_id>] <sender> [绝对时间]: <文本> —— 时间供时序/间隔/活跃时段分析。
import type { MsgDto } from '../types.js';

export interface WindowMsg {
  id: number;       // 锚点 = msg_id(数字), 本地锚非可移植标识
  sender: string;   // from_name
  text: string;     // 已还原正文;附件消息为 '[附件: <file_name>]'
  ts: number;       // unix 秒, 格式化用
}

export const CONTEXT_CHAR_LIMIT = 4000; // 字数硬上限, 不随 N 联动(默认 N=50 在 summaryPrefs.ts)

/** 还原单条消息为 WindowMsg。is_info 跳过返回 null;信封经 resolve 还原;附件只留文件名。 */
function toWindowMsg(m: MsgDto, resolve: (text: string) => string): WindowMsg | null {
  if (m.is_info) return null;
  let text = resolve(m.text || '').trim();
  if (!text && m.file) text = `[附件: ${m.file_name || '文件'}]`;
  if (!text) return null;
  return { id: m.msg_id, sender: m.from_name || '?', text, ts: m.ts };
}

/** 组装上下文窗口:最近 N 条(数组尾部 N 条),系统消息/空文本剔除。 */
export function buildContextWindow(
  msgs: MsgDto[],
  resolve: (text: string) => string,
  n: number,
): WindowMsg[] {
  const out: WindowMsg[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const w = toWindowMsg(msgs[i], resolve);
    if (w) out.push(w);
    if (out.length >= n) break;
  }
  return out.reverse();
}

/** unix 秒 → 'YYYY-MM-DD HH:MM'(本地时区)。 */
export function formatTs(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 窗口行格式化(带绝对时间),累计超 CONTEXT_CHAR_LIMIT 截断;单条超限仅真正超长时截断,短消息整条丢弃。 */
export function formatWindowLines(win: WindowMsg[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const w of win) {
    const prefix = `[id=${w.id}] ${w.sender} [${formatTs(w.ts)}]: `;
    const lineLen = prefix.length + w.text.length + 1; // +1 换行
    if (used + lineLen <= CONTEXT_CHAR_LIMIT) {
      lines.push(prefix + w.text);
      used += lineLen;
      continue;
    }
    // 剩余预算不足。注意:进入此分支即保证 w.text.length > avail,故不能以 avail>0 为截断条件
    // (那会让普通短消息被截成误导性的近空 stub)。仅当消息自身长度 ≥ 整个窗口上限(真正超长)
    // 才截断保留,普通消息整条丢弃(旧消息,安全)。
    const avail = CONTEXT_CHAR_LIMIT - used - prefix.length - 2; // -1 换行 -1 省略号
    if (avail > 0 && w.text.length >= CONTEXT_CHAR_LIMIT) {
      lines.push(prefix + w.text.slice(0, avail) + '…');
    }
    break;
  }
  return lines.join('\n');
}
