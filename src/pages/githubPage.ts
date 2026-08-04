import { call } from '../api.js';
import { ui } from '../components/ui.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';

// D1 GitHub:独立 GitHub 界面(GitHubPage)。
// 全部走界面命令(全局 token,无则公开只读);复用 ui.ts 组件;状态页面内局部。
// 命令:get_github_settings/set_github_token/list_github_repos/add_github_repo/remove_github_repo/
//       github_repo/github_list_issues/github_get_issue/github_list_pulls/github_list_commits/
//       github_search_repo/github_search_code/github_list_events/github_get_content

// ── 后端 DTO(与 src-tauri/src/github/types.rs + dto.rs 对应,snake_case 响应)────
// DTO 全量保留:仓库数据 Tab(Issues/Pulls/…)渲染由 rightDrawer 承接(Task 2 复用)。

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

// 中间栏已隐藏,GitHub 完全主区化;此函数仅渲染占位(不会显示)。
export async function renderGithubNav(panel: HTMLElement): Promise<void> {
  panel.innerHTML = '';
}

export async function renderGithubMain(main: HTMLElement): Promise<void> {
  main.innerHTML = '';

  // ── 页面内局部状态(每次进入重建) ──
  let repo: GithubRepoDto | null = null; // 当前选中仓库
  let hasToken = false;
  let tokenValue = ''; // 设置弹窗预填/保存用
  let boundRepos: GithubRepoDto[] = []; // 已绑定仓库缓存(reloadRepos 填充)
  const repoMeta = new Map<string, RepoDto | null>(); // full_name → 元数据缓存(语言/星标/描述)

  const root = document.createElement('div');
  root.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';
  main.appendChild(root);

  // ── 玻璃工具条(复用 .main-header + chat-header 玻璃材质)──
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
  titleBox.innerHTML = `
    <div class="main-title">GitHub</div>
    <div class="main-subtitle">仓库浏览 · 代码搜索 · 绑定管理</div>
  `;
  const headerBadge = ui.badge({ text: '未配置 Token', variant: 'muted' });
  const refreshBtn = ui.iconButton({ icon: 'refresh-cw', title: '刷新', onClick: () => void refreshAll() });
  const settingsBtn = ui.iconButton({ icon: 'settings', title: '设置', onClick: () => openSettings(false) });
  const openWebBtn = ui.iconButton({ icon: 'external-link', title: '打开网页', onClick: () => void copyRepoUrl() });
  openWebBtn.style.display = 'none'; // 仅选中仓库时显示
  const actions = document.createElement('div');
  actions.className = 'main-actions';
  actions.append(headerBadge, refreshBtn, settingsBtn, openWebBtn);
  header.append(titleBox, actions);
  root.appendChild(header);

  // ── 仓库选择行(工具条下沿)──
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'flex-shrink:0;display:flex;align-items:center;gap:8px;padding:12px 20px 0';
  const repoLabel = document.createElement('span');
  repoLabel.style.cssText = 'font-size:var(--font-scale-body);color:var(--text-mute);white-space:nowrap';
  repoLabel.textContent = '仓库';
  const repoSelect = ui.select({ options: [{ value: '', label: '未绑定仓库' }], onChange: (v) => selectRepo(v) });
  repoSelect.style.cssText = 'flex:1;max-width:320px';
  const toolHint = document.createElement('span');
  toolHint.style.cssText = 'font-size:var(--font-scale-micro);color:var(--text-faint)';
  toolHint.textContent = '选中仓库后,右侧展示仓库数据';
  toolbar.append(repoLabel, repoSelect, toolHint);
  root.appendChild(toolbar);

  // ── 可滚动主区(flex row:左=仓库列表/引导,右=搜索)──
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;gap:16px;align-items:flex-start;max-width:1100px';
  root.appendChild(body);

  const leftCol = document.createElement('div');
  leftCol.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:12px';
  body.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:12px';
  body.appendChild(rightCol);

  // 仓库列表容器(renderBoundList 重建所在卡片)
  const repoListEl = document.createElement('div');
  repoListEl.style.cssText = 'display:flex;flex-direction:column;gap:6px';

  // ── 搜索区(右列):仓库搜索 + 代码搜索 ──
  const searchBody = document.createElement('div');
  searchBody.style.cssText = 'display:flex;flex-direction:column;gap:12px';

  const repoSearchInput = ui.input({ placeholder: '搜索仓库,如 peytchat', onEnter: () => void doRepoSearch() });
  const repoSearchBtn = ui.button({ label: '搜索仓库', icon: 'search', size: 'sm', variant: 'primary', onClick: () => void doRepoSearch() });
  const repoSearchRow = document.createElement('div');
  repoSearchRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  repoSearchRow.append(repoSearchInput, repoSearchBtn);
  searchBody.appendChild(ui.field({ label: '仓库搜索', children: repoSearchRow }));
  const repoResults = document.createElement('div');
  repoResults.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  searchBody.appendChild(repoResults);

  const codeSearchInput = ui.input({ placeholder: '搜索代码,如 fn main', onEnter: () => void doCodeSearch() });
  const codeSearchBtn = ui.button({ label: '搜索代码', icon: 'search', size: 'sm', onClick: () => void doCodeSearch() });
  const codeSearchRow = document.createElement('div');
  codeSearchRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  codeSearchRow.append(codeSearchInput, codeSearchBtn);
  searchBody.appendChild(ui.field({ label: '代码搜索', children: codeSearchRow, help: '需配置 GitHub Token' }));
  const codeResults = document.createElement('div');
  codeResults.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  searchBody.appendChild(codeResults);

  rightCol.appendChild(ui.card({ title: '搜索', children: searchBody }));

  // ── 数据加载 ──
  async function loadSettings(): Promise<void> {
    try {
      const s = await call<GithubSettingsDto>('get_github_settings');
      hasToken = !!s.token && s.token.trim() !== '';
      tokenValue = s.token || '';
      setTokenBadge();
    } catch { /* 忽略 */ }
  }
  function setTokenBadge(): void {
    headerBadge.className = `ui-badge${hasToken ? ' ui-badge-success' : ' ui-badge-muted'}`;
    headerBadge.textContent = hasToken ? '已配置 Token' : '未配置 Token';
  }
  async function refreshAll(): Promise<void> {
    await loadSettings();
    await reloadRepos();
  }

  // ── Token 保存/清除 ──
  async function saveToken(clear = false, raw = ''): Promise<void> {
    try {
      await call('set_github_token', { token: clear ? null : (raw.trim() || null) });
      hasToken = !clear && raw.trim() !== '';
      tokenValue = clear ? '' : raw.trim();
      setTokenBadge();
      ui.toast(clear ? 'Token 已清除' : 'Token 已保存');
      // 刷新仓库数据(可能从公开只读变为可写/私有可读)
      await reloadRepos();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }

  // ── 绑定仓库:添加 / 删除 ──
  async function addRepo(input: HTMLInputElement, listEl: HTMLElement): Promise<void> {
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
      await reloadRepos();
      await renderSettingsRepoList(listEl);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }
  function removeRepo(r: GithubRepoDto, listEl: HTMLElement | null): void {
    ui.confirm({
      title: '删除绑定',
      message: `解除绑定 ${r.full_name}?`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: async () => {
        try {
          await call('remove_github_repo', { id: r.id });
          ui.toast('已解除绑定');
          await reloadRepos();
          if (listEl) await renderSettingsRepoList(listEl);
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        }
      },
    });
  }

  // ── 已绑定仓库列表(主区左列)──
  async function reloadRepos(): Promise<void> {
    repoMeta.clear();
    let repos: GithubRepoDto[] = [];
    try {
      repos = await call<GithubRepoDto[]>('list_github_repos');
    } catch (e) {
      leftCol.innerHTML = '';
      leftCol.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    boundRepos = repos;
    const prevFull = repo?.full_name ?? '';
    // 刷新下拉,保持当前选中
    repoSelect.innerHTML = '';
    if (repos.length === 0) {
      repoSelect.appendChild(new Option('未绑定仓库', ''));
    } else {
      for (const r of repos) repoSelect.appendChild(new Option(r.full_name, r.full_name));
    }
    if (prevFull && repos.some((r) => r.full_name === prevFull)) {
      repoSelect.value = prevFull;
    } else if (repo) {
      // 选中仓库已被解除绑定 → 清空选中并收起抽屉
      repo = null;
      state.detailPanelOpen = false;
      state.rightDrawerOpen = false;
      saveState();
    }
    await renderBoundList();
  }
  async function renderBoundList(): Promise<void> {
    if (boundRepos.length === 0) {
      leftCol.innerHTML = '';
      leftCol.appendChild(renderEmptyGuide());
      updateSelectionHighlight();
      return;
    }
    const rows = await Promise.all(boundRepos.map((r) => renderRepoRow(r)));
    repoListEl.innerHTML = '';
    for (const row of rows) repoListEl.appendChild(row);
    leftCol.innerHTML = '';
    leftCol.appendChild(ui.card({ title: `已绑定仓库 · ${boundRepos.length}`, children: repoListEl }));
    updateSelectionHighlight();
  }
  async function renderRepoRow(r: GithubRepoDto): Promise<HTMLElement> {
    const meta = await fetchRepoMeta(r);
    const subtitle = meta
      ? `${meta.language ?? '未知语言'} · ★ ${meta.stargazers_count}${meta.description ? ' · ' + meta.description : ''}`
      : `${r.owner} / ${r.repo}`;
    const openBtn = ui.iconButton({
      icon: 'external-link',
      title: '复制链接',
      size: 'sm',
      onClick: () => void copyRepoUrl(r),
    });
    openBtn.addEventListener('click', (e) => e.stopPropagation());
    const row = ui.listItem({
      title: r.full_name,
      subtitle,
      icon: 'git-branch',
      onClick: () => selectRepo(r.full_name),
      trailing: openBtn,
    });
    row.dataset.full = r.full_name;
    return row;
  }
  async function fetchRepoMeta(r: GithubRepoDto): Promise<RepoDto | null> {
    const cached = repoMeta.get(r.full_name);
    if (cached !== undefined) return cached;
    try {
      const d = await call<RepoDto>('github_repo', { owner: r.owner, repo: r.repo });
      repoMeta.set(r.full_name, d);
      return d;
    } catch {
      repoMeta.set(r.full_name, null);
      return null;
    }
  }

  // ── 未绑定引导 ──
  function renderEmptyGuide(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px 20px;text-align:center;border:1px dashed var(--border-dashed);border-radius:var(--radius-md);background:var(--panel)';
    const title = document.createElement('div');
    title.textContent = '还没有绑定仓库';
    title.style.cssText = 'font-size:var(--font-scale-title);font-weight:600;color:var(--text)';
    const steps = document.createElement('div');
    steps.style.cssText = 'font-size:var(--font-scale-body);color:var(--text-mute);line-height:1.8';
    steps.innerHTML = '1. 点击右上角「设置」<br>2. 输入 <code>owner/repo</code>(如 <code>octocat/Hello-World</code>)添加绑定<br>3. 回到列表点击仓库浏览数据';
    const btn = ui.button({
      label: '去绑定仓库', icon: 'plus', variant: 'primary',
      onClick: () => openSettings(true),
    });
    wrap.append(title, steps, btn);
    return wrap;
  }

  // ── 选中仓库 → 设置 state 触发右侧抽屉(Task 2 渲染数据)──
  function selectRepo(fullName: string): void {
    const cur = boundRepos.find((r) => r.full_name === fullName) ?? null;
    if (fullName && !cur) {
      ui.toast(`仓库 ${fullName} 未绑定,请先在设置中添加`);
      return;
    }
    repoSelect.value = fullName || '';
    applySelection(cur);
  }
  function applySelection(next: GithubRepoDto | null): void {
    repo = next;
    updateSelectionHighlight();
    updateOpenWebBtn();
    if (!repo) {
      // 清理 github 残留 tab,避免泄漏到消息页(messages/groups 只认 members/pin)
      state.detailTab = 'members';
      state.detailPanelOpen = false;
      state.rightDrawerOpen = false;
      saveState();
      void openRightDrawer();
      return;
    }
    // 打开 rightDrawer 展示仓库数据;detailTab 由 Task 2 扩展类型
    state.currentPage = 'github';
    state.detailPanelOpen = true;
    state.detailTab = 'github' as any; // Task 2 扩展 detailTab 类型,届时移除 as any
    state.rightDrawerOpen = true;
    saveState();
    void openRightDrawer();
  }
  function updateSelectionHighlight(): void {
    const full = repo?.full_name ?? '';
    repoListEl.querySelectorAll<HTMLElement>('.ui-list-item').forEach((el) => {
      el.classList.toggle('active', !!full && el.dataset.full === full);
    });
  }
  function updateOpenWebBtn(): void {
    openWebBtn.style.display = repo ? '' : 'none';
  }
  function openRightDrawer(): void {
    void import('../shell/rightDrawer.js').then(({ renderRightDrawer }) => renderRightDrawer());
  }
  async function copyRepoUrl(r?: GithubRepoDto): Promise<void> {
    const target = r ?? repo;
    if (!target) return;
    const url = repoMeta.get(target.full_name)?.html_url ?? `https://github.com/${target.full_name}`;
    try {
      await navigator.clipboard.writeText(url);
      ui.toast('已复制仓库链接');
    } catch {
      ui.toast('复制失败');
    }
  }

  // ── 搜索逻辑 ──
  async function doRepoSearch(): Promise<void> {
    const q = repoSearchInput.value.trim();
    if (!q) { ui.toast('请输入搜索关键词'); return; }
    repoResults.innerHTML = '';
    repoResults.appendChild(ui.spinner());
    let results: SearchRepoDto[] = [];
    try {
      results = await call<SearchRepoDto[]>('github_search_repo', { query: q });
    } catch (e) {
      repoResults.innerHTML = '';
      repoResults.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    repoResults.innerHTML = '';
    if (results.length === 0) {
      repoResults.appendChild(ui.empty('未找到匹配仓库'));
      return;
    }
    for (const r of results.slice(0, 20)) {
      const bound = boundRepos.some((b) => b.full_name === r.full_name);
      repoResults.appendChild(ui.listItem({
        title: r.full_name,
        subtitle: `${r.language ?? '未知语言'} · ★ ${r.stargazers_count}${r.description ? ' · ' + r.description : ''}${bound ? ' · 已绑定' : ''}`,
        icon: 'git-branch',
        onClick: () => selectRepo(r.full_name),
      }));
    }
  }
  async function doCodeSearch(): Promise<void> {
    const q = codeSearchInput.value.trim();
    if (!q) { ui.toast('请输入搜索关键词'); return; }
    if (!hasToken) {
      ui.toast('代码搜索需要 GitHub Token,请先配置');
      return;
    }
    codeResults.innerHTML = '';
    codeResults.appendChild(ui.spinner());
    let results: SearchCodeDto[] = [];
    try {
      results = await call<SearchCodeDto[]>('github_search_code', { query: q });
    } catch (e) {
      codeResults.innerHTML = '';
      codeResults.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    codeResults.innerHTML = '';
    if (results.length === 0) {
      codeResults.appendChild(ui.empty('未找到匹配代码'));
      return;
    }
    for (const c of results.slice(0, 20)) {
      codeResults.appendChild(ui.listItem({
        title: `${c.repo_full_name}/${c.path}`,
        subtitle: c.name,
        icon: 'file-text',
      }));
    }
  }

  // ── 设置弹窗:token + 绑定仓库管理 ──
  function openSettings(focusRepo: boolean): void {
    const bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'display:flex;flex-direction:column;gap:14px';

    const tokenInput = ui.input({ type: 'password', placeholder: 'GitHub Token(留空 = 公开只读)', value: tokenValue });
    const saveBtn = ui.button({
      label: '保存 Token', icon: 'check', size: 'sm', variant: 'primary',
      onClick: async () => { await saveToken(false, tokenInput.value); },
    });
    const clearBtn = ui.button({
      label: '清除 Token', icon: 'trash', size: 'sm',
      onClick: async () => { await saveToken(true); tokenInput.value = ''; },
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

    const repoInput = ui.input({ placeholder: 'owner/repo,如 octocat/Hello-World', onEnter: () => void addRepo(repoInput, repoList) });
    const addBtn = ui.button({ label: '添加', icon: 'plus', size: 'sm', variant: 'primary', onClick: () => void addRepo(repoInput, repoList) });
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
        onClick: () => removeRepo(r, listEl),
      }),
    });
    row.style.cursor = 'default';
    return row;
  }

  // ── 初始化 ──
  await loadSettings();
  await reloadRepos();
  // 无选中仓库时收起右侧抽屉(避免上一页成员/置顶残留显示在 GitHub 页)
  if (!repo) {
    const drawerOpen = state.rightDrawerOpen || state.detailPanelOpen;
    state.detailTab = 'members';
    state.detailPanelOpen = false;
    state.rightDrawerOpen = false;
    if (drawerOpen) {
      saveState();
      void openRightDrawer();
    }
  }
}
