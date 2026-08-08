// src/app/pages/chat/measure.ts
// 照抄 opencode pages/session/timeline/measure.ts。

export function scheduleConnectedMeasure<T extends HTMLElement>(element: T, measure: (element: T) => void) {
  return requestAnimationFrame(() => {
    if (element.isConnected) measure(element)
  })
}
