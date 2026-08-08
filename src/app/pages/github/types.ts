// src/app/pages/github/types.ts
// GitHub 集成页 DTO(snake_case,对应 src-tauri/src/github/types.rs + dto.rs)。
// 数据行命令与 legacy src/pages/githubPage.ts 完全一致,全部已注册
// (见 docs/agent/migration-data-flow.md §3:16 个命令 0 MISS)。

export type GithubTab = "issues" | "pulls" | "commits" | "files" | "events" | "details"
export type PullFilter = "open" | "closed" | "all"

export interface GithubSettingsDto {
  token?: string | null
}

export interface GithubRepoDto {
  id: number
  owner: string
  repo: string
  full_name: string
}

export interface RepoDto {
  full_name: string
  description: string | null
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
  default_branch: string
  html_url: string
}

export interface IssueDto {
  number: number
  title: string
  state: string
  user: string
  created_at: string
  updated_at: string
  labels: string[]
  body: string | null
  html_url: string
}

export interface PullDto {
  number: number
  title: string
  state: string
  user: string
  created_at: string
  updated_at: string
  merged_at: string | null
  additions: number
  deletions: number
  html_url: string
}

export interface CommitDto {
  sha: string
  message: string
  author: string | null
  date: string | null
}

export interface EventDto {
  typ: string
  actor: string | null
  created_at: string
  summary: string
}

export interface ContentDto {
  name: string
  path: string
  typ: string // "file" | "dir"
  size: number
  content: string | null
}

export interface SearchRepoDto {
  full_name: string
  description: string | null
  stargazers_count: number
  language: string | null
  html_url: string
}

export interface SearchCodeDto {
  name: string
  path: string
  repo_full_name: string
  html_url: string
}

/** "owner/repo" → [owner, repo] */
export function splitFullName(full: string): [string, string] {
  const idx = full.indexOf("/")
  if (idx <= 0 || idx === full.length - 1) return [full, ""]
  return [full.slice(0, idx), full.slice(idx + 1)]
}
