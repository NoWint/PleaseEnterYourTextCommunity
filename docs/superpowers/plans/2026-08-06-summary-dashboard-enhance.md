# 总结看板增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 深化现有 6 分析板块 + 新增情绪氛围板块 + `<time>` 时间定位标签 + 提示词 few-shot 示例，符合 apple-design 视觉/动效。

**Architecture:** 前端 summaryDashboard.ts 加 mood 渲染器 + 参与度可视化 + 深化板块字段；tagParser/markdown 加 `<time>` 标签解析 + data-time-ref chip；chatView 加 jumpToTime 定位；后端 summary/commands.rs 的 system_prompt 加 few-shot 示例与 mood schema。

**Tech Stack:** Vanilla TS, marked, Rust (tauri), apple-design CSS 动效。

**Spec:** `docs/superpowers/specs/2026-08-06-summary-dashboard-enhance-design.md`

---

### Task 1: tagParser + markdown — `<time>` 标签

**Files:**
- Modify: `src/utils/tagParser.ts` (TAG_SRC/TAG_RE/TAG_ESCAPED + stripQuotes 已有)
- Modify: `src/utils/markdown.ts` (placeholderTags + restoreTags)

- [ ] **Step 1: tagParser 三套正则加 time 类型**

tagParser.ts 的 `MsgRef.type` 加 `'time'`；TAG_SRC/TAG_ESCAPED/TAG_RE 从 `(message|user)` 改为 `(message|user|time)`。parseSafeTags/parseTags 对 time 渲染 `data-time-ref` chip:

```ts
// parseSafeTags 里:
return kind === 'message'
  ? `<span class="ref-msg" data-ref="${value}">引用</span>`
  : kind === 'time'
    ? `<span class="ref-time" data-time="${value}">🕐 ${escapeHtml(displayTime(value))}</span>`
    : `<span class="ref-user" data-user="${value}">@${value}</span>`;
```

加 `displayTime(v)` helper:解析时间字符串 → 显示「HH:MM」(仅时分)或「MM-DD HH:MM」(完整),非法返回原样。

```ts
/** 解析时间值 → 显示标签。支持 14:30 / 2026-08-05 / 2026-08-05 14:30。非法 → 原样。 */
export function displayTime(v: string): string {
  const t = v.trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  if (full) {
    const [, y, mo, d, h, mi] = full;
    return h ? `${mo}-${d} ${String(h).padStart(2, '0')}:${mi}` : `${mo}-${d}`;
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) return `${String(Number(hm[1])).padStart(2, '0')}:${hm[2]}`;
  return v;
}
```

parseTags/renderParsed 同样:time → `<span class="mention-chip" data-time-ref="...">🕐 ...</span>`。

- [ ] **Step 2: markdown.ts 同步**

placeholderTags 正则加 time;restoreTags 生成 time chip:

```ts
const chip = t.kind === 'message'
  ? `<a class="mention-chip" data-msg-ref="${escapeHtml(t.value)}">@消息 ${escapeHtml(t.value)}</a>`
  : t.kind === 'time'
    ? `<span class="mention-chip" data-time-ref="${escapeHtml(t.value)}">🕐 ${escapeHtml(displayTime(t.value))}</span>`
    : `<span class="mention-chip" data-user-ref="${escapeHtml(t.value)}">@${escapeHtml(t.value)}</span>`;
```

markdown.ts 需 import `displayTime`(从 tagParser,检查循环依赖——markdown 已 import escapeHtml,加 displayTime 即可;或本地复制)。若循环依赖,本地复制 displayTime。

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: 无输出(通过)

- [ ] **Step 4: 提交**

```bash
git add src/utils/tagParser.ts src/utils/markdown.ts
git commit -m "feat(summary): <time> 标签解析 + data-time-ref chip(三套解析器同步)"
```

---

### Task 2: 新增情绪氛围板块渲染

**Files:**
- Modify: `src/components/summaryDashboard.ts` (AnalysisKind + ANALYSIS_TYPES + renderDetailBody + renderMood)

- [ ] **Step 1: 加 mood kind + 类型**

AnalysisKind 加 `'mood'`;ANALYSIS_TYPES 插在 summary 后:

