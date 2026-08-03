// Webxdc 消息卡片 + 沙箱运行时 — 对齐 Delta Chat 的 WebxdcMessageContent。
//
// webxdc 是 Delta 生态的小程序:HTML5 应用打包成一条消息(.xdc = zip),在聊天里
// 以卡片展示,点击「启动」后于沙箱 iframe 内运行,经 window.webxdc API 与聊天
// 同步状态(sendUpdate / status updates)。
//
// ── 文件边界 ──────────────────────────────────────────
//   本文件只允许新建/编辑 src/components/webxdc.ts。message.ts 由主 Agent 在
//   Webxdc 附件处调用 renderWebxdcCard + bindWebxdcCard;后端命令
//   get_webxdc_info / get_webxdc_status_updates / send_webxdc_status_update /
//   get_webxdc_blob 由主 Agent 在 commands.rs 实现。命令参数约定:
//     get_webxdc_info(msgId)              -> { name, document, summary }
//     get_webxdc_status_updates(msgId)    -> Array<{ serial, update, desc }>
//     send_webxdc_status_update(msgId, payload) -> number (serial)
//
// ── 沙箱安全 ──────────────────────────────────────────
//   iframe 用 sandbox="allow-scripts allow-same-origin"(仅这两项,不授予
//   allow-top-navigation / allow-popups / allow-forms 等特权)。iframe 内代码
//   不可信:不能让其触碰宿主特权(命令调用、文件访问)。注意 srcdoc 引导页会让
//   iframe 与宿主同源(继承宿主 origin)——这是「基础版」的妥协,安全细节由主
//   Agent review;生产方案应让应用运行在 asset 协议 origin(cross-origin),
//   经包内 webxdc.js(postMessage 桥)通信,本文件宿主侧已实现同一套桥协议。
//
// ── blob 加载(TODO 主 Agent) ─────────────────────────
//   .xdc 是 zip 包,入口 HTML(document)需主 Agent 经 get_webxdc_blob 解包注入。
//   本文件先用「简化方案」:iframe 引导页就绪 window.webxdc 桥后,尝试把 asset
//   URL 当 HTML 直读(fetch + document.write,仅对可直读 HTML 的简化包有效);
//   非 HTML(zip)则静默跳过,等待主 Agent 的真实加载路径。

import { call, transformBlobURL } from '../api.js';
import { state } from '../state.js';
import { iconSvg } from './icon.js';

interface WebxdcInfo {
  name: string;
  document: string; // 包内入口 HTML 文件名(主 Agent 的 blob 加载逻辑使用)
  summary: string;
}

// core 返回的更新结构:StatusUpdateItem { payload, info } + serial + max_serial。
// 前端把 payload 映射为 update(传给 webxdc 应用的 setUpdateListener)、info 映射为 desc。
interface WebxdcStatusUpdate {
  serial: number;
  max_serial?: number;
  payload?: unknown;
  info?: string | null;
}

/** iframe 桥 → 宿主的请求消息。 */
interface BridgeMsg {
  webxdcBridge: 1 | 2;
  type: string;
  id?: number;
  data: Record<string, unknown> | null;
}

// ── 运行时状态(单实例:同时只允许一个 webxdc 全屏窗口) ──
let activeMsgId: number | null = null;
let activeFrame: HTMLIFrameElement | null = null;
let unsubEvent: (() => void) | null = null;
let onEscKey: ((e: KeyboardEvent) => void) | null = null;

const infoCache = new Map<number, WebxdcInfo>();

/**
 * 渲染 webxdc 消息卡片 HTML(供 message.ts 在 Webxdc 附件处插入)。
 * 卡片结构:.webxdc-card > 图标 + .webxdc-info(name + summary) + 启动按钮。
 * 插入 DOM 后需调用 bindWebxdcCard(container) 绑定启动点击并水合名称/摘要。
 */
