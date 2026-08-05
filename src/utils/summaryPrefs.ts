// 主题总结偏好:后端 SQL(summary_settings 表)读写,前端内存缓存。
// 一次 summary_get_state 全量拉回;save 增量写。
import { call } from '../api.js';

export interface SummaryPrefs {
  mode: 'off' | 'wordfreq' | 'llm';
  source: 'local' | 'api';
  modelSize: '0.5b' | '1.5b';
  contextN: number;
}
export const DEFAULT_PREFS: SummaryPrefs = { mode: 'wordfreq', source: 'local', modelSize: '0.5b', contextN: 50 };

// 下载状态(引擎/模型是否已就绪)+ API 配置与偏好一起缓存,避免重复 summary_get_state。
type SummaryCache = SummaryPrefs & {
  engineDownloaded: boolean; modelDownloaded: boolean;
  apiBaseUrl: string | null; apiKey: string | null; apiModel: string | null;
};
let cache: SummaryCache | null = null;

/** 从后端拉一次全量偏好 + 下载状态 + API 配置(启动/设置页打开时调用;失败用默认值)。 */
export async function loadSummaryPrefs(): Promise<SummaryCache> {
  try {
    const s = await call<{ mode: string; source: string; modelSize: string; contextN: number; engineDownloaded: boolean; modelDownloaded: boolean; apiBaseUrl: string | null; apiKey: string | null; apiModel: string | null }>('summary_get_state');
    cache = {
      mode: s.mode as SummaryPrefs['mode'],
      source: s.source as SummaryPrefs['source'],
      modelSize: s.modelSize as SummaryPrefs['modelSize'],
      contextN: Math.min(200, Math.max(10, s.contextN)),
      engineDownloaded: s.engineDownloaded,
      modelDownloaded: s.modelDownloaded,
      apiBaseUrl: s.apiBaseUrl,
      apiKey: s.apiKey,
      apiModel: s.apiModel,
    };
  } catch { cache = { ...DEFAULT_PREFS, engineDownloaded: false, modelDownloaded: false, apiBaseUrl: null, apiKey: null, apiModel: null }; }
  return cache;
}

/** 同步读内存缓存(气泡刷新等高频路径,不每次 IPC)。未加载则用默认值。 */
export function getSummaryPrefs(): SummaryCache {
  return cache ?? { ...DEFAULT_PREFS, engineDownloaded: false, modelDownloaded: false, apiBaseUrl: null, apiKey: null, apiModel: null };
}

/** 保存偏好(内存 + 后端 SQL 增量写;已缓存的下载状态/API 配置保持不变)。 */
export async function saveSummaryPrefs(p: SummaryPrefs): Promise<void> {
  cache = {
    ...DEFAULT_PREFS, ...p,
    engineDownloaded: cache?.engineDownloaded ?? false,
    modelDownloaded: cache?.modelDownloaded ?? false,
    apiBaseUrl: cache?.apiBaseUrl ?? null,
    apiKey: cache?.apiKey ?? null,
    apiModel: cache?.apiModel ?? null,
  };
  try {
    await call('summary_save_prefs', {
      mode: p.mode, source: p.source, modelSize: p.modelSize, contextN: p.contextN,
    });
  } catch { /* 静默:内存已更新,后端下次再同步 */ }
}
