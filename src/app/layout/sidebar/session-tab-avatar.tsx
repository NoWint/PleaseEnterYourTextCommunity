// src/app/layout/sidebar/session-tab-avatar.tsx
// 照抄 opencode pages/layout/session-tab-avatar.tsx 改造：
// - SessionProgressIndicatorV2 → v2 Spinner
// - server 依赖保留（对齐 opencode 签名），useSessionTabAvatarState 走本地 chat context

import { getProjectAvatarVariant, type LocalProject } from "../../context/layout"
import { displayName, getProjectAvatarSource } from "./helpers"
import { useSessionTabAvatarState } from "./project-avatar-state"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Show } from "solid-js"
import type { ServerConnection } from "../../context/server"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  server: ServerConnection.Key
  revealProjectOnHover?: boolean
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.directory,
    () => props.sessionId,
  )
  return (
    <SessionTabAvatarView
      project={props.project}
      directory={props.directory}
      revealProjectOnHover={props.revealProjectOnHover}
      unread={state.unread()}
      loading={state.loading()}
    />
  )
}

export function SessionTabAvatarView(props: {
  project?: LocalProject
  directory: string
  revealProjectOnHover?: boolean
  unread: boolean
  loading: boolean
}) {
  const projectAvatar = () => (
    <ProjectAvatar
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      variant={getProjectAvatarVariant(props.project?.icon?.color)}
      unread={props.unread}
    />
  )
  return (
    <Show when={props.loading} fallback={projectAvatar()}>
      <span class="relative block size-4 shrink-0">
        <span class="absolute inset-0 flex items-center justify-center">
          <Spinner class="size-4" />
        </span>
        <Show when={props.revealProjectOnHover !== false}>
          <span class="invisible absolute inset-0 group-hover:visible">{projectAvatar()}</span>
        </Show>
      </span>
    </Show>
  )
}