export function renderWebxdcCard(msg: { msg_id: number; file: string | null }): string {
  const name = baseName(msg.file) || 'Webxdc 应用';
  return `
    <div class="msg-attachment webxdc-card" data-webxdc-msg="${msg.msg_id}">
      <span class="webxdc-icon">${iconSvg('package', { width: 20, height: 20, strokeWidth: 1.8 })}</span>
      <div class="webxdc-info">
        <div class="webxdc-name" data-webxdc-name>${escapeHtml(name)}</div>
        <div class="webxdc-summary" data-webxdc-summary>Webxdc 应用</div>
      </div>
      <button class="btn webxdc-launch" data-webxdc-launch="${msg.msg_id}" title="启动应用">启动</button>
    </div>
  `;
}

/**
 * 绑定卡片交互:启动按钮点击 → openWebxdc;并异步拉 get_webxdc_info 水合名称/摘要。
 * message.ts 在插入 renderWebxdcCard 返回的 HTML 后对消息容器调用本函数
 * (虚拟化重渲染会重新生成容器,需再次调用,与 voicePlayer 的 bind 约定一致)。
 */
export function bindWebxdcCard(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.webxdc-launch').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mid = Number(btn.dataset.webxdcLaunch);
      if (!Number.isNaN(mid)) void openWebxdc(mid);
    });
  });
  container.querySelectorAll<HTMLElement>('.webxdc-card').forEach((card) => {
    const mid = Number(card.dataset.webxdcMsg);
    if (!Number.isNaN(mid)) void hydrateCardInfo(mid, card);
  });
}

/**
 * 启动 webxdc 应用:全屏 overlay 内嵌沙箱 iframe,注入 window.webxdc API。
 * 流程:拉 get_webxdc_info 拿名称 → 建 overlay + iframe(sandbox)→ 用 srcdoc
 * 引导页(同源)定义 window.webxdc 桥 → 监听 core WebxdcStatusUpdate 推给 iframe。
 */
export async function openWebxdc(msgId: number): Promise<void> {
  const msg = state.messages.find((m) => m.msg_id === msgId);
  const file = msg?.file ?? null;

  let info: WebxdcInfo | null = infoCache.get(msgId) ?? null;
  if (!info) {
    info = await call<WebxdcInfo>('get_webxdc_info', { msgId }).catch(() => null);
    if (info) infoCache.set(msgId, info);
  }

  closeWebxdc();
  ensureStyles();

  const title = info?.name || baseName(file) || 'Webxdc 应用';
  const overlay = document.createElement('div');
  overlay.className = 'webxdc-overlay';
  overlay.id = 'webxdc-overlay';
  overlay.innerHTML = `
    <header class="webxdc-header">
      <span class="webxdc-title">${escapeHtml(title)}</span>
      <button class="webxdc-close" title="关闭">${iconSvg('x', { width: 18, height: 18 })}</button>
    </header>
    <iframe class="webxdc-frame" title="webxdc 应用" sandbox="allow-scripts allow-forms"></iframe>
  `;
  document.body.appendChild(overlay);
  const frame = overlay.querySelector<HTMLIFrameElement>('.webxdc-frame')!;
  activeMsgId = msgId;
  activeFrame = frame;

  // 简化方案:transformBlobURL 得到 asset:// 路径,嵌入引导页做直读尝试
  // (xdc 包是 zip,真实解包由主 Agent 的 get_webxdc_blob 路径负责,见 TODO)。
  let assetUrl = '';
  if (file) {
    try {
      assetUrl = await transformBlobURL(file);
    } catch {
      assetUrl = '';
    }
  }
  // 注入 webxdc API:用 srcdoc 引导页定义 window.webxdc(同源,宿主侧桥协议)。
  frame.srcdoc = buildBridgeHtml(state.self?.name ?? '', state.self?.addr ?? '', assetUrl);

  // 事件桥:core WebxdcStatusUpdate → 重新拉取并推给 iframe(动态 import onEvent)。
  const { onEvent } = await import('../api.js');
  unsubEvent = await onEvent('WebxdcStatusUpdate', (ev) => {
    const mid = ev.msg_id as number | undefined;
    if (mid == null || mid !== activeMsgId || !activeFrame) return;
    void refreshUpdatesToFrame(mid, activeFrame);
  });

  // 关闭交互:关闭按钮 / 点击遮罩空白 / Esc。
  overlay.querySelector<HTMLElement>('.webxdc-close')?.addEventListener('click', () => closeWebxdc());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeWebxdc();
  });
  onEscKey = (e) => {
    if (e.key === 'Escape') closeWebxdc();
  };
  document.addEventListener('keydown', onEscKey);
}

