import { call, transformBlobURL } from '../api.js';
import { colorHex } from './avatar.js';
import { escapeHtml, escapeAttr } from './escape.js';
import { mountPopup } from './readReceiptsPopup.js';
import { isOnline, lastSeenText } from '../utils/online.js';
import type { MemberDto } from '../types.js';

// 群聊在线状态 popup:点击 chat-header 的「N 人在线」→ 弹出在线/离线成员列表。
// 数据源与 chat-header 相同(get_chat_info 的 members,含 last_seen)。

interface Info { members: MemberDto[]; }

// 单成员行:头像 + username + 最后XX时间。
async function memberRow(m: MemberDto): Promise<string> {
  const bg = colorHex(m.color);
  const letter = (m.name || '?').charAt(0).toUpperCase() || '?';
  const url = m.avatar ? await transformBlobURL(m.avatar) : null;
  const avatarHtml = url
    ? `<img src="${escapeAttr(url)}" alt="" style="width:100%;height:100%;object-fit:cover" />`
    : escapeHtml(letter);
  const online = isOnline(m.last_seen);
  const timeText = m.is_self ? '我' : (online ? '在线' : `${lastSeenText(m.last_seen)}`);
  return `
    <div class="ol-row">
      <div class="ol-avatar" style="background:${bg}">${avatarHtml}</div>
      <div class="ol-meta">
        <div class="ol-name">${escapeHtml(m.name)}</div>
        ${m.addr ? `<div class="ol-addr">${escapeHtml(m.addr)}</div>` : ''}
      </div>
      <div class="ol-time${online ? ' ol-online' : ''}">
        ${online ? '<span class="ol-dot"></span>' : ''}${escapeHtml(timeText)}
      </div>
    </div>`;
}

// 弹出在线/离线列表。anchor = chat-header 的「N 人在线」。
export async function openOnlinePopup(anchor: HTMLElement, chatId: number): Promise<void> {
  mountPopup(`
    <div class="enc-head">群成员在线状态</div>
    <div class="ol-body">
      <div class="ui-spinner"></div>
    </div>
  `, anchor, 'rr-popup ol-popup');

  let info: Info;
  try {
    info = await call<Info>('get_chat_info', { chatId });
  } catch (e) {
    const body = document.querySelector('.ol-popup .ol-body');
    if (body) body.innerHTML = `<div class="enc-empty">加载失败:${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    return;
  }

  const members = (info.members || []).filter((m) => !m.is_self);
  const body = document.querySelector('.ol-popup .ol-body');
  if (!body) return;
  if (members.length === 0) {
    body.innerHTML = `<div class="enc-empty">暂无成员</div>`;
    return;
  }
  const online = members.filter((m) => isOnline(m.last_seen));
  const offline = members.filter((m) => !isOnline(m.last_seen));
  const rows = async (list: MemberDto[]): Promise<string> => (await Promise.all(list.map(memberRow))).join('');

  body.innerHTML = `
    <div class="ol-section-title">在线 (${online.length})</div>
    <div class="ol-section">${online.length ? await rows(online) : '<div class="enc-empty">当前无人在线</div>'}</div>
    <div class="ol-section-title">离线 (${offline.length})</div>
    <div class="ol-section">${offline.length ? await rows(offline) : '<div class="enc-empty">无离线成员</div>'}</div>
  `;
}
