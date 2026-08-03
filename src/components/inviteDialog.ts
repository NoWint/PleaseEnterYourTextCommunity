import { state } from '../state.js';
import { ui } from './ui.js';
import { buildInviteLink } from '../utils/inviteLink.js';

// 分享我的邀请:显示 PEYT 短邀请链接 + 复制按钮。
// 链接 = peyt://invite/<base64url邮箱>?n=<名字>,对方粘贴后前端解码 → create_chat_by_email。

export function openInviteDialog(): void {
  const email = state.self?.addr || '';
  if (!email) {
    ui.toast('无法生成邀请链接:缺少账号邮箱');
    return;
  }
  const link = buildInviteLink(email, state.self?.name);

  const copyBtn = ui.button({
    label: '复制链接',
    icon: 'copy',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(link);
        ui.toast('邀请链接已复制');
        dlg.close();
      } catch {
        ui.toast('复制失败,请手动选中链接');
      }
    },
  });
  const dlg = ui.dialog({
    title: '分享我的邀请',
    body: `
      <div style="font-size:13px;color:var(--text-mute);line-height:1.5;margin-bottom:12px">
        分享下方链接,对方在 PEYT 里粘贴即可加你为好友。
      </div>
      <div class="ui-dialog-section">
        <div style="font-size:14px;color:var(--text);word-break:break-all;font-family:var(--font-mono);font-size:13px;line-height:1.6;user-select:all">${escapeHtml(link)}</div>
      </div>
    `,
    actions: [copyBtn],
  });
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