```ts
{ kind: 'mood', title: '情绪氛围', icon: 'smile', engine: 'llm', priority: 0 },
```

isJsonKind 加 mood;renderDetailBody 加 `case 'mood': return renderMood(text);`

- [ ] **Step 2: 写 renderMood**

```ts
/** mood: {overall, score, emoji, summary, highlights:[{text,emoji}]} → 情绪卡片。 */
function renderMood(text: string): string {
  const d = safeParseJson(text) as {
    overall?: string; score?: number; emoji?: string; summary?: string;
    highlights?: Array<{ text?: string; emoji?: string }>;
  } | null;
  if (!d || typeof d !== 'object') return fallbackJson(text);
  const score = typeof d.score === 'number' ? Math.max(0, Math.min(100, d.score)) : 50;
  const tone = score >= 66 ? 'positive' : score >= 34 ? 'neutral' : 'negative';
  const emoji = d.emoji || '😐';
  const overall = d.overall || (tone === 'positive' ? '积极' : tone === 'negative' ? '消极' : '中立');
  const highlights = Array.isArray(d.highlights)
    ? d.highlights.map((h) =>
        `<div class="sd-mood-hl"><span class="sd-mood-hl-emoji">${escapeHtml(h.emoji || '•')}</span><span class="sd-mood-hl-text">${escapeHtml(h.text ?? '')}</span></div>`).join('')
    : '';
  return `<div class="sd-mood">
    <div class="sd-mood-top">
      <div class="sd-mood-emoji sd-mood-${tone}">${escapeHtml(emoji)}</div>
      <div class="sd-mood-meta">
        <span class="sd-mood-overall">${escapeHtml(overall)}</span>
        <div class="sd-mood-bar"><div class="sd-mood-bar-fill sd-mood-${tone}" style="width:${score}%"></div></div>
      </div>
    </div>
    ${d.summary ? `<div class="sd-mood-summary sd-markdown">${renderMarkdown(d.summary)}</div>` : ''}
    ${highlights ? `<div class="sd-mood-hls">${highlights}</div>` : ''}
  </div>`;
}
```

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/components/summaryDashboard.ts
git commit -m "feat(summary): 情绪氛围板块渲染(mood JSON → emoji+色带+highlights)"
```

---

### Task 3: 参与度可视化

**Files:**
- Modify: `src/components/summaryDashboard.ts` (renderParticipationStat)

- [ ] **Step 1: 重写 renderParticipationStat 加可视化**

利用 computeParticipation 的 hours(24h)/density(逐日)/per_member。渲染:
- 活跃时段柱状条:24h 分桶,柱高=count/max,圆角顶。
- 消息趋势:逐日条。
- 成员对比条:相对宽度。

```ts
function renderParticipationStat(win: WindowMsg[]): string {
  const p = computeParticipation(win);
  const maxH = Math.max(1, ...p.hours.map((h) => h.count));
  const maxD = Math.max(1, ...p.density.map((d) => d.count));
  const maxM = Math.max(1, ...p.per_member.map((m) => m.msg_count));
  const bars = p.hours
    .map((h) => `<div class="sd-p-h-bar" style="height:${(h.count / maxH) * 100}%"><span class="sd-p-h-label">${h.hour}</span></div>`)
    .join('');
  const trend = p.density
    .map((d) => `<div class="sd-p-d-bar" style="height:${(d.count / maxD) * 100}%"><span class="sd-p-d-label">${d.day.slice(5)}</span></div>`)
    .join('');
  const members = p.per_member
    .map((m) => `<div class="sd-p-m-row"><span class="sd-p-name">${escapeHtml(m.name)}</span>
      <div class="sd-p-m-track"><div class="sd-p-m-fill" style="width:${(m.msg_count / maxM) * 100}%"></div></div>
      <span class="sd-p-nums">${m.msg_count} 条 · ${m.char_count} 字 · ${m.active_days} 天</span></div>`)
    .join('');
  return `<div class="sd-p-hours"><div class="sd-p-subtitle">活跃时段</div><div class="sd-p-h-chart">${bars}</div></div>
    <div class="sd-p-trend"><div class="sd-p-subtitle">消息趋势</div><div class="sd-p-d-chart">${trend}</div></div>
    <div class="sd-p-members"><div class="sd-p-subtitle">成员活跃</div>${members}</div>`;
}
```

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/components/summaryDashboard.ts
git commit -m "feat(summary): 参与度可视化(活跃时段柱状+消息趋势+成员对比)"
```

