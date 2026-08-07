// src/app/utils/base64.ts
// base64url 编解码（对齐 opencode 的 URL-safe 形状）：encode 输出无 + / = 的
// base64url（- 与 _），decode 兼容标准 base64（+ 与 /）与 base64url 两种输入。

export function base64Encode(input: string) {
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64Decode(input: string) {
  try {
    // 归一化 base64url → 标准 base64（标准 base64 输入不含 -/_，原样通过）
    let value = input.replace(/-/g, "+").replace(/_/g, "/")
    value = value.padEnd(Math.ceil(value.length / 4) * 4, "=")
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    // 非法 base64：原样返回，避免路由解析崩溃
    return input
  }
}
