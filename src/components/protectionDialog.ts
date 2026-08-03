import { call, transformBlobURL } from '../api.js';
import { iconSvg } from './icon.js';
import { ui, colorHex } from './ui.js';
import { escapeHtml, escapeAttr } from './escape.js';
import type { MemberDto } from '../types.js';

// get_chat_info 返回结构 —— 只声明本组件用到的字段,多余字段由后端额外返回,运行时忽略。
interface ChatInfo {
  name: string;
  chat_type: string;
  is_encrypted: boolean;
  members: MemberDto[];
}

// 保护状态对话框:显示当前会话的 E2EE 状态与各成员加密指纹(对齐 Delta ProtectionStatusDialog)。
// 后端契约:
//   get_chat_info(chatId) → { name, chat_type, is_encrypted, members: MemberDto[] }
//   get_chat_encryption_info(chatId) → string(会话级指纹块,core ChatId::get_encryption_info)
//   get_contact_encryption_info(contactId) → string(单个联系人 encrinfo;SELF 会报错)
//   get_self_encryption_info() → string(自己的指纹,单独处理 SELF)
export async function openProtectionDialog(chatId: number): Promise<void> {
  const dlg = ui.dialog({
    title: '保护状态',
    size: 'lg',
    body: `
      <div id="pd-header" style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span class="ui-spinner"></span>
      </div>
      <div class="ui-dialog-section" style="padding:12px 14px;display:flex;flex-direction:row;align-items:center;gap:10px">
        <span id="pd-status" style="display:flex;align-items:center;gap:10px;min-width:0;width:100%"><span class="ui-spinner"></span></span>
      </div>
      <div class="ui-dialog-sep"></div>
      <div class="ui-dialog-section-title" style="margin-bottom:8px">成员指纹</div>
      <div id="pd-members" style="display:flex;flex-direction:column;gap:10px;max-height:280px;overflow-y:auto;padding-right:2px">
        <div class="ui-spinner"></div>
      </div>
    `,
  });

  // 拉会话信息(标题 + 类型 + 成员)
  let info: ChatInfo;
  try {
    info = await call<ChatInfo>('get_chat_info', { chatId });
  } catch (e) {
    fail(dlg, e instanceof Error ? e.message : String(e));
    return;
  }

  // 会话标题 + 类型标签
  const headerEl = dlg.overlay.querySelector<HTMLElement>('#pd-header');
  if (headerEl) {
    headerEl.innerHTML = `
      <span style="font-size:var(--font-scale-body);font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(info.name)}</span>
      <span style="flex:none;font-size:var(--font-scale-secondary);color:var(--text-mute);background:var(--capsule);padding:2px 8px;border-radius:10px">${escapeHtml(typeLabel(info.chat_type))}</span>
    `;
  }

  // E2EE 状态说明:以 core 判定为准(is_encrypted),不再硬编码「已启用」
  const statusEl = dlg.overlay.querySelector<HTMLElement>('#pd-status');
  if (statusEl) {
    const encrypted = info.is_encrypted;
    const statusTitle = encrypted ? '端到端加密已启用' : '此会话未加密';
    const statusColor = encrypted ? 'var(--text-action)' : 'var(--text-warn, var(--text-weak))';
    statusEl.innerHTML = `
      <span style="flex:none;color:${statusColor}">${iconSvg(encrypted ? 'shield' : 'shield-off', { width: 18, height: 18 })}</span>
      <div style="min-width:0">
        <div style="font-size:var(--font-scale-body);font-weight:600;color:var(--text)">${statusTitle}</div>
        <div style="font-size:var(--font-scale-secondary);color:var(--text-weak)">${escapeHtml(statusDesc(info.chat_type, encrypted))}</div>
      </div>
    `;
  }

  // 并行加载每个成员的指纹。SELF 是 special contact,core 的 get_encrinfo 拒绝 →
  // 单独走 get_self_encryption_info(自己的指纹)。单成员失败不影响整体。
  const membersEl = dlg.overlay.querySelector<HTMLElement>('#pd-members');
  if (!membersEl) return;
  const members = info.members || [];
  if (members.length === 0) {
    membersEl.innerHTML = `<div style="color:var(--text-weak);font-size:var(--font-scale-body);padding:8px">无成员指纹信息</div>`;
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
      return memberRow(m, encrinfo);
    }),
  );
  membersEl.innerHTML = rows.join('');
}

async function memberRow(m: MemberDto, encrinfo: string): Promise<string> {
  const bg = colorHex(m.color);
  const letter = (m.name || '?').charAt(0).toUpperCase() || '?';
  const url = m.avatar ? await transformBlobURL(m.avatar) : null;
  const avatarHtml = url
    ? `<img src="${escapeAttr(url)}" alt="" style="width:100%;height:100%;object-fit:cover" />`
    : escapeHtml(letter);
  return `
    <div class="ui-dialog-section" style="flex-direction:row;align-items:flex-start;padding:10px 12px">
      <div style="flex:none;width:32px;height:32px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:var(--font-scale-body);font-weight:600;color:var(--text);overflow:hidden">${avatarHtml}</div>
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">
          <span style="font-size:var(--font-scale-body);font-weight:600;color:var(--text)">${escapeHtml(m.name)}</span>
          ${m.is_self ? '<span style="font-size:var(--font-scale-micro);color:var(--text-weak)">我</span>' : ''}
          ${m.addr ? `<span style="font-size:var(--font-scale-micro);color:var(--text-mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px">${escapeHtml(m.addr)}</span>` : ''}
        </div>
        <pre style="margin:6px 0 0;font-family:var(--font-mono);font-size:var(--font-scale-micro);line-height:1.5;color:var(--text-body);white-space:pre-wrap;word-break:break-all;max-height:96px;overflow-y:auto;padding:8px;border-radius:6px;background:var(--surface)">${escapeHtml(encrinfo || '(无指纹信息)')}</pre>
      </div>
    </div>`;
}

function typeLabel(chatType: string): string {
  switch (chatType) {
    case 'single': return '单聊';
    case 'group': return '群聊';
    case 'mailinglist': return '邮件列表';
    case 'broadcast': return '广播';
    case 'self_talk': return '备注消息';
    case 'device': return '设备消息';
    default: return chatType;
  }
}

function statusDesc(chatType: string, encrypted: boolean): string {
  if (!encrypted) {
    return '尚未建立端到端加密,可能仍在发送明文消息';
  }
  switch (chatType) {
    case 'group': return '所有消息均端到端加密,请逐一核对群成员指纹以验证身份';
    case 'single': return '本会话已端到端加密,核对指纹可验证对方身份';
    case 'self_talk': return '备注消息仅保存在本设备,已加密存储';
    case 'mailinglist': return '消息对所有收件人端到端加密';
    case 'broadcast': return '消息对所有收件人端到端加密';
    default: return '本会话已端到端加密';
  }
}

function fail(dlg: { overlay: HTMLDivElement }, message: string): void {
  const headerEl = dlg.overlay.querySelector<HTMLElement>('#pd-header');
  if (headerEl) headerEl.innerHTML = `<span style="color:var(--text);font-size:var(--font-scale-body)">加载失败</span>`;
  const statusEl = dlg.overlay.querySelector<HTMLElement>('#pd-status');
  if (statusEl) statusEl.innerHTML = `<span style="color:var(--text-weak);font-size:var(--font-scale-secondary)">${escapeHtml(message)}</span>`;
  const membersEl = dlg.overlay.querySelector<HTMLElement>('#pd-members');
  if (membersEl) membersEl.innerHTML = '';
}