---

### Task 4: 深化板块(悬而未决/决策/行动项)

**Files:**
- Modify: `src/components/summaryDashboard.ts` (renderOpenQuestions/renderDecisions/renderActionItems)

- [ ] **Step 1: renderOpenQuestions 加 priority/due**

Schema 加可选 priority(high/medium/low)、due(字符串):

```ts
const rows = d.questions.map((q) => {
  const pri = q.priority === 'high' ? ' sd-q-pri-high' : q.priority === 'medium' ? ' sd-q-pri-med' : '';
  const due = q.due ? `<span class="sd-chip sd-chip-due">${escapeHtml(q.due)}</span>` : '';
  return `<div class="sd-item${pri}"><span class="sd-q-icon">?</span><span class="sd-item-text">${escapeHtml(q.text ?? '')}${refChip(q.ref)}</span><span class="sd-item-meta">${due}${q.asked_by ? `<span class="sd-chip">${escapeHtml(q.asked_by)}</span>` : ''}</span></div>`;
}).join('');
```

- [ ] **Step 2: renderDecisions 加 status/impact**

```ts
const cards = d.decisions.map((dc) => {
  const st = dc.status === 'done'
    ? `<span class="sd-dec-status sd-dec-done">✓</span>`
    : dc.status === 'pending' ? `<span class="sd-dec-status sd-dec-pending">○</span>` : '';
  const impact = dc.impact ? `<div class="sd-dec-impact">${escapeHtml(dc.impact)}</div>` : '';
  return `<div class="sd-dec">${st}<div class="sd-dec-head">${iconSvg('pin', { width: 14, height: 14 })}<span class="sd-dec-title">${escapeHtml(dc.title ?? '')}</span>${dc.by ? `<span class="sd-chip">${escapeHtml(dc.by)}</span>` : ''}${refChip(dc.ref)}</div>${dc.rationale ? `<div class="sd-dec-rationale">${escapeHtml(dc.rationale)}</div>` : ''}${impact}</div>`;
}).join('');
```

- [ ] **Step 3: renderActionItems 加进度/分类/持久化**

- 分类:assignee 区分个人/团队 chip。
- 进度条:已完成/总数。
- 勾选 localStorage 持久化:`sd-action-done:{chatId}:{kind}:{index}`。

```ts
function renderActionItems(text: string, chatId: number): string {
  const d = safeParseJson(text) as { items?: Array<{ text?: string; assignee?: string; due?: string; ref?: number }> } | null;
  if (!d || !Array.isArray(d.items)) return fallbackJson(text);
  const storeKey = (i: number) => `sd-action-done:${chatId}:action_items:${i}`;
  const doneCount = d.items.filter((_, i) => localStorage.getItem(storeKey(i)) === '1').length;
  const rows = d.items.map((it, i) => {
    const checked = localStorage.getItem(storeKey(i)) === '1';
    const meta = [
      it.assignee ? `<span class="sd-chip">${escapeHtml(it.assignee)}</span>` : '',
      it.due ? `<span class="sd-chip sd-chip-due">${escapeHtml(it.due)}</span>` : '',
    ].filter(Boolean).join('');
    return `<label class="sd-item"><input type="checkbox" class="sd-check-input" data-action-i="${i}" ${checked ? 'checked' : ''}><span class="sd-checkbox"></span><span class="sd-item-text">${escapeHtml(it.text ?? '')}${refChip(it.ref)}</span>${meta ? `<span class="sd-item-meta">${meta}</span>` : ''}</label>`;
  }).join('');
  const pct = d.items.length ? Math.round((doneCount / d.items.length) * 100) : 0;
  return `<div class="sd-action-progress"><div class="sd-action-p-fill" style="width:${pct}%"></div><span>${doneCount}/${d.items.length}</span></div><div class="sd-list">${rows || '<div class="sd-empty">无行动项</div>'}</div>`;
}
```

