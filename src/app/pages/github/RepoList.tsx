// src/app/pages/github/RepoList.tsx
// 左侧仓库栏:已绑定仓库列表(github_repo 元数据 + 缓存)+ 添加仓库对话框(add_github_repo)
// + 解除绑定(remove_github_repo,确认对话框)+ 搜索(仓库 github_search_repo / 代码 github_search_code)。
// 命令:list_github_repos / add_github_repo / remove_github_repo / github_repo /
//       github_search_repo / github_search_code(全部已注册)。

import { createResource, createSignal, For, Show, type JSX } from "solid-js"
import { call } from "@/api"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle, DialogFooter } from "@opencode-ai/ui/v2/dialog-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { showToast } from "../../utils/toast"
import { LangDot } from "./utils"
import type { GithubRepoDto, RepoDto, SearchCodeDto, SearchRepoDto } from "./types"

// ── 仓库元数据缓存(full_name → RepoDto|null),跨挂载保留,避免重复请求 ──
const repoMetaCache = new Map<string, RepoDto | null>()

export async function fetchRepoMeta(r: GithubRepoDto): Promise<RepoDto | null> {
  const cached = repoMetaCache.get(r.full_name)
  if (cached !== undefined) return cached
  try {
    const d = await call<RepoDto>("github_repo", { owner: r.owner, repo: r.repo })
    repoMetaCache.set(r.full_name, d)
    return d
  } catch {
    repoMetaCache.set(r.full_name, null)
    return null
  }
}

export function clearRepoMetaCache(): void {
  repoMetaCache.clear()
}

// ── 仓库行(绑定列表 / 搜索结果共用) ───────────────────────
// lang/stars/desc 显式传入(搜索结果)时跳过元数据请求;否则按 full_name 拉取 github_repo。
function RepoRow(props: {
  repo: GithubRepoDto
  active?: boolean
  lang?: string | null
  stars?: number | null
  desc?: string | null
  onSelect: () => void
  onRemove?: () => void
}) {
  const [meta] = createResource(() => props.repo.full_name, () => fetchRepoMeta(props.repo))

  const lang = () => (props.lang !== undefined ? props.lang : meta()?.language)
  const stars = () => (props.stars !== undefined ? props.stars : meta()?.stargazers_count)
  const desc = () => (props.desc !== undefined ? props.desc : meta()?.description)

  return (
    <button
      type="button"
      class="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-background-bg-raised"
      classList={{ "bg-v2-background-bg-raised": props.active === true }}
      onClick={props.onSelect}
    >
      <span class="mt-0.5 shrink-0 text-v2-text-text-faint">
        <Icon name="folder" size="small" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-medium text-v2-text-text-base">{props.repo.full_name}</span>
        <Show when={desc()}>
          <span class="mt-0.5 block truncate text-[11px] text-v2-text-text-faint">{desc()}</span>
        </Show>
        <Show when={lang()}>
          <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-v2-text-text-faint">
            <LangDot lang={lang()} />
            <span class="truncate">{lang()}</span>
          </span>
        </Show>
      </span>
      <span class="flex shrink-0 items-center gap-1">
        <Show when={stars() !== null && stars() !== undefined}>
          <span class="shrink-0 text-[11px] text-v2-text-text-faint">★ {stars()}</span>
        </Show>
        <Show when={props.onRemove}>
          <IconButtonV2
            size="small"
            variant="ghost-muted"
            icon={<Icon name="xmark-small" size="small" />}
            title="解除绑定"
            class="opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              props.onRemove?.()
            }}
          />
        </Show>
      </span>
    </button>
  )
}

// ── 添加仓库对话框 ────────────────────────────────────────
/** 供侧栏头部「+」与空状态「去绑定」共用 */
export function showAddRepoDialog(show: (el: () => JSX.Element) => void, onAdded: () => void) {
  show(() => <AddRepoDialog onAdded={onAdded} />)
}

