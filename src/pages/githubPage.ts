import { call } from '../api.js';
import { ui } from '../components/ui.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import type { GithubRepoRef, GithubTab } from '../types.js';

// D1 GitHub:独立 GitHub 界面(GitHubPage)。
// 全部走界面命令(全局 token,无则公开只读);复用 ui.ts 组件;状态页面内局部。
// 命令:get_github_settings/set_github_token/list_github_repos/add_github_repo/remove_github_repo/
//       github_repo/github_list_issues/github_get_issue/github_list_pulls/github_list_commits/
//       github_search_repo/github_search_code/github_list_events/github_get_content
//
// D1 Task A:VSCode/IDE 式三栏。renderGithubNav 渲染侧边栏(仓库树 + 设置 + 搜索入口),
// renderGithubMain 渲染主编辑区(玻璃工具条 + Tab 条 + 内容区占位)。
// 数据 Tab(Issues/Pulls/…)渲染由 Task B 从 rightDrawer 迁回主区,本任务仅搭布局壳 + 路由。

// ── 后端 DTO(与 src-tauri/src/github/types.rs + dto.rs 对应,snake_case 响应)────
// DTO 全量保留:仓库数据 Tab(Issues/Pulls/…)渲染由 Task B 复用。
interface GithubSettingsDto { token?: string | null; }
interface GithubRepoDto { id: number; owner: string; repo: string; full_name: string; }
interface RepoDto {
  full_name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  html_url: string;
}
interface IssueDto {
  number: number;
  title: string;
  state: string;
  user: string;
  created_at: string;
  updated_at: string;
  labels: string[];
  body: string | null;
  html_url: string;
}
interface PullDto {
  number: number;
  title: string;
  state: string;
  user: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  additions: number;
  deletions: number;
  html_url: string;
}
interface CommitDto { sha: string; message: string; author: string | null; date: string | null; }
interface EventDto { typ: string; actor: string | null; created_at: string; summary: string; }
interface ContentDto { name: string; path: string; typ: string; size: number; content: string | null; }
interface SearchRepoDto {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  html_url: string;
}
interface SearchCodeDto { name: string; path: string; repo_full_name: string; html_url: string; }

// ── 模块级共享状态(renderGithubNav 与 renderGithubMain 共用;进入页面期间保持) ──
let ghSelected: GithubRepoDto | null = null;
let ghHasToken = false;
let ghTokenValue = ''; // 设置弹窗预填/保存用
let ghRepos: GithubRepoDto[] = []; // 已绑定仓库缓存
const ghRepoMeta = new Map<string, RepoDto | null>(); // full_name → 元数据缓存(语言/星标/描述)

// 侧边栏 ↔ 主区联动回调:
// - editorRenderer:renderGithubMain 注册;侧边栏选中仓库时调用,通知主区切换(核心联动机制)
// - mainRepoSync:renderGithubMain 注册;仓库列表/Token/选中变化后同步主区(badge/标题/Tab/内容)
// - sidebarRefresher:renderGithubNav 注册;仓库列表变化后重渲染侧边栏仓库树
let editorRenderer: ((repo: GithubRepoRef | null) => void) | null = null;
let mainRepoSync: (() => void) | null = null;
let sidebarRefresher: (() => void) | null = null;

// ── 共享数据操作(纯逻辑,不持有 DOM;视图刷新交给回调) ─────────────────────────
async function ghLoadSettings(): Promise<void> {
  try {
    const s = await call<GithubSettingsDto>('get_github_settings');
    ghHasToken = !!s.token && s.token.trim() !== '';
    ghTokenValue = s.token || '';
  } catch { /* 忽略 */ }
}

