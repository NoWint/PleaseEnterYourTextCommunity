// src/app/pages/chat/virtual-items.ts
// 照抄 opencode pages/session/timeline/virtual-items.ts。

export function filterVirtualIndexes(indexes: number[], count: number) {
  return indexes.filter((index) => index >= 0 && index < count)
}
