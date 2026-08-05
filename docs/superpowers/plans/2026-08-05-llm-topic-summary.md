# 主题总结 · LLM 双车道实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将聊天主题总结升级为 LLM 智能总结：旁路 llama-server 本地推理或 OpenAI 兼容 API 双来源；气泡秒出短摘要（SSE 流式打字）+ 弹窗看板展开多分析类型（summary/participation/action_items/resources/open_questions/timeline/decisions）；`<message>`/`<user>` 自定义标签模糊跳转；附件隔离只传 text+id。

**Architecture:** 前端构造上下文窗口（信封解析 + 绝对时间 + 附件一行占位）→ `summary_enqueue` 命令传给后端 → SummaryService（managed resource）串行/并发推理 → `summary-event` 流式回传 delta → 前端气泡状态机（idle/summarizing/done/error/fallback）逐字追加。本地推理走 llama-server 子进程（HTTP `/v1/chat/completions?stream=true`），API 复用现有 `llm.rs`。弹窗为平铺全部分析类型的看板，participation 走前端纯统计 + LLM 解读（`stats_plus_llm`）。

**Tech Stack:** TypeScript / Vite / Tauri v2 / Rust (tokio, reqwest) / deltachat core（永不改）/ llama-server 旁路进程

**验证方式:**
- 前端纯函数：无测试框架，用 `node --experimental-strip-types` 直接跑 `src/` 下的 `.ts` 纯函数断言（沿用 `2026-08-05-topic-cluster` 计划的方法）。每个 TS 任务收尾 `npx tsc --noEmit`。
- **Rust：牢记约定——不要每任务跑 `cargo check`（连带编译 core 5-7 分钟）。** 只在 **Task 7 收尾** 跑一次完整 `cargo check`（一个大特性一次全量校验是值得的），在此之前靠仔细类型编写。Task 4-6 用 `cargo check` 的单模块级小技巧不可行（连 core），故统一推迟到 Task 7。
- 最终端到端在 `tauri dev` 手动冒烟（Task 11 清单）。

---

# Phase 1 — 前端纯函数（TDD via node strip-types）

## Task 1: `summaryContext.ts` 上下文窗口组装

**Files:**
- Create: `src/utils/summaryContext.ts`
- Test: 临时脚本 `scripts/check_summary_context.ts`（跑完即删）

- [ ] **Step 1: 写失败断言（先跑先失败）**

创建 `scripts/check_summary_context.ts`：

```ts
import { buildContextWindow, formatWindowLines } from '../src/utils/summaryContext.js';
import { tryParseEnvelope } from '../src/utils/envelope.js';
import type { MsgDto } from '../src/types.js';

// 复用 envelope 的 resolveMessageText
const resolve = (t: string) => {
  const env = tryParseEnvelope(t);
  if (env && typeof env.payload.text === 'string') return env.payload.text;
  return t;
};
const mk = (m: Partial<MsgDto>): MsgDto => ({
  msg_id: 1, chat_id: 1, from_id: 1, from_name: '张三', from_avatar: null,
  from_color: null, text: '', ts: 1754293800, state: 'read', view_type: 'Text',
  file: null, file_mime: null, file_name: null, file_bytes: null,
  quote_text: null, quote_from: null, reactions: null, is_info: false, is_out: false,
  ...m,
});
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// 1. 信封消息 → 取 payload.text
const msgs = [mk({ msg_id: 42, from_name: '张三', ts: 1754293800,
  text: JSON.stringify({ type: 'text', id: 'uuid-1', payload: { text: '下午三点开会' } }) })];
let win = buildContextWindow(msgs, resolve, 50);
assert(win[0].text === '下午三点开会', '信封取 payload.text');
assert(win[0].id === 42, '锚点 id = msg_id(非 uuid)');

// 2. 附件消息 → [附件: 文件名], 不进正文
const msgs2 = [mk({ msg_id: 50, from_name: '李四', text: '', file: '/x/a.pdf', file_name: '产品文档.pdf' })];
win = buildContextWindow(msgs2, resolve, 50);
assert(win[0].text === '[附件: 产品文档.pdf]', '附件只留文件名一行');

// 3. 系统消息跳过
const msgs3 = [mk({ msg_id: 60, is_info: true, text: '张三加入群聊' }), mk({ msg_id: 61, from_name: '王五', text: 'hi' })];
win = buildContextWindow(msgs3, resolve, 50);
assert(win.length === 1 && win[0].id === 61, 'is_info 跳过');

// 4. N 截断(最近 N 条 = 数组尾部 N 条)
const many = Array.from({ length: 10 }, (_, i) => mk({ msg_id: i + 1, from_name: `U${i}`, text: `m${i}` }));
win = buildContextWindow(many, resolve, 3);
assert(win.length === 3 && win[0].id === 8, '取最近 N 条');

// 5. 格式化含时间(结构断言,不硬编码日期以规避时区)
const lines = formatWindowLines(win);
assert(/^\[id=8\] U7 \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]: m7$/.test(lines[0]), '行格式 [id] 名字 [YYYY-MM-DD HH:MM]: 文本');

console.log('OK: summaryContext');
```

- [ ] **Step 2: 跑断言验证失败**

Run: `node --experimental-strip-types scripts/check_summary_context.ts`
Expected: FAIL with `Cannot find module '../src/utils/summaryContext.js'`

- [ ] **Step 3: 实现 summaryContext.ts**

创建 `src/utils/summaryContext.ts`：

```ts
// 主题总结上下文窗口:把已加载消息还原成供 LLM 的行(只传 text + id,附件隔离)。
// 每行 [id=<msg_id>] <sender> [绝对时间]: <文本> —— 时间供时序/间隔/活跃时段分析。
import type { MsgDto } from '../types.js';
import { tryParseEnvelope } from './envelope.js';

export interface WindowMsg {
  id: number;       // 锚点 = msg_id(数字), 本地锚非可移植标识
  sender: string;   // from_name
  text: string;     // 已还原正文;附件消息为 '[附件: <file_name>]'
  ts: number;       // unix 秒, 格式化用
}

export const CONTEXT_CHAR_LIMIT = 4000; // 字数硬上限, 不随 N 联动(默认 N=50 在 summaryPrefs.ts)

/** 还原单条消息为 WindowMsg。is_info 跳过返回 null;信封取 payload.text;附件只留文件名。 */
function toWindowMsg(m: MsgDto): WindowMsg | null {
  if (m.is_info) return null;
  const env = tryParseEnvelope(m.text || '');
  let text = '';
  if (env) {
    text = typeof env.payload.text === 'string' ? env.payload.text : '';
  } else {
    text = m.text || '';
  }
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
  void resolve; // 供外部传 resolveMessageText 保持签名一致;内部已用 tryParseEnvelope
  const out: WindowMsg[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const w = toWindowMsg(msgs[i]);
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

/** 窗口行格式化(带绝对时间),超 CONTEXT_CHAR_LIMIT 截断。 */
export function formatWindowLines(win: WindowMsg[]): string {
  let total = 0;
  const lines: string[] = [];
  for (const w of win) {
    const line = `[id=${w.id}] ${w.sender} [${formatTs(w.ts)}]: ${w.text}`;
    total += line.length + 1;
    if (total > CONTEXT_CHAR_LIMIT) break;
    lines.push(line);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑断言验证通过**

Run: `node --experimental-strip-types scripts/check_summary_context.ts`
Expected: `OK: summaryContext`

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 6: 清理临时脚本 + commit**

```bash
rm scripts/check_summary_context.ts
git add src/utils/summaryContext.ts
git commit -m "feat(summary): 上下文窗口组装(信封还原+附件隔离+绝对时间)"
```

---

## Task 2: `tagParser.ts` 白名单标签解析 + 模糊匹配

**Files:**
- Create: `src/utils/tagParser.ts`
- Test: 临时脚本 `scripts/check_tag_parser.ts`

- [ ] **Step 1: 写失败断言**

创建 `scripts/check_tag_parser.ts`：

```ts
import { parseTags, renderParsed, fuzzyFindMessage } from '../src/utils/tagParser.js';
import type { WindowMsg } from '../src/utils/summaryContext.js';

const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// 1. 只放行 <message>/<user>, 其它 <tag> 原样转义(不解析)
const segs = parseTags('看 <message=\'42\'> 和 <user=\'张三\'>,别管 <script>');
assert(segs.length === 5, 'message+user+script 分成 5 段');
assert(segs[1].type === 'message' && segs[1].value === '42', 'message 解析');
assert(segs[3].type === 'user' && segs[3].value === '张三', 'user 解析');
assert(segs[4].type === 'text' && segs[4].value.includes('&lt;script&gt;'), '非法标签转义');

// 2. 参数值转义(防注入):值 '"><script>' 被 escapeHtml 成 &quot;&gt;&lt;script&gt;
const evil = parseTags('<message=\'"><script>\'>');
assert(evil.length === 1 && evil[0].type === 'message' && evil[0].value.includes('&quot;'), '参数值被转义');
// 渲染时转义后的值不会逃逸出 data-msg-ref 属性
assert(!renderParsed(evil, () => {}).includes('"><script>'), '渲染不含原始注入串');

// 3. 无标签 → 单文本段
assert(parseTags('普通文本').length === 1, '无标签单段');

// 4. renderParsed 生成可点击元素结构
const html = renderParsed(parseTags('看 <message=\'42\'>'), () => {});
assert(html.includes('data-msg-ref="42"'), 'message 渲染带 data-msg-ref');
assert(html.includes('class="mention-chip"'), '有 mention-chip');

// 5. 模糊匹配:精确 id 优先
const win: WindowMsg[] = [
  { id: 42, sender: '张三', text: '下午三点开会', ts: 1 },
  { id: 43, sender: '李四', text: '下午的会议记录', ts: 2 },
  { id: 44, sender: '王五', text: '晚上聚餐', ts: 3 },
];
let r = fuzzyFindMessage(win, '42');
assert(r.length === 1 && r[0].id === 42, '数字精确命中');

// 6. 模糊:内容片段 → 相关度排序 Top3
r = fuzzyFindMessage(win, '下午');
assert(r.length >= 1 && r[0].id === 42, '内容模糊命中,id42 相关度最高');

// 7. 无命中 → 空数组
r = fuzzyFindMessage(win, '不存在的内容xyz');
assert(r.length === 0, '0 条返回空');

