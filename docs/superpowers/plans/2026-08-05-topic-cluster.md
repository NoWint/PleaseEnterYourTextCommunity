# 会话主题聚类(Topic Cluster)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 chat-header 主题气泡从「孤立词频」升级为「句内共现 + 贪心聚类的词簇短语主题」,输出凝聚的 2-3 词主题簇(如「午饭 好吃」)。

**Architecture:** 在 `wordAnalysis.ts` 新增 `computeTopics`:对已加载消息逐条还原信封 → 切句 → 句内分词 → 两两建共现边(加权)→ 贪心聚类(阈值 0.3×maxEdge)→ 簇评分 → 返回 `TopicCluster[]`。展示层 `wordCloud.ts` 气泡改显示短语、弹窗改显示主题簇列表;`chatView.ts` 调用点改 `computeTopics`。纯前端,零新依赖。

**Tech Stack:** TypeScript / jieba-wasm(已有) / Vite(tsc 验证)

**验证方式:** 本仓库无测试框架。用 `node --experimental-strip-types`(或临时 tsx)直接跑 `wordAnalysis.ts` 纯函数断言输出,替代单测;最终 `npx tsc --noEmit` + `npm run build` 全量验证。

---

### Task 1: `wordAnalysis.ts` 新增共现矩阵 + 贪心聚类核心

**Files:**
- Modify: `src/utils/wordAnalysis.ts`(在现有 `computeTopWords` 后追加,不删旧函数)

- [ ] **Step 1: 新增 TopicCluster 接口 + 辅助纯函数**

在 `wordAnalysis.ts` 末尾追加:

```ts
// ── 会话主题聚类:句内共现 + 贪心聚类 ──────────────────────────
// 孤立词频只统计「哪个词多」,不统计「哪些词总一起出现」,导致主题碎。
// 升级:句内两两建共现边(加权),高频共现的词聚成簇,输出词簇短语。

export interface TopicCluster {
  words: string[];       // 簇内词(最高频在前)
  score: number;         // 簇得分 = Σ簇内词加权频次 + Σ簇内边权
  wordFreqs: WordFreq[]; // 簇内词频明细(弹窗展开用)
}

/** 按 [，。！？;、] 切短句。 */
function splitSentences(text: string): string[] {
  return text.split(/[，。！？;、\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 句内词去重(同词不重复计),返回有序数组。 */
function uniqueWords(words: string[]): string[] {
  return [...new Set(words)];
}

/** 词对规范键:a<b 保证无向。 */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
```

- [ ] **Step 2: 实现 computeTopics 主函数**

继续在 `wordAnalysis.ts` 末尾追加:

```ts
/**
 * 计算 Top n 主题簇:遍历已加载消息(倒序,index=1 最近),
 * 每条 resolveMessageText 还原信封 → 切句 → 分词 → 句内两两建共现边。
 * 边权 = 1/句内词数(短句归一) + 1/index(消息新鲜度)。
 * 贪心聚类:边权降序,阈值 = 0.3×最大边权,连簇后簇评分。
 */
export function computeTopics(
  msgs: MsgDto[],
  resolve: (text: string) => string,
  n: number,
): TopicCluster[] {
  // 1. 建共现矩阵:word → Map<word, weight>
  const cooccur = new Map<string, Map<string, number>>();
  // 2. 词频(加权):word → { count, weight }
  const freq = new Map<string, { count: number; weight: number }>();

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.is_info) continue;
    const text = resolve(m.text || '');
    if (!text) continue;
    const idx = msgs.length - i; // 1 = 最近

    for (const sentence of splitSentences(text)) {
      const words = uniqueWords(segmentText(sentence));
      if (words.length === 0) continue;
      const nWords = words.length;
      for (const w of words) {
        const f = freq.get(w) ?? { count: 0, weight: 0 };
        f.count += 1;
        f.weight += 1 / idx;
        freq.set(w, f);
      }
      // 两两建边
      for (let a = 0; a < nWords; a++) {
        for (let b = a + 1; b < nWords; b++) {
          const wa = words[a];
          const wb = words[b];
          let row = cooccur.get(wa);
          if (!row) { row = new Map(); cooccur.set(wa, row); }
          const cur = row.get(wb) ?? 0;
          row.set(wb, cur + 1 / nWords + 1 / idx);
        }
      }
    }
  }

  // 3. 收集边,降序
  const edges: Array<{ a: string; b: string; w: number }> = [];
  for (const [wa, row] of cooccur) {
    for (const [wb, w] of row) {
      if (wa < wb) edges.push({ a: wa, b: wb, w });
    }
  }
  edges.sort((x, y) => y.w - x.w);

  // 4. 贪心聚类:阈值 = 0.3×最大边权
  const thresh = edges.length ? edges[0].w * 0.3 : 0;
  const clusters: Array<Set<string>> = [];
  for (const e of edges) {
    if (e.w < thresh) continue;
    const ca = clusters.findIndex((c) => c.has(e.a));
    const cb = clusters.findIndex((c) => c.has(e.b));
    if (ca === -1 && cb === -1) {
      clusters.push(new Set([e.a, e.b]));
    } else if (ca !== -1 && cb === -1) {
      clusters[ca].add(e.b);
    } else if (ca === -1 && cb !== -1) {
      clusters[cb].add(e.a);
    } else if (ca !== cb) {
      // 两个不同簇被新边连通 → 合并
      for (const w of clusters[cb]) clusters[ca].add(w);
      clusters.splice(cb, 1);
    }
  }

  // 5. 簇评分 + 组词
  const result: TopicCluster[] = [];
  const wordFreq = (w: string): { count: number; weight: number } =>
    freq.get(w) ?? { count: 0, weight: 0 };
  for (const c of clusters) {
    const ws = [...c];
    let score = 0;
    const wfs: WordFreq[] = [];
    for (const w of ws) {
      const f = wordFreq(w);
      score += f.weight;
      wfs.push({ word: w, count: f.count, weight: f.weight });
    }
    // 加边权
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        score += cooccur.get(ws[i])?.get(ws[j]) ?? 0;
      }
    }
    // 簇内词按加权频次降序,取前 3 组成短语
    wfs.sort((a, b) => b.weight - a.weight);
    result.push({
      words: wfs.slice(0, 3).map((f) => f.word),
      score,
      wordFreqs: wfs,
    });
  }
  result.sort((a, b) => b.score - a.score);
  return result.slice(0, n);
}
```

- [ ] **Step 3: 用 node 直接跑纯函数验证(替代单测)**

创建临时验证脚本 `scripts/verify-topics.ts`:

```ts
import { computeTopics, segmentText, initSegmenter, type MsgDto } from '../src/utils/wordAnalysis.js';
import { resolveMessageText } from '../src/utils/envelope.js';

async function main() {
  await initSegmenter();
  const mk = (text: string, is_info = false): MsgDto => ({
    msg_id: 0, chat_id: 0, from_id: 1, from_name: 'x', from_avatar: null,
    from_color: null, text: JSON.stringify({ type: 'text', id: 'x', payload: { text } }),
    ts: 0, is_out: true, state: 'sent', quote_from: null, quote_text: null,
    view_type: 'Text', file: null, file_name: null, file_mime: null, file_bytes: null,
    width: null, height: null, download_state: 'Done', subject: null, is_info,
  });
  const msgs = [
    mk('午饭吃什么好'),
    mk('今天午饭吃面条'),
    mk('晚饭也可以吃面'),
    mk('周末去爬山吧'),
    mk('爬山要注意天气'),
  ];
  const topics = computeTopics(msgs, resolveMessageText, 3);
  console.log('TOPICS:', JSON.stringify(topics, null, 2));
  // 断言:午饭/吃 应聚成一簇,爬山/周末 应聚成一簇
  const hasFoodCluster = topics.some((t) => t.words.includes('午饭') && t.words.includes('吃'));
  const hasHikeCluster = topics.some((t) => t.words.includes('爬山'));
  if (!hasFoodCluster) throw new Error('FAIL: 午饭簇缺失');
  if (!hasHikeCluster) throw new Error('FAIL: 爬山簇缺失');
  console.log('PASS');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

运行:
```bash
cd "E:\WechatDevelop\PEYT Community" && npx tsx scripts/verify-topics.ts
```
预期:输出 TOPICS(含「午饭 吃」簇、「爬山 周末」簇),最后打印 `PASS`。

> 注:若无 `tsx`,用 `npx --yes tsx@4` 临时跑。

- [ ] **Step 4: tsc 全量检查**

```bash
cd "E:\WechatDevelop\PEYT Community" && npx tsc --noEmit
```
预期:无输出(通过)。

- [ ] **Step 5: 删除临时脚本 + Commit**

```bash
cd "E:\WechatDevelop\PEYT Community"
rm scripts/verify-topics.ts
git add src/utils/wordAnalysis.ts
git commit -m "feat(topic): 句内共现 + 贪心聚类 computeTopics,输出词簇短语主题"
```

---

### Task 2: `wordCloud.ts` 展示层改主题簇

**Files:**
- Modify: `src/components/wordCloud.ts`

- [ ] **Step 1: 改 renderTopicBubbleHtml 接受 TopicCluster[]**

将 `renderTopicBubbleHtml(words: WordFreq[])` 改为 `renderTopicBubbleHtml(clusters: TopicCluster[])`,拼接短语:

```ts
import type { WordFreq, TopicCluster } from '../utils/wordAnalysis.js';