`renderActionItems` 签名加 `chatId` 参数;`renderDetailBody(kind, text)` 改签名 `(kind, text, chatId)`。**5 处调用点同步传 chatId**:
- 行 130 renderStreaming 内:`renderDetailBody(kind, text, chatId)`(renderStreaming 需加 chatId 参数)
- 行 145 action_items 分支:`renderActionItems(text, chatId)`
- 行 330 openSummaryDashboard 缓存命中:`renderDetailBody(t.kind, cached.text, chatId)`
- 行 383 enqueueOverlay 缓存命中:`renderDetailBody(kind, cached.text, chatId)`
- 行 506 bindFullscreenEvents done:`renderDetailBody(p.kind as AnalysisKind, cur.text, p.chatId)`

`renderStreaming(kind, text)` 也加 chatId 参数,同步调用点(openSummaryDashboard/bindFullscreenEvents/scheduleRefresh)。

checkbox change 时持久化:在 bindFullscreenEvents 的 done 渲染后绑定 `.sd-check-input` change → 写 localStorage。

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/components/summaryDashboard.ts
git commit -m "feat(summary): 深化悬而未决(priority/due)/决策(status/impact)/行动项(进度+持久化)"
```

---

### Task 5: `<time>` 定位 — jumpToTime

**Files:**
- Modify: `src/chat/chatView.ts` (导出 jumpToTime + 时间解析)
- Modify: `src/components/summaryDashboard.ts` (看板内 time chip 点击)
- Modify: `src/chat/chatView.ts` (气泡内 time chip 点击委托)

- [ ] **Step 1: chatView 加 jumpToTime**

```ts
/** 解析 <time> 值 → unix 秒。支持 14:30 / 2026-08-05 / 2026-08-05 14:30。非法 → null。 */
export function parseTimeToTs(v: string): number | null {
  const t = v.trim();
  const full = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  if (full) {
    const [, y, mo, d, h, mi] = full;
    return Math.floor(new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0)).getTime() / 1000);
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) {
    const now = new Date();
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hm[1]), Number(hm[2])).getTime() / 1000);
  }
  return null;
}

/** 跳转到指定时间最近的消息(>= ts 第一条)。复用 jumpToMessage 高亮。 */
export async function jumpToTime(ts: number): Promise<void> {
  const target = state.messages.find((m) => m.ts >= ts);
  if (!target) { ui.toast('未找到该时间的消息'); return; }
  await jumpToMessage(target.msg_id);
}
```

- [ ] **Step 2: 看板 time chip 点击**

summaryDashboard overlay 委托加 `.ref-time, .mention-chip[data-time-ref]`:

```ts
const refEl = t.closest<HTMLElement>('.mention-chip[data-time-ref], .mention-chip[data-msg-ref], .mention-chip[data-user-ref], .sd-ref[data-ref], .ref-time[data-time], .ref-msg[data-ref], .ref-user[data-user]');
// time 分支:
if (refEl.dataset.timeRef != null || refEl.dataset.time != null) {
  const v = refEl.dataset.timeRef ?? refEl.dataset.time ?? '';
  const ts = parseTimeToTs(v);
  if (ts != null) {
    overlay.remove();
    void import('../chat/chatView.js').then(({ jumpToTime }) => jumpToTime(ts));
  }
  return;
}
```

- [ ] **Step 3: 气泡 time chip 点击**

chatView bindTopicChipClick 的 mention 检测加 `[data-time-ref]`:

```ts
const mention = (e.target as HTMLElement).closest<HTMLElement>('.mention-chip[data-user-ref], .mention-chip[data-msg-ref], .mention-chip[data-time-ref]');
// time 分支:
if (mention.dataset.timeRef != null) {
  const ts = parseTimeToTs(mention.dataset.timeRef);
  if (ts != null) void jumpToTime(ts);
  return;
}
```

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src/chat/chatView.ts src/components/summaryDashboard.ts
git commit -m "feat(summary): <time> 定位 jumpToTime(解析→找最近消息→跳转高亮)"
```

---

