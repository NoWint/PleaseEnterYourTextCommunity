// src/app/utils/path.ts
// 轻量路径工具（对齐 opencode @opencode-ai/core/util/path + utils/path-key）。

export function getFilename(path: string) {
  const segments = path.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? path
}

export type PathKey = string

export const pathKey = (path: string): PathKey => {
  const trimmed = path.replace(/\/+$/, "")
  if (!trimmed && path.startsWith("/")) return "/"
  return trimmed
}