/** 关闭当前 webxdc 窗口(幂等)。 */
export function closeWebxdc(): void {
  if (onEscKey) {
    document.removeEventListener('keydown', onEscKey);
    onEscKey = null;
  }
  if (unsubEvent) {
    unsubEvent();
    unsubEvent = null;
  }
  activeMsgId = null;
  activeFrame = null;
  document.getElementById('webxdc-overlay')?.remove();
}

// ── 宿主侧 webxdc 桥(postMessage 协议) ─────────────────
// iframe(webxdcBridge:1) → 宿主:sendUpdate / getAllUpdates / getNextUpdate。
// 宿主(webxdcBridge:2) → iframe:回复(带同 id)或推送 updates。
// 注册一次,仅在 activeMsgId 非空时处理,避免永久空转。

window.addEventListener('message', (ev) => {
  // 来源校验:只接受当前活动 webxdc iframe 的消息。否则任意同源脚本可冒充 guest
  // 触发宿主调后端命令(安全)。opaque origin 下 ev.source 仍是 iframe 的 Window 引用。
  if (ev.source !== activeFrame?.contentWindow) return;
  const msg = ev.data as BridgeMsg | undefined;
  if (!msg || msg.webxdcBridge !== 1) return;
  const mid = activeMsgId;
  if (mid == null) return;
  void handleBridgeRequest(mid, msg, ev.source);
});

async function handleBridgeRequest(msgId: number, msg: BridgeMsg, source: MessageEventSource | null): Promise<void> {
  const reply = (data: unknown): void => {
    (source as Window | null)?.postMessage({ webxdcBridge: 2, type: msg.type, id: msg.id, data }, '*');
  };
  try {
    switch (msg.type) {
      case 'sendUpdate': {
        const payload = msg.data?.update as unknown;
        const desc = String(msg.data?.desc ?? '');
        // core 期望 StatusUpdateItem JSON 结构 {"payload":..., "info":...}。
        const serial = await call<number>('send_webxdc_status_update', {
          msgId,
          payload: JSON.stringify({ payload, info: desc }),
        });
        reply({ serial });
        // 本地回显:让发送者自己的 setUpdateListener 立即收到(serial 去重避免与
        // WebxdcStatusUpdate 事件推送重复)。
        pushUpdateToFrame({ update: payload, serial, desc });
        break;
      }
      case 'getAllUpdates': {
        const updates = await call<WebxdcStatusUpdate[]>('get_webxdc_status_updates', { msgId });
        // core 字段是 payload/info,映射为 webxdc 应用的 update/desc
        const norm = updates.map((u) => ({ update: u.payload, serial: u.serial, desc: u.info ?? '' }));
        reply({ updates: norm, maxSerial: norm.length ? norm[norm.length - 1].serial : 0 });
        break;
      }
      case 'getNextUpdate': {
        const updates = await call<WebxdcStatusUpdate[]>('get_webxdc_status_updates', { msgId });
        const since = Number(msg.data?.since ?? 0);
        const next = updates.find((u) => u.serial > since);
        reply(next
          ? {
              update: next.payload,
              serial: next.serial,
              maxSerial: updates.length ? updates[updates.length - 1].serial : next.serial,
              desc: next.info ?? '',
            }
          : null);
        break;
      }
      default:
        break;
    }
  } catch {
    reply(null);
  }
}

