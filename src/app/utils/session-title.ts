// src/app/utils/session-title.ts
// 会话标题工具（对齐 opencode utils/session-title）。

const pattern = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function sessionTitle(title?: string) {
  if (!title) return title
  const match = title.match(pattern)
  return match?.[1] ?? title
}
