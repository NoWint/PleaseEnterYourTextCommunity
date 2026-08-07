// src/app/layout/titlebar/titlebar-session-events.ts
// 照抄 opencode components/titlebar-session-events.ts，去掉 ServerConnection 依赖（IM 单 server）。

export const SESSION_TABS_REMOVED_EVENT = "opencode:session-tabs-removed"

export type SessionTabsRemovedDetail = {
  server?: string
  directory: string
  sessionIDs: string[]
}

export function notifySessionTabsRemoved(input: SessionTabsRemovedDetail) {
  window.dispatchEvent(new CustomEvent(SESSION_TABS_REMOVED_EVENT, { detail: input }))
}

export function readSessionTabsRemovedDetail(event: Event): SessionTabsRemovedDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return undefined
  if (!("directory" in detail)) return undefined
  if (!("sessionIDs" in detail)) return undefined
  if (typeof detail.directory !== "string") return undefined
  if (!Array.isArray(detail.sessionIDs)) return undefined
  if ("server" in detail && detail.server !== undefined && typeof detail.server !== "string") return undefined

  const sessionIDs = detail.sessionIDs.filter((id): id is string => typeof id === "string")
  if (sessionIDs.length === 0) return undefined

  return {
    server: "server" in detail && typeof detail.server === "string" ? detail.server : undefined,
    directory: detail.directory,
    sessionIDs,
  }
}
