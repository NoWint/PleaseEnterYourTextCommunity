import { transformBlobURL } from '../api.js';
import { escapeHtml, escapeAttr } from './escape.js';
import type { MemberDto, SelfProfile } from '../types.js';

export function colorHex(c: number | null | undefined): string {
  if (!c && c !== 0) return 'var(--border-strong)';
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

export async function renderAvatarHtml(member: MemberDto | SelfProfile | { name: string; avatar: string | null; color: number | null }): Promise<string> {
  const url = member.avatar ? await transformBlobURL(member.avatar) : null;
  const bg = colorHex(member.color);
  const letter = (member.name || '?').charAt(0).toUpperCase() || '?';
  return url
    ? `<img src="${escapeAttr(url)}" class="avatar" alt="" />`
    : `<div class="avatar" style="background:${bg}">${escapeHtml(letter)}</div>`;
}

