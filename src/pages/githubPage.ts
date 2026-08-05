import { call } from '../api.js';
import { ui } from '../components/ui.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';
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
// renderGithubMain 渲染主编辑区(玻璃工具条 + Tab 条 + 内容区)。
// 数据 Tab(Issues/Pulls/Commits/Files/Events/Details)由 Task B 从 rightDrawer 迁入主区
// (renderGh* + openGh* + DTO),renderEditorContent 按 state.githubTab 分发。

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

// 文件 tab 的当前目录路径 + 所属仓库 key(切换仓库时重置)
let ghFilesPath = '';
let ghFilesRepoKey = '';

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
      void renderEditorContent();
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
  // 编辑区内容渲染分发:按 state.githubTab 调对应数据渲染函数填充内容区。
  // 每次渲染独立 wrap 容器:旧异步结果写旧 DOM(已卸载),避免跨 tab 竞态覆盖新内容。
  let contentRenderToken = 0;
  async function renderEditorContent(): Promise<void> {
    const token = ++contentRenderToken;
    const repo = ghSelected;
    content.innerHTML = '';
    if (!repo) {
      content.appendChild(ui.empty('从左侧选择仓库'));
      return;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
    content.appendChild(wrap);
    wrap.appendChild(ui.spinner());
    try {
      if (state.githubTab === 'issues') await renderGhIssues(wrap, repo);
      else if (state.githubTab === 'pulls') await renderGhPulls(wrap, repo);
      else if (state.githubTab === 'commits') await renderGhCommits(wrap, repo);
      else if (state.githubTab === 'files') await renderGhFiles(wrap, repo);
      else if (state.githubTab === 'events') await renderGhEvents(wrap, repo);
      else await renderGhDetails(wrap, repo);
    } catch (e) {
      if (token !== contentRenderToken) return;
      wrap.innerHTML = '';
      wrap.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    }
  }

  // 主区回调注册:仓库/设置变化同步 + 侧边栏选中仓库联动
  mainRepoSync = (): void => {
    headerBadge.className = `ui-badge${ghHasToken ? ' ui-badge-success' : ' ui-badge-muted'}`;
    headerBadge.textContent = ghHasToken ? '已配置 Token' : '未配置 Token';
    openWebBtn.style.display = ghSelected ? '' : 'none';
    setRepoTitle(ghSelected?.full_name ?? null);
    syncTabActive();
    void renderEditorContent();
  };
  editorRenderer = (repo: GithubRepoRef | null): void => {
    setRepoTitle(ghSelected?.full_name ?? (repo ? `${repo.owner}/${repo.repo}` : null));
    openWebBtn.style.display = ghSelected ? '' : 'none';
    syncTabActive();
    void renderEditorContent();
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

// ── 编辑区数据渲染(选中仓库 → 主区数据 tab;Task B 自 rightDrawer 迁入)──────────
// 富行样式复用 .rd-gh-*(styles.css),目标容器为编辑区内容区。每次 tab/仓库切换都会
// 重新分发渲染,旧异步结果写旧容器无副作用。
// 富行:状态 badge + 标签 chip + 作者/时间。点击 → Issue 详情弹窗
async function renderGhIssues(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  let issues: IssueDto[];
  try {
    issues = await call<IssueDto[]>('github_list_issues', { owner: repo.owner, repo: repo.repo, state: 'open' });
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  body.innerHTML = '';
  if (issues.length === 0) {
    body.appendChild(ui.empty('暂无 Issue'));
    return;
  }
  issues.forEach((it, i) => {
    if (i > 0) body.appendChild(document.createElement('div')).className = 'rd-gh-sep';
    const row = document.createElement('div');
    row.className = 'rd-gh-row';
    const labels = it.labels.length
      ? `<span class="ui-badge">${escapeHtml(it.labels.slice(0, 3).join(', '))}</span>` : '';
    row.innerHTML = `
      <div class="rd-gh-title">
        <span class="rd-gh-title-text">#${it.number} ${escapeHtml(it.title)}</span>
        ${stateBadge(it.state)}${labels}
      </div>
      <div class="rd-gh-sub">${escapeHtml(it.user)} · 更新于 ${fmtDate(it.updated_at)}</div>
    `;
    row.addEventListener('click', () => void openGhIssue(it, repo));
    body.appendChild(row);
  });
}
async function openGhIssue(it: IssueDto, repo: GithubRepoRef): Promise<void> {
  let detail = it;
  try {
    detail = await call<IssueDto>('github_get_issue', { owner: repo.owner, repo: repo.repo, number: it.number });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  const head = document.createElement('div');
  head.style.cssText = 'font-size:var(--font-scale-title);font-weight:600';
  head.textContent = `#${detail.number} ${detail.title}`;
  bodyEl.appendChild(head);
  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:var(--font-scale-secondary);color:var(--text-mute)';
  meta.appendChild(ui.badge({ text: detail.state, variant: detail.state === 'open' ? 'success' : 'muted' }));
  if (detail.labels.length) meta.appendChild(ui.badge({ text: detail.labels.slice(0, 5).join(', '), variant: 'default' }));
  bodyEl.appendChild(meta);
  const pre = document.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:var(--font-scale-body);line-height:1.6;margin:0;max-height:320px;overflow-y:auto;font-family:var(--font-mono)';
  pre.textContent = detail.body || '(无正文)';
  bodyEl.appendChild(pre);
  const dlg = ui.dialog({ title: 'Issue 详情', actions: [], size: 'lg' });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(bodyEl, actionsEl);
}

// Pulls:富行 + +N/-N(增绿减红)+ 合并状态。点击 → 详情弹窗
async function renderGhPulls(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  let pulls: PullDto[];
  try {
    pulls = await call<PullDto[]>('github_list_pulls', { owner: repo.owner, repo: repo.repo, state: 'open' });
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  body.innerHTML = '';
  if (pulls.length === 0) {
    body.appendChild(ui.empty('暂无 Pull Request'));
    return;
  }
  pulls.forEach((p, i) => {
    if (i > 0) body.appendChild(document.createElement('div')).className = 'rd-gh-sep';
    const row = document.createElement('div');
    row.className = 'rd-gh-row';
    const merged = p.merged_at ? '已合并' : p.state;
    row.innerHTML = `
      <div class="rd-gh-title">
        <span class="rd-gh-title-text">#${p.number} ${escapeHtml(p.title)}</span>
        ${stateBadge(merged)}
      </div>
      <div class="rd-gh-sub">
        <span class="rd-gh-pos">+${p.additions}</span> <span class="rd-gh-neg">-${p.deletions}</span>
        · ${escapeHtml(p.user)} · 更新于 ${fmtDate(p.updated_at)}
      </div>
    `;
    row.addEventListener('click', () => void openGhPull(p));
    body.appendChild(row);
  });
}
async function openGhPull(p: PullDto): Promise<void> {
  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  const head = document.createElement('div');
  head.style.cssText = 'font-size:var(--font-scale-title);font-weight:600';
  head.textContent = `#${p.number} ${p.title}`;
  bodyEl.appendChild(head);
  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:var(--font-scale-secondary);color:var(--text-mute)';
  meta.appendChild(ui.badge({ text: p.merged_at ? 'merged' : p.state, variant: p.merged_at ? 'muted' : (p.state === 'open' ? 'success' : 'muted') }));
  meta.appendChild(ui.badge({ text: `+${p.additions}`, variant: 'success' }));
  meta.appendChild(ui.badge({ text: `-${p.deletions}`, variant: 'danger' }));
  bodyEl.appendChild(meta);
  const info = document.createElement('div');
  info.style.cssText = 'font-size:var(--font-scale-secondary);color:var(--text-mute)';
  info.textContent = `${p.user} · 创建 ${fmtDate(p.created_at)} · 更新 ${fmtDate(p.updated_at)}${p.merged_at ? ` · 合并 ${fmtDate(p.merged_at)}` : ''}`;
  bodyEl.appendChild(info);
  const dlg = ui.dialog({ title: 'Pull Request', actions: [], size: 'md' });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(bodyEl, actionsEl);
}

// Commits:mono sha[0:7] + 消息首行 + 作者/日期
async function renderGhCommits(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  let commits: CommitDto[];
  try {
    commits = await call<CommitDto[]>('github_list_commits', { owner: repo.owner, repo: repo.repo });
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  body.innerHTML = '';
  if (commits.length === 0) {
    body.appendChild(ui.empty('暂无 Commit'));
    return;
  }
  commits.forEach((c, i) => {
    if (i > 0) body.appendChild(document.createElement('div')).className = 'rd-gh-sep';
    const row = document.createElement('div');
    row.className = 'rd-gh-row';
    row.innerHTML = `
      <div class="rd-gh-title">
        <span class="rd-gh-mono">${escapeHtml(c.sha.slice(0, 7))}</span>
        <span class="rd-gh-title-text">${escapeHtml((c.message || '').split('\n')[0])}</span>
      </div>
      <div class="rd-gh-sub">${escapeHtml(c.author ?? '未知')} · ${c.date ? fmtDate(c.date) : '未知时间'}</div>
    `;
    body.appendChild(row);
  });
}

// 文件:面包屑 + 目录/文件项。目录可进(更新 ghFilesPath + 重渲染),文件 → 内容弹窗
async function renderGhFiles(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  const key = `${repo.owner}/${repo.repo}`;
  if (ghFilesRepoKey !== key) {
    ghFilesRepoKey = key;
    ghFilesPath = '';
  }
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px';
  body.appendChild(wrap);

  const srcBadge = ui.badge({ text: '数据源:GitHub', variant: 'muted' });
  srcBadge.style.marginRight = '6px';
  void call<string>('project_data_source', { owner: repo.owner, repo: repo.repo })
    .then((src) => {
      const local = src === 'local';
      srcBadge.textContent = local ? '数据源:本地' : '数据源:GitHub';
      srcBadge.className = `ui-badge${local ? ' ui-badge-success' : ' ui-badge-muted'}`;
    })
    .catch(() => { /* 静默失败 → 默认 GitHub */ });

  const crumb = document.createElement('div');
  crumb.style.cssText = 'display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:var(--font-scale-secondary);color:var(--text-mute)';
  crumb.appendChild(srcBadge);
  const rootBtn = ui.button({ label: repo.repo, variant: 'ghost', size: 'sm', onClick: () => { ghFilesPath = ''; void renderGhFiles(body, repo); } });
  crumb.appendChild(rootBtn);
  if (ghFilesPath) {
    const segs = ghFilesPath.split('/');
    segs.forEach((seg, idx) => {
      crumb.appendChild(document.createTextNode('/'));
      const b = ui.button({ label: seg, variant: 'ghost', size: 'sm', onClick: () => { ghFilesPath = segs.slice(0, idx + 1).join('/'); void renderGhFiles(body, repo); } });
      crumb.appendChild(b);
    });
  }
  wrap.appendChild(crumb);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px';
  wrap.appendChild(list);

  // 上一级目录入口(不在根目录时)
  if (ghFilesPath) {
    list.appendChild(ui.listItem({
      title: '..',
      subtitle: '上一级',
      icon: 'arrow-up',
      onClick: () => { ghFilesPath = ghFilesPath.split('/').slice(0, -1).join('/'); void renderGhFiles(body, repo); },
    }));
  }

  let items: ContentDto[];
  try {
    items = await call<ContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: ghFilesPath });
  } catch (e) {
    list.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  if (items.length === 0) {
    list.appendChild(ui.empty('空目录'));
    return;
  }
  for (const it of items) {
    if (it.typ === 'dir') {
      list.appendChild(ui.listItem({
        title: it.name,
        subtitle: '目录',
        icon: 'package',
        onClick: () => { ghFilesPath = it.path; void renderGhFiles(body, repo); },
      }));
    } else {
      list.appendChild(ui.listItem({
        title: it.name,
        subtitle: `${it.size} B`,
        icon: 'file-text',
        onClick: () => void openGhFile(it, repo),
      }));
    }
  }
}
async function openGhFile(it: ContentDto, repo: GithubRepoRef): Promise<void> {
  let item = it;
  try {
    item = await call<ContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: it.path }).then((a) => a[0]);
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  const text = item.content ? decodeBase64(item.content) : '(无法读取内容)';
  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const head = document.createElement('div');
  head.style.cssText = 'font-size:var(--font-scale-body);font-weight:600;word-break:break-all';
  head.textContent = `${repo.owner}/${repo.repo}/${item.path}`;
  bodyEl.appendChild(head);
  const pre = document.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font-size:var(--font-scale-secondary);line-height:1.6;margin:0;max-height:400px;overflow-y:auto;font-family:var(--font-mono)';
  pre.textContent = text;
  bodyEl.appendChild(pre);
  const dlg = ui.dialog({ title: item.name, actions: [], size: 'lg' });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(bodyEl, actionsEl);
}

// 动态:时间线 — 事件类型 icon + 摘要(title)+ actor · 相对时间(subtitle)
async function renderGhEvents(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  let events: EventDto[];
  try {
    events = await call<EventDto[]>('github_list_events', { owner: repo.owner, repo: repo.repo });
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  body.innerHTML = '';
  if (events.length === 0) {
    body.appendChild(ui.empty('暂无动态'));
    return;
  }
  events.forEach((ev, i) => {
    if (i > 0) body.appendChild(document.createElement('div')).className = 'rd-gh-sep';
    const row = document.createElement('div');
    row.className = 'rd-gh-row';
    row.innerHTML = `
      <div class="rd-gh-title">
        ${iconSvg(eventIcon(ev.typ), { width: 14, height: 14, class: 'rd-gh-event-icon' })}
        <span class="rd-gh-title-text">${escapeHtml(ev.summary || ev.typ)}</span>
      </div>
      <div class="rd-gh-sub">${escapeHtml(ev.typ)}${ev.actor ? ' · ' + escapeHtml(ev.actor) : ''} · ${relativeTime(ev.created_at)}</div>
    `;
    body.appendChild(row);
  });
}

// 详情:仓库信息卡(描述/语言/星标/forks/issues/默认分支)+ README 前段
async function renderGhDetails(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  let d: RepoDto;
  try {
    d = await call<RepoDto>('github_repo', { owner: repo.owner, repo: repo.repo });
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:12px';
  body.appendChild(wrap);

  const title = document.createElement('div');
  title.style.cssText = 'font-size:var(--font-scale-title);font-weight:600;word-break:break-all';
  title.textContent = d.full_name;
  wrap.appendChild(title);

  if (d.description) {
    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:var(--font-scale-body);color:var(--text-mute);line-height:1.6';
    desc.textContent = d.description;
    wrap.appendChild(desc);
  }

  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center';
  if (d.language) meta.appendChild(ui.badge({ text: d.language, variant: 'default' }));
  meta.appendChild(ui.badge({ text: `★ ${d.stargazers_count}`, variant: 'default' }));
  meta.appendChild(ui.badge({ text: `fork ${d.forks_count}`, variant: 'default' }));
  meta.appendChild(ui.badge({ text: `open issues ${d.open_issues_count}`, variant: 'default' }));
  meta.appendChild(ui.badge({ text: `default branch ${d.default_branch}`, variant: 'muted' }));
  wrap.appendChild(meta);

  const readmeTitle = document.createElement('div');
  readmeTitle.style.cssText = 'font-size:var(--font-scale-body);font-weight:600;color:var(--text-mute)';
  readmeTitle.textContent = 'README';
  wrap.appendChild(readmeTitle);
  const readmeEl = document.createElement('pre');
  readmeEl.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:var(--font-scale-secondary);line-height:1.6;margin:0;max-height:320px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:var(--font-mono)';
  wrap.appendChild(readmeEl);
  try {
    const root = await call<ContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: '' });
    const readme = root.find((x) => x.typ === 'file' && x.name.toLowerCase().startsWith('readme'));
    if (readme) {
      const file = await call<ContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: readme.path }).then((a) => a[0]);
      readmeEl.textContent = file.content ? decodeBase64(file.content).slice(0, 3000) : '(无法读取)';
    } else {
      readmeEl.textContent = '(未找到 README)';
    }
  } catch (e) {
    readmeEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

// ── GitHub 工具函数(自 rightDrawer 迁入)────────────────────────────────
function stateBadge(state: string): string {
  const variant = state === 'open' ? 'success' : 'muted';
  return `<span class="ui-badge ui-badge-${variant}">${escapeHtml(state)}</span>`;
}
function eventIcon(typ: string): IconName {
  const map: Record<string, IconName> = {
    WatchEvent: 'star',
    ForkEvent: 'git-branch',
    PushEvent: 'arrow-up',
    CreateEvent: 'plus',
    DeleteEvent: 'trash',
    IssuesEvent: 'alert-circle',
    IssueCommentEvent: 'message-circle',
    PullRequestEvent: 'git-branch',
    PullRequestReviewEvent: 'check',
    ReleaseEvent: 'package',
    CommitCommentEvent: 'message-circle',
  };
  return map[typ] ?? 'timeline';
}
function fmtDate(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleDateString();
}
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}
function decodeBase64(b64: string): string {
  try {
    const binary = atob(b64.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return b64;
  }
}
