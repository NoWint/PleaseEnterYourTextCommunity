import { call } from '../api.js';
import { state } from '../state.js';
import { ui } from './ui.js';
import { escapeHtml } from './escape.js';
import type { MemberDto } from '../types.js';

// 已读弹层本土化:
// - 群聊/广播:点「N 人已读」→ 弹已读名单(左已读+时间 / 右未读),标题显示已读计数。
// - 单聊:点「已读」→ 弹对方的已读时间(单一入口,不显示名单/未读)。

export interface ReadReceiptDto {
  contact_id: number;
  name: string;
  addr: string;
  avatar: string | null;
  color: number | null;
  ts: number;
}

let currentPopup: HTMLElement | null = null;
let closeHandler: ((e: MouseEvent) => void) | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;

async function loadReceipts(msgId: number): Promise<ReadReceiptDto[] | null> {
  try {
    return await call<ReadReceiptDto[]>('get_message_read_receipts', { msgId });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return null;
  }
}

// 构建 + 锚定 + 关闭绑定(两种弹层共用)。
function mountPopup(contentHtml: string, anchor: HTMLElement, className = 'rr-popup'): void {
  closePopup();
  const popup = document.createElement('div');
  popup.className = className;
  popup.innerHTML = contentHtml;
  document.body.appendChild(popup);
  currentPopup = popup;

  // 锚定在触发文字旁:优先下方,空间不足则上方;水平对齐 anchor 左缘,超右则右缘对齐。
  const rect = anchor.getBoundingClientRect();
  const popRect = popup.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  if (spaceBelow < popRect.height && spaceAbove > spaceBelow) {
    popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  } else {
    popup.style.top = `${rect.bottom + 4}px`;
  }
  if (rect.left + popRect.width > window.innerWidth - 8) {
    popup.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  } else {
    popup.style.left = `${rect.left}px`;
  }

  closeHandler = (e: MouseEvent) => {
    if (currentPopup && !currentPopup.contains(e.target as Node)) closePopup();
  };
  escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePopup();
  };
  setTimeout(() => {
    if (closeHandler) document.addEventListener('click', closeHandler);
    if (escHandler) document.addEventListener('keydown', escHandler);
  }, 0);
}

// 群聊/广播:已读名单(左已读+时间 / 右未读)。
export async function openReadReceiptsPopup(msgId: number, anchor: HTMLElement): Promise<void> {
  const receipts = await loadReceipts(msgId);
  if (!receipts) return;
  const readIds = new Set(receipts.map((r) => r.contact_id));
  const members: MemberDto[] = state.currentMembers ?? [];
  // 未读 = 当前成员里非自己、且不在已读名单中的人。
  // 已读名单来自 msgs_mdns(别人读了我发的消息),自己永远不在其中。
  const unread = members.filter((m) => !m.is_self && !readIds.has(m.contact_id));

  const readRows = receipts.length
    ? receipts.map((r) => memberRow(r.name, r.addr, r.avatar, r.color, fmtTs(r.ts))).join('')
    : '<div class="rr-empty">暂无已读</div>';
  const unreadRows = unread.length
    ? unread.map((m) => memberRow(m.name, m.addr, m.avatar ?? null, m.color ?? null, '')).join('')
    : '<div class="rr-empty">全部已读</div>';
  mountPopup(`
    <div class="rr-head">已读 (${receipts.length})</div>
    <div class="rr-cols">
      <div class="rr-col">
        <div class="rr-col-title">已读</div>
        ${readRows}
      </div>
      <div class="rr-col">
        <div class="rr-col-title">未读</div>
        ${unreadRows}
      </div>
    </div>
  `, anchor);
}

// 单聊:点「已读」→ 显示对方的已读时间。
export async function showReadTimePopup(msgId: number, anchor: HTMLElement): Promise<void> {
  const receipts = await loadReceipts(msgId);
  if (!receipts) return;
  const r = receipts[0];
  if (!r) {
    mountPopup('<div class="rr-head">已读</div><div class="rr-empty">暂无已读时间</div>', anchor);
    return;
  }
  mountPopup(`
    <div class="rr-head">已读时间</div>
    <div class="rr-single">${memberRow(r.name, r.addr, r.avatar, r.color, fmtTs(r.ts))}</div>
  `, anchor);
}

function memberRow(name: string, addr: string, avatar: string | null, color: number | null, time: string): string {
  const bg = color == null ? 'var(--border-strong)' : '#' + (color & 0xffffff).toString(16).padStart(6, '0');
  const letter = (name || '?').charAt(0).toUpperCase() || '?';
  const avatarHtml = avatar
    ? `<img src="${escapeHtml(avatar)}" class="rr-avatar" alt="" />`
    : `<div class="rr-avatar" style="background:${bg}">${escapeHtml(letter)}</div>`;
  return `
    <div class="rr-row">
      ${avatarHtml}
      <div class="rr-row-meta">
        <div class="rr-name">${escapeHtml(name)}</div>
        ${addr ? `<div class="rr-addr">${escapeHtml(addr)}</div>` : ''}
      </div>
      ${time ? `<span class="rr-time">${escapeHtml(time)}</span>` : ''}
    </div>
  `;
}

function fmtTs(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay) {
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    return `${Math.floor(diffMin / 60)}小时前`;
  }
  if (isYesterday) return '昨天';
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function closePopup(): void {
  if (currentPopup) {
    currentPopup.remove();
    currentPopup = null;
  }
  if (closeHandler) {
    document.removeEventListener('click', closeHandler);
    closeHandler = null;
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}
