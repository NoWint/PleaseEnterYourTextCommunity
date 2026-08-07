// src/app/types.ts
// IM-shaped data types for the new shell.
// Task 1 使用假数据（src/app/data/fake.ts），Task 3 接入真实数据时保持这些形状。

/** 一次聊天会话（IM 版 opencode Session）。 */
export interface AppSession {
  id: string
  title: string
  /** 所属工作区 key（AppWorkspace.worktree）。 */
  directory: string
  time: { created: number; updated?: number }
  parentID?: string
  archived?: boolean
  projectID?: string
  /** 未读数（Task 3 前为假数据）。 */
  unread: number
  /** 是否"工作中"（发送/加载中），Task 3 前为假数据。 */
  working?: boolean
}

/** 工作区（IM 版 opencode LocalProject，字段名保持 opencode 形状以便照抄组件）。 */
export interface AppWorkspace {
  id?: string
  name?: string
  /** 唯一 key，替代 opencode 的 worktree 路径语义。 */
  worktree: string
  expanded: boolean
  icon?: { color?: string; url?: string; override?: string }
  vcs?: string
  sandboxes?: string[]
}