function AddRepoDialog(props: { onAdded: () => void }) {
  const dialog = useDialog()
  let inputRef: HTMLInputElement | undefined
  const [error, setError] = createSignal("")

  const add = async () => {
    const val = inputRef?.value.trim() ?? ""
    const idx = val.indexOf("/")
    if (!val || idx <= 0 || idx === val.length - 1) {
      setError("请输入 owner/repo,如 octocat/Hello-World")
      return
    }
    const owner = val.slice(0, idx)
    const repoName = val.slice(idx + 1)
    if (!owner || owner.includes("/") || !repoName) {
      setError("仓库标识非法,应为 owner/repo")
      return
    }
    try {
      await call("add_github_repo", { owner, repo: repoName })
      showToast({ title: "已绑定" })
      props.onAdded()
      dialog.close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog size="normal">
      <DialogHeader>
        <DialogTitle>添加仓库</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-2">
        <TextInputV2
          ref={inputRef}
          placeholder="owner/repo,如 octocat/Hello-World"
          onKeyDown={(e) => {
            if (e.key === "Enter") void add()
          }}
        />
        <Show when={error()}>
          <span class="text-[11px] text-red-400">{error()}</span>
        </Show>
        <p class="text-[11px] text-v2-text-text-faint">
          输入 GitHub 仓库的 owner/repo,如 octocat/Hello-World,回车或点「添加」绑定。
        </p>
      </DialogBody>
      <DialogFooter>
        <div class="flex w-full items-center justify-end gap-2">
          <ButtonV2 size="small" variant="neutral" onClick={() => dialog.close()}>
            取消
          </ButtonV2>
          <ButtonV2 size="small" variant="contrast" icon="plus" onClick={() => void add()}>
            添加
          </ButtonV2>
        </div>
      </DialogFooter>
    </Dialog>
  )
}

// ── 仓库列表 + 空状态引导 ─────────────────────────────────
export function RepoList(props: {
  repos: GithubRepoDto[]
  selected: GithubRepoDto | null
  onSelect: (repo: GithubRepoDto) => void
  onChanged: () => void
}) {
  const dialog = useDialog()

  const openAddDialog = () => showAddRepoDialog((el) => dialog.show(el), props.onChanged)

  const confirmRemove = (r: GithubRepoDto) => {
    dialog.show(() => (
      <Dialog size="normal">
        <DialogHeader>
          <DialogTitle>解除绑定</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p class="text-[13px] text-v2-text-text-muted">确定解除绑定 {r.full_name} 吗?</p>
        </DialogBody>
        <DialogFooter>
          <div class="flex w-full items-center justify-end gap-2">
            <ButtonV2 size="small" variant="neutral" onClick={() => dialog.close()}>
              取消
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="danger"
              onClick={() => {
                void call("remove_github_repo", { id: r.id })
                  .then(() => {
                    showToast({ title: "已解除绑定" })
                    dialog.close()
                    props.onChanged()
                  })
                  .catch((e) => {
                    showToast({ title: "解除绑定失败", description: e instanceof Error ? e.message : String(e) })
                  })
              }}
            >
              删除
            </ButtonV2>
          </div>
        </DialogFooter>
      </Dialog>
    ))
  }

  return (
    <div class="flex h-full flex-col gap-0.5 overflow-y-auto px-1.5 py-1">
      <Show when={props.repos.length === 0} fallback={<></>}>
        <div class="flex flex-col items-center gap-2 py-10 text-center">
          <span class="text-v2-text-text-faint">
            <Icon name="branch" size="large" />
          </span>
          <span class="text-[13px] font-medium text-v2-text-text-base">还没有绑定仓库</span>
          <span class="px-3 text-[11px] text-v2-text-text-faint">绑定 owner/repo 即可浏览 Issues / PR / 提交等数据</span>
          <ButtonV2 size="small" variant="contrast" icon="plus" onClick={openAddDialog}>
            去绑定
          </ButtonV2>
        </div>
      </Show>
      <For each={props.repos}>
        {(r) => (
          <RepoRow
            repo={r}
            active={props.selected?.full_name === r.full_name}
            onSelect={() => props.onSelect(r)}
            onRemove={() => confirmRemove(r)}
          />
        )}
      </For>
    </div>
  )
}

// ── 搜索(仓库 + 代码一起搜,按分区展示) ─────────────────────
export function GithubSearch(props: {
  repos: GithubRepoDto[]
  hasToken: boolean
  onSelectRepo: (repo: GithubRepoDto) => void
  onOpenSettings: () => void
}) {
  let inputRef: HTMLInputElement | undefined
  const [repos, setRepos] = createSignal<SearchRepoDto[]>([])
  const [codes, setCodes] = createSignal<SearchCodeDto[]>([])
  const [loading, setLoading] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [done, setDone] = createSignal(false)

  const search = async () => {
    const q = inputRef?.value.trim() ?? ""
    if (!q) {
      showToast({ title: "请输入搜索关键词" })
      return
    }
    setLoading(true)
    setErr("")
    setDone(false)
    setRepos([])
    setCodes([])
    try {
      const rs = await call<SearchRepoDto[]>("github_search_repo", { query: q })
      setRepos(rs.slice(0, 10))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    if (props.hasToken) {
      try {
        const cs = await call<SearchCodeDto[]>("github_search_code", { query: q })
        setCodes(cs.slice(0, 10))
      } catch (e) {
        setErr((prev) => (prev ? `${prev}\n` : "") + (e instanceof Error ? e.message : String(e)))
      }
    }
    setLoading(false)
    setDone(true)
  }

  return (
    <div class="flex flex-col gap-1.5">
      <TextInputV2
        ref={inputRef}
        placeholder="搜索仓库 / 代码…"
        appearance="large"
        leadingIcon={<Icon name="magnifying-glass" size="small" />}
        onKeyDown={(e) => {
          if (e.key === "Enter") void search()
        }}
      />
      <Show when={loading()}>
        <div class="py-2 text-center text-[11px] text-v2-text-text-faint">搜索中…</div>
      </Show>
      <Show when={done() && !loading()}>
        <div class="flex max-h-[38vh] flex-col gap-1.5 overflow-y-auto pr-1">
          <div class="text-[11px] font-semibold text-v2-text-text-faint">仓库</div>
          <Show when={repos().length === 0 && !err()}>
            <div class="text-[11px] text-v2-text-text-faint">未找到匹配仓库</div>
          </Show>
          <For each={repos()}>
            {(r) => (
              <RepoRow
                repo={{
                  id: 0,
                  owner: r.full_name.split("/")[0] ?? "",
                  repo: r.full_name.split("/")[1] ?? "",
                  full_name: r.full_name,
                }}
                lang={r.language}
                stars={r.stargazers_count}
                desc={r.description}
                onSelect={() =>
                  props.onSelectRepo({
                    id: 0,
                    owner: r.full_name.split("/")[0] ?? "",
                    repo: r.full_name.split("/")[1] ?? "",
                    full_name: r.full_name,
                  })
                }
              />
            )}
          </For>
          <Show when={err()}>
            <div class="whitespace-pre-line text-[11px] text-red-400">{err()}</div>
          </Show>

          <div class="mt-1 flex items-center justify-between">
            <span class="text-[11px] font-semibold text-v2-text-text-faint">代码</span>
            <Show when={!props.hasToken}>
              <button type="button" class="text-[11px] text-blue-400 hover:underline" onClick={props.onOpenSettings}>
                需要 Token · 去配置
              </button>
            </Show>
          </div>
          <Show when={!props.hasToken}>
            <div class="text-[11px] text-v2-text-text-faint">代码搜索需要 Token 才能使用。</div>
          </Show>
          <Show when={props.hasToken && codes().length === 0 && !err()}>
            <div class="text-[11px] text-v2-text-text-faint">未找到匹配代码</div>
          </Show>
          <For each={codes()}>
            {(c) => (
              <button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-v2-background-bg-raised">
                <span class="shrink-0 text-v2-text-text-faint">
                  <Icon name="filetree" size="small" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px] text-v2-text-text-base">{c.name}</span>
                  <span class="block truncate text-[10px] text-v2-text-text-faint">
                    {c.repo_full_name}/{c.path}
                  </span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
