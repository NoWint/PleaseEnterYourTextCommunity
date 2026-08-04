import { call } from '../api.js';
import { state } from '../state.js';
import { ui } from './ui.js';
import type { ChatListItem } from '../types.js';

// 分享邀请链接:选一个会话,把链接作为文本消息发过去(桌面端无系统分享面板,等价微信「发送给朋友」)。
// 适用于群二维码/个人邀请/频道邀请等所有生成 securejoin 链接的入口。
export async function sendInviteLink(link: string): Promise<void> {
  let chats: ChatListItem[] = [];
  try {
    chats = await call<ChatListItem[]>('get_chatlist');
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  // 排除当前会话,避免把链接发回源会话造成循环邀请。
  const targets = chats.filter((cc) => cc.chat_id !== state.currentChatId);
  if (targets.length === 0) {
    ui.toast('暂无可分享的会话');
    return;
  }
  const dlg = ui.dialog({ title: '分享到', body: '<div></div>', size: 'md' });
  const bodyEl = dlg.overlay.querySelector<HTMLElement>('.ui-dialog-body');
  if (!bodyEl) return;
  const listWrap = document.createElement('div');
  listWrap.style.maxHeight = '320px';
  listWrap.style.overflowY = 'auto';
  for (const chat of targets) {
    listWrap.appendChild(ui.listItem({
      title: chat.name,
      subtitle: chat.last_msg?.slice(0, 40) || '',
      onClick: async () => {
        dlg.close();
        try {
          await call('send_text', { chatId: chat.chat_id, text: link });
          ui.toast(`已发送到 ${chat.name}`);
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        }
      },
    }));
  }
  bodyEl.appendChild(listWrap);
}