// 拉取绑定仓库列表 + 恢复/校验选中;失败时清空列表并刷新视图。
async function ghReloadRepos(): Promise<void> {
  ghRepoMeta.clear();
  let repos: GithubRepoDto[] = [];
  try {
    repos = await call<GithubRepoDto[]>('list_github_repos');
  } catch (e) {
    ghRepos = [];
    sidebarRefresher?.();
    mainRepoSync?.();
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  ghRepos = repos;
  // 恢复选中仓库:优先当前选中,否则从 state.currentGithubRepo 恢复(跨渲染/跨进入保留)
  const prevName = ghSelected?.full_name
    ?? (state.currentGithubRepo ? `${state.currentGithubRepo.owner}/${state.currentGithubRepo.repo}` : '');
  ghSelected = prevName && repos.some((r) => r.full_name === prevName)
    ? (repos.find((r) => r.full_name === prevName) ?? null)
    : null;
  // 同步 state.currentGithubRepo(选中变化 / 选中仓库被解除绑定)
  const stateName = state.currentGithubRepo ? `${state.currentGithubRepo.owner}/${state.currentGithubRepo.repo}` : '';
  if (ghSelected && stateName !== ghSelected.full_name) {
    state.currentGithubRepo = { owner: ghSelected.owner, repo: ghSelected.repo };
    saveState();
  } else if (!ghSelected && stateName) {
    state.currentGithubRepo = null;
    state.githubTab = 'issues';
    saveState();
  }
  sidebarRefresher?.();
  mainRepoSync?.();
}

// 选中仓库:写共享 state + 持久化 + 通知主区切换(不设置 detailTab/rightDrawer —— 抽屉对 github 禁用)。
function ghSelectRepo(fullName: string): void {
  const cur = ghRepos.find((r) => r.full_name === fullName) ?? null;
  if (fullName && !cur) {
    ui.toast(`仓库 ${fullName} 未绑定,请先在设置中添加`);
    return;
  }
  ghSelected = cur;
  state.currentGithubRepo = cur ? { owner: cur.owner, repo: cur.repo } : null;
  state.githubTab = 'issues';
  saveState();
  editorRenderer?.(cur ? { owner: cur.owner, repo: cur.repo } : null);
  sidebarRefresher?.();
}

async function ghRefreshAll(): Promise<void> {
  await ghLoadSettings();
  await ghReloadRepos();
}

async function ghFetchRepoMeta(r: GithubRepoDto): Promise<RepoDto | null> {
  const cached = ghRepoMeta.get(r.full_name);
  if (cached !== undefined) return cached;
  try {
    const d = await call<RepoDto>('github_repo', { owner: r.owner, repo: r.repo });
    ghRepoMeta.set(r.full_name, d);
    return d;
  } catch {
    ghRepoMeta.set(r.full_name, null);
    return null;
  }
}

async function ghCopyRepoUrl(r?: GithubRepoDto): Promise<void> {
  const target = r ?? ghSelected;
  if (!target) return;
  const url = ghRepoMeta.get(target.full_name)?.html_url ?? `https://github.com/${target.full_name}`;
  try {
    await navigator.clipboard.writeText(url);
    ui.toast('已复制仓库链接');
  } catch {
    ui.toast('复制失败');
  }
}

// ── 设置弹窗:Token + 绑定仓库管理(侧边栏/主区共用) ──────────────────────────
async function ghSaveToken(clear = false, raw = ''): Promise<void> {
  try {
    await call('set_github_token', { token: clear ? null : (raw.trim() || null) });
    ghHasToken = !clear && raw.trim() !== '';
    ghTokenValue = clear ? '' : raw.trim();
    ui.toast(clear ? 'Token 已清除' : 'Token 已保存');
    // 刷新仓库数据(可能从公开只读变为可写/私有可读)
    await ghReloadRepos();
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
}

async function ghAddRepo(input: HTMLInputElement, listEl: HTMLElement): Promise<void> {
  const val = input.value.trim();
  const idx = val.indexOf('/');
  if (!val || idx <= 0 || idx === val.length - 1) {
    ui.toast('请输入 owner/repo,如 octocat/Hello-World');
    return;
  }
  const owner = val.slice(0, idx);
  const repoName = val.slice(idx + 1);
  if (!owner || owner.includes('/') || !repoName) {
    ui.toast('仓库标识非法,应为 owner/repo');
    return;
  }
  try {
    await call('add_github_repo', { owner, repo: repoName });
    input.value = '';
    ui.toast('已绑定');
    await ghReloadRepos();
    await renderSettingsRepoList(listEl);
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
}

function ghRemoveRepo(r: GithubRepoDto, listEl: HTMLElement | null): void {
  ui.confirm({
    title: '删除绑定',
    message: `解除绑定 ${r.full_name}?`,
    confirmLabel: '删除',
    danger: true,
    onConfirm: async () => {
      try {
        await call('remove_github_repo', { id: r.id });
        ui.toast('已解除绑定');
        await ghReloadRepos();
        if (listEl) await renderSettingsRepoList(listEl);
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

function openSettings(focusRepo: boolean): void {
  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'display:flex;flex-direction:column;gap:14px';

  const tokenInput = ui.input({ type: 'password', placeholder: 'GitHub Token(留空 = 公开只读)', value: ghTokenValue });
  const saveBtn = ui.button({
    label: '保存 Token', icon: 'check', size: 'sm', variant: 'primary',
    onClick: async () => { await ghSaveToken(false, tokenInput.value); },
  });
  const clearBtn = ui.button({
    label: '清除 Token', icon: 'trash', size: 'sm',
    onClick: async () => { await ghSaveToken(true); tokenInput.value = ''; },
  });
  const tokenActions = document.createElement('div');
  tokenActions.style.cssText = 'display:flex;gap:8px';
  tokenActions.append(saveBtn, clearBtn);
  bodyEl.appendChild(ui.field({
    label: '全局 GitHub Token',
    children: tokenInput,
    help: '无 token 时公开仓库只读;代码搜索需 token。Token 仅保存在本机数据库。',
  }));
  bodyEl.appendChild(tokenActions);

  const repoInput = ui.input({ placeholder: 'owner/repo,如 octocat/Hello-World', onEnter: () => void ghAddRepo(repoInput, repoList) });
  const addBtn = ui.button({ label: '添加', icon: 'plus', size: 'sm', variant: 'primary', onClick: () => void ghAddRepo(repoInput, repoList) });
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  addRow.append(repoInput, addBtn);
  bodyEl.appendChild(ui.field({ label: '绑定仓库', children: addRow }));

  const repoList = document.createElement('div');
  repoList.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  bodyEl.appendChild(repoList);

  const dlg = ui.dialog({ title: 'GitHub 设置', actions: [] });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(bodyEl, actionsEl);

  void renderSettingsRepoList(repoList);
  if (focusRepo) repoInput.focus();
}

async function renderSettingsRepoList(listEl: HTMLElement): Promise<void> {
  let repos: GithubRepoDto[] = [];
  try {
    repos = await call<GithubRepoDto[]>('list_github_repos');
  } catch (e) {
    listEl.innerHTML = '';
    listEl.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  listEl.innerHTML = '';
  if (repos.length === 0) {
    listEl.appendChild(ui.empty('暂无绑定仓库'));
    return;
  }
  for (const r of repos) {
    listEl.appendChild(renderSettingsRepoRow(r, listEl));
  }
}

function renderSettingsRepoRow(r: GithubRepoDto, listEl: HTMLElement): HTMLElement {
  const row = ui.listItem({
    title: r.full_name,
    subtitle: `${r.owner} / ${r.repo}`,
    icon: 'git-branch',
    trailing: ui.iconButton({
      icon: 'trash', title: '删除', danger: true, size: 'sm',
      onClick: () => ghRemoveRepo(r, listEl),
    }),
  });
  row.style.cursor = 'default';
  return row;
}

// ── 搜索逻辑(渲染在侧边栏 footer 的搜索面板) ────────────────────────────────
async function doRepoSearch(queryEl: HTMLInputElement, resultsEl: HTMLElement): Promise<void> {
  const q = queryEl.value.trim();
  if (!q) { ui.toast('请输入搜索关键词'); return; }
  resultsEl.innerHTML = '';
  resultsEl.appendChild(ui.spinner());
  let results: SearchRepoDto[] = [];
  try {
    results = await call<SearchRepoDto[]>('github_search_repo', { query: q });
  } catch (e) {
    resultsEl.innerHTML = '';
    resultsEl.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  resultsEl.innerHTML = '';
  if (results.length === 0) {
    resultsEl.appendChild(ui.empty('未找到匹配仓库'));
    return;
  }
  for (const r of results.slice(0, 20)) {
    const bound = ghRepos.some((b) => b.full_name === r.full_name);
    resultsEl.appendChild(ui.listItem({
      title: r.full_name,
      subtitle: `${r.language ?? '未知语言'} · ★ ${r.stargazers_count}${r.description ? ' · ' + r.description : ''}${bound ? ' · 已绑定' : ''}`,
      icon: 'git-branch',
      onClick: () => ghSelectRepo(r.full_name),
    }));
  }
}

async function doCodeSearch(queryEl: HTMLInputElement, resultsEl: HTMLElement): Promise<void> {
  const q = queryEl.value.trim();
  if (!q) { ui.toast('请输入搜索关键词'); return; }
  if (!ghHasToken) {
    ui.toast('代码搜索需要 GitHub Token,请先配置');
    return;
  }
  resultsEl.innerHTML = '';
  resultsEl.appendChild(ui.spinner());
  let results: SearchCodeDto[] = [];
  try {
    results = await call<SearchCodeDto[]>('github_search_code', { query: q });
  } catch (e) {
    resultsEl.innerHTML = '';
    resultsEl.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  resultsEl.innerHTML = '';
  if (results.length === 0) {
    resultsEl.appendChild(ui.empty('未找到匹配代码'));
    return;
  }
  for (const c of results.slice(0, 20)) {
    resultsEl.appendChild(ui.listItem({
      title: `${c.repo_full_name}/${c.path}`,
      subtitle: c.name,
      icon: 'file-text',
    }));
  }
}

// ── 侧边栏:仓库树 + 设置入口 + 搜索入口(VSCode 式资源管理器感) ────────────────
export async function renderGithubNav(panel: HTMLElement): Promise<void> {
  panel.innerHTML = '';

  // header:「仓库」标题 + 设置/刷新按钮
  const header = document.createElement('div');
  header.className = 'nav-header';
  const titleBox = document.createElement('div');
  titleBox.innerHTML = `<div class="nav-title">GitHub</div><div class="nav-subtitle">仓库浏览</div>`;
  const headerActions = document.createElement('div');
  headerActions.className = 'nav-header-actions';
  const refreshBtn = ui.iconButton({ icon: 'refresh-cw', title: '刷新', size: 'sm', onClick: () => void ghRefreshAll() });
  const settingsBtn = ui.iconButton({ icon: 'settings', title: '设置', size: 'sm', onClick: () => openSettings(false) });
  headerActions.append(refreshBtn, settingsBtn);
  header.append(titleBox, headerActions);
  panel.appendChild(header);

  // 仓库树(绑定仓库列表 / 空引导)
  const tree = document.createElement('div');
  tree.className = 'nav-list';
  panel.appendChild(tree);

  // footer:搜索入口(仓库搜索/代码搜索,可折叠)
  const footer = document.createElement('div');
  footer.style.cssText = 'flex-shrink:0;border-top:1px solid var(--border);padding:8px 12px 10px;display:flex;flex-direction:column;gap:8px';
  const searchToggle = ui.button({ icon: 'search', size: 'sm', variant: 'ghost', onClick: toggleSearch });
  const searchLabel = document.createElement('span');
  searchLabel.textContent = '搜索';
  searchToggle.appendChild(searchLabel);
  footer.appendChild(searchToggle);
  const searchPanel = document.createElement('div');
  searchPanel.style.cssText = 'display:none;flex-direction:column;gap:10px;max-height:260px;overflow-y:auto';
  const repoSearchInput = ui.input({ placeholder: '搜索仓库,如 peytchat', onEnter: () => void doRepoSearch(repoSearchInput, repoResults) });
  const repoSearchBtn = ui.iconButton({ icon: 'search', title: '搜索仓库', size: 'sm', onClick: () => void doRepoSearch(repoSearchInput, repoResults) });
  const repoRow = document.createElement('div');
  repoRow.style.cssText = 'display:flex;gap:6px;align-items:center';
  repoRow.append(repoSearchInput, repoSearchBtn);
  const repoResults = document.createElement('div');
  repoResults.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  const codeSearchInput = ui.input({ placeholder: '搜索代码,如 fn main', onEnter: () => void doCodeSearch(codeSearchInput, codeResults) });
  const codeSearchBtn = ui.iconButton({ icon: 'search', title: '搜索代码', size: 'sm', onClick: () => void doCodeSearch(codeSearchInput, codeResults) });
  const codeRow = document.createElement('div');
  codeRow.style.cssText = 'display:flex;gap:6px;align-items:center';
  codeRow.append(codeSearchInput, codeSearchBtn);
  const codeResults = document.createElement('div');
  codeResults.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  searchPanel.append(repoRow, repoResults, codeRow, codeResults);
  footer.appendChild(searchPanel);
  panel.appendChild(footer);

  function toggleSearch(): void {
    const show = searchPanel.style.display === 'none';
    searchPanel.style.display = show ? 'flex' : 'none';
    searchLabel.textContent = show ? '收起' : '搜索';
    if (show) repoSearchInput.focus();
  }

  // 仓库树渲染
  async function renderTree(): Promise<void> {
    tree.innerHTML = '';
    if (ghRepos.length === 0) {
      tree.appendChild(renderEmptyGuide());
      return;
    }
    for (const r of ghRepos) tree.appendChild(await renderRepoRow(r));
  }
  async function renderRepoRow(r: GithubRepoDto): Promise<HTMLElement> {
    const meta = await ghFetchRepoMeta(r);
    const subtitle = meta
      ? `${meta.language ?? '未知语言'} · ★ ${meta.stargazers_count}${meta.description ? ' · ' + meta.description : ''}`
      : `${r.owner} / ${r.repo}`;
    const row = ui.listItem({
      title: r.full_name,
      subtitle,
      icon: 'git-branch',
      onClick: () => ghSelectRepo(r.full_name),
    });
    row.dataset.full = r.full_name;
    row.classList.toggle('active', !!ghSelected && ghSelected.full_name === r.full_name);
    return row;
  }
  function renderEmptyGuide(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:24px 16px;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center';
    const title = document.createElement('div');
    title.textContent = '还没有绑定仓库';
    title.style.cssText = 'font-size:var(--font-scale-body);font-weight:600;color:var(--text)';
    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:var(--font-scale-micro);color:var(--text-faint);line-height:1.7';
    desc.textContent = '点击右上角「设置」添加 owner/repo 即可浏览数据';
    const btn = ui.button({ label: '去绑定', icon: 'plus', size: 'sm', variant: 'primary', onClick: () => openSettings(true) });
    wrap.append(title, desc, btn);
    return wrap;
  }

  // 仓库列表变化 → 重渲染树
  sidebarRefresher = () => { void renderTree(); };

  // 初始化
  await ghLoadSettings();
  await ghReloadRepos();
}

// ── 主编辑区:玻璃工具条 + Tab 条 + 内容区(VSCode 式) ────────────────────────
export async function renderGithubMain(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const root = document.createElement('div');
  root.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';
  main.appendChild(root);

  // 玻璃工具条(复用 .main-header + chat-header 玻璃材质):当前仓库名 + Token badge + 打开网页/刷新
  const header = document.createElement('div');
  header.className = 'main-header';
  header.style.cssText = [
    'flex-shrink:0',
    'position:sticky;top:0;z-index:10',
    'background:color-mix(in srgb, var(--panel) 86%, transparent)',
    '-webkit-backdrop-filter:blur(18px) saturate(150%)',
    'backdrop-filter:blur(18px) saturate(150%)',
    'box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 40%, transparent)',
  ].join(';');
  const titleBox = document.createElement('div');
  const headerBadge = ui.badge({ text: '未配置 Token', variant: 'muted' });
  const openWebBtn = ui.iconButton({ icon: 'external-link', title: '打开网页', onClick: () => void ghCopyRepoUrl() });
  openWebBtn.style.display = 'none'; // 仅选中仓库时显示
  const refreshBtn = ui.iconButton({ icon: 'refresh-cw', title: '刷新', onClick: () => void ghRefreshAll() });
  const actions = document.createElement('div');
  actions.className = 'main-actions';
  actions.append(headerBadge, refreshBtn, openWebBtn);
  header.append(titleBox, actions);
  root.appendChild(header);

  // 编辑区 Tab 条(VSCode 式:紧凑堆叠,active 下划线高亮)
  const GH_TABS: Array<{ id: GithubTab; label: string; icon: IconName }> = [
    { id: 'issues', label: 'Issues', icon: 'alert-circle' },
    { id: 'pulls', label: 'Pulls', icon: 'git-branch' },
    { id: 'commits', label: 'Commits', icon: 'clock' },
    { id: 'files', label: '文件', icon: 'package' },
    { id: 'events', label: '动态', icon: 'timeline' },
    { id: 'details', label: '详情', icon: 'info' },
  ];
  const tabsEl = document.createElement('div');
  tabsEl.className = 'gh-editor-tabs';
  const tabEls = GH_TABS.map((t) => {
    const b = document.createElement('button');
    b.className = 'gh-editor-tab';
    b.dataset.tab = t.id;
    b.title = t.label;
    b.innerHTML = `${iconSvg(t.icon, { width: 14, height: 14 })}<span>${t.label}</span>`;
    b.addEventListener('click', () => {
      if (!ghSelected) return;
      state.githubTab = t.id;
      saveState();
      syncTabActive();
      renderEditorContent();
    });
    return b;
  });
  for (const t of tabEls) tabsEl.appendChild(t);
  root.appendChild(tabsEl);

  // 内容区(数据由 Task B 渲染;本任务为占位 spinner)
  const content = document.createElement('div');
  content.style.cssText = 'flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column';
  root.appendChild(content);

  function syncTabActive(): void {
    for (const b of tabEls) b.classList.toggle('active', b.dataset.tab === state.githubTab);
  }
  function setRepoTitle(fullName: string | null): void {
    titleBox.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'main-title';
    t.textContent = fullName ?? 'GitHub';
    const s = document.createElement('div');
    s.className = 'main-subtitle';
    s.textContent = fullName ? '仓库数据 · 点击标签页查看' : '仓库浏览 · 代码搜索 · 绑定管理';
    titleBox.append(t, s);
  }
  const tabLabel = (): string => GH_TABS.find((t) => t.id === state.githubTab)?.label ?? '';
  function renderEditorContent(): void {
    content.innerHTML = '';
    if (!ghSelected) {
      content.appendChild(ui.empty('从左侧选择仓库'));
      return;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:48px 24px;color:var(--text-faint)';
    wrap.appendChild(ui.spinner());
    const name = document.createElement('div');
    name.style.cssText = 'font-size:var(--font-scale-body);color:var(--text-mute);font-weight:500';
    name.textContent = ghSelected.full_name;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:var(--font-scale-micro);color:var(--text-faint)';
    sub.textContent = `${tabLabel()} · 数据渲染由后续任务接入`;
    wrap.append(name, sub);
    content.appendChild(wrap);
  }

  // 主区回调注册:仓库/设置变化同步 + 侧边栏选中仓库联动
  mainRepoSync = (): void => {
    headerBadge.className = `ui-badge${ghHasToken ? ' ui-badge-success' : ' ui-badge-muted'}`;
    headerBadge.textContent = ghHasToken ? '已配置 Token' : '未配置 Token';
    openWebBtn.style.display = ghSelected ? '' : 'none';
    setRepoTitle(ghSelected?.full_name ?? null);
    syncTabActive();
    renderEditorContent();
  };
  editorRenderer = (repo: GithubRepoRef | null): void => {
    setRepoTitle(ghSelected?.full_name ?? (repo ? `${repo.owner}/${repo.repo}` : null));
    openWebBtn.style.display = ghSelected ? '' : 'none';
    syncTabActive();
    renderEditorContent();
  };

  // 初始化:加载设置 + 仓库(侧边栏可能已加载,复用);同步主区显示
  await ghLoadSettings();
  if (ghRepos.length === 0) await ghReloadRepos();
  mainRepoSync();

  // right-drawer 对 github 页禁用:确保折叠,并清理上一页(messages/groups)的抽屉残留。
  // (githubPage 不再设置 detailTab='github' / rightDrawerOpen)
  const hadDrawer = state.detailPanelOpen || state.rightDrawerOpen;
  state.detailTab = 'members';
  state.detailPanelOpen = false;
  state.rightDrawerOpen = false;
  if (hadDrawer) {
    saveState();
    void import('../shell/rightDrawer.js').then(({ renderRightDrawer }) => renderRightDrawer());
  }
}
