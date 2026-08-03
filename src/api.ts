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

// 单一事件桥:一次 listen('dc-event'),按 typ 分发给注册的回调。
// 模仿 delta 的单一 emitter 模型,避免每个 handler 独立 listen 导致事件丢失/不稳定。
type Handler = (payload: DcEvent) => void;
const handlers = new Map<string, Set<Handler>>();
let bridgeStarted = false;

let bridgeRetries = 0;

async function startEventBridge(): Promise<void> {
  if (bridgeStarted) return;
  bridgeStarted = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('dc-event', (ev) => {
      const payload = ev.payload as DcEvent;
      eventLog.push(payload);
      if (eventLog.length > 50) eventLog.shift();
      const set = handlers.get(payload.typ);
      if (set) for (const cb of set) cb(payload);
    });
    console.log('[event-bridge] dc-event listener started');
  } catch (e) {
    console.error('[event-bridge] failed to start dc-event listener:', e);
    bridgeStarted = false;
    // 延迟重试,应对 Tauri IPC 初始化竞态
    if (bridgeRetries < 5) {
      bridgeRetries++;
      setTimeout(() => void startEventBridge(), 1000);
    }
  }
}

export async function onEvent(typ: string, cb: (payload: DcEvent) => void): Promise<() => void> {
  await startEventBridge();
  if (!handlers.has(typ)) handlers.set(typ, new Set());
  handlers.get(typ)!.add(cb);
  console.log(`[onEvent] registered "${typ}"`);
  return () => {
    handlers.get(typ)?.delete(cb);
  };
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
