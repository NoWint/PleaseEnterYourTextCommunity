const blobCache = new Map<string, string>();

export interface DcEvent {
  typ: string;
  [key: string]: unknown;
}

export async function call<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (err) {
    showError(err);
    throw err;
  }
}

// 全局事件日志:记录最近收到的 dc-event,供 debug 页排查事件流
export const eventLog: DcEvent[] = [];

export async function onEvent(typ: string, cb: (payload: DcEvent) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen('dc-event', (ev) => {
    const payload = ev.payload as DcEvent;
    // 记录所有事件(只保留最近 50 条),便于诊断事件流是否到达前端
    eventLog.push(payload);
    if (eventLog.length > 50) eventLog.shift();
    if (payload.typ === typ) cb(payload);
  });
}

export async function transformBlobURL(path: string): Promise<string> {
  if (!path) return '';
  if (blobCache.has(path)) return blobCache.get(path)!;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const url = convertFileSrc(path);
    blobCache.set(path, url);
    return url;
  } catch {
    return '';
  }
}

export function showError(err: unknown): void {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = err instanceof Error ? err.message : String(err);
    el.style.display = 'block';
  }
}

export function clearError(): void {
  const el = document.getElementById('error');
  if (el) el.style.display = 'none';
}
