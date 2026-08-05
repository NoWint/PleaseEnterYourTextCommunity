# 会话主题聚类(Topic Cluster)设计

日期:2026-08-05
状态:设计定稿
范围:将 chat-header 主题气泡从「孤立词频」升级为「共现聚类的词簇短语主题」——输出凝聚的 2-3 词主题簇(如「午饭 好吃」「项目 进度 延期」),取代当前零散的单个关键词。

## 1. 背景与动机

当前 `computeTopWords`(wordAnalysis.ts)做**孤立词频**:jieba 分词 → 停用词过滤 → 按 1/N 加权累加每个词。问题在于它只统计「哪个词出现多」,**不统计「哪些词总在一起出现」**。聊「明天午饭去哪吃」会得到 `明天/午饭/去哪/吃` 四个碎词,而不是一个凝聚的主题。

用户痛点:**主题太碎**。解决方案:**句内共现 + 加权聚类**——统计词与词的共现关系,把经常同句出现的词聚成一簇,输出词簇短语。

## 2. 已敲定决策

| 维度 | 决策 |
|---|---|
| 算法 | **句内共现 + 贪心聚类**(纯前端,零新依赖) |
| 计算位置 | **前端** `wordAnalysis.ts`(jieba 已有) |
| 共现窗口 | **句内**(按 `，。！？;` 切句,句内两两建边) |
| 输出形态 | **词簇短语**(2-3 词),Top 2-3 簇 |
| 簇评分 | 簇内词加权频次和 + 簇内边权和 |
| 聚类阈值 | 边权 > 0.3 × 最大边权 才连簇 |
| 气泡展示 | 短语主题(词簇内空格,簇间「·」) |
| 弹窗展示 | 主题簇列表(短语 + 簇得分),可展开簇内词频 |

## 3. 架构

```
src/utils/wordAnalysis.ts     ← 新增共现图 + 聚类(纯函数,复用分词/停用词)
  ├─ initSegmenter()          不变(jieba 懒加载)
  ├─ segmentText()            不变(分词 + 过滤)
  ├─ computeTopics(msgs, resolve, n)  ★ 取代 computeTopWords
  │     ├─ 切句 → 句内分词 → 两两建共现边(加权)
  │     ├─ 贪心聚类(阈值 0.3×maxEdge)
  │     └─ 簇评分 → Top n 簇 → TopicCluster[]
  └─ TopicCluster 接口
src/components/wordCloud.ts   ← 展示层调整
  ├─ renderTopicBubbleHtml(clusters)  气泡显示短语
  ├─ openWordAnalysisPopup(clusters)  弹窗显示簇列表
  └─ drawWordCloud(canvas, words)     不变(喂簇内词)
src/chat/chatView.ts          ← 调用点改 computeTopics, topicWords 类型改 TopicCluster[]
```

**数据流**:`state.messages` → `scheduleTopicRefresh()` 防抖 300ms → `computeTopics`(逐条 `resolveMessageText` 还原 → 切句 → 分词 → 句内共现加权 → 贪心聚类 → 簇评分)→ Top 簇渲染进气泡 → 点击 → 弹窗显示簇列表 + 词云。

## 4. 共现图 + 聚类算法(核心)

### 4.1 切句与分词

对每条消息还原正文后,按 `[，。！？;、]` 切成短句。每句 `segmentText` 分词(停用词/标点/单字/数字已过滤)。句内词去重(同词不重复计)。

### 4.2 共现矩阵

```
cooccur: Map<word, Map<word, weight>>
对每个短句:
  句中词两两(a, b, a≠b):
    edge(a,b) += 1/句内词数          ← 归一化:短句少词权重高
    edge(a,b) += 1/index             ← 消息新鲜度:index=距最近消息的第几条(与现有 1/N 加权一致)
```

注意:`Map` 键用 `a < b` 排序保证对称(无向边)。

### 4.3 贪心聚类

1. 所有边按权重降序排序
2. 阈值 `thresh = 0.3 × maxEdgeWeight`
3. 遍历边:若 `a`、`b` 均未在任何簇,或其中一方已在簇且边权 > thresh → 并入该簇
4. 孤立词(无任何有效边)作为单元素簇保留