/** 渲染主题气泡 HTML: 专业 SVG(hash) + Top 主题短语横向排布。 */
export function renderTopicBubbleHtml(clusters: TopicCluster[]): string {
  const text = clusters.length
    ? clusters.map((c) => c.words.join(' ')).join(' · ')
    : '暂无主题词';
  return `<div class="topic-bubble" data-topic-bubble="1">${iconSvg('hash', { width: 14, height: 14 })}<span>${text}</span></div>`;
}
```

- [ ] **Step 2: 改 openWordAnalysisPopup 展示主题簇列表**

将 `openWordAnalysisPopup(anchor, words: WordFreq[])` 改为 `openWordAnalysisPopup(anchor, clusters: TopicCluster[])`:
- 左列词云:喂**全部簇内词合并的词频**
- 右列:主题簇列表(短语 + 得分),点击行展开簇内词频明细

```ts
/**
 * 点击气泡 → 弹出与已读 popup 同款的会话主题分析弹窗。
 * 左: canvas 词云(全部簇内词); 右: 主题簇列表(短语 + 得分,可展开词频明细)。
 */
export function openWordAnalysisPopup(anchor: HTMLElement, clusters: TopicCluster[]): void {
  // 词云数据:合并所有簇的 wordFreqs(去重,取加权和)
  const cloudMap = new Map<string, number>();
  for (const c of clusters) {
    for (const f of c.wordFreqs) {
      cloudMap.set(f.word, (cloudMap.get(f.word) ?? 0) + f.weight);
    }
  }
  const cloudWords: WordFreq[] = [...cloudMap.entries()]
    .map(([word, weight]) => ({ word, count: 1, weight }))
    .sort((a, b) => b.weight - a.weight);

  const rows = clusters.length
    ? clusters
        .map(
          (c, i) => `
          <div class="wc-cluster" data-i="${i}">
            <div class="wc-row wc-cluster-head">
              <span class="wc-word">${escapeHtml(c.words.join(' '))}</span>
              <span class="wc-meta">${c.score.toFixed(2)}</span>
            </div>
            <div class="wc-cluster-detail" data-detail="${i}" style="display:none">
              ${c.wordFreqs.map((f) => `<div class="wc-detail-row"><span>${escapeHtml(f.word)}</span><span>${f.count} 次</span></div>`).join('')}
            </div>
          </div>`,
        )
        .join('')
    : '<div class="wc-empty">暂无主题词</div>';
  const clustersJson = JSON.stringify(clusters);
  mountPopup(
    `<div class="rr-head">会话主题分析</div>
     <div class="rr-cols">
       <div class="rr-col">
         <div class="rr-col-title">词云</div>
         <canvas class="wc-canvas" width="280" height="220"></canvas>
       </div>
       <div class="rr-col">
         <div class="rr-col-title">主题簇</div>
         <div class="wc-list" data-wc-json="${escapeAttr(clustersJson)}">${rows}</div>
       </div>
     </div>`,
    anchor,
    'rr-popup wc-popup',
  );
  // 弹窗挂载后画词云
  requestAnimationFrame(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.wc-canvas');
    if (canvas) drawWordCloud(canvas, cloudWords);
  });
  // 点击簇行 → 展开/收起词频明细
  document.querySelectorAll<HTMLElement>('.wc-cluster-head').forEach((head, i) => {
    head.addEventListener('click', (e) => {
      e.stopPropagation();
      const detail = document.querySelector<HTMLElement>(`[data-detail="${i}"]`);
      if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });
  });
}
```

- [ ] **Step 3: 加簇明细展开样式(注入块,复用 .wc- 前缀)**

在 `wordCloud.ts` 或 `styles.css` 的 `.wc-*` 样式区追加(styles.css 已有 `.wc-row/.wc-word/.wc-meta`):

```css
.wc-cluster { margin-bottom: 4px; }
.wc-cluster-head { cursor: pointer; border-radius: var(--radius-sm); }
.wc-cluster-head:hover { background: var(--capsule); }
.wc-cluster-detail { padding: 2px 8px 6px; }
.wc-detail-row {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: var(--font-scale-micro); color: var(--text-mute); padding: 1px 0;
}
```

- [ ] **Step 4: tsc 全量检查**

```bash
cd "E:\WechatDevelop\PEYT Community" && npx tsc --noEmit
```
预期:无输出。

- [ ] **Step 5: Commit**

```bash
cd "E:\WechatDevelop\PEYT Community"
git add src/components/wordCloud.ts src/styles.css
git commit -m "feat(topic): 气泡显示主题短语,弹窗显示主题簇列表 + 词频展开"
```

---

### Task 3: `chatView.ts` 接入 computeTopics

**Files:**
- Modify: `src/chat/chatView.ts`(import 行 + topicWords 类型 + scheduleTopicRefresh 调用点)

- [ ] **Step 1: 改 import**

将:
```ts
import { initSegmenter, computeTopWords, type WordFreq } from '../utils/wordAnalysis.js';
```
改为:
```ts
import { initSegmenter, computeTopics, type TopicCluster } from '../utils/wordAnalysis.js';
```

- [ ] **Step 2: 改 topicWords 类型**

将:
```ts
let topicWords: WordFreq[] = [];
```
改为:
```ts
let topicWords: TopicCluster[] = [];
```

- [ ] **Step 3: 改 scheduleTopicRefresh 调用点**

将(714-722 行附近):
```ts
    const words = computeTopWords(state.messages, resolveMessageText, 5);
    console.log('[word-freq] top words:', words.map((w) => `${w.word}:${w.count}`).join(', '));
    topicWords = words;
    const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
    if (!chip) return;
    chip.innerHTML = renderTopicBubbleHtml(words);
    chip.querySelector('[data-topic-bubble="1"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openWordAnalysisPopup(e.currentTarget as HTMLElement, topicWords);
    });