/** 宿主 → iframe 推送一组更新(sendUpdate 回显 / WebxdcStatusUpdate 事件)。 */
function pushUpdateToFrame(data: { update: unknown; serial: number; desc: string }): void {
  if (!activeFrame) return;
  const win = activeFrame.contentWindow;
  if (!win) return;
  win.postMessage(
    { webxdcBridge: 2, type: 'updates', data: { updates: [data], maxSerial: data.serial } },
    '*',
  );
}

/** core WebxdcStatusUpdate 事件触发:重拉全部更新并推给 iframe(桥按 serial 去重)。 */
async function refreshUpdatesToFrame(msgId: number, frame: HTMLIFrameElement): Promise<void> {
  try {
    const updates = await call<WebxdcStatusUpdate[]>('get_webxdc_status_updates', { msgId });
    const norm = updates.map((u) => ({ update: u.payload, serial: u.serial, desc: u.info ?? '' }));
    const win = frame.contentWindow;
    if (!win) return;
    win.postMessage(
      { webxdcBridge: 2, type: 'updates', data: { updates: norm, maxSerial: norm.length ? norm[norm.length - 1].serial : 0 } },
      '*',
    );
  } catch {
    /* 拉取失败静默,等待下一次事件 */
  }
}

/** 卡片名称/摘要异步水合(get_webxdc_info 结果按 msgId 缓存,降低虚拟化重渲染 IPC)。 */
async function hydrateCardInfo(msgId: number, card: HTMLElement): Promise<void> {
  let info = infoCache.get(msgId) ?? null;
  if (!info) {
    info = await call<WebxdcInfo>('get_webxdc_info', { msgId }).catch(() => null);
    if (info) infoCache.set(msgId, info);
  }
  if (!info) return;
  const nameEl = card.querySelector<HTMLElement>('[data-webxdc-name]');
  const sumEl = card.querySelector<HTMLElement>('[data-webxdc-summary]');
  if (nameEl && info.name) nameEl.textContent = info.name;
  if (sumEl && info.summary) sumEl.textContent = info.summary;
}

/**
 * 生成 iframe 引导页 srcdoc:定义 window.webxdc 桥(经 postMessage 与宿主通信),
 * 并保留简化 blob 加载尝试 + 主 Agent TODO。内嵌 selfAddr/selfName/assetUrl。
 */
