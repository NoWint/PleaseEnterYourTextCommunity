// 会话主题词频统计: 分词(jieba-wasm) + 停用词过滤 + 1/N 加权累加。
// 纯函数 + 单例初始化, 供 chat-header 主题气泡与词云弹窗使用。
import init, { cut } from 'jieba-wasm';
import type { MsgDto } from '../types.js';
import { isStopword } from './stopwords.js';

export interface WordFreq {
  word: string;
  count: number;   // 原始出现次数(加权前)
  weight: number;  // 加权累计值(1/N 累加, 新消息权重高)
}

let initialized = false;
let initPromise: Promise<void> | null = null;

/** 懒加载初始化 jieba-wasm(单例, 幂等)。失败抛错, 调用方降级。 */
export async function initSegmenter(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = init().then(() => {
      initialized = true;
    });
  }
  await initPromise;
}

/** 分词 + 过滤: 返回非停用词的词数组(含重复, 供计数)。 */
export function segmentText(text: string): string[] {
  const tokens = cut(text, false);
  return tokens.filter((w) => !isStopword(w));
}

/**
 * 统计 Top N 关键词: 遍历已加载消息(倒序, 最近 index=1),
 * 每条 resolveMessageText 解析 JSON 信封取 payload.text, 分词后
 * weight += 1/index(新消息权重高), count += 1(原始次数)。按 weight 降序取 N。
 * 系统信息行 / 空文本跳过。
 */
export function computeTopWords(
  msgs: MsgDto[],
  resolve: (text: string) => string,
  n: number,
): WordFreq[] {
  const weightMap = new Map<string, number>();
  const countMap = new Map<string, number>();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.is_info) continue;
    const text = resolve(m.text || '');
    if (!text) continue;
    const words = segmentText(text);
    const idx = msgs.length - i;
    for (const w of words) {
      weightMap.set(w, (weightMap.get(w) ?? 0) + 1 / idx);
      countMap.set(w, (countMap.get(w) ?? 0) + 1);
    }
  }
  const arr: WordFreq[] = [];
  for (const [word, weight] of weightMap) {
    arr.push({ word, count: countMap.get(word) ?? 0, weight });
  }
  arr.sort((a, b) => b.weight - a.weight);
  return arr.slice(0, n);
}

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

/** 贪心聚类阈值 = 该比例 × 最大边权,低于阈值的边不参与连簇。 */
const CLUSTER_THRESHOLD_RATIO = 0.3;
/** 每个簇取前 N 个高频词组成短语。 */
const MAX_PHRASE_WORDS = 3;

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
      // 两两建边(键规范化: 恒存 字典序小→大, 与下方收集过滤条件一致)
      for (let a = 0; a < nWords; a++) {
        for (let b = a + 1; b < nWords; b++) {
          const wa = words[a];
          const wb = words[b];
          const [k, v] = wa < wb ? [wa, wb] : [wb, wa];
          let row = cooccur.get(k);
          if (!row) { row = new Map(); cooccur.set(k, row); }
          const cur = row.get(v) ?? 0;
          row.set(v, cur + 1 / nWords + 1 / idx);
        }
      }
    }
  }

  // 3. 收集边,降序(建边已规范化键序, 此处 wa<wb 过滤仅去重对称边)
  const edges: Array<{ a: string; b: string; w: number }> = [];
  for (const [wa, row] of cooccur) {
    for (const [wb, w] of row) {
      if (wa < wb) edges.push({ a: wa, b: wb, w });
    }
  }
  edges.sort((x, y) => y.w - x.w);

  // 4. 贪心聚类:阈值 = CLUSTER_THRESHOLD_RATIO × 最大边权
  const thresh = edges.length ? edges[0].w * CLUSTER_THRESHOLD_RATIO : 0;
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
    const clusterWords = [...c];
    let score = 0;
    const wordFreqs: WordFreq[] = [];
    for (const w of clusterWords) {
      const f = wordFreq(w);
      score += f.weight;
      wordFreqs.push({ word: w, count: f.count, weight: f.weight });
    }
    // 加边权(双向查: 共现矩阵存 字典序小→大 一侧, 簇 Set 序无关字典序)
    for (let i = 0; i < clusterWords.length; i++) {
      for (let j = i + 1; j < clusterWords.length; j++) {
        score +=
          cooccur.get(clusterWords[i])?.get(clusterWords[j]) ??
          cooccur.get(clusterWords[j])?.get(clusterWords[i]) ??
          0;
      }
    }
    // 簇内词按加权频次降序,取前 MAX_PHRASE_WORDS 组成短语
    wordFreqs.sort((a, b) => b.weight - a.weight);
    result.push({
      words: wordFreqs.slice(0, MAX_PHRASE_WORDS).map((f) => f.word),
      score,
      wordFreqs,
    });
  }
  result.sort((a, b) => b.score - a.score);
  return result.slice(0, n);
}
