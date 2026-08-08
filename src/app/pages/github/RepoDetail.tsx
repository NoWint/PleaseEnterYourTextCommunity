// src/app/pages/github/RepoDetail.tsx
// 右侧仓库详情:tabs-v2 六 Tab(问题 / 拉取请求 / 提交 / 文件 / 动态 / 详情)。
// 命令:github_list_issues + github_get_issue / github_list_pulls / github_list_commits /
//       github_get_content + project_data_source / github_list_events / github_repo(全部已注册)。
// 页面内导航(tab 切换 / 文件面包屑 / 加载更多)全部为本地信号;仓库切换经 index.tsx 的
// keyed Show 整体重挂载,内部状态自然重置。

import { createEffect, createResource, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { call } from "@/api"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon, type IconProps } from "@opencode-ai/ui/v2/icon"
import { showToast } from "../../utils/toast"
import { fetchRepoMeta } from "./RepoList"
import {
  DataState,
  decodeBase64,
  eventIcon,
  fileIcon,
  fmtDate,
  fmtSize,
  LangDot,
  relativeTime,
  StatePill,
  StatusIcon,
  withTimeout,
} from "./utils"
import type { CommitDto, ContentDto, EventDto, GithubRepoDto, GithubTab, IssueDto, PullDto, PullFilter } from "./types"

const TAB_KEY_PREFIX = "peyt.githubTab:"

function loadTab(fullName: string): GithubTab {
  const saved = localStorage.getItem(TAB_KEY_PREFIX + fullName)
  return saved === "issues" || saved === "pulls" || saved === "commits" || saved === "files" || saved === "events" || saved === "details"
    ? saved
    : "issues"
}

const TABS: Array<{ id: GithubTab; label: string; icon: IconProps["name"] }> = [
  { id: "issues", label: "问题", icon: "menu" },
  { id: "pulls", label: "拉取请求", icon: "branch" },
  { id: "commits", label: "提交", icon: "review" },
  { id: "files", label: "文件", icon: "filetree" },
  { id: "events", label: "动态", icon: "status" },
  { id: "details", label: "详情", icon: "help" },
]

function NoRepo() {
  return (
    <div class="flex flex-1 items-center justify-center">
      <div class="flex flex-col items-center gap-2 text-center">
        <span class="text-v2-text-text-faint">
          <Icon name="branch" size="large" />
        </span>
        <span class="text-[13px] text-v2-text-text-faint">从左侧选择一个仓库开始浏览</span>
      </div>
    </div>
  )
}

export default function RepoDetail(props: {
  repo: GithubRepoDto | null
  onRefresh: () => void
}) {
  return (
    <Show when={props.repo} fallback={<NoRepo />} keyed>
      {(repo) => <RepoPane repo={repo} onRefresh={props.onRefresh} />}
    </Show>
  )
}

// ── 仓库主区:工具条 + Tab 条 + 内容区 ─────────────────────
function RepoPane(props: { repo: GithubRepoDto; onRefresh: () => void }) {
  const repo = () => props.repo
  const [tab, setTab] = createSignal<GithubTab>(loadTab(repo().full_name))
  const [tick, setTick] = createSignal(0) // 刷新计数,驱动各 Tab resource 重取

  const selectTab = (t: GithubTab) => {
    setTab(t)
    localStorage.setItem(TAB_KEY_PREFIX + repo().full_name, t)
  }

  const copyLink = async () => {
    const url = `https://github.com/${repo().full_name}`
    try {
      await navigator.clipboard.writeText(url)
      showToast({ title: "已复制仓库链接" })
    } catch {
      showToast({ title: "复制失败" })
    }
  }

  const refresh = () => {
    props.onRefresh()
    setTick((t) => t + 1)
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 工具条 */}
      <div class="flex shrink-0 items-center gap-2 border-b border-v2-border-border-weak-base px-3 py-2">
        <span class="truncate text-[13px] font-semibold text-v2-text-text-base">{repo().full_name}</span>
        <span class="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButtonV2 size="small" variant="ghost-muted" title="复制仓库链接" icon={<Icon name="outline-copy" size="small" />} onClick={() => void copyLink()} />
          <IconButtonV2 size="small" variant="ghost-muted" title="刷新" icon={<Icon name="reset" size="small" />} onClick={refresh} />
        </span>
      </div>

      {/* Tab 条 */}
      <TabsV2 value={tab()} onChange={(v) => selectTab((v ?? "issues") as GithubTab)} class="min-h-0 flex-1">
        <TabsV2.List class="shrink-0 border-b border-v2-border-border-weak-base px-2">
          <For each={TABS}>
            {(t) => (
              <TabsV2.Trigger value={t.id}>
                <Icon name={t.icon} size="small" />
                {t.label}
              </TabsV2.Trigger>
            )}
          </For>
        </TabsV2.List>
        <TabsV2.Content value="issues">
          <IssuesTab repo={repo()} tick={tick()} />
        </TabsV2.Content>
        <TabsV2.Content value="pulls">
          <PullsTab repo={repo()} tick={tick()} />
        </TabsV2.Content>
        <TabsV2.Content value="commits">
          <CommitsTab repo={repo()} tick={tick()} />
        </TabsV2.Content>
        <TabsV2.Content value="files">
          <FilesTab repo={repo()} tick={tick()} />
        </TabsV2.Content>
        <TabsV2.Content value="events">
          <EventsTab repo={repo()} tick={tick()} />
        </TabsV2.Content>
        <TabsV2.Content value="details">
          <DetailsTab repo={repo()} tick={tick()} />
        </TabsV2.Content>
      </TabsV2>
    </div>
  )
}