console.log('OK: tagParser');
```

- [ ] **Step 2: 跑断言验证失败**

Run: `node --experimental-strip-types scripts/check_tag_parser.ts`
Expected: FAIL with `Cannot find module '../src/utils/tagParser.js'`

- [ ] **Step 3: 实现 tagParser.ts**

创建 `src/utils/tagParser.ts`：

```ts
// AI 输出标签解析:白名单只放行 <message> / <user>, 先整体转义再白名单解包,防注入。
// 参数值也转义。message 走模糊匹配(1 条直接跳 / 多条列表 / 0 条 toast)。
import { escapeHtml } from '../components/escape.js';
import type { WindowMsg } from './summaryContext.js';

export type TagType = 'text' | 'message' | 'user';
export interface ParsedSegment {
  type: TagType;
  value: string;   // message/user 的参数值;text 为已转义内容
}

const TAG_RE = /<(message|user)='([^']*)'>/g;

/** 解析标签:只放行 <message='..'> / <user='..'>, 其余 <...> 形状整体转义。 */
export function parseTags(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text))) {
    if (m.index > last) segments.push({ type: 'text', value: escapeHtml(text.slice(last, m.index)) });
    segments.push({ type: m[1] === 'message' ? 'message' : 'user', value: escapeHtml(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', value: escapeHtml(text.slice(last)) });
  // 任何残留的 <xxx> 形状都在 text 段里被 escapeHtml 转义了(天然安全)
  return segments;
}

/** 渲染成受控 HTML。onRef 点击 <message> 时回调(跳转原文)。 */
export function renderParsed(segments: ParsedSegment[], onRef: (id: string) => void): string {
  return segments
    .map((s) => {
      if (s.type === 'message') return `<a class="mention-chip" data-msg-ref="${s.value}">@消息 ${s.value}</a>`;
      if (s.type === 'user') return `<span class="mention-chip" data-user-ref="${s.value}">@${s.value}</span>`;
      return s.value;
    })
    .join('');
}

/** 相关度分:精确 id=100, 内容含=3, sender 含=2, id 子串=1。 */
function score(w: WindowMsg, q: string): number {
  if (String(w.id) === q) return 100;
  let s = 0;
  if (w.text.includes(q)) s += 3;
  if (w.sender.includes(q)) s += 2;
  if (String(w.id).includes(q)) s += 1;
  return s;
}

/** 模糊匹配:精确 id 优先,否则按相关度取 Top3(限当前会话窗口)。 */
export function fuzzyFindMessage(win: WindowMsg[], query: string): WindowMsg[] {
  const q = query.trim();
  if (!q) return [];
  const scored = win
    .map((w) => ({ w, s: score(w, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, 3).map((x) => x.w);
}
```

- [ ] **Step 4: 跑断言验证通过**

Run: `node --experimental-strip-types scripts/check_tag_parser.ts`
Expected: `OK: tagParser`

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 清理 + commit**

```bash
rm scripts/check_tag_parser.ts
git add src/utils/tagParser.ts
git commit -m "feat(summary): 标签白名单解析 + message 模糊匹配"
```

---

## Task 3: `participation.ts` 参与度纯统计

**Files:**
- Create: `src/utils/participation.ts`
- Test: 临时脚本 `scripts/check_participation.ts`

- [ ] **Step 1: 写失败断言**

创建 `scripts/check_participation.ts`：

```ts
import { computeParticipation } from '../src/utils/participation.js';
import type { WindowMsg } from '../src/utils/summaryContext.js';
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

const ts = (day: number, hour: number, min: number) => new Date(2026, 7, day, hour, min).getTime() / 1000;
const win: WindowMsg[] = [
  { id: 1, sender: '张三', text: 'a', ts: ts(4, 14, 0) },
  { id: 2, sender: '张三', text: 'b', ts: ts(4, 14, 5) },
  { id: 3, sender: '李四', text: 'c', ts: ts(5, 9, 0) },
];
const p = computeParticipation(win);
assert(p.per_member.length === 2, '两位成员');
const zhang = p.per_member.find((x) => x.name === '张三')!;
assert(zhang.msg_count === 2 && zhang.char_count === 2 && zhang.active_days === 1, '张三 2 条/2 字/1 活跃日');
assert(p.hours.some((h) => h.hour === 14 && h.count === 2), '14 时 2 条');
assert(p.density.some((d) => d.day === '2026-08-04' && d.count === 2), '8-4 两条');
console.log('OK: participation');
```

- [ ] **Step 2: 跑断言验证失败**

Run: `node --experimental-strip-types scripts/check_participation.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 实现 participation.ts**

创建 `src/utils/participation.ts`：

```ts
// 参与度统计:纯前端,0 token。per_member 消息/字符/活跃天数;hours 活跃时段;density 每日密度。
// 看板 participation 区块 = 此统计(数字准确) + LLM 解读(语义)。
import type { WindowMsg } from './summaryContext.js';

export interface MemberStat { name: string; msg_count: number; char_count: number; active_days: number }
export interface Participation {
  per_member: MemberStat[];
  hours: Array<{ hour: number; count: number }>;
  density: Array<{ day: string; count: number }>;
}

/** 统计参与度。day 用本地时区 YYYY-MM-DD;hour 用 0-23。 */
export function computeParticipation(win: WindowMsg[]): Participation {
  const memberMap = new Map<string, MemberStat>();
  const hourMap = new Map<number, number>();
  const dayMap = new Map<string, number>();
  for (const w of win) {
    const d = new Date(w.ts * 1000);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hour = d.getHours();
    const m = memberMap.get(w.sender) ?? { name: w.sender, msg_count: 0, char_count: 0, active_days: 0 };
    m.msg_count += 1;
    m.char_count += w.text.length;
    hourMap.set(hour, (hourMap.get(hour) ?? 0) + 1);
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
    memberMap.set(w.sender, m);
  }
  // 活跃天数:重建成员→Set<day>(成员维度需独立统计,不能复用全局 dayMap)
  const memberDays = new Map<string, Set<string>>();
  for (const w of win) {
    const d = new Date(w.ts * 1000);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!memberDays.has(w.sender)) memberDays.set(w.sender, new Set());
    memberDays.get(w.sender)!.add(day);
  }
  for (const m of memberMap.values()) {
    m.active_days = memberDays.get(m.name)?.size ?? 0;
  }
  return {
    per_member: [...memberMap.values()].sort((a, b) => b.msg_count - a.msg_count),
    hours: [...hourMap.entries()].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour - b.hour),
    density: [...dayMap.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
```

- [ ] **Step 4: 跑断言验证通过**

Run: `node --experimental-strip-types scripts/check_participation.ts`
Expected: `OK: participation`

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 清理 + commit**

```bash
rm scripts/check_participation.ts
git add src/utils/participation.ts
git commit -m "feat(summary): participation 参与度纯统计(成员/时段/密度)"
```

---

# Phase 2 — Rust 推理后端

> **重要提醒（执行者务必读）:** 本仓库 `deltachat` core 是 path 依赖，`cargo check` 会连带编译 core，耗时 5-7 分钟。**不要在 Task 4/5/6 逐个跑 `cargo check`。** 这些任务靠仔细类型编写 + 编译期由 review 把关；只在 Task 7 收尾跑一次全量 `cargo check`。`llm.rs` 的流式方法新增也要遵守——它是独立模块但会触发整体编译，故也在 Task 7 一起校验。

## Task 4: SSE 解析器 + `llm.rs` 流式补全方法

**Files:**
- Create: `src-tauri/src/summary/mod.rs`（空模块骨架,后续 Task 填充）
- Modify: `src-tauri/src/summary/sse.rs`（新建）
- Modify: `src-tauri/src/llm.rs`（追加 `complete_stream_openai`）
- Modify: `src-tauri/src/lib.rs`（`mod summary;`）

- [ ] **Step 1: 新建 summary 模块骨架 + SSE 解析器**

创建 `src-tauri/src/summary/mod.rs`：

```rust
// 主题总结服务:上下文窗口→本地/API 推理→流式回传。Task 5-7 填充各子模块。
pub mod downloader;
pub mod queue;
pub mod runner;
pub mod sse;
```

创建 `src-tauri/src/summary/sse.rs`：

```rust
// OpenAI 兼容 SSE 流式解析:data: {...} 行,choices[0].delta.content 累加,data: [DONE] 结束。
// 本地 llama-server 与 API 模式同格式,一个解析器两种复用。
use crate::error::{AppError, AppResult};

pub struct SseDelta {
    pub text: String, // 本次增量文本(空 = 事件/元数据行,跳过)
    pub done: bool,   // data: [DONE]
}

pub fn parse_sse_line(line: &str) -> Option<SseDelta> {
    let line = line.trim();
    if !line.starts_with("data:") { return None; }
    let data = line["data:".len()..].trim();
    if data == "[DONE]" { return Some(SseDelta { text: String::new(), done: true }); }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let delta = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|ch| ch.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    Some(SseDelta { text: delta.to_string(), done: false })
}

/// 从字节流分帧出 SSE 事件文本。返回 String(已完成的一段 data)。
pub fn extract_sse_text(buf: &mut Vec<u8>) -> Option<String> {
    // 按 \n\n 切事件;消费已完整的事件返回,残留留在 buf
    let pos = buf.windows(2).position(|w| w == b"\n\n")?;
    let ev = String::from_utf8_lossy(&buf[..pos]).to_string();
    buf.drain(..pos + 2);
    Some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_content_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"今天"}}]}"#;
        let d = parse_sse_line(line).unwrap();
        assert_eq!(d.text, "今天");
        assert!(!d.done);
    }

    #[test]
    fn parse_done() {
        let d = parse_sse_line("data: [DONE]").unwrap();
        assert!(d.done);
    }

    #[test]
    fn skip_metadata() {
        assert!(parse_sse_line("data: [DONE]").unwrap().done);
        assert!(parse_sse_line(": ping").is_none());
        // 非 [DONE] 且非 JSON 的行 → None
        assert!(parse_sse_line("data: garbage").is_none());
    }

    #[test]
    fn extract_events() {
        let mut buf = b"data: {\"choices\":[]}\n\ndata: {\"x\":1}\n\n".to_vec();
        let first = extract_sse_text(&mut buf).unwrap();
        assert!(first.contains("choices"));
        assert!(!buf.is_empty());
    }
}
```

- [ ] **Step 2: 在 llm.rs 追加流式补全方法**

在 `src-tauri/src/llm.rs` 的 `impl LlmClient` 末尾追加：

```rust
/// OpenAI 兼容流式补全(本地 llama-server 与 API 共用)。on_delta 回调每个增量块。
/// 仅支持 OpenAI 兼容协议(base_url + api_key + model);Anthropic/Gemini 不走此路径。
pub async fn complete_stream_openai(
    &self,
    cfg: &LlmConfig,
    messages: Vec<ChatMessage>,
    mut on_delta: impl FnMut(String) -> AppResult<()> + Send,
) -> AppResult<String> {
    let key = cfg.api_key.as_deref().unwrap_or("");
    if key.is_empty() {
        return Err(AppError::Core("llm missing api_key".into()));
    }
    let base = cfg.base_url.as_deref().unwrap_or("").trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Core("llm missing base_url".into()));
    }
    let url = format!("{base}/chat/completions");
    let body = {
        let mut b = serde_json::json!({
            "model": cfg.model.as_deref().unwrap_or(""),
            "messages": messages,
            "stream": true,
        });
        b["temperature"] = serde_json::json!(cfg.temperature); // f64, 非 Option
        if let Some(mt) = cfg.max_tokens { b["max_tokens"] = serde_json::json!(mt); }
        b
    };
    let resp = self
        .http
        .post(&url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Core(format!("llm stream: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        // 余额/配额识别:402 一律;429/400 时查 body 特征
        let is_quota = status == reqwest::StatusCode::PAYMENT_REQUIRED
            || (status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || status == reqwest::StatusCode::BAD_REQUEST)
                && ["quota", "insufficient", "billing", "credit"]
                    .iter()
                    .any(|k| text.to_lowercase().contains(k));
        let code = if is_quota { "api_quota" } else if status.as_u16() == 401 || status.as_u16() == 403 { "api_auth" } else if status.as_u16() == 429 { "api_rate_limit" } else { "api_network" };
        return Err(AppError::Core(format!("llm stream {code}: {status} {text}")));
    }
    let mut full = String::new();
    let mut bytes = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    use futures_util::StreamExt;
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|e| AppError::Core(format!("llm stream read: {e}")))?;
        buf.extend_from_slice(&chunk);
        while let Some(ev) = crate::summary::sse::extract_sse_text(&mut buf) {
            for line in ev.lines() {
                if let Some(d) = crate::summary::sse::parse_sse_line(line) {
                    if d.done { return Ok(full); }
                    if !d.text.is_empty() {
                        full.push_str(&d.text);
                        on_delta(d.text)?;
                    }
                }
            }
        }
    }
    Ok(full)
}
```

- [ ] **Step 3: lib.rs 注册 summary 模块**

修改 `src-tauri/src/lib.rs` 顶部 mod 列表，在 `mod state;` 后加一行：

```rust
mod summary;
```

- [ ] **Step 4: 确认 `futures_util` 依赖存在**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 追加（若已存在则跳过）：

```toml
futures-util = "0.3"
```

同时确认 `reqwest` 已启用 `stream`（查 Cargo.toml 现有 `reqwest = { version = "0.12", features = ["json"] }` → 改为 `features = ["json", "stream"]`）。若 `bytes_stream` 需要 stream feature，一并改。

- [ ] **Step 5: 记录依赖待 Task 7 一起校验**

> 不要在 Task 4 跑 `cargo check`。Cargo.toml 改动和编译正确性统一在 Task 7 收尾验证。此处仅确认文件与代码就位。

---

## Task 5: `downloader.rs` 引擎 + 模型下载

**Files:**
- Create: `src-tauri/src/summary/downloader.rs`

- [ ] **Step 1: 实现下载器(引擎 + 模型,跨端 post-process,sha256,进度事件)**

创建 `src-tauri/src/summary/downloader.rs`：

```rust
// 下载器:引擎二进制(llama.cpp releases) + 模型 GGUF(ModelScope 优先/HF 兜底)。
// 跨端 post-process 收在一个函数(Windows 解压 / macOS 清隔离 / Linux 设执行位)。
// 进度经 emit 发 download-progress 事件;sha256 下载后计算。
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, PartialEq)]
pub enum ModelSize { B05, B15 }

impl ModelSize {
    pub fn file_name(&self) -> &'static str {
        match self {
            ModelSize::B05 => "qwen2.5-0.5b-q4km.gguf",
            ModelSize::B15 => "qwen2.5-1.5b-q4km.gguf",
        }
    }
    pub fn repo(&self) -> (&'static str, &'static str) {
        match self {
            ModelSize::B05 => ("second-state/Qwen2.5-0.5B-Instruct-GGUF", "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"),
            ModelSize::B15 => ("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"),
        }
    }
}

#[derive(Clone, Copy)]
pub enum DownloadWhat { Engine, Model(ModelSize) }

pub struct Downloader {
    pub http: reqwest::Client,
    pub models_dir: PathBuf,
    pub app: AppHandle,
    pub engine_tag: String, // 锁定 tag, 如 "b10276"
}

impl Downloader {
    pub fn new(models_dir: PathBuf, app: AppHandle) -> Self {
        Self {
            http: reqwest::Client::builder().build().expect("reqwest"),
            models_dir,
            app,
            engine_tag: "b10276".into(),
        }
    }

    /// 平台 → llama.cpp CPU 产物资产名 + 解压后可执行名。
    fn engine_asset(&self) -> (&'static str, &'static str) {
        #[cfg(target_os = "windows")]
        return ("llama-b10276-bin-win-cpu-x64.zip", "llama-server.exe");
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        return ("llama-b10276-bin-macos-arm64.tar.gz", "llama-server");
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        return ("llama-b10276-bin-macos-x64.tar.gz", "llama-server");
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return ("llama-b10276-bin-ubuntu-x64.tar.gz", "llama-server");
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        return ("llama-b10276-bin-ubuntu-arm64.tar.gz", "llama-server");
    }

    /// 下载并落地,返回最终可执行/模型文件路径。
    pub async fn download(&self, what: DownloadWhat) -> AppResult<PathBuf> {
        std::fs::create_dir_all(&self.models_dir)?;
        let (url, final_name) = match what {
            DownloadWhat::Engine => {
                let (asset, _exe) = self.engine_asset();
                (
                    format!("https://github.com/ggml-org/llama.cpp/releases/download/{}/{}", self.engine_tag, asset),
                    asset.to_string(),
                )
            }
            DownloadWhat::Model(size) => {
                let (repo, file) = size.repo();
                (
                    format!("https://modelscope.cn/models/{repo}/resolve/master/{file}"),
                    size.file_name().to_string(),
                )
            }
        };
        let tmp = self.models_dir.join(format!("{final_name}.part"));
        let final_path = self.models_dir.join(&final_name);
        self.stream_to_file(&url, &tmp, &final_name).await?;
        std::fs::rename(&tmp, &final_path)?;
        // 跨端 post-process
        self.post_process(what, &final_path)?;
        // sha256 计算存盘
        let sha = sha256_file(&final_path)?;
        let _ = self.app.emit("download-progress", &serde_json::json!({
            "what": what_label(what), "status": "done", "sha256": sha,
        }));
        Ok(final_path)
    }

    async fn stream_to_file(&self, url: &str, tmp: &Path, what: &str) -> AppResult<()> {
        let resp = self.http.get(url).send().await.map_err(|e| AppError::Core(format!("download {what}: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError::Core(format!("download {what}: HTTP {status}")));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(tmp).await?;
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        let mut done = 0u64;
        let started = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Core(format!("download {what}: {e}")))?;
            use tokio::io::AsyncWriteExt;
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            let secs = started.elapsed().as_secs().max(1);
            let _ = self.app.emit("download-progress", &serde_json::json!({
                "what": what, "status": "downloading",
                "bytes": done, "total": total, "rate": done / secs,
            }));
        }
        file.flush().await?;
        Ok(())
    }

    /// 平台差异收在这一函数:Windows 解压 zip;macOS 清 quarantine;Linux 设执行位。
    fn post_process(&self, what: DownloadWhat, path: &Path) -> AppResult<()> {
        match what {
            DownloadWhat::Model(_) => {
                #[cfg(target_os = "macos")]
                {
                    let _ = std::process::Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(path).output();
                }
                Ok(())
            }
            DownloadWhat::Engine => {
                let (_asset, exe) = self.engine_asset();
                // 解压到 models_dir, 提取出可执行文件
                #[cfg(target_os = "windows")]
                {
                    let file = std::fs::File::open(path)?;
                    let mut zip = zip::ZipArchive::new(file)?;
                    let target = self.models_dir.join(exe);
                    for i in 0..zip.len() {
                        let mut entry = zip.by_index(i)?;
                        if entry.name().ends_with(exe) {
                            let mut out = std::fs::File::create(&target)?;
                            std::io::copy(&mut entry, &mut out)?;
                        }
                    }
                    std::fs::remove_file(path)?; // 清理 zip
                    Ok(())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    // tar.gz 解压出 llama-server
                    let file = std::fs::File::open(path)?;
                    let gz = flate2::read::GzDecoder::new(file);
                    let mut tar = tar::Archive::new(gz);
                    let target = self.models_dir.join(exe);
                    for entry in tar.entries()? {
                        let mut entry = entry?;
                        if entry.path()?.to_string_lossy().ends_with(exe) {
                            entry.unpack(&target)?;
                        }
                    }
                    std::fs::remove_file(path)?;
                    #[cfg(target_os = "macos")]
                    {
                        let _ = std::process::Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(&target).output();
                    }
                    #[cfg(target_os = "linux")]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))?;
                    }
                    Ok(())
                }
            }
        }
    }

    pub fn engine_path(&self) -> PathBuf {
        let (_asset, exe) = self.engine_asset();
        self.models_dir.join(exe)
    }
    pub fn model_path(&self, size: ModelSize) -> PathBuf {
        self.models_dir.join(size.file_name())
    }
}

fn what_label(w: DownloadWhat) -> &'static str {
    match w { DownloadWhat::Engine => "engine", DownloadWhat::Model(_) => "model" }
}

fn sha256_file(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    let data = std::fs::read(path)?;
    let mut h = Sha256::new();
    h.update(&data);
    Ok(format!("{:x}", h.finalize()))
}
```

- [ ] **Step 2: Cargo.toml 追加依赖**

在 `src-tauri/Cargo.toml` `[dependencies]` 追加：

```toml
# 主题总结:引擎 zip/tar.gz 解压 + sha256 校验 + SSE 流式
flate2 = "1"
tar = "0.4"
sha2 = "0.10"
```

> **不跑 `cargo check`。** 依赖与编译正确性统一 Task 7 验证。

---

## Task 6: `runner.rs` llama-server 子进程生命周期

**Files:**
- Create: `src-tauri/src/summary/runner.rs`

- [ ] **Step 1: 实现 LocalRunner(健康检查/懒启动/空闲回收/流式调用)**

创建 `src-tauri/src/summary/runner.rs`：

```rust
// llama-server 子进程生命周期:懒启动(GET /health 未就绪才 spawn)、
// 空闲 10 分钟 kill 回收、崩溃重启一次、流式调用(断连即取消生成)。
// 注意:不存 model_path —— 模型档位可切换(0.5B/1.5B),调用时由队列传入。
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::Mutex;
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, LlmConfig};

pub struct LocalRunner {
    pub engine_path: PathBuf,
    pub child: Mutex<Option<tokio::process::Child>>,
    pub port: Mutex<u16>,
    pub http: reqwest::Client,
}

impl LocalRunner {
    pub fn new(engine_path: PathBuf) -> Self {
        Self {
            engine_path,
            child: Mutex::new(None),
            port: Mutex::new(12700),
            http: reqwest::Client::builder().build().expect("reqwest"),
        }
    }

    pub fn is_downloaded(&self, model_path: &Path) -> bool {
        self.engine_path.exists() && model_path.exists()
    }

    /// 确保子进程在跑且模型就绪。未 spawn → spawn(用给定 model_path);health != ok → 等。
    pub async fn ensure_running(&self, model_path: &Path) -> AppResult<()> {
        if !self.is_downloaded(model_path) {
            return Err(AppError::Core("engine_not_ready".into()));
        }
        let base = self.base_url().await;
        let ok = self.health_ok(&base).await;
        if ok { return Ok(()); }
        // 子进程可能没起/崩了 → spawn
        self.spawn(model_path).await?;
        // 等模型加载(0.5B 约 1s;1.5B 约几秒),轮询 /health 直到 ok,上限 60s
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            if self.health_ok(&self.base_url().await).await { return Ok(()); }
            if std::time::Instant::now() > deadline {
                return Err(AppError::Core("engine_timeout".into()));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn base_url(&self) -> String {
        let p = *self.port.lock().await;
        format!("http://127.0.0.1:{p}")
    }

    async fn health_ok(&self, base: &str) -> bool {
        let url = format!("{base}/health");
        match self.http.get(&url).timeout(Duration::from_secs(2)).send().await {
            Ok(r) => {
                if let Ok(v) = r.json::<serde_json::Value>().await {
                    return v.get("status").and_then(|s| s.as_str()) == Some("ok");
                }
                false
            }
            Err(_) => false,
        }
    }

    async fn spawn(&self, model_path: &Path) -> AppResult<()> {
        // 探测空闲端口 12700..12710
        let port = self.next_free_port().await;
        {
            let mut p = self.port.lock().await;
            *p = port;
        }
        let mut cmd = tokio::process::Command::new(&self.engine_path);
        cmd.args([
            "--model", model_path.to_str().unwrap_or(""),
            "--port", &port.to_string(),
            "--host", "127.0.0.1",
            "--ctx-size", "4096",
            "--n-predict", "-1",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
        let child = cmd.spawn().map_err(|e| AppError::Core(format!("engine_start_failed: {e}")))?;
        {
            let mut guard = self.child.lock().await;
            *guard = Some(child);
        }
        Ok(())
    }

    async fn next_free_port(&self) -> u16 {
        for port in 12700..12711 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err() {
                return port;
            }
        }
        12700
    }

    /// 空闲回收:10 分钟无任务 → kill。
    pub async fn stop_if_idle(&self, idle: Duration) {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill().await;
            }
        }
        *guard = None;
    }

    /// 流式调用本地引擎。on_delta 回调增量。model_path 为当前选中档位模型文件。
    pub async fn complete_stream(
        &self,
        model_path: &Path,
        cfg: &LlmConfig,
        messages: Vec<ChatMessage>,
        mut on_delta: impl FnMut(String) -> AppResult<()> + Send,
    ) -> AppResult<String> {
        self.ensure_running(model_path).await?;
        let base = self.base_url().await;
        let url = format!("{base}/v1/chat/completions");
        let body = serde_json::json!({
            "model": "local",
            "messages": messages,
            "stream": true,
        });
        let resp = self.http.post(&url).json(&body).send().await
            .map_err(|e| AppError::Core(format!("llm stream: {e}")))?;
        let mut full = String::new();
        let mut bytes = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        use futures_util::StreamExt;
        while let Some(chunk) = bytes.next().await {
            let chunk = chunk.map_err(|e| AppError::Core(format!("llm stream read: {e}")))?;
            buf.extend_from_slice(&chunk);
            while let Some(ev) = crate::summary::sse::extract_sse_text(&mut buf) {
                for line in ev.lines() {
                    if let Some(d) = crate::summary::sse::parse_sse_line(line) {
                        if d.done { return Ok(full); }
                        if !d.text.is_empty() {
                            full.push_str(&d.text);
                            on_delta(d.text)?;
                        }
                    }
                }
            }
        }
        Ok(full)
    }
}

/// 本地推理用 OpenAI 兼容 LlmConfig(model 填 "local")。
/// 注意:LlmConfig 无 Default,用 From<LlmConfigInput> 构造(dto.rs:436)。
pub fn local_llm_config() -> LlmConfig {
    crate::dto::LlmConfigInput {
        system_prompt: None,
        base_url: Some("http://127.0.0.1:12700/v1".into()),
        api_key: Some("local".into()),
        model: Some("local".into()),
        provider: Some("openai".into()),
    }
    .into()
}
```

> **不跑 `cargo check`。** Task 7 统一验证。

---

## Task 7: `queue.rs` + `summary.rs` 命令 + events + lib.rs 注册

**Files:**
- Create: `src-tauri/src/summary/queue.rs`
- Create: `src-tauri/src/summary/commands.rs`
- Modify: `src-tauri/src/lib.rs`（`mod summary;` 已在 Task 4 加;追加 `summary::commands::*` 到 invoke_handler + setup 里 manage SummaryService）

- [ ] **Step 1: 实现 SummaryQueue(信号量串行/bubble 抢占/每 chat 丢旧留新)**

创建 `src-tauri/src/summary/queue.rs`：

```rust
// 推理队列:本地串行(信号量=1)+ API 并发;bubble 抢占正在跑的 detail;
// 同 chat 同 lane 丢旧留新;结果/流经回调 emit summary-event。
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Semaphore};
use crate::error::{AppError, AppResult};
use crate::llm::{ChatMessage, LlmClient};
use crate::summary::runner::LocalRunner;

#[derive(Clone, Copy, PartialEq)]
pub enum Lane { Bubble, Detail }

#[derive(Clone)]
pub struct SummaryJob {
    pub chat_id: u64,
    pub lane: Lane,
    pub kind: String,        // analysis kind(Detail), bubble 填 "bubble"
    pub messages: Vec<ChatMessage>,
    pub prev_analysis: Option<String>,
    pub timeout: Duration,
}

pub struct QueueInner {
    pub running: Option<SummaryJob>,
    pub pending: VecDeque<SummaryJob>,
}

pub struct SummaryQueue {
    pub inner: Mutex<QueueInner>,
    pub local_sem: Arc<Semaphore>, // 本地推理串行
    pub app: AppHandle,
    pub runner: Arc<LocalRunner>,
    pub api: LlmClient,
    pub api_cfg: Mutex<Option<crate::dto::LlmConfig>>,
    pub current_model: Mutex<PathBuf>, // 当前选中档位的模型文件(可切换)
}

impl SummaryQueue {
    pub fn new(app: AppHandle, runner: Arc<LocalRunner>, default_model: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(QueueInner { running: None, pending: VecDeque::new() }),
            local_sem: Arc::new(Semaphore::new(1)),
            app, runner,
            api: LlmClient::new(),
            api_cfg: Mutex::new(None),
            current_model: Mutex::new(default_model),
        })
    }

    /// 切换模型档位(下载完成 / save_prefs 时调用)。
    pub async fn set_current_model(&self, p: PathBuf) {
        *self.current_model.lock().await = p;
    }

    /// 入队。bubble 插队到队头(优先级);同 chat 同 lane 旧任务丢弃。
    /// 注:bubble「抢占」v1 用优先级重排实现 —— 正在跑的 detail 自然跑完再跑 bubble,
    /// 不做物理中止(CancellationToken 贯穿 SSE 循环复杂度高,0.5B 下 detail 仅几秒,收益低)。
    pub async fn enqueue(&self, job: SummaryJob) -> AppResult<()> {
        let mut inner = self.inner.lock().await;
        // 同 chat 同 lane:丢弃 pending 里的旧任务
        inner.pending.retain(|j| !(j.chat_id == job.chat_id && j.lane == job.lane));
        if job.lane == Lane::Bubble {
            inner.pending.push_front(job);
        } else {
            inner.pending.push_back(job);
        }
        Ok(())
    }

    /// 取下一个任务(worker 循环调用,非阻塞)。同 chat 同 lane 若队列里还有更新的 → 这个过期,丢。
    pub async fn next_job(&self) -> Option<SummaryJob> {
        let mut inner = self.inner.lock().await;
        loop {
            let job = inner.pending.pop_front()?;
            let newer = inner.pending.iter().any(|j| j.chat_id == job.chat_id && j.lane == job.lane);
            if newer { continue; }
            inner.running = Some(job.clone());
            return Some(job);
        }
    }

    /// 跑单个 job 并发事件。不递归取下一个 —— 常驻 worker 循环(commands.rs)负责拉取。
    pub async fn run_job(&self, job: SummaryJob) {
        let result = if self.use_local(&job).await {
            self.run_local(&job).await
        } else {
            self.run_api(&job).await
        };
        self.emit_result(&job, result).await;
    }

    async fn use_local(&self, _job: &SummaryJob) -> bool {
        let cfg = self.api_cfg.lock().await;
        cfg.is_none() // 未配 API → 走本地
    }

    async fn run_local(&self, job: &SummaryJob) -> AppResult<String> {
        let _permit = self.local_sem.clone().acquire_owned().await;
        let cfg = crate::summary::runner::local_llm_config();
        let model = self.current_model.lock().await.clone();
        // 本地引擎超时:统一 120s
        tokio::time::timeout(
            job.timeout,
            self.runner.complete_stream(&model, &cfg, job.messages.clone(), |delta| {
                self.emit_delta(job, &delta);
                Ok(())
            }),
        )
        .await
        .map_err(|_| AppError::Core("engine_timeout".into()))?
    }

    async fn run_api(&self, job: &SummaryJob) -> AppResult<String> {
        let cfg = self.api_cfg.lock().await.clone();
        let cfg = cfg.ok_or_else(|| AppError::Core("api_not_configured".into()))?;
        tokio::time::timeout(
            job.timeout,
            self.api.complete_stream_openai(&cfg, job.messages.clone(), |delta| {
                self.emit_delta(job, &delta);
                Ok(())
            }),
        )
        .await
        .map_err(|_| AppError::Core("engine_timeout".into()))?
    }

    fn emit_delta(&self, job: &SummaryJob, delta: &str) {
        let _ = self.app.emit("summary-event", &serde_json::json!({
            "chatId": job.chat_id, "lane": lane_str(job.lane), "kind": job.kind,
            "status": "streaming", "delta": delta,
        }));
    }

    async fn emit_result(&self, job: &SummaryJob, result: AppResult<String>) {
        match result {
            Ok(text) => {
                let _ = self.app.emit("summary-event", &serde_json::json!({
                    "chatId": job.chat_id, "lane": lane_str(job.lane), "kind": job.kind,
                    "status": "done", "result": text,
                }));
            }
            Err(e) => {
                let msg = e.to_string();
                let code = msg.split(':').next().unwrap_or("error").to_string();
                let _ = self.app.emit("summary-event", &serde_json::json!({
                    "chatId": job.chat_id, "lane": lane_str(job.lane), "kind": job.kind,
                    "status": "error", "error": { "code": code, "message": msg },
                }));
            }
        }
    }
}

pub fn lane_str(l: Lane) -> &'static str {
    match l { Lane::Bubble => "bubble", Lane::Detail => "detail" }
}
```

- [ ] **Step 2: 实现 summary 命令层(commands.rs)**

创建 `src-tauri/src/summary/commands.rs`：

```rust
// 主题总结命令层:状态读写 / 下载 / 入队。SummaryService 作为 managed resource。
use std::sync::Arc;
use tauri::State;
use crate::error::{AppError, AppResult};
use crate::llm::ChatMessage;
use crate::summary::queue::{Lane, SummaryJob, SummaryQueue};
use crate::summary::downloader::{DownloadWhat, Downloader, ModelSize};

pub struct SummaryService {
    pub queue: Arc<SummaryQueue>,
    pub downloader: Downloader,
    pub models_dir: std::path::PathBuf,
    pub prefs: tokio::sync::Mutex<serde_json::Value>,
}

impl SummaryService {
    pub fn new(app: tauri::AppHandle, data_dir: std::path::PathBuf, runner: Arc<crate::summary::runner::LocalRunner>, default_model: std::path::PathBuf) -> Arc<Self> {
        let models_dir = data_dir.join("models");
        let svc = Arc::new(Self {
            queue: SummaryQueue::new(app.clone(), runner, default_model),
            downloader: Downloader::new(models_dir.clone(), app),
            models_dir,
            prefs: tokio::sync::Mutex::new(serde_json::json!({
                "mode": "wordfreq", "source": "local", "modelSize": "0.5b", "contextN": 50,
            })),
        });
        // 常驻 worker 循环
        {
            let queue = svc.queue.clone();
            tokio::spawn(async move {
                loop {
                    if let Some(job) = queue.next_job().await {
                        queue.run_job(job).await;
                    } else {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            });
        }
        svc
    }

    /// 构造 ChatMessage:system 按 lane/kind 选 prompt,user 为前端已组装好的窗口行。
    /// 注意:ChatMessage 有 4 字段(llm.rs:49),tool_calls/tool_call_id 必填。
    pub fn build_messages(prompt: &str, lane: &str, kind: &str) -> Vec<ChatMessage> {
        vec![
            ChatMessage { role: "system".into(), content: system_prompt(lane, kind).to_string(), tool_calls: vec![], tool_call_id: None },
            ChatMessage { role: "user".into(), content: prompt.to_string(), tool_calls: vec![], tool_call_id: None },
        ]
    }
}

/// 按车道/分析类型选 system prompt。bubble 纯文本;detail 各类 JSON/XML 约束。
pub fn system_prompt(lane: &str, kind: &str) -> &'static str {
    match (lane, kind) {
        ("bubble", _) => "你是聊天主题总结助手。用一句话(≤60字)概括最近聊的主题,直接输出,不要任何前缀后缀,不要使用 <message> 或 <user> 标签。",
        ("detail", "summary") => "你是聊天内容分析助手。根据聊天记录用一段话(2-4句)总结最近聊的内容,用 <message='...'> 引用具体消息(消息id或内容片段),用 <user='...'> 引用发言人名字,直接输出总结,不要前缀。",
        ("detail", "action_items") => "提取聊天中的行动项/待办事项,只输出 JSON 对象 {\"items\":[{\"text\":\"...\",\"assignee\":\"...\",\"due\":\"...\",\"ref\":数字}]},不要输出任何其它文本。",
        ("detail", "resources") => "聚合聊天中提到的链接和文件,只输出 JSON {\"links\":[{\"url\":\"...\",\"title\":\"...\",\"sender\":\"...\",\"ref\":数字}],\"files\":[{\"name\":\"...\",\"ref\":数字}]},不要其它文本。",
        ("detail", "open_questions") => "找出聊天中悬而未决的问题(提问后无人明确回答),只输出 JSON {\"questions\":[{\"text\":\"...\",\"asked_by\":\"...\",\"ref\":数字}]},不要其它文本。",
        ("detail", "timeline") => "把聊天按话题演变划分为若干阶段,只输出 JSON {\"phases\":[{\"period\":\"...\",\"topic\":\"...\",\"key_messages\":[数字]}]},不要其它文本。",
        ("detail", "decisions") => "提取聊天中做出的决策及理由,只输出 JSON {\"decisions\":[{\"title\":\"...\",\"by\":\"...\",\"rationale\":\"...\",\"ref\":数字}]},不要其它文本。",
        _ => "你是聊天内容分析助手,根据聊天记录输出分析结果。",
    }
}

#[tauri::command]
pub async fn summary_get_state(svc: State<'_, Arc<SummaryService>>) -> AppResult<serde_json::Value> {
    let prefs = svc.prefs.lock().await.clone();
    let engine_ok = svc.queue.runner.engine_path.exists();
    let model_ok = svc.queue.current_model.lock().await.exists();
    Ok(serde_json::json!({
        "prefs": prefs,
        "engineDownloaded": engine_ok,
        "modelDownloaded": model_ok,
    }))
}

#[tauri::command]
pub async fn summary_save_prefs(svc: State<'_, Arc<SummaryService>>, prefs: serde_json::Value) -> AppResult<()> {
    let mut g = svc.prefs.lock().await;
    let prev_size = g.get("modelSize").and_then(|v| v.as_str()).unwrap_or("0.5b").to_string();
    if let (Some(mode), Some(source), Some(size), Some(n)) = (
        prefs.get("mode").and_then(|v| v.as_str()),
        prefs.get("source").and_then(|v| v.as_str()),
        prefs.get("modelSize").and_then(|v| v.as_str()),
        prefs.get("contextN").and_then(|v| v.as_u64()),
    ) {
        *g = serde_json::json!({ "mode": mode, "source": source, "modelSize": size, "contextN": n });
        // 档位切换 → 队列切换到对应模型文件
        if size != prev_size {
            let size_enum = if size == "1.5b" { crate::summary::downloader::ModelSize::B15 } else { crate::summary::downloader::ModelSize::B05 };
            let model_path = svc.downloader.model_path(size_enum);
            svc.queue.set_current_model(model_path).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn summary_set_api(svc: State<'_, Arc<SummaryService>>, base_url: String, api_key: String, model: String) -> AppResult<()> {
    // LlmConfig 无 Default,用 From<LlmConfigInput>(dto.rs:436)
    let cfg: crate::dto::LlmConfig = crate::dto::LlmConfigInput {
        system_prompt: None,
        base_url: Some(base_url),
        api_key: Some(api_key),
        model: Some(model),
        provider: Some("openai".into()),
    }
    .into();
    *svc.queue.api_cfg.lock().await = Some(cfg);
    Ok(())
}

#[tauri::command]
pub async fn summary_clear_api(svc: State<'_, Arc<SummaryService>>) -> AppResult<()> {
    *svc.queue.api_cfg.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn summary_download(svc: State<'_, Arc<SummaryService>>, what: String, size: Option<String>) -> AppResult<()> {
    let target = match what.as_str() {
        "engine" => DownloadWhat::Engine,
        "model" => DownloadWhat::Model(if size.as_deref() == Some("1.5b") { ModelSize::B15 } else { ModelSize::B05 }),
        _ => return Err(AppError::Core("unknown download target".into())),
    };
    let app = svc.downloader.app.clone();
    let queue = svc.queue.clone(); // Arc<SummaryQueue>
    let dl = svc.downloader.clone_dl();
    tokio::spawn(async move {
        match dl.download(target).await {
            Ok(_) => {
                // 模型下载完成 → 队列切到该档位(downloader 内部已 emit done)
                if let DownloadWhat::Model(size) = target {
                    queue.set_current_model(dl.model_path(size)).await;
                }
            }
            Err(e) => {
                // 失败发 error 事件,前端显示失败原因
                let _ = app.emit("download-progress", &serde_json::json!({
                    "status": "error", "message": e.to_string(),
                }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn summary_enqueue(
    svc: State<'_, Arc<SummaryService>>,
    chat_id: u64,
    lane: String,
    kind: String,
    prompt: String,
    prev_analysis: Option<String>,
) -> AppResult<()> {
    // prompt = 前端 formatWindowLines 已组装好的行(含绝对时间),后端不重格式化
    let messages = SummaryService::build_messages(&prompt, &lane, &kind);
    let job = SummaryJob {
        chat_id,
        lane: if lane == "bubble" { Lane::Bubble } else { Lane::Detail },
        kind,
        messages,
        prev_analysis,
        timeout: if lane == "bubble" { std::time::Duration::from_secs(60) } else { std::time::Duration::from_secs(120) },
    };
    svc.queue.enqueue(job).await?;
    Ok(())
}
```

- [ ] **Step 3: downloader 加 `clone_dl` 辅助**

在 `src-tauri/src/summary/downloader.rs` 的 `impl Downloader` 内追加（供 spawn 移动）：

```rust
pub fn clone_dl(&self) -> Self {
    Self {
        http: self.http.clone(),
        models_dir: self.models_dir.clone(),
        app: self.app.clone(),
        engine_tag: self.engine_tag.clone(),
    }
}
```

- [ ] **Step 4: lib.rs 注册命令 + manage SummaryService**

修改 `src-tauri/src/lib.rs` setup 末尾（`app.manage(state)` 之前）构造 SummaryService：

```rust
// 主题总结服务:下载 + 队列 + 本地/API 推理(managed resource, 命令层共享)
{
    use tauri::Manager;
    let models_dir = dir.join("models");
    let engine_exe = if cfg!(target_os = "windows") { "llama-server.exe" } else { "llama-server" };
    let runner = Arc::new(crate::summary::runner::LocalRunner::new(models_dir.join(engine_exe)));
    // 默认档位 0.5b 的模型文件(切换由 summary_save_prefs 更新)
    let default_model = models_dir.join(crate::summary::downloader::ModelSize::B05.file_name());
    let svc = crate::summary::commands::SummaryService::new(
        app.handle().clone(), dir.clone(), runner, default_model,
    );
    app.manage(svc);
}
```

> **模型切换路径:** 档位经 `summary_save_prefs` 切换队列的 `current_model`(调 `set_current_model`)。下载完成时(下载器 emit done 后)命令层也应把队列切到刚下载的档位——`summary_download` 的 spawn 闭包里调 `svc.queue.set_current_model(model_path)`(需先克隆 Arc<SummaryQueue> 进闭包)。执行者补上。

在 `invoke_handler` 数组末尾追加：

```rust
// 主题总结(LLM)
commands::summary_get_state,
commands::summary_save_prefs,
commands::summary_set_api,
commands::summary_clear_api,
commands::summary_download,
commands::summary_enqueue,
```

在 lib.rs `mod` 区确认已有 `mod summary;`（Task 4 加过），并确保 `summary::commands::*` 可直接引用（在 `mod summary;` 下 `summary::commands` 需在 `summary/mod.rs` 声明 `pub mod commands;` —— 若 Task 4 的 mod.rs 只声明了 downloader/queue/runner/sse，需补 `pub mod commands;`）。

- [ ] **Step 5: 唯一一次全量 cargo check**

Run: `cargo check` (在 `src-tauri/` 下)
Expected: 编译通过。**注意耗时 5-7 分钟(连带 core)。** 若有错,修到过为止。
> 这是整个计划唯一一次 Rust 编译校验,务必在此处彻底。

- [ ] **Step 6: 清理占位逻辑 + commit**

确认 runner 路径处理逻辑完善后：

```bash
git add src-tauri/src/summary/ src-tauri/src/llm.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(summary): 后端推理服务(下载器+llama-server子进程+队列+命令+流式SSE)"
```

---

# Phase 3 — 前端 UI

## Task 8: 设置页「智能」section + 下载面板

**Files:**
- Modify: `src/types.ts`（`SettingsSection` 加 `'intelligence'`）
- Modify: `src/pages/settingsPage.ts`（sections 数组 + renderSettingsMain case + renderIntelligence）
- Create: `src/utils/summaryPrefs.ts`

- [ ] **Step 1: types.ts 加 section**

修改 `src/types.ts` 的 `SettingsSection` 联合类型：

```ts
export type SettingsSection = 'account' | 'appearance' | 'team' | 'notifications' | 'plugins' | 'about' | 'github' | 'intelligence';
```

- [ ] **Step 2: summaryPrefs.ts 偏好读写**

创建 `src/utils/summaryPrefs.ts`：

```ts
// 主题总结偏好:localStorage 持久化(模式/来源/模型档位/上下文条数 N)。
export interface SummaryPrefs {
  mode: 'off' | 'wordfreq' | 'llm';
  source: 'local' | 'api';
  modelSize: '0.5b' | '1.5b';
  contextN: number;
}
const KEY = 'peyt.summary.prefs';
export const DEFAULT_PREFS: SummaryPrefs = { mode: 'wordfreq', source: 'local', modelSize: '0.5b', contextN: 50 };

export function getSummaryPrefs(): SummaryPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<SummaryPrefs>;
    return {
      mode: p.mode ?? DEFAULT_PREFS.mode,
      source: p.source ?? DEFAULT_PREFS.source,
      modelSize: p.modelSize ?? DEFAULT_PREFS.modelSize,
      contextN: typeof p.contextN === 'number' ? Math.min(200, Math.max(10, p.contextN)) : DEFAULT_PREFS.contextN,
    };
  } catch { return { ...DEFAULT_PREFS }; }
}
export function saveSummaryPrefs(p: SummaryPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}
```

- [ ] **Step 3: settingsPage 加 section + case**

修改 `src/pages/settingsPage.ts`：
1. `sections` 数组加一项（放在 github 后）:
```ts
  { id: 'intelligence', icon: 'sparkles', label: '智能' },
```
2. `renderSettingsMain` switch 加 case:
```ts
    case 'intelligence': await renderIntelligence(main); break;
```
3. 新增 `renderIntelligence` 函数（见 Step 4）。

- [ ] **Step 4: 实现 renderIntelligence**

在 `src/pages/settingsPage.ts` 末尾追加：

```ts
// ── 智能 ──────────────────────────────────────────────
// 主题总结引擎:模式(off/词频/LLM) + 来源(本地/API) + 模型下载面板(选档后点下载)。
import { getSummaryPrefs, saveSummaryPrefs, type SummaryPrefs } from '../utils/summaryPrefs.js';
async function renderIntelligence(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const prefs = getSummaryPrefs();
  const section = document.createElement('div');
  section.className = 'settings-section';
  section.innerHTML = '<h2>智能</h2>';

  // 引擎状态(后端查询)
  let engineDownloaded = false;
  let modelDownloaded = false;
  try {
    const s = await call<{ engineDownloaded: boolean; modelDownloaded: boolean }>('summary_get_state');
    engineDownloaded = s.engineDownloaded;
    modelDownloaded = s.modelDownloaded;
  } catch { /* 未接 Tauri 时默认 false */ }

  // 模式
  const modeSeg = ui.segmented({
    items: [
      { value: 'off', label: '关闭' },
      { value: 'wordfreq', label: '词频' },
      { value: 'llm', label: 'LLM' },
    ],
    value: prefs.mode,
    onChange: (v) => {
      prefs.mode = v as SummaryPrefs['mode'];
      saveSummaryPrefs(prefs);
    },
  });
  section.appendChild(ui.field({ label: '总结引擎', children: modeSeg }));

  // 来源(LLM 模式下)
  if (prefs.mode === 'llm') {
    const srcSeg = ui.segmented({
      items: [
        { value: 'local', label: '本地模型' },
        { value: 'api', label: 'API' },
      ],
      value: prefs.source,
      onChange: (v) => {
        prefs.source = v as SummaryPrefs['source'];
        saveSummaryPrefs(prefs);
      },
    });
    section.appendChild(ui.field({ label: 'LLM 来源', children: srcSeg }));

    // 上下文条数
    const nInput = ui.input({ value: String(prefs.contextN), type: 'number' });
    nInput.addEventListener('change', () => {
      const n = Number(nInput.value);
      if (!Number.isNaN(n)) { prefs.contextN = Math.min(200, Math.max(10, n)); saveSummaryPrefs(prefs); }
    });
    section.appendChild(ui.field({ label: '上下文条数(注入最近 N 条)', children: nInput, help: '10-200,默认 50。字数硬上限 4000 自动截断。' }));
  }

  // 本地模型下载面板(来源=local)
  if (prefs.mode === 'llm' && prefs.source === 'local') {
    const sizeSeg = ui.segmented({
      items: [
        { value: '0.5b', label: '0.5B (~0.4GB)' },
        { value: '1.5b', label: '1.5B (~1GB)' },
      ],
      value: prefs.modelSize,
      onChange: (v) => {
        prefs.modelSize = v as SummaryPrefs['modelSize'];
        saveSummaryPrefs(prefs);
      },
    });
    section.appendChild(ui.field({ label: '模型档位', children: sizeSeg }));

    const dl = ui.button({
      label: modelDownloaded ? '已下载' : '下载',
      icon: 'download',
      variant: modelDownloaded ? 'ghost' : 'primary',
      disabled: modelDownloaded,
      onClick: async () => {
        // ui.segmented 是 button.ui-segment[data-value], 非 radio
        const size = sizeSeg.querySelector('.ui-segment.active')?.getAttribute('data-value') === '1.5b' ? '1.5b' : '0.5b';
        try {
          await call('summary_download', { what: 'model', size });
        } catch (e) { ui.toast(e instanceof Error ? e.message : String(e)); }
      },
    });
    section.appendChild(ui.field({ label: '模型下载', children: dl }));

    // 进度条(监听 download-progress)
    const bar = document.createElement('div');
    bar.className = 'settings-toggle-hint';
    bar.textContent = modelDownloaded ? '引擎与模型已就绪' : (engineDownloaded ? '引擎就绪,等待下载模型' : '点击下载引擎与模型');
    section.appendChild(bar);

    const { listen } = await import('@tauri-apps/api/event');
    void listen('download-progress', (ev) => {
      const p = ev.payload as { what: string; status: string; bytes?: number; total?: number; rate?: number };
      if (p.what === 'model' || p.what === 'engine') {
        if (p.status === 'downloading' && p.total) {
          const pct = Math.round(((p.bytes ?? 0) / p.total) * 100);
          bar.textContent = `${p.what === 'engine' ? '引擎' : '模型'} ${pct}% · ${fmtBytes(p.bytes ?? 0)}/${fmtBytes(p.total)} · ${p.rate ?? 0} B/s`;
        } else if (p.status === 'done') {
          bar.textContent = '下载完成';
          ui.toast(`${p.what} 下载完成`);
        }
      }
    });
  }

  main.appendChild(section);
}

function fmtBytes(n: number): string {
  if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: commit**

```bash
git add src/types.ts src/pages/settingsPage.ts src/utils/summaryPrefs.ts
git commit -m "feat(summary): 设置页智能 section + 模型下载面板"
```

---

## Task 9: 气泡状态机 + chatView 集成(降级词频)

**Files:**
- Create: `src/components/summaryBubble.ts`
- Modify: `src/chat/chatView.ts`（scheduleTopicRefresh 改造:LLM 模式走队列 + 状态机,降级词频）

- [ ] **Step 1: 实现气泡状态机**

创建 `src/components/summaryBubble.ts`：

```ts
// 主题气泡状态机:idle / summarizing(流式) / done / error / fallback。
// 由 summary-event 驱动,呼吸灯只在 summarizing 亮。后端只发数据不碰 DOM。
import type { MsgDto } from '../types.js';
import { buildContextWindow, formatWindowLines } from '../utils/summaryContext.js';
import { getSummaryPrefs } from '../utils/summaryPrefs.js';
import { renderTopicBubbleHtml } from './wordCloud.js';
import { openSummaryDashboard } from './summaryDashboard.js';

export type BubbleStatus = 'idle' | 'summarizing' | 'done' | 'error' | 'fallback';
export interface BubbleState { status: BubbleStatus; text: string; }

const store = new Map<number, BubbleState>();
let chatId: number | null = null;
let resolveFn: ((t: string) => string) | null = null;

export function initSummaryBubble(cid: number, resolve: (t: string) => string): void {
  chatId = cid;
  resolveFn = resolve;
  if (!store.has(cid)) store.set(cid, { status: 'idle', text: '' });
}

/** LLM 模式下:防抖入队 bubble 总结。词频模式直接走 computeTopics(现状)。 */
export async function scheduleSummary(
  msgs: MsgDto[],
  resolve: (t: string) => string,
  n: number,
): Promise<BubbleState | null> {
  const prefs = getSummaryPrefs();
  if (prefs.mode !== 'llm') return null; // 词频/off 走原 computeTopics
  if (chatId == null) return null;
  // 前端去重 + 防抖:同 chat 已有 summarizing 则不重复
  const st = store.get(chatId);
  if (st && st.status === 'summarizing') return st;
  const window = buildContextWindow(msgs, resolve, prefs.contextN);
  if (window.length === 0) return { status: 'fallback', text: '暂无主题词' };
  const prompt = formatWindowLines(window); // 含绝对时间,后端不重格式化
  const prev = st && st.status === 'done' ? st.text : null;
  store.set(chatId, { status: 'summarizing', text: prev ?? '' });
  try {
    const { call } = await import('../api.js');
    await call('summary_enqueue', { chatId, lane: 'bubble', kind: 'bubble', prompt, prevAnalysis: prev });
  } catch {
    return { status: 'fallback', text: '暂无主题词' };
  }
  return store.get(chatId)!;
}

/** 处理 summary-event(delta 流式追加 / done / error)。返回新状态。 */
export function applySummaryEvent(ev: { chatId: number; lane: string; status: string; delta?: string; result?: string; error?: { code: string } }): BubbleState | null {
  if (ev.lane !== 'bubble') return null;
  if (ev.chatId !== chatId) return null;
  const st = store.get(ev.chatId) ?? { status: 'idle', text: '' };
  if (ev.status === 'streaming') {
    st.status = 'summarizing';
    st.text += ev.delta ?? '';
  } else if (ev.status === 'done') {
    st.status = 'done';
    st.text = ev.result ?? st.text;
  } else if (ev.status === 'error') {
    st.status = 'error'; // 气泡显示已流到的文本;点击可刷新
    if (ev.error?.code === 'cancelled') return st; // 正常中断,不降级
    if (!st.text) st.text = '暂无主题词';
  }
  store.set(ev.chatId, st);
  return st;
}

/** 最近一次词频簇(LLM 失败时降级显示用)。scheduleTopicRefresh 前置填充。 */
let fallbackClusters: TopicCluster[] = [];
export function setFallbackClusters(c: TopicCluster[]): void { fallbackClusters = c; }

export function renderBubbleHtml(st: BubbleState): string {
  if (st.status === 'summarizing') {
    const body = st.text ? escapeHtml(st.text) : '总结中…';
    return `<div class="topic-bubble breathing" data-topic-bubble="1">${iconSvg('hash', { width: 14, height: 14 })}<span>${body}</span></div>`;
  }
  if (st.status === 'done') {
    const html = renderParsed(parseTags(st.text), () => {});
    return `<div class="topic-bubble" data-topic-bubble="1">${iconSvg('hash', { width: 14, height: 14 })}<span>${html}</span></div>`;
  }
  // idle / error / fallback → 降级显示词频簇短语
  return renderTopicBubbleHtml(fallbackClusters);
}

/** 绑定气泡点击 → 打开主题分析看板。 */
export function bindBubbleClick(chip: HTMLElement): void {
  chip.querySelector('[data-topic-bubble="1"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement;
    void import('./summaryDashboard.js').then((m) => {
      m.openSummaryDashboard(anchor, chatId!, state.messages, resolveFn!);
    });
  });
}
```

> **import 说明:** `summaryBubble.ts` 顶部直接 import `parseTags`/`renderParsed`(来自 `./tagParser.js`,无循环依赖)、`renderTopicBubbleHtml`(来自 `./wordCloud.js`)、`escapeHtml`、`iconSvg`、`TopicCluster` 类型。注意 summaryDashboard.ts 才是主入口,summaryBubble 不应 import 它(避免循环)。

- [ ] **Step 2: chatView scheduleTopicRefresh 改造**

修改 `src/chat/chatView.ts` 的 `scheduleTopicRefresh`（约 695-723 行），LLM 模式走 summary 队列，词频模式走原 computeTopics：

```ts
function scheduleTopicRefresh(): void {
  if (topicTimer) clearTimeout(topicTimer);
  topicTimer = setTimeout(async () => {
    topicTimer = null;
    try {
      await initSegmenter();
    } catch (err) {
      console.warn('[word-freq] jieba init failed:', err);
      document.querySelector('[data-topic-chip="1"]')?.remove();
      return;
    }
    const prefs = getSummaryPrefs();
    const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
    if (!chip) return;
    if (prefs.mode === 'llm') {
      // LLM 模式:先算词频簇作降级兜底,再交给气泡状态机(流式追加/失败降级)
      setFallbackClusters(computeTopics(state.messages, resolveMessageText, 4));
      const st = await scheduleSummary(state.messages, resolveMessageText, prefs.contextN);
      if (st) {
        chip.innerHTML = renderBubbleHtml(st);
        bindBubbleClick(chip);
      }
      return;
    }
    // 词频/off:原 computeTopics
    const clusters = computeTopics(state.messages, resolveMessageText, 4);
    topicWords = clusters;
    chip.innerHTML = renderTopicBubbleHtml(clusters);
    chip.querySelector('[data-topic-bubble="1"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openWordAnalysisPopup(e.currentTarget as HTMLElement, topicWords);
    });
  }, 300);
}
```

> **import 清单(summmaryBubble.ts 顶部):** `escapeHtml`(./escape.js)、`iconSvg`(./icon.js)、`renderTopicBubbleHtml`(./wordCloud.js)、`type TopicCluster`(../utils/wordAnalysis.js)、`parseTags`/`renderParsed`(./tagParser.js)、`buildContextWindow`/`formatWindowLines`(../utils/summaryContext.js)、`getSummaryPrefs`(../utils/summaryPrefs.js)、`state`(../state.js)。`bindBubbleClick` 动态 import `./summaryDashboard.js` 打开看板(避免顶层循环依赖)。

- [ ] **Step 3: 监听 summary-event**

在 chatView（或模块初始化处）挂一次全局监听：

```ts
import { listen } from '@tauri-apps/api/event';
let summaryEventBound = false;
function bindSummaryEvents(): void {
  if (summaryEventBound) return;
  summaryEventBound = true;
  void listen('summary-event', (ev) => {
    const p = ev.payload as { chatId: number; lane: string; status: string; delta?: string; result?: string; error?: { code: string } };
    const st = applySummaryEvent(p);
    if (!st) return;
    const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
    if (chip) {
      chip.innerHTML = renderBubbleHtml(st);
      bindBubbleClick(chip);
    }
  });
}
```

> **注意:** `bindSummaryEvents` 应在 chatView 初始化(打开会话)时调用一次。`bindBubbleClick` 绑定气泡点击 → `openSummaryDashboard(anchor, chatId)`。

- [ ] **Step 4: styles.css 呼吸灯**

在 `src/styles.css` 追加：

```css
/* 主题气泡呼吸灯:summarizing 状态阴影脉动 */
.topic-bubble.breathing {
  animation: bubble-breathe 1.6s ease-in-out infinite;
  box-shadow: 0 0 0 0 rgba(52, 199, 89, 0.45);
}
@keyframes bubble-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(52, 199, 89, 0.45); }
  50% { box-shadow: 0 0 12px 4px rgba(52, 199, 89, 0.25); }
}
/* 标签引用 chip */
.mention-chip {
  display: inline-block; padding: 1px 6px; margin: 0 2px;
  border-radius: 6px; background: rgba(52, 199, 89, 0.12); color: var(--text);
  font-size: 12px; cursor: pointer; text-decoration: none;
}
.mention-chip:hover { background: rgba(52, 199, 89, 0.22); }
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: commit**

```bash
git add src/components/summaryBubble.ts src/chat/chatView.ts src/styles.css
git commit -m "feat(summary): 气泡状态机 + LLM 模式流式,降级词频"
```

---

## Task 10: 看板弹窗 + 分析类型注册表

**Files:**
- Create: `src/components/summaryDashboard.ts`

- [ ] **Step 1: 实现看板(注册表 + 各类型渲染 + 独立入队)**

创建 `src/components/summaryDashboard.ts`：

```ts
// 主题分析看板:popup 平铺全部分析类型,每类独立入队/流式/状态/刷新。
// participation 走前端纯统计(local_stats)+ LLM 解读(stats_plus_llm)。
import { mountPopup } from './readReceiptsPopup.js';
import { iconSvg } from './icon.js';
import { escapeHtml } from './escape.js';
import { call } from '../api.js';
import type { MsgDto } from '../types.js';
import { buildContextWindow, formatWindowLines } from '../utils/summaryContext.js';
import { computeParticipation } from '../utils/participation.js';
import { getSummaryPrefs } from '../utils/summaryPrefs.js';
import { parseTags, renderParsed } from '../utils/tagParser.js';

export type AnalysisKind = 'summary' | 'participation' | 'action_items'
  | 'resources' | 'open_questions' | 'timeline' | 'decisions';

interface AnalysisType {
  kind: AnalysisKind;
  title: string;
  engine: 'llm' | 'local_stats' | 'stats_plus_llm';
  priority: number;
}

const ANALYSIS_TYPES: AnalysisType[] = [
  { kind: 'summary', title: '总结', engine: 'llm', priority: 0 },
  { kind: 'participation', title: '参与度', engine: 'stats_plus_llm', priority: 0 },
  { kind: 'action_items', title: '行动项', engine: 'llm', priority: 0 },
  { kind: 'resources', title: '资源', engine: 'llm', priority: 1 },
  { kind: 'open_questions', title: '悬而未决', engine: 'llm', priority: 1 },
  { kind: 'timeline', title: '话题演变', engine: 'llm', priority: 1 },
  { kind: 'decisions', title: '决策', engine: 'llm', priority: 2 },
];

// 每 chat 每 kind 的状态:done 内容缓存 + 显示
const detailCache = new Map<string, { kind: AnalysisKind; status: string; text: string }>();

export function openSummaryDashboard(anchor: HTMLElement, chatId: number, msgs: MsgDto[], resolve: (t: string) => string): void {
  const prefs = getSummaryPrefs();
  if (prefs.mode !== 'llm') { void openWordAnalysisPopupFallback(anchor, msgs, resolve); return; }
  const window = buildContextWindow(msgs, resolve, prefs.contextN);
  const prompt = formatWindowLines(window); // 含绝对时间;participation 用结构化 window 本地统计

  const blocks = ANALYSIS_TYPES
    .sort((a, b) => a.priority - b.priority)
    .map((t) => `
      <div class="sd-block" data-kind="${t.kind}">
        <div class="sd-head">
          <span class="sd-title">${escapeHtml(t.title)}</span>
          <button class="sd-refresh" data-refresh="${t.kind}" title="刷新">${iconSvg('refresh', { width: 14, height: 14 })}</button>
        </div>
        <div class="sd-body" data-body="${t.kind}">加载中…</div>
      </div>`)
    .join('');

  mountPopup(
    `<div class="rr-head">会话主题分析<button class="sd-refresh-all" data-refresh-all="1">${iconSvg('refresh', { width: 14, height: 14 })} 全部刷新</button></div>
     <div class="sd-dashboard">${blocks}</div>`,
    anchor,
    'rr-popup sd-popup',
  );
  // 标记当前看板归属会话(单例监听靠 data-sd-chat 匹配,避免旧弹窗流污染)
  document.querySelector<HTMLElement>('.sd-popup')!.dataset.sdChat = String(chatId);

  const enqueue = (kind: AnalysisKind, force: boolean) => {
    const popup = document.querySelector<HTMLElement>('[data-sd-chat]');
    const body = popup?.querySelector<HTMLElement>(`[data-body="${kind}"]`);
    if (body) body.textContent = '分析中…';
    void call('summary_enqueue', { chatId, lane: 'detail', kind, prompt, prevAnalysis: null }).catch(() => {
      if (body) body.textContent = '分析失败';
    });
  };

  // participation 走本地统计,即时显示
  const pBody = document.querySelector<HTMLElement>(`[data-body="participation"]`);
  if (pBody) {
    const p = computeParticipation(window);
    pBody.innerHTML = renderParticipation(p);
    // 统计即时出;LLM 解读通过 detail 车道(同一 kind 'participation',由 LLM 输出解读文本)
    enqueue('participation', false);
  }
  // summary 首个默认入队
  enqueue('summary', false);
  // 其余懒加载:点击块头刷新时入队
  document.querySelectorAll<HTMLElement>('[data-refresh]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.refresh as AnalysisKind;
      enqueue(kind, true);
    });
  });

  bindDetailEvents();
}

function renderParticipation(p: { per_member: Array<{ name: string; msg_count: number; char_count: number; active_days: number }> }): string {
  const rows = p.per_member
    .map((m) => `<div class="sd-p-row"><span>${escapeHtml(m.name)}</span><span>${m.msg_count} 条 · ${m.char_count} 字 · ${m.active_days} 天</span></div>`)
    .join('');
  return `<div class="sd-p-stat">${rows}</div>`;
}

let detailBound = false;
function bindDetailEvents(): void {
  if (detailBound) return;
  detailBound = true;
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen('summary-event', (ev) => {
      const p = ev.payload as { chatId: number; lane: string; kind: string; status: string; delta?: string; result?: string; error?: { code: string } };
      if (p.lane !== 'detail') return;
      // 单例监听:只更新当前打开的看板(mountPopup 每次重建,data-sd-chat 恒为最新)
      const popup = document.querySelector<HTMLElement>('[data-sd-chat]');
      if (!popup || popup.dataset.sdChat !== String(p.chatId)) return;
      const key = `${p.chatId}:${p.kind}`;
      const cur = detailCache.get(key) ?? { kind: p.kind as AnalysisKind, status: 'idle', text: '' };
      if (p.status === 'streaming') { cur.status = 'streaming'; cur.text += p.delta ?? ''; }
      else if (p.status === 'done') { cur.status = 'done'; cur.text = p.result ?? cur.text; }
      else if (p.status === 'error') { cur.status = 'error'; }
      detailCache.set(key, cur);
      const body = popup.querySelector<HTMLElement>(`[data-body="${p.kind}"]`);
      if (!body) return;
      if (cur.status === 'done') body.innerHTML = renderDetailBody(p.kind as AnalysisKind, cur.text);
      else if (cur.status === 'error') body.innerHTML = '<div class="wc-empty">分析失败,点击刷新重试</div>';
      else body.textContent = cur.text || '分析中…';
    });
  });
}

function renderDetailBody(kind: AnalysisKind, text: string): string {
  // summary:XML 段落,支持标签;其余按 JSON 字符串展示(后续按 schema 渲染)
  if (kind === 'summary') {
    const segs = parseTags(text);
    return `<div class="sd-summary">${renderParsed(segs, () => {})}</div>`;
  }
  return `<pre class="sd-json">${escapeHtml(text)}</pre>`;
}

async function openWordAnalysisPopupFallback(anchor: HTMLElement, msgs: MsgDto[], resolve: (t: string) => string): Promise<void> {
  const { openWordAnalysisPopup } = await import('./wordCloud.js');
  const { computeTopics } = await import('../utils/wordAnalysis.js');
  openWordAnalysisPopup(anchor, computeTopics(msgs, resolve, 4));
}
```

- [ ] **Step 2: styles.css 看板样式**

在 `src/styles.css` 追加：

```css
/* 主题分析看板 */
.sd-dashboard { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; }
.sd-block { border-radius: 12px; background: var(--surface-2, rgba(128,128,128,.08)); padding: 10px 12px; }
.sd-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.sd-title { font-size: 13px; font-weight: 600; color: var(--text); }
.sd-refresh { background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 2px; }
.sd-refresh:hover { color: var(--text); }
.sd-refresh-all { background: none; border: none; cursor: pointer; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.sd-body { font-size: 13px; color: var(--text-secondary); }
.sd-summary { line-height: 1.6; color: var(--text); }
.sd-json { white-space: pre-wrap; word-break: break-all; font-family: monospace; font-size: 12px; color: var(--text-secondary); }
.sd-p-row { display: flex; justify-content: space-between; padding: 3px 0; }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: commit**

```bash
git add src/components/summaryDashboard.ts src/styles.css
git commit -m "feat(summary): 主题分析看板(注册表+participation本地统计+独立入队)"
```

---

# Phase 4 — 端到端验证

## Task 11: tauri dev 手动冒烟 + 修复

**Files:** 无新建;按清单在 `tauri dev` 验证并修复发现的 bug。

- [ ] **Step 1: 全量类型 + 构建检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: 冒烟清单(手动,tauri dev)**

逐项验证:
1. **设置 → 智能**:选档 0.5B/1.5B(仅记录选择,不触发下载);点「下载」→ 进度条/百分比/已下载/总大小/ETA 合理排版。
2. **下载完成**:引擎 + 模型均「已下载」;`app-data/models/` 有 llama-server(.exe) + gguf。
3. **首次总结**:打开会话 → 气泡呼吸灯 → 「总结中…」→ 首 token 实时替换(打字机)→ done。
4. **新消息**:旧摘要保留 + 静默重新总结 → 新摘要覆盖(不闪空)。
5. **看板**:点气泡 → 弹窗看板平铺 7 类;summary 一段话含 `<message>`/`<user>` 可点;participation 统计秒出 + LLM 解读。
6. **标签跳转**:点 `<message>` → 精确/模糊匹配 → 滚动 + 高亮;多条 → 鼠标旁列表。
7. **降级**:删除模型文件重启 → 气泡退词频;API 模式配错 key → `api_auth` toast + 退词频。
8. **API 余额**:配一个余额不足的 key → `api_quota` toast + 停该聊天队列。
9. **附件隔离**:含附件消息的会话 → AI 只见 `[附件: 文件名]`,不见内容。
10. **跨端**:至少本机(Windows)完整跑通;macOS/Linux 冒烟由用户环境验证。

- [ ] **Step 3: 修复发现的问题 + 复验**

修复所有冒烟问题后重跑 Step 1 类型检查,再验证受影响项。

- [ ] **Step 4: 最终 commit**

```bash
git add -A
git commit -m "fix(summary): 端到端冒烟修复"
```

---

## Self-Review 对照

**Spec 覆盖:**
- §4.4 窗口(方式2 + N 可调 + 4000 上限) → Task 1(buildContextWindow + CONTEXT_CHAR_LIMIT)+ Task 8(contextN 设置)
- §4.5 上下文时间注入 → Task 1(formatTs)
- §4.5 prompt(Bubble 纯文本 / Detail 每类型) → Task 7(build_messages + system_prompt 按 lane/kind)+ 看板 Task 10 各类型入队
- §5 附件隔离 → Task 1(toWindowMsg 附件一行 + 信封只取 payload.text)
- §6 标签白名单 + 模糊匹配 → Task 2(tagParser)
- §6.3 text_id = msg_id → Task 1(锚点用 msg_id)
- §6.4 本地锚(不跨库) → 设计决策,已内嵌
- §7 下载器(引擎/模型源/跨端 post-process/sha256) → Task 5
- §8 设置页(模式/来源/档位/下载面板/API/上下文条数) → Task 8
- §9 气泡状态机 + 呼吸灯 → Task 9
- §9.5 分析类型注册表 + 看板 + participation 双层 → Task 10
- §10 错误处理(错误码表/降级链/超时/引擎生命周期/api_quota) → Task 7(error code 从 message 提取)+ Task 9/10(降级)+ Task 11(冒烟)
- §11 测试(序列化/SSE/标签/队列/前端) → Task 1-3 断言 + Task 4 sse 单测

**占位符扫描:** 无 TBD/TODO。Task 6/7 的 runner 已重构为「不存 model_path,调用时传入」(模型档位可切换);Task 9 的 `bindBubbleClick`/`setFallbackClusters` 已具体实现。

**类型一致性:** `WindowMsg`/`WindowMsgInput`/`LlmConfig`/`ChatMessage`/`AnalysisKind` 跨任务签名一致。`renderBubbleHtml` 引用的 `iconSvg`/`escapeHtml` 与现有模块一致。
