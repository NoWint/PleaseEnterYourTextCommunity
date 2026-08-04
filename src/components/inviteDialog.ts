import { call } from '../api.js';
import { state } from '../state.js';
import { ui } from './ui.js';
import { escapeHtml } from './escape.js';
import { sendInviteLink } from './shareLink.js';

// 分享我的邀请:显示 PEYT 邀请链接(https://peyt.yzjtiantian.cn/#<token>)+ 复制/分享按钮。
// 链接由后端 get_securejoin_qr 生成并替换成 peyt 品牌域名;对方粘贴/点开唤起即处理。

export async function openInviteDialog(): Promise<void> {
  if (!state.self?.addr) {
    ui.toast('无法生成邀请链接:缺少账号邮箱');
    return;
  }
  let link = '';
  try {
    link = await call<string>('get_securejoin_qr', { chatId: null });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  if (!link) {
    ui.toast('无法生成邀请链接');
    return;
  }

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
  const shareBtn = ui.button({
    label: '分享',
    icon: 'forward',
    onClick: () => void sendInviteLink(link),
  });
  const dlg = ui.dialog({
    title: '分享我的邀请',
    body: `
      <div style="font-size:var(--font-scale-body);color:var(--text-mute);line-height:1.5;margin-bottom:12px">
        分享下方链接,对方在 PEYT 里粘贴即可加你为好友;对方装 PEYT 后点开也能唤起。
      </div>
      <div class="ui-dialog-section">
        <div style="color:var(--text);word-break:break-all;font-family:var(--font-mono);font-size:var(--font-scale-body);line-height:1.6;user-select:all">${escapeHtml(link)}</div>
      </div>
    `,
    actions: [copyBtn, shareBtn],
  });
}
