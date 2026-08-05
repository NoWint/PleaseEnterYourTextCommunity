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

let cache: SummaryPrefs | null = null;

/** 从后端拉一次全量偏好(启动/设置页打开时调用;失败用默认值)。 */
export async function loadSummaryPrefs(): Promise<SummaryPrefs> {
  try {
    const s = await call<{ mode: string; source: string; modelSize: string; contextN: number }>('summary_get_state');
    cache = {
      mode: s.mode as SummaryPrefs['mode'],
      source: s.source as SummaryPrefs['source'],
      modelSize: s.modelSize as SummaryPrefs['modelSize'],
      contextN: Math.min(200, Math.max(10, s.contextN)),
    };
  } catch { cache = { ...DEFAULT_PREFS }; }
  return cache;
}

/** 同步读内存缓存(气泡刷新等高频路径,不每次 IPC)。未加载则用默认值。 */
export function getSummaryPrefs(): SummaryPrefs {
  return cache ?? { ...DEFAULT_PREFS };
}

/** 保存偏好(内存 + 后端 SQL 增量写)。 */
export async function saveSummaryPrefs(p: SummaryPrefs): Promise<void> {
  cache = { ...p };
  try {
    await call('summary_save_prefs', {
      mode: p.mode, source: p.source, modelSize: p.modelSize, contextN: p.contextN,
    });
  } catch { /* 静默:内存已更新,后端下次再同步 */ }
}
