// src/app/pages/github/index.tsx
// GitHub 集成页(d1 spec §7.2):左侧仓库栏(列表 + 搜索 + 设置入口)+ 右侧仓库详情。
// 迁移自 legacy src/pages/githubPage.ts:
// - 模块级回调三件套(editorRenderer / mainRepoSync / sidebarRefresher)→ 组件 props + signal
// - state.currentGithubRepo / state.githubTab 全局持久化 → 组件本地 signal + localStorage
// - ui.dialog / ui.toast → v2 dialog.show / showToast
// 命令:get_github_settings / set_github_token / list_github_repos / add_github_repo /
//       remove_github_repo / github_repo / github_* 数据命令 / open_external(全部已注册)。

import { createSignal, onMount } from "solid-js"
import { call } from "@/api"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { showToast } from "../../utils/toast"
import { clearRepoMetaCache, GithubSearch, RepoList, showAddRepoDialog } from "./RepoList"
import RepoDetail from "./RepoDetail"
import SettingsPanel from "./SettingsPanel"
import type { GithubRepoDto, GithubSettingsDto } from "./types"

const SELECTED_KEY = "peyt.githubRepo"

export default function GithubPage() {
  const dialog = useDialog()
  const [repos, setRepos] = createSignal<GithubRepoDto[]>([])
  const [selected, setSelected] = createSignal<GithubRepoDto | null>(null)
  const [hasToken, setHasToken] = createSignal(false)
  const [tokenValue, setTokenValue] = createSignal("")

  const loadSettings = async () => {
    try {
      const s = await call<GithubSettingsDto>("get_github_settings")
      setHasToken(!!s.token && s.token.trim() !== "")
      setTokenValue(s.token || "")
    } catch {
      // 忽略:默认无 token(公开只读)
    }
  }

  const loadRepos = async () => {
    clearRepoMetaCache()
    let list: GithubRepoDto[]
    try {
      list = await call<GithubRepoDto[]>("list_github_repos")
    } catch (e) {
      setRepos([])
      setSelected(null)
      showToast({ title: "加载仓库失败", description: e instanceof Error ? e.message : String(e) })
      return
    }
    setRepos(list)
    // 恢复选中:优先上次选择(localStorage),仍在绑定列表中才生效
    const saved = localStorage.getItem(SELECTED_KEY)
    const next = saved ? (list.find((r) => r.full_name === saved) ?? null) : null
    setSelected(next)
  }

  const refreshAll = async () => {
    await loadSettings()
    await loadRepos()
  }

  const selectRepo = (r: GithubRepoDto) => {
    if (r.id === 0) {
      // 搜索结果仓库:未绑定 → 提示
      if (!repos().some((x) => x.full_name === r.full_name)) {
        showToast({ title: `仓库 ${r.full_name} 未绑定,请先在设置中添加` })
        return
      }
    }
    setSelected(r)
    localStorage.setItem(SELECTED_KEY, r.full_name)
  }

  const openSettings = () =>
    dialog.show(() => (
      <SettingsPanel
        initialToken={tokenValue()}
        onSaved={(ok, value) => {
          setHasToken(ok)
          setTokenValue(value)
          void loadRepos()
        }}
      />
    ))

  onMount(() => {
    void loadSettings()
    void loadRepos()
  })

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      {/* 左侧:仓库栏 */}
      <aside class="flex w-60 shrink-0 flex-col border-r border-v2-border-border-weak-base">
        <div class="flex shrink-0 items-center gap-0.5 px-2.5 py-2">
          <span class="min-w-0 flex-1 truncate text-[13px] font-semibold text-v2-text-text-base">GitHub</span>
          <IconButtonV2
            size="small"
            variant="ghost-muted"
            title="添加仓库"
            icon={<Icon name="plus" size="small" />}
            onClick={() => showAddRepoDialog((el) => dialog.show(el), () => void loadRepos())}
          />
          <IconButtonV2 size="small" variant="ghost-muted" title="刷新" icon={<Icon name="reset" size="small" />} onClick={() => void refreshAll()} />
          <IconButtonV2 size="small" variant="ghost-muted" title="设置" icon={<Icon name="settings-gear" size="small" />} onClick={openSettings} />
        </div>
        <div class="min-h-0 flex-1">
          <RepoList repos={repos()} selected={selected()} onSelect={selectRepo} onChanged={() => void loadRepos()} />
        </div>
        <div class="shrink-0 border-t border-v2-border-border-weak-base p-2">
          <GithubSearch
            repos={repos()}
            hasToken={hasToken()}
            onSelectRepo={selectRepo}
            onOpenSettings={openSettings}
          />
        </div>
      </aside>

      {/* 右侧:仓库详情 */}
      <section class="flex min-h-0 min-w-0 flex-1 flex-col">
        <RepoDetail repo={selected()} onRefresh={() => void refreshAll()} />
      </section>
    </div>
  )
}
