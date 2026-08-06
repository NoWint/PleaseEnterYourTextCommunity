// 成员选择器:处理 AI <user> 标签点击 → 模糊匹配成员 → 单名片/多人列表。
// AI 输出名字常不带空格/缩写/错字,精确匹配找不到 → fuzzyMatchMembers 按相关度打分;
// 1 人直接弹名片;多人弹成员列表,点击某项再弹名片 popup。
import { ui } from './ui.js';
import { escapeHtml } from './escape.js';
import { colorHex } from './avatar.js';
import { fuzzyMatchMembers, type MemberHit } from '../utils/tagParser.js';
import type { MemberDto } from '../types.js';
import { state } from '../state.js';

/**
 * 解析 <user> 标签点击。
 * @param name  标签值(如「张三」「张三 丰」)
 * @param anchor 触发 chip 元素(名片 popup 定位锚点)
 * @param members 成员候选列表(默认 state.currentMembers)
 */
export function openUserPicker(name: string, anchor: HTMLElement, members: MemberDto[] = state.currentMembers): void {
  const hits = fuzzyMatchMembers(name, members, 5);
  if (hits.length === 0) {
    ui.toast(`未找到成员:${name}`);
    return;
  }
  // 精确命中(score 100)或仅 1 人 → 直接弹名片
  const exact = hits.filter((h) => h.score >= 100);
  const best = exact.length > 0 ? exact[0] : hits[0];
  if (hits.length === 1 || exact.length === 1) {
    void openMemberCard(best.member, anchor);
    return;
  }
  // 多人 → 弹成员列表,点击某项再弹名片
  const rows = hits
    .map((h, i) => {
      const m = h.member;
      const avatar = m.avatar
        ? `<img src="${escapeHtml(m.avatar)}" alt="" class="mp-avatar-img">`
        : `<span class="mp-avatar-letter" style="background:${colorHex(m.color)}">${escapeHtml((m.name || '?').charAt(0).toUpperCase())}</span>`;
      return `<button class="mp-row" data-mp-i="${i}" type="button">
        <span class="mp-avatar">${avatar}</span>
        <span class="mp-meta">
          <span class="mp-name">${escapeHtml(m.name)}</span>
          ${m.addr ? `<span class="mp-addr">${escapeHtml(m.addr)}</span>` : ''}
        </span>
        <span class="mp-score">${h.score}</span>
      </button>`;
    })
    .join('');
  const dlg = ui.dialog({
    title: `选择成员(「${name}」匹配 ${hits.length} 人)`,
    body: `<div class="mp-list">${rows}</div>`,
    size: 'sm',
    closeable: true,
  });
  dlg.overlay.querySelectorAll<HTMLElement>('.mp-row').forEach((row) => {
    row.addEventListener('click', () => {
      const i = Number(row.dataset.mpI || 0);
      const hit = hits[i];
      dlg.close();
      if (hit) void openMemberCard(hit.member, anchor);
    });
  });
}

/** 打开单个成员名片(复用 contactCard popup)。 */
async function openMemberCard(member: MemberDto, anchor: HTMLElement): Promise<void> {
  const { openContactCard } = await import('./contactCard.js');
  openContactCard({
    contactId: member.contact_id,
    name: member.name,
    addr: member.addr,
    avatar: member.avatar,
    color: member.color,
    lastSeen: member.last_seen,
    anchor,
  });
}
