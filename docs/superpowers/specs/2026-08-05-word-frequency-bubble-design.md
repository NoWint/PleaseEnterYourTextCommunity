# 会话主题词频气泡(Word Frequency Bubble)设计

日期:2026-08-05
状态:设计定稿
范围:chat-header 中新增一块与名称框同样式的气泡,展示当前会话已加载消息的词频统计(Top 3-5 关键词),反映讨论主题;点击气泡弹出与「已读 popup」同款的词频统计 + 词云图。

## 1. 背景与动机

聊天窗口的 chat-header 目前只有会话名称框。用户希望在不离开聊天流的情况下,一眼看到**当前讨论的主题关键词**——从已加载消息里统计词频(去除口水词/标点,消息越新权重越高),Top 词显示在 header 气泡里;点击气泡弹出更完整的文本分析(词频列表 + 词云图)。

所有消息正文都是 JSON 信封(`{"type":"text","payload":{"text":"..."}}`),统计前需解析(`resolveMessageText`,已有工具)。

## 2. 已敲定决策

| 维度 | 决策 |
|---|---|
| 分词方案 | **前端分词库(jieba-wasm)** —— 中文无空格,需词典分词 |
| 数据范围 | **已加载消息**(`state.messages`,约 50 条,零额外 IPC) |
| 权重 | **线性倒数 1/N**(距最近消息第 1 条=1,第 10 条=0.1) |
| 气泡内容 | **Top 3-5 关键词**横向排布,专业 SVG 图标,不用 emoji |
| 弹出层 | **已读 popup 同款**(锚点定位 + 外部点击/Escape 关闭),复用 `mountPopup` |
| 词云渲染 | **Canvas 自绘**(词频映射字号/颜色,瀑布式排布) |
| 停用词 | **内置中文停用词表**(口水词 + 标点 + 单字 + 数字) |
| 重算时机 | **防抖 300ms + 同步算**,切换会话/新消息触发 |

## 3. 架构

```
src/utils/wordAnalysis.ts     ← 分词 + 停用词 + 加权词频(纯函数)
  ├─ initSegmenter()          jieba-wasm 懒加载初始化(单例)
  ├─ segmentText(text)        中文分词,过滤标点/单字/数字/停用词
  ├─ computeWordFreq(msgs)    遍历已加载消息 → 1/N 加权词频 Map
  └─ topWords(freq, n)        取 Top N(降序)
src/utils/stopwords.ts        ← 内置停用词表 + 过滤正则
src/components/wordCloud.ts   ← Canvas 词云 + 弹出层
  ├─ renderWordCloud(canvas, words)  按词频画词云
  └─ openWordAnalysisPopup(anchor, words)  已读 popup 同款弹出层
src/chat/chatView.ts          ← 接入: header 气泡 + 防抖重算
  └─ renderTopicBubble(...)    气泡渲染 + scheduleTopicRefresh()
```

**数据流**:`state.messages` 变化 → `scheduleTopicRefresh()` 防抖 300ms → `computeWordFreq`(逐条 `resolveMessageText` 解析信封 → `segmentText` → 停用词过滤 → `1/N` 加权累加)→ `topWords(5)` → 渲染进 header 气泡 → 点击气泡 → `openWordAnalysisPopup` 弹出词云 + 词频列表。

**性能**:50 条 × 平均 20 词 ≈ 1000 词/次,一次遍历 O(messages×words),毫秒级;防抖避免新消息洪峰反复重算;jieba-wasm 懒加载(首次显示气泡才初始化),不拖慢聊天加载。

**错误处理**:jieba 初始化失败/分词抛错 → 气泡显示空态或隐藏,不阻断聊天;统计异常静默降级。

## 4. 分词模块 `wordAnalysis.ts`

```ts
export interface WordFreq { word: string; count: number; weight: number; }

export async function initSegmenter(): Promise<void>   // jieba-wasm 懒加载单例初始化
export function segmentText(text: string): string[]     // 分词,过滤标点/单字/数字/停用词
export function computeWordFreq(msgs: MsgDto[]): Map<string, number>  // 1/N 加权累加
export function topWords(freq: Map<string, number>, n: number): WordFreq[]  // 降序取 Top N
```

