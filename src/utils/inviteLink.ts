// PEYT 好友邀请链接 — 纯前端生成/解析。
// 格式: peyt://invite/<base64url(email)>?n=<encodeURIComponent(name)>
// 不用 securejoin 长链接,对方粘贴链接后前端解码邮箱 → create_chat_by_email 建会话。

export function buildInviteLink(email: string, name?: string): string {
  const b64 = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const nameQuery = name ? `?n=${encodeURIComponent(name)}` : '';
  return `peyt://invite/${b64}${nameQuery}`;
}

// 解析 peyt://invite/<b64> 链接 → 邮箱;非法返回 null。
export function parseInviteLink(link: string): string | null {
  try {
    const m = link.trim().match(/^peyt:\/\/invite\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const email = atob(b64);
    return isEmail(email) ? email : null;
  } catch {
    return null;
  }
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