```
改为:
```ts
    const clusters = computeTopics(state.messages, resolveMessageText, 4);
    console.log('[topic] clusters:', clusters.map((c) => `${c.words.join(' ')}:${c.score.toFixed(2)}`).join(', '));
    topicWords = clusters;
    const chip = document.querySelector<HTMLElement>('[data-topic-chip="1"]');
    if (!chip) return;
    chip.innerHTML = renderTopicBubbleHtml(clusters);
    chip.querySelector('[data-topic-bubble="1"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openWordAnalysisPopup(e.currentTarget as HTMLElement, topicWords);
    });
```

- [ ] **Step 4: 全局 tsc + build**

```bash
cd "E:\WechatDevelop\PEYT Community" && npx tsc --noEmit && npm run build
```
预期:tsc 无输出,build 成功(✓ built in Ns)。

- [ ] **Step 5: Commit**

```bash
cd "E:\WechatDevelop\PEYT Community"
git add src/chat/chatView.ts
git commit -m "feat(topic): chatView 接入 computeTopics,气泡/弹窗显示主题簇"
```

---

## Self-Review 记录

**Spec 覆盖:**
- §4 共现图+聚类 → Task 1 ✓
- §5 数据结构(TopicCluster) → Task 1 ✓
- §6.1 气泡短语 → Task 2 ✓
- §6.2 弹窗簇列表+展开 → Task 2 ✓
- §7 chatView 接入 → Task 3 ✓
- §8 性能(毫秒级)→ 算法 O(E log E),无额外触发点 ✓
- §9 兼容(jieba 失败/空簇兜底)→ computeTopics 返回空数组,气泡「暂无主题词」;initSegmenter 失败逻辑不变 ✓

**Placeholder 扫描:** 无 TBD/TODO;每个步骤含完整代码。

**类型一致性:** `TopicCluster.words/score/wordFreqs` 三处(定义/气泡/弹窗)一致;`computeTopics(msgs, resolve, n)` 三处调用签名一致;`renderTopicBubbleHtml(clusters)` / `openWordAnalysisPopup(anchor, clusters)` 签名跨 Task 2/3 一致。

**遗留:** Task 1 的验证用 `tsx` 临时脚本,仓库无测试框架故不引入 jest/vitest;脚本跑完即删。
