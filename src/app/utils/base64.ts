// src/app/utils/base64.ts
// base64 编解码（对齐 @opencode-ai/core/util/encode 的 web-safe 形状）。

export function base64Encode(input: string) {
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64Decode(input: string) {
  const binary = atob(input)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