### 4.4 簇评分

```
簇得分 = Σ(簇内词加权频次) + Σ(簇内边权)
```

取 Top n(默认 4)簇。每簇取最高频的 2-3 词组成短语(短语内空格连接)。

### 4.5 边界情况

- 空会话/全停用词 → 空簇数组 → 气泡「暂无主题词」
- 单条消息 → 句内词去重后无有效边 → 簇退化回孤立词(合理兜底)
- 簇词数 < 2 → 降级显示单个词(不硬凑)

## 5. 数据结构

```ts
export interface TopicCluster {
  words: string[];      // 簇内词(最高频在前),如 ["午饭","好吃"]
  score: number;        // 簇得分
  wordFreqs: WordFreq[]; // 簇内词频明细(弹窗展开用)
}
export interface WordFreq { word: string; count: number; weight: number; }  // 不变

export async function initSegmenter(): Promise<void>  // 不变
export function segmentText(text: string): string[]    // 不变
export function computeTopics(msgs, resolve, n): TopicCluster[]  // ★ 新增,取代 computeTopWords
```

`computeTopWords` 删除(无其他调用点);`WordFreq` 保留(`TopicCluster.wordFreqs` 复用)。

## 6. 展示层

### 6.1 气泡(chat-header)

```
[hash图标] 午饭 好吃 · 项目 进度 · 周末 爬山
```

- 词簇短语:簇内空格,簇间「·」。2-3 个簇。
- 无主题 → 「暂无主题词」(不变)。
- 保持 `.topic-bubble` 样式与 `ch-head` 一致(不变)。

### 6.2 弹窗(已读 popup 同款)

```
会话主题分析
[词云 canvas]  [主题簇列表]
              午饭 好吃       5.2
              项目 进度 延期   3.8
              周末 爬山 天气   2.1
```

- 左列词云:喂**全部簇内词**(合并所有簇的词频),画布逻辑不变。
- 右列:**主题簇列表**,每行 = 短语 + 簇得分。点击行展开该簇的词频明细(词 + 次数)。
- 复用 `mountPopup` 锚点 + 外部点击/Escape 关闭。

## 7. 接入 chatView.ts

- `topicWords` 模块变量类型 `WordFreq[]` → `TopicCluster[]`
- `scheduleTopicRefresh` 里 `computeTopWords(...)` → `computeTopics(state.messages, resolveMessageText, 4)`
- `renderTopicBubbleHtml(words)` 签名改收 `TopicCluster[]`
- `openWordAnalysisPopup(anchor, clusters)` 签名改收 `TopicCluster[]`
- 懒加载 `initSegmenter`、失败静默隐藏、防抖 300ms 均不变

## 8. 性能

- 共现构建:`O(消息 × 句 × 词²)`。50 条 × 每句 ~5 词 → 每句 ~10 词对 → 几百到几千次累加,毫秒级。
- 聚类:边排序 O(E log E) + 一遍贪心,零额外开销。
- 沿用 300ms 防抖,不新增触发点。

## 9. 兼容与降级

- jieba 初始化失败 → 气泡隐藏(不变)。
- 分词返回空 / 共现矩阵空 → 空簇 → 「暂无主题词」。
- 簇退化孤立词 → 降级显示单词(不崩)。
- 弹窗词云在簇为空时画布留白。

## 10. 明确不做(本期)

- 不做 LDA/Embedding 等统计主题模型(需后端 + 模型,过重)。
- 不做停用词可配置。
- 不做会话全部历史统计(只统计已加载消息)。
- 不做词性标注(POS)。

## 11. 验收要点

1. 打开会话 → 气泡显示 **2-3 个主题短语**(词簇),而非孤立词。
2. 聊具体话题(如「午饭好吃」)→ 气泡出现「午饭 好吃」凝聚簇,不再碎片化。
3. 新消息 → 300ms 防抖后主题更新。
4. 点气泡 → 弹窗左词云(簇内词)+ 右主题簇列表(短语 + 得分)。
5. 点击簇行 → 展开簇内词频明细。
6. 停用词/标点/单字/数字仍被过滤。
7. 空会话 / jieba 失败 → 静默兜底,不崩。
