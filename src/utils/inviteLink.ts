// PEYT 邀请链接工具。
// 弃用 peyt://invite/<base64邮箱> 短链(不互通、无加密握手)。
// 改用 core 标准 securejoin 链接(https://peyt.yzjtiantian.cn/#<token>),见 deepLink.ts。

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