// ── 内容滚动容器 ─────────────────────────────────────────
function Scroller(props: { children: JSX.Element }) {
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex min-h-full flex-col divide-y divide-v2-border-border-weak-base">{props.children}</div>
    </div>
  )
}

// ── 问题 Tab ─────────────────────────────────────────────
function IssuesTab(props: { repo: GithubRepoDto; tick: number }) {
  const [issues, { refetch: refetchIssues }] = createResource(
    () => props.repo.full_name + "#" + props.tick,
    () => call<IssueDto[]>("github_list_issues", { owner: props.repo.owner, repo: props.repo.repo, state: "open" }),
  )
  return (
    <Scroller>
      <DataState loading={issues.loading && !issues()} error={issues.error} empty={!issues() || issues()!.length === 0} onRetry={() => refetchIssues()} />
      <For each={issues()}>
        {(it) => <IssueRow issue={it} repo={props.repo} />}
      </For>
    </Scroller>
  )
}

function IssueRow(props: { issue: IssueDto; repo: GithubRepoDto }) {
  const dialog = useDialog()
  return (
    <button
      type="button"
      class="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-v2-background-bg-raised"
      onClick={() => dialog.show(() => <IssueDetailDialog issue={props.issue} repo={props.repo} />)}
    >
      <span class="mt-0.5">
        <StatusIcon state={props.issue.state} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 flex-wrap items-center gap-1.5">
          <span class="truncate text-[13px] text-v2-text-text-base">{props.issue.title}</span>
          <For each={props.issue.labels.slice(0, 3)}>
            {(l) => (
              <span class="shrink-0 rounded-full bg-v2-background-bg-raised px-2 py-0.5 text-[10px] text-v2-text-text-muted">{l}</span>
            )}
          </For>
        </span>
        <span class="mt-0.5 block text-[11px] text-v2-text-text-faint">
          #{props.issue.number} · {props.issue.user} · {relativeTime(props.issue.updated_at)}
        </span>
      </span>
    </button>
  )
}

function IssueDetailDialog(props: { issue: IssueDto; repo: GithubRepoDto }) {
  const [detail] = createResource(
    () => props.issue.number,
    async (n) => {
      try {
        return await call<IssueDto>("github_get_issue", { owner: props.repo.owner, repo: props.repo.repo, number: n })
      } catch (e) {
        showToast({ title: "加载 Issue 详情失败", description: e instanceof Error ? e.message : String(e) })
        return props.issue
      }
    },
  )
  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>
          Issue #{props.issue.number} 详情
        </DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-2.5">
        <Show when={detail()} fallback={<div class="py-4 text-center text-[12px] text-v2-text-text-faint">加载中…</div>}>
          {(d) => (
            <>
              <div class="text-[14px] font-semibold text-v2-text-text-base">{d().title}</div>
              <div class="flex flex-wrap items-center gap-1.5">
                <StatePill state={d().state} />
                <For each={d().labels.slice(0, 5)}>
                  {(l) => <span class="rounded-full bg-v2-background-bg-raised px-2 py-0.5 text-[10px] text-v2-text-text-muted">{l}</span>}
                </For>
              </div>
              <pre class="m-0 max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-v2-text-text-muted">
                {d().body || "(无正文)"}
              </pre>
            </>
          )}
        </Show>
      </DialogBody>
    </Dialog>
  )
}

