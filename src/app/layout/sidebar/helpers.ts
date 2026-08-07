// src/app/layout/sidebar/helpers.ts
// 照抄 opencode pages/layout/helpers.ts 改造（去掉 server/sync 依赖）。
// 会话列表工具：sortedRootSessions / displayName / getProjectAvatarSource 等。

import { getFilename, pathKey } from "../../utils/path"
import type { AppSession } from "../../types"
import type { LocalProject } from "../../context/layout"

type SessionStore = {
  session?: AppSession[]
  path: { directory: string }
}

function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: AppSession, b: AppSession) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

const isRootVisibleSession = (session: AppSession, directory: string) =>
  pathKey(session.directory) === pathKey(directory) && !session.parentID && !session.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, now: number) => roots(store).sort(sortSessions(now))

export const latestRootSession = (stores: SessionStore[], now: number) =>
  stores.flatMap(roots).sort(sortSessions(now))[0]

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree) || project.worktree

export function toggleHomeProjectSelection(
  current: { server: string; directory?: string } | undefined,
  server: string,
  directory: string,
) {
  if (current?.server === server && current.directory === directory) return { server }
  return { server, directory }
}

export function homeProjectDirectories(result: string | string[] | null) {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

export function getProjectAvatarSource(id?: string, icon?: { color?: string; url?: string; override?: string }) {
  if (icon?.override) return icon.override
  if (icon?.color) return undefined
  return icon?.url
}

export function projectForSession(
  session: AppSession,
  projects: LocalProject[],
  byID: Map<string, LocalProject> = new Map(
    projects.flatMap((project) => (project.id ? [[project.id, project] as const] : [])),
  ),
) {
  const direct = byID.get(session.projectID ?? "")
  if (direct) return direct
  const directory = pathKey(session.directory)
  return projects.find(
    (project) =>
      pathKey(project.worktree) === directory || project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
  )
}

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}
