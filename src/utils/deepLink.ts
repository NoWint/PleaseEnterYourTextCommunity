import { call, onEvent } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { showToast } from '../toast.js';
import { isEmail } from './inviteLink.js';

// PEYT 深链路由(复刻 i.delta.chat 唤起体验):
// 网页/链接唤起 PEYT → Rust 发 dc-event(DeepLink)→ 本模块 routeDeepLink 处理。
//
// 链接类型:
// - https://peyt.yzjtiantian.cn/#<token> : PEYT 品牌域名链接,normalize 回 i.delta.chat 供 core
// - https://i.delta.chat/#<token>       : core 原生(粘贴进来)
// - OPENPGP4FPR:<token>                 : scheme 唤起(网页 Open chat 按钮)
// - dcaccount:/dclogin:                 : 静默忽略(所有账号均从客户端注册)
// - 纯邮箱                              : 建单聊

/** PEYT 品牌域名 → core 认的 i.delta.chat 域名(供 secure_join 解析)。 */
function normalizeUrl(url: string): string {
  if (url.startsWith('https://peyt.yzjtiantian.cn/')) {
    return 'https://i.delta.chat/' + url.slice('https://peyt.yzjtiantian.cn/'.length);
  }
  return url;
}

/**
 * 生成二维码前归一化:core check_qr 只认 https://i.delta.chat/# 或 OPENPGP4FPR:,
 * 不认 peyt.yzjtiantian.cn 域名。展示/复制用品牌链接,但**二维码内容**必须编码
 * core 可解析的形式,否则扫码端识别失败。
 */
export function normalizeUrlForQr(url: string): string {
  return normalizeUrl(url);
}

/** 深链处理主函数。 */
export async function routeDeepLink(rawUrl: string): Promise<void> {
  const url = rawUrl.trim();
  if (!url) return;
  try {
    // 1. 纯邮箱 → 建单聊
    if (isEmail(url)) {
      const chatId = await call<number>('create_chat_by_email', { email: url });
      await jumpToChat(chatId);
      return;
    }
    const lower = url.toLowerCase();
    // 2. dclogin:/dcaccount: → 静默忽略(所有账号均从客户端注册,无外部账号登录)
    if (lower.startsWith('dclogin:') || lower.startsWith('dcaccount:')) {
      return;
    }
    // 3. securejoin 链接(peyt 域名 / i.delta.chat / OPENPGP4FPR)→ secure_join
    const chatId = await call<number>('secure_join', { qr: normalizeUrl(url) });
    try { await call('accept_chat', { chatId }); } catch { /* 非请求会话忽略 */ }
    await jumpToChat(chatId);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  }
}

async function jumpToChat(chatId: number): Promise<void> {
  state.currentChatId = chatId;
  saveState();
  const { renderRail } = await import('../shell/rail.js');
  const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
  await renderRail();
  await renderNavPanel();
  await renderMain();
}

/** 注册深链事件监听(Rust emit dc-event DeepLink)。 */
export function registerDeepLinkListener(): void {
  onEvent('DeepLink', (e) => {
    const url = e.url as string | undefined;
    if (url) void routeDeepLink(url);
  });
}

/** 冷启动补收:应用启动后取 Rust PENDING 深链(启动早于事件注册时用)。 */
export async function processPendingDeepLink(): Promise<void> {
  try {
    const url = await call<string | null>('take_pending_deeplink');
    if (url) void routeDeepLink(url);
  } catch { /* 无 pending 忽略 */ }
}
