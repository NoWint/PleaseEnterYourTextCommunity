// src/app/pages/bots/activity.ts
// bot-activity 事件订阅：走 Tauri 原生 listen（不走 dc-event 桥，与 legacy botsPage 一致），
// 按 bot 过滤分发；组件卸载时退订。

import type { BotActivityDto } from "./types"

type Handler = (a: BotActivityDto) => void

const handlers = new Set<Handler>()
let unlisten: (() => void) | null = null
let started = false

async function ensureListener(): Promise<void> {
  if (started) return
  started = true
  try {
    const { listen } = await import("@tauri-apps/api/event")
    unlisten = await listen("bot-activity", (ev) => {
      const payload = ev.payload as BotActivityDto
      for (const cb of handlers) cb(payload)
    })
  } catch {
    started = false
  }
}

export function onBotActivity(cb: Handler): () => void {
  handlers.add(cb)
  void ensureListener()
  return () => {
    handlers.delete(cb)
  }
}
