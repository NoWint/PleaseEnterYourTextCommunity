// 在线状态判断:core 的 was_seen_recently 语义 —— 对方最后活动时间落在 600s 窗口内即视为「在线」。
// 活动 = 收到对方发送的邮件(send timestamp 落库为 contacts.last_seen)。
// 参考 core/src/contact.rs: SEEN_RECENTLY_SECONDS = 600。

export const SEEN_RECENTLY_SECONDS = 600;

// last_seen(unix 秒,0 = 无记录)→ 是否在线
export function isOnline(lastSeen: number): boolean {
  if (!lastSeen) return false;
  return Date.now() / 1000 - lastSeen <= SEEN_RECENTLY_SECONDS;
}

// last_seen → 人类可读状态文案:在线 / X分钟前 / X小时前 / X天前 / 从未在线。
// 用于聊天列表绿点 tooltip 与 chat-header 状态行。
export function lastSeenText(lastSeen: number): string {
  if (!lastSeen) return '从未在线';
  const diffSec = Math.floor(Date.now() / 1000 - lastSeen);
  if (diffSec < SEEN_RECENTLY_SECONDS) return '在线';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}