// ── 拉取请求 Tab ─────────────────────────────────────────
// 筛选状态模块级保留(同 legacy ghPullState:切换 Tab / 重挂载后保留上次筛选)。
let pullFilter: PullFilter = "open"

function PullsTab(props: { repo: GithubRepoDto; tick: number }) {
  const [filter, setFilter] = createSignal<PullFilter>(pullFilter)
  const [pulls, { refetch: refetchPulls }] = createResource(
    () => props.repo.full_name + ":" + filter() + "#" + props.tick,
    () => call<PullDto[]>("github_list_pulls", { owner: props.repo.owner, repo: props.repo.repo, state: filter() }),
  )
  const select = (f: PullFilter) => {
    pullFilter = f
    setFilter(f)
  }
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="shrink-0 px-3 py-2">
        <SegmentedControlV2 value={filter()} onChange={(v) => select((v ?? "open") as PullFilter)}>
          <SegmentedControlItemV2 value="open">开启</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="closed">已关闭</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="all">全部</SegmentedControlItemV2>
        </SegmentedControlV2>
      </div>
      <Scroller>
        <DataState loading={pulls.loading && !pulls()} error={pulls.error} empty={!pulls() || pulls()!.length === 0} onRetry={() => refetchPulls()} />
        <For each={pulls()}>
          {(p) => <PullRow pull={p} />}
        </For>
      </Scroller>
    </div>
  )
}

function PullRow(props: { pull: PullDto }) {
  const dialog = useDialog()
  const merged = !!props.pull.merged_at
  const color = merged ? "#a371f7" : props.pull.state === "open" ? "#3fb950" : "#a371f7"
  return (
    <button
      type="button"
      class="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-v2-background-bg-raised"
      onClick={() => dialog.show(() => <PullDetailDialog pull={props.pull} />)}
    >
      <span class="mt-0.5 shrink-0">
        {merged ? (
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5.118 5.686V10.314M5.118 5.686C5.97 5.686 6.661 4.995 6.661 4.143C6.661 3.291 5.97 2.6 5.118 2.6C4.266 2.6 3.575 3.291 3.575 4.143C3.575 4.995 4.266 5.686 5.118 5.686ZM5.118 10.314C4.266 10.314 3.575 11.005 3.575 11.857C3.575 12.709 4.266 13.4 5.118 13.4C5.97 13.4 6.661 12.709 6.661 11.857M5.118 10.314C5.97 10.314 6.661 11.005 6.661 11.857" stroke={color} stroke-width="1.5" fill={merged ? color : "none"} />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5.118 5.686V10.314M5.118 5.686C5.97 5.686 6.661 4.995 6.661 4.143C6.661 3.291 5.97 2.6 5.118 2.6C4.266 2.6 3.575 3.291 3.575 4.143C3.575 4.995 4.266 5.686 5.118 5.686ZM5.118 10.314C4.266 10.314 3.575 11.005 3.575 11.857C3.575 12.709 4.266 13.4 5.118 13.4C5.97 13.4 6.661 12.709 6.661 11.857M5.118 10.314C5.97 10.314 6.661 11.005 6.661 11.857M10.882 5.686C11.734 5.686 12.425 4.995 12.425 4.143C12.425 3.291 11.734 2.6 10.882 2.6C10.03 2.6 9.339 3.291 9.339 4.143C9.339 4.995 10.03 5.686 10.882 5.686ZM10.882 5.686V9.457C10.882 10.783 9.807 11.857 8.482 11.857H6.661" stroke={color} stroke-width="1.5" />
          </svg>
        )}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] text-v2-text-text-base">{props.pull.title}</span>
        <span class="mt-0.5 block text-[11px] text-v2-text-text-faint">
          #{props.pull.number} · <span class="text-[#3fb950]">+{props.pull.additions}</span>
          <span class="text-[#f85149]"> −{props.pull.deletions}</span> · {props.pull.user} · {relativeTime(props.pull.updated_at)}
        </span>
      </span>
    </button>
  )
}