### Task 6: 提示词优化 + mood schema + 样式

**Files:**
- Modify: `src-tauri/src/summary/commands.rs` (system_prompt few-shot + mood)
- Modify: `src/styles.css` (apple 动效/样式: mood/参与度/深化/priority)

- [ ] **Step 1: 后端 prompt 加 few-shot + mood**

summary/commands.rs `system_prompt` 加:
- mood 分支:`("detail", "mood") => "...只输出 JSON {\"overall\":...,\"score\":0-100,\"emoji\":...,\"summary\":\"...\",\"highlights\":[{\"text\":...,\"emoji\":...}]},不要其它文本。"`
- 每板块示例段:在 detail summary prompt 末尾加 `例如:输入 [...] 输出:...`
- 标签规范段:加通用提示「引用时务必用 <message='id'>/<user='名'>/<time='时刻'>,不要省略引号,名字/时间原样输出」。
- 注意:后端 system_prompt 返回值是 `&'static str`,加示例会变长;保持简洁,示例 1 条。

- [ ] **Step 2: apple 样式**

styles.css 加:
- `.sd-mood` 系列:emoji 56px 圆形容器 + tone 色(positive 绿/neutral 黄/negative 红 `color-mix`)+ overall 毛玻璃 chip + 色带圆角条 + highlights stagger。弹簧入场 `scale(0.8)→1` damping 0.8。
- `.sd-p-h-chart/.sd-p-d-chart` 柱状条:flex 底对齐,圆角顶,逐柱 stagger。
- `.sd-p-m-fill` 对比条:圆角填充。
- `.sd-q-pri-high` 红色左缘药丸;`.sd-dec-status` 勾/圈;`.sd-action-progress` 圆角进度条。
- `.ref-time`/`.mention-chip[data-time-ref]` chip 样式(accent 下划线 + 微底)。
- 全部 `@media (prefers-reduced-motion: reduce)` 降级 opacity/静态。

- [ ] **Step 3: cargo check(后端)**

Run: `cd src-tauri && cargo check`(需 `export PATH="/c/Strawberry/perl/bin:$PATH"`)
Expected: 编译通过(仅 warning)

- [ ] **Step 4: Type-check + build**

Run: `npx tsc --noEmit && npx vite build`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/summary/commands.rs src/styles.css
git commit -m "feat(summary): 提示词 few-shot+mood schema + apple 动效样式"
```

---

### Task 7: 验证 + 收尾

**Files:** 无新增

- [ ] **Step 1: 全量验证**

Run: `npx tsc --noEmit && npx vite build && cd src-tauri && cargo check`
Expected: 全部通过

- [ ] **Step 2: 人工验收点**

- 情绪氛围:打开看板 → mood 板块显示 emoji + 色带 + 解读。
- 参与度:时段柱状 + 趋势 + 成员对比。
- `<time>`:AI 输出 `<time='14:30'>` → chip,点击跳最近消息。
- priority high:悬而未决红色高亮。
- 行动项勾选:刷新后保持。
- reduced-motion:动画禁用。

---

## Self-Review

**Spec 覆盖检查:**
- §2 `<time>` 标签 → Task 1(解析)+ Task 5(定位)✓
- §3 mood 板块 → Task 2 ✓
- §4.1 参与度可视化 → Task 3 ✓
- §4.2/4.3/4.4 深化 → Task 4 ✓
- §4.5 apple 动效 → Task 6 Step 2 ✓
- §5 提示词 → Task 6 Step 1 ✓
- §8 测试 → Task 7 验证 ✓

**Type 一致性:** `renderDetailBody(kind, text)` 在 Task 4 改签名加 chatId,调用点 renderStreaming/openSummaryDashboard/scheduleRefresh 需同步(检查:renderStreaming 调 renderDetailBody(kind, text) 处要传 chatId)。`parseTimeToTs`/`jumpToTime` 在 Task 5 定义、chatView 内使用。`displayTime` Task 1 定义、tagParser/markdown 使用(注意循环依赖——markdown 从 tagParser import displayTime,但 tagParser 不 import markdown,无循环)。

**占位符检查:** 无 TBD/TODO;每步含实际代码/命令。✓