function buildBridgeHtml(selfName: string, selfAddr: string, assetUrl: string): string {
  const selfNameJson = JSON.stringify(selfName ?? '').replace(/</g, '\\u003c');
  const selfAddrJson = JSON.stringify(selfAddr ?? '').replace(/</g, '\\u003c');
  const assetUrlJson = JSON.stringify(assetUrl ?? '').replace(/</g, '\\u003c');
  const apiSource = `
    (function () {
      'use strict';
      var host = window.parent;
      var pending = {};
      var nextId = 1;
      var listener = null;
      var listenerSerial = 0;
      var maxSerial = 0;
      function post(type, data, cb) {
        var id = nextId++;
        if (cb) { pending[id] = cb; }
        host.postMessage({ webxdcBridge: 1, type: type, id: id, data: data || {} }, '*');
      }
      function deliver(update, serial) {
        if (listener && serial > listenerSerial) {
          listenerSerial = serial;
          listener(update, serial);
        }
      }
      function onMessage(ev) {
        var msg = ev.data;
        if (!msg || msg.webxdcBridge !== 2) { return; }
        if (msg.id && pending[msg.id]) {
          var cb = pending[msg.id];
          delete pending[msg.id];
          cb(msg.data);
          return;
        }
        if (msg.type === 'updates' && listener) {
          var list = (msg.data && msg.data.updates) || [];
          if (msg.data && typeof msg.data.maxSerial === 'number') { maxSerial = msg.data.maxSerial; }
          for (var i = 0; i < list.length; i++) { deliver(list[i].update, list[i].serial); }
        }
      }
      window.addEventListener('message', onMessage);
      window.webxdc = {
        selfAddr: ${selfAddrJson},
        selfName: ${selfNameJson},
        sendUpdate: function (update, desc) {
          post('sendUpdate', { update: update, desc: desc || '' });
        },
        setUpdateListener: function (cb, serial) {
          listener = typeof cb === 'function' ? cb : null;
          listenerSerial = serial || 0;
          post('getAllUpdates', { serial: listenerSerial }, function (result) {
            if (!result) { return; }
            var list = result.updates || [];
            if (typeof result.maxSerial === 'number') { maxSerial = result.maxSerial; }
            for (var i = 0; i < list.length; i++) { deliver(list[i].update, list[i].serial); }
          });
        },
        getNextUpdate: function () {
          return new Promise(function (resolve) {
            post('getNextUpdate', { since: listenerSerial }, function (result) {
              if (!result || typeof result.serial !== 'number') { resolve(null); return; }
              listenerSerial = result.serial;
              resolve({ update: result.update, serial: result.serial, maxSerial: maxSerial, desc: result.desc || '' });
            });
          });
        },
        getAllUpdates: function () {
          return new Promise(function (resolve) {
            post('getAllUpdates', {}, function (result) {
              if (!result) { resolve([]); return; }
              if (typeof result.maxSerial === 'number') { maxSerial = result.maxSerial; }
              resolve(result.updates || []);
            });
          });
        }
      };
      // TODO(主Agent): xdc 包是 zip,入口 HTML 需主 Agent 经 get_webxdc_blob 解包后
      // 注入本文档(此时 window.webxdc 桥已就绪,应用可直接使用)。下方为「简化方案」
      // 占位:尝试把 assetUrl 当 HTML 直读(仅对可直读 HTML 的简化包有效),失败/非
      // HTML(zip)则静默跳过,等待主 Agent 的真实加载路径。
      var appUrl = ${assetUrlJson};
      if (appUrl) {
        try {
          fetch(appUrl).then(function (r) { return r.text(); }).then(function (html) {
            if (!html || !/<\\/html>/i.test(html)) { return; }
            document.open();
            document.write('<base href="' + appUrl + '">' + html);
            document.close();
          }).catch(function () { /* 忽略 */ });
        } catch (e) { /* 忽略 */ }
      }
    })();
  `;
  return '<!doctype html><html><head><meta charset="utf-8"><script>' + apiSource + '</script></head><body></body></html>';
}

// ── 样式(首次打开时注入一次,不触碰 styles.css) ────────
function ensureStyles(): void {
  if (document.getElementById('webxdc-css')) return;
  const style = document.createElement('style');
  style.id = 'webxdc-css';
  style.textContent = `
.webxdc-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--border-strong); border-radius: var(--radius-md); }
.webxdc-card .webxdc-icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex: none; border-radius: 10px; background: var(--active); color: var(--text-mute); }
.webxdc-card .webxdc-info { flex: 1; min-width: 0; }
.webxdc-card .webxdc-name { font-size: var(--font-scale-body); font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.webxdc-card .webxdc-summary { font-size: var(--font-scale-secondary); color: var(--text-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.webxdc-card .webxdc-launch { flex: none; padding: 5px 12px; font-size: var(--font-scale-secondary); }
.webxdc-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; background: var(--bg); }
.webxdc-overlay .webxdc-header { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border-strong); background: var(--panel); }
.webxdc-overlay .webxdc-title { flex: 1; font-size: var(--font-scale-title); font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.webxdc-overlay .webxdc-close { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-mute); cursor: pointer; }
.webxdc-overlay .webxdc-close:hover { color: var(--text); background: var(--active); }
.webxdc-overlay .webxdc-frame { flex: 1; width: 100%; border: 0; background: #fff; }
`;
  document.head.appendChild(style);
}

function baseName(file: string | null): string {
  if (!file) return '';
  const seg = file.split(/[\\/]/).pop() || '';
  return seg.replace(/\.xdc$/i, '');
}

function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