function PullDetailDialog(props: { pull: PullDto }) {
  const d = () => props.pull
  const mergedAt = () => d().merged_at
  return (
    <Dialog size="normal">
      <DialogHeader>
        <DialogTitle>Pull Request #{d().number}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-2.5">
        <div class="text-[14px] font-semibold text-v2-text-text-base">{d().title}</div>
        <div class="flex flex-wrap items-center gap-1.5">
          <StatePill state={mergedAt() ? "merged" : d().state} />
          <span class="rounded-full bg-[color-mix(in_srgb,#3fb950_18%,transparent)] px-2 py-0.5 text-[11px] text-[#3fb950]">+{d().additions}</span>
          <span class="rounded-full bg-[color-mix(in_srgb,#f85149_18%,transparent)] px-2 py-0.5 text-[11px] text-[#f85149]">−{d().deletions}</span>
        </div>
        <div class="text-[12px] text-v2-text-text-faint">
          {d().user} · 创建 {fmtDate(d().created_at)} · 更新 {fmtDate(d().updated_at)}
          {mergedAt() ? ` · 合并 ${fmtDate(mergedAt()!)}` : ""}
        </div>
      </DialogBody>
    </Dialog>
  )
}

// ── 提交 Tab ─────────────────────────────────────────────
const COMMITS_PER_PAGE = 30

