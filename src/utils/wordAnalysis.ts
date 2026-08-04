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