- `segmentText`: `jieba.cut(text)` → 过滤:停用词表命中、标点正则、纯数字、长度<2 单字。
- `computeWordFreq`: 遍历 `state.messages` 倒序(最近的 index=1),`resolveMessageText(msg.text)` 解析信封,`segmentText` 分词,`freq[word] += 1/index`。
- `topWords`: 按加权值降序,截取 N。
- 依赖 `jieba-wasm`(npm 包,确切实例 API 实施时验证;典型 `cut` 返回词数组)。

## 5. 停用词表 `stopwords.ts`

- 内置 ~100 条中文停用词:助词(的 了 是 在 我 有 和 就 都 而 及 与 着 或 一个 没有 我们 你们 他们)、指示词(这个 那个 什么 怎么)、语气词(啊 嗯 哦 吧 呢 了 吗 呀)、常见口语(就是 然后 反正 觉得 知道 还是 因为 所以)等。
- 过滤正则:标点 `[，。！？、；：""''（）【】《》…—\s]`、纯数字 `^\d+$`、单字(长度<2,中文单字词信息量低)。
- 停用词表是代码一部分,进 git。

## 6. 气泡 + 弹出层 `wordCloud.ts`

### 6.1 气泡

- 复用 `.chat-header > div` 同样式(panel 背景 + 边框 + 圆角 + padding),在名称框 `.ch-head` 右侧并列一个 `.topic-bubble`。
- 内容:专业 SVG 图标 + Top 3-5 词,格式 `[图标] 词1 · 词2 · 词3`。**不使用 emoji**。
- 点击 cursor:pointer;无关键词时显示空态(「暂无主题词」或隐藏)。

### 6.2 弹出层(已读 popup 同款)

- 复用 `readReceiptsPopup.ts` 的 `mountPopup(contentHtml, anchor, className)` + `closePopup()`,导出供本模块使用(当前未导出,需加 `export`)。
- 触发:点气泡 anchor → `openWordAnalysisPopup(anchor, words)`。
- 内容(复用 `.rr-popup` 壳 + `.rr-cols` 两列):
  - `.rr-head` 标题「会话词频分析」+ 统计条数/消息数。
  - 左 `.rr-col`:`<canvas>` 词云图。
  - 右 `.rr-col`:完整词频列表(词 + 次数 + 权重),按权重降序,滚动。
- 交互:外部点击/Escape 关闭(复用 `mountPopup`),锚定在气泡旁。

### 6.3 Canvas 词云自绘

- `renderWordCloud(canvas, words)`:按词频映射字号(12→36px)与颜色(主题色板),`measureText` 量宽,瀑布式逐行堆叠(简单近似螺旋,不引第三方碰撞布局库)。
- 词频越高字越大、越靠前;canvas 尺寸自适应弹出层宽度。
- 空词频 → 画布留白或提示文字。

## 7. 接入 `chatView.ts`

- header 骨架里,名称框 `.ch-head` 右侧并列 `.topic-bubble`。
- 切换会话 / `state.messages` 变化 → `scheduleTopicRefresh()`(防抖 300ms)→ `computeWordFreq` → 更新气泡文本。
- 首次显示气泡时 `initSegmenter()` 懒加载。
- 复用 `resolveMessageText`(message.ts 已导出)解析信封。

## 8. 明确不做(本期)

- 不做词云库(wordcloud2),Canvas 自绘瀑布排布足够。
- 不做停用词可配置(设置页),内置表即可。
- 不做会话全部历史统计(只统计已加载消息)。
- 不做词性标注(POS)、TF-IDF、关键词权重的高级算法——1/N 加权足够反映「越新越重要」。

## 9. 验收要点

1. 打开会话 → header 名称框右侧出现主题气泡,显示 Top 3-5 词(专业 SVG 图标,无 emoji)。
2. 气泡词随会话切换变化,反映当前会话内容。
3. 收到新消息 → 防抖 300ms 后气泡词更新(最新消息词权重上升)。
4. 点气泡 → 弹出已读 popup 同款弹窗:左词云图 + 右词频列表。
5. 词云字号随词频变化,颜色来自主题色板。
6. 外部点击 / Escape 关闭弹窗。
7. 停用词/标点/单字/数字被过滤,不出现「的了是」「啊」等。
8. 统计过程不阻塞聊天滚动;jieba 初始化失败时气泡静默隐藏,聊天正常。