function CommitsTab(props: { repo: GithubRepoDto; tick: number }) {
  const [commits, setCommits] = createSignal<CommitDto[]>([])
  const [page, setPage] = createSignal(1)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [hasMore, setHasMore] = createSignal(false)

  const load = async (p: number) => {
    setLoading(true)
    setError("")
    try {
      const data = await withTimeout(
        call<CommitDto[]>("github_list_commits", { owner: props.repo.owner, repo: props.repo.repo, page: p }),
        30000, // 对齐后端 30s;网络慢时 commit 响应可达 20s+,不能 10s 就误判超时
      )
      setCommits((prev) => (p === 1 ? data : [...prev, ...data]))
      setHasMore(data.length >= COMMITS_PER_PAGE)
    } catch (e) {
      if (p === 1) setError(e instanceof Error && e.message === "timeout" ? "加载超时:连接 GitHub API 超时,请检查网络后重试" : e instanceof Error ? e.message : String(e))
      else showToast({ title: "加载失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load(1))
  let prevTick = props.tick
  createEffect(() => {
    if (props.tick === prevTick) return
    prevTick = props.tick
    setPage(1)
    setCommits([])
    void load(1)
  })

  return (
    <Scroller>
      <Show when={error()}>
        <div class="flex flex-col items-center gap-2 px-4 py-8 text-[12px] text-v2-text-text-faint">
          <span class="text-center">{error()}</span>
          <button type="button" class="rounded-md border border-v2-border-border-weak-base px-3 py-1 text-[11px] hover:bg-v2-background-bg-raised" onClick={() => void load(1)}>
            重试
          </button>
        </div>
      </Show>
      <Show when={!error() && commits().length === 0 && loading()}>
        <div class="py-10 text-center text-[12px] text-v2-text-text-faint">加载中…</div>
      </Show>
      <Show when={!error() && commits().length === 0 && !loading()}>
        <div class="py-10 text-center text-[12px] text-v2-text-text-faint">暂无 Commit</div>
      </Show>
      <For each={commits()}>
        {(c) => (
          <div class="flex items-start gap-2.5 px-4 py-2.5">
            <span class="mt-1.5 size-2 shrink-0 rounded-full bg-v2-text-text-faint" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] text-v2-text-text-base">{(c.message || "").split("\n")[0]}</div>
              <div class="mt-0.5 text-[11px] text-v2-text-text-faint">
                <span class="font-mono text-v2-text-text-muted">{c.sha.slice(0, 7)}</span> · {c.author ?? "未知"} · {c.date ? relativeTime(c.date) : "未知时间"}
              </div>
            </div>
          </div>
        )}
      </For>
      <Show when={hasMore()}>
        <div class="p-2">
          <button
            type="button"
            disabled={loading()}
            class="w-full rounded-md border border-v2-border-border-weak-base py-1.5 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-raised disabled:opacity-60"
            onClick={() => {
              const next = page() + 1
              setPage(next)
              void load(next)
            }}
          >
            {loading() ? "加载中…" : "加载更多"}
          </button>
        </div>
      </Show>
    </Scroller>
  )
}

// ── 文件 Tab:面包屑 + 目录树 ─────────────────────────────
function FilesTab(props: { repo: GithubRepoDto; tick: number }) {
  const dialog = useDialog()
  const [path, setPath] = createSignal("")
  const [items, { refetch: refetchItems }] = createResource(
    () => props.repo.full_name + ":" + path() + "#" + props.tick,
    () => call<ContentDto[]>("github_get_content", { owner: props.repo.owner, repo: props.repo.repo, path: path() }),
  )
  // 数据源徽标(本地 / GitHub),失败静默 → 默认 GitHub
  const [source] = createResource(
    () => props.repo.full_name + "#" + props.tick,
    () => call<string>("project_data_source", { owner: props.repo.owner, repo: props.repo.repo }).catch(() => "github"),
  )

  const segs = () => (path() ? path().split("/") : [])

  const openFile = (it: ContentDto) => dialog.show(() => <FileContentDialog item={it} repo={props.repo} />)

  return (
    <Scroller>
      <div class="flex items-center gap-1.5 border-b border-v2-border-border-weak-base px-3 py-2">
        <span class="rounded-full bg-v2-background-bg-raised px-2 py-0.5 text-[10px] text-v2-text-text-faint">
          数据源:{source() === "local" ? "本地" : "GitHub"}
        </span>
        <button type="button" class="rounded px-1.5 py-0.5 text-[12px] text-v2-text-text-muted hover:bg-v2-background-bg-raised" onClick={() => setPath("")}>
          {props.repo.repo}
        </button>
        <For each={segs()}>
          {(seg, i) => (
            <span class="flex items-center">
              <span class="text-v2-text-text-faint">
                <Icon name="chevron-down" size="small" class="rotate-[-90deg]" />
              </span>
              <button type="button" class="rounded px-1.5 py-0.5 text-[12px] text-v2-text-text-muted hover:bg-v2-background-bg-raised" onClick={() => setPath(segs().slice(0, i() + 1).join("/"))}>
                {seg}
              </button>
            </span>
          )}
        </For>
      </div>

      <DataState loading={items.loading && !items()} error={items.error} empty={!items() || items()!.length === 0} onRetry={() => refetchItems()} />

      <Show when={path()}>
        <button
          type="button"
          class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-v2-background-bg-raised"
          onClick={() => setPath(segs().slice(0, -1).join("/"))}
        >
          <span class="text-v2-text-text-faint">
            <Icon name="collapse" size="small" />
          </span>
          <span class="text-[12px] text-v2-text-text-muted">.. 上一级</span>
        </button>
      </Show>

      <For each={items()}>
        {(it) => {
          if (it.typ === "dir") {
            return (
              <button
                type="button"
                class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-v2-background-bg-raised"
                onClick={() => setPath(it.path)}
              >
                <span class="text-v2-text-text-faint">
                  <Icon name="folder" size="small" />
                </span>
                <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base">{it.name}</span>
                <span class="shrink-0 text-[11px] text-v2-text-text-faint">目录</span>
              </button>
            )
          }
          return (
            <button
              type="button"
              class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-v2-background-bg-raised"
              onClick={() => openFile(it)}
            >
              <span class="text-v2-text-text-faint">
                <Icon name={fileIcon(it.name)} size="small" />
              </span>
              <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base">{it.name}</span>
              <span class="shrink-0 text-[11px] text-v2-text-text-faint">{fmtSize(it.size)}</span>
            </button>
          )
        }}
      </For>
    </Scroller>
  )
}

function FileContentDialog(props: { item: ContentDto; repo: GithubRepoDto }) {
  const [item] = createResource(
    () => props.item.path,
    async (p) => {
      const arr = await call<ContentDto[]>("github_get_content", { owner: props.repo.owner, repo: props.repo.repo, path: p })
      return arr[0] ?? props.item
    },
  )
  const text = () => (item()?.content ? decodeBase64(item()!.content ?? "") : "(无法读取内容)")
  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>{props.item.name}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-2">
        <div class="truncate text-[12px] text-v2-text-text-faint">
          {props.repo.full_name}/{props.item.path}
        </div>
        <pre class="m-0 max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-v2-text-text-muted">
          {text()}
        </pre>
      </DialogBody>
    </Dialog>
  )
}

// ── 动态 Tab:事件时间线 ──────────────────────────────────
function EventsTab(props: { repo: GithubRepoDto; tick: number }) {
  const [events, { refetch: refetchEvents }] = createResource(
    () => props.repo.full_name + "#" + props.tick,
    () => call<EventDto[]>("github_list_events", { owner: props.repo.owner, repo: props.repo.repo }),
  )
  return (
    <Scroller>
      <DataState loading={events.loading && !events()} error={events.error} empty={!events() || events()!.length === 0} onRetry={() => refetchEvents()} />
      <For each={events()}>
        {(ev) => (
          <div class="flex items-start gap-2.5 px-4 py-2.5">
            <span class="mt-0.5 shrink-0 text-v2-text-text-faint">
              <Icon name={eventIcon(ev.typ)} size="small" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-v2-text-text-base">{ev.summary || ev.typ}</span>
              <span class="mt-0.5 block text-[11px] text-v2-text-text-faint">
                {ev.typ}
                {ev.actor ? ` · ${ev.actor}` : ""} · {relativeTime(ev.created_at)}
              </span>
            </span>
          </div>
        )}
      </For>
    </Scroller>
  )
}

// ── 详情 Tab:仓库信息卡 + README ─────────────────────────
function DetailsTab(props: { repo: GithubRepoDto; tick: number }) {
  const [meta] = createResource(
    () => props.repo.full_name + "#" + props.tick,
    () => fetchRepoMeta(props.repo),
  )
  const [readme, setReadme] = createSignal<{ text: string; error: boolean }>({ text: "加载中…", error: false })

  onMount(() => {
    void (async () => {
      try {
        const root = await call<ContentDto[]>("github_get_content", { owner: props.repo.owner, repo: props.repo.repo, path: "" })
        const rd = root.find((x) => x.typ === "file" && x.name.toLowerCase().startsWith("readme"))
        if (!rd) {
          setReadme({ text: "(未找到 README)", error: false })
          return
        }
        const arr = await call<ContentDto[]>("github_get_content", { owner: props.repo.owner, repo: props.repo.repo, path: rd.path })
        const file = arr[0]
        setReadme({ text: file?.content ? decodeBase64(file.content).slice(0, 3000) : "(无法读取)", error: false })
      } catch (e) {
        setReadme({ text: e instanceof Error ? e.message : String(e), error: true })
      }
    })()
  })

  return (
    <div class="flex-1 overflow-y-auto">
      <div class="flex flex-col gap-3 p-4">
        <Show when={meta()} fallback={<DataState loading={meta.loading} error={meta.error} empty={false} />}>
          {(d) => (
            <>
              <div class="flex items-center gap-2">
                <span class="truncate text-[16px] font-semibold text-v2-text-text-base">{d().full_name}</span>
                <Show when={d().language}>
                  <span class="flex shrink-0 items-center gap-1.5 rounded-full bg-v2-background-bg-raised px-2.5 py-0.5 text-[11px] text-v2-text-text-muted">
                    <LangDot lang={d().language} />
                    {d().language}
                  </span>
                </Show>
              </div>
              <Show when={d().description}>
                <p class="text-[12px] text-v2-text-text-muted">{d().description}</p>
              </Show>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-v2-text-text-faint">
                <span class="flex items-center gap-1">★ <b class="text-v2-text-text-base">{d().stargazers_count}</b></span>
                <span class="flex items-center gap-1">
                  <Icon name="branch" size="small" />
                  <b class="text-v2-text-text-base">{d().forks_count}</b>
                </span>
                <span class="flex items-center gap-1">
                  <Icon name="menu" size="small" />
                  <b class="text-v2-text-text-base">{d().open_issues_count}</b>
                </span>
                <span class="flex items-center gap-1">
                  <Icon name="branch" size="small" />
                  <span class="font-mono text-v2-text-text-muted">{d().default_branch}</span>
                </span>
              </div>
            </>
          )}
        </Show>

        <div class="overflow-hidden rounded-lg border border-v2-border-border-weak-base">
          <div class="border-b border-v2-border-border-weak-base px-3 py-1.5 text-[11px] font-semibold text-v2-text-text-faint">README</div>
          <pre class="m-0 max-h-[340px] overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed text-v2-text-text-muted">
            {readme().text}
          </pre>
        </div>
      </div>
    </div>
  )
}
