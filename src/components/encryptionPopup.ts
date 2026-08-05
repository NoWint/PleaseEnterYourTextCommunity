import { call, transformBlobURL } from '../api.js';
import { iconSvg } from './icon.js';
import { colorHex } from './avatar.js';
import { escapeHtml, escapeAttr } from './escape.js';
import { mountPopup } from './readReceiptsPopup.js';
import { state } from '../state.js';
import type { MemberDto } from '../types.js';

// 会话加密徽章弹窗:点 header 的绿色锁徽章 → 弹出当前会话的 E2EE 状态与各成员指纹。
// 指纹来源与 protectionDialog 相同(后端契约):
//   get_chat_encryption_info(chatId) → string(会话级指纹块,core ChatId::get_encryption_info)
//   get_contact_encryption_info(contactId) → string(单个联系人 encrinfo;SELF 会报错)
//   get_self_encryption_info() → string(自己的指纹,单独处理 SELF)
// 这里展示受控的「已加密 + 指纹列表」视图(不展示明细加密状态行,那是保护状态对话框的事)。

// 单个成员的指纹块:上行 = 头像 + 名称 + 地址(水平),下行 = 指纹(限高可滚动)。
async function fingerprintRow(m: MemberDto, encrinfo: string): Promise<string> {
  const bg = colorHex(m.color);
  const letter = (m.name || '?').charAt(0).toUpperCase() || '?';
  const url = m.avatar ? await transformBlobURL(m.avatar) : null;
  const avatarHtml = url
    ? `<img src="${escapeAttr(url)}" alt="" style="width:100%;height:100%;object-fit:cover" />`
    : escapeHtml(letter);
  return `
    <div class="enc-row">
      <div class="enc-user">
        <div class="enc-avatar" style="background:${bg}">${avatarHtml}</div>
        <div class="enc-meta">
          <div class="enc-name">
            <span>${escapeHtml(m.name)}</span>
            ${m.is_self ? '<span class="enc-self">我</span>' : ''}
          </div>
          ${m.addr ? `<div class="enc-addr">${escapeHtml(m.addr)}</div>` : ''}
        </div>
      </div>
      <div class="enc-fpr">${escapeHtml(encrinfo || '(无指纹信息)')}</div>
    </div>`;
}

// 弹出加密信息 popup。anchor = 头部绿色锁徽章。
// 文案:端到端加密已启用。域名从当前账号邮箱动态取(chatmail 中转域),不硬编码。
export async function openEncryptionPopup(anchor: HTMLElement, chatId: number): Promise<void> {
  const relayDomain = (state.self?.addr || '').split('@')[1] || '';
  // 先出骨架(loading),再并行拉成员指纹填充,避免等待期间无任何视觉反馈
  mountPopup(`
    <div class="enc-head">
      <span style="color:var(--success)">${iconSvg('lock', { width: 15, height: 15 })}</span>
      端到端加密已启用
    </div>
    <div class="enc-sub">
      消息全程端到端加密，${relayDomain ? `<span class="enc-relay">@${escapeHtml(relayDomain)}</span>` : '邮件中转服务'}只负责转发密文，无法读取内容。
      逐一核对下方成员指纹，即可验证双方身份。
    </div>
    <div class="enc-body">
      <div class="ui-spinner"></div>
    </div>
  `, anchor, 'rr-popup enc-popup');

  let info: { name: string; is_group: boolean; members: MemberDto[] };
  try {
    info = await call('get_chat_info', { chatId });
  } catch (e) {
    const body = document.querySelector('.enc-popup .enc-body');
    if (body) body.innerHTML = `<div class="enc-empty">加载失败:${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    return;
  }

  const members = info.members || [];
  const body = document.querySelector('.enc-popup .enc-body');
  if (!body) return;
  if (members.length === 0) {
    body.innerHTML = `<div class="enc-empty">暂无成员指纹信息</div>`;
    return;
  }
  const rows = await Promise.all(
    members.map(async (m) => {
      let encrinfo: string;
      try {
        encrinfo = m.is_self
          ? await call<string>('get_self_encryption_info')
          : await call<string>('get_contact_encryption_info', { contactId: m.contact_id });
      } catch (e) {
        encrinfo = e instanceof Error ? e.message : String(e);
      }
      return fingerprintRow(m, encrinfo);
    }),
  );
  body.innerHTML = rows.join('');
}
