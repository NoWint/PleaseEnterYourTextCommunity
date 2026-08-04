import { call } from '../api.js';
import { ui } from '../components/ui.js';

// D1 GitHub:独立 GitHub 界面(GitHubPage)。
// 全部走界面命令(全局 token,无则公开只读);复用 ui.ts 组件;状态页面内局部。
// 命令:get_github_settings/set_github_token/list_github_repos/add_github_repo/remove_github_repo/
//       github_repo/github_list_issues/github_get_issue/github_list_pulls/github_list_commits/
//       github_search_repo/github_search_code/github_list_events/github_get_content

// ── 后端 DTO(与 src-tauri/src/github/types.rs + dto.rs 对应,snake_case 响应)────

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

type GithubTab = 'issues' | 'pulls' | 'commits' | 'files' | 'events' | 'details';

const GH_TABS: Array<{ id: GithubTab; label: string }> = [
  { id: 'issues', label: 'Issues' },
  { id: 'pulls', label: 'Pulls' },
  { id: 'commits', label: 'Commits' },
  { id: 'files', label: '文件' },
  { id: 'events', label: '动态' },
  { id: 'details', label: '详情' },
];

// 中间栏已隐藏,GitHub 完全主区化;此函数仅渲染占位(不会显示)。
export async function renderGithubNav(panel: HTMLElement): Promise<void> {
  panel.innerHTML = '';
}

export async function renderGithubMain(main: HTMLElement): Promise<void> {
  main.innerHTML = '';

  // ── 页面内局部状态(每次进入重建) ──
  let repo: GithubRepoDto | null = null; // 当前选中仓库
  let activeTab: GithubTab = 'issues';
  let filesPath = ''; // 文件 tab 的当前目录
  let hasToken = false;

  const root = document.createElement('div');
  root.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';
  main.appendChild(root);

  // 顶栏
  const header = document.createElement('div');
  header.className = 'main-header';
  header.style.cssText = 'flex-shrink:0';
  const titleBox = document.createElement('div');
  titleBox.innerHTML = `
    <div class="main-title">GitHub</div>
    <div class="main-subtitle">仓库浏览 · 代码搜索 · 绑定管理</div>
  `;
  const headerBadge = ui.badge({ text: '未配置 token', variant: 'muted' });
  const actions = document.createElement('div');
  actions.className = 'main-actions';
  actions.appendChild(headerBadge);
  header.appendChild(titleBox);
  header.appendChild(actions);
  root.appendChild(header);

  // 可滚动正文
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:16px;max-width:1000px';
  root.appendChild(body);

  // ── 设置区:全局 token + 已绑定仓库管理 ──
  const settingsBody = document.createElement('div');
  settingsBody.style.cssText = 'display:flex;flex-direction:column;gap:12px';

  const tokenInput = ui.input({ type: 'password', placeholder: 'GitHub Token(留空 = 公开只读)' });
  const tokenActions = document.createElement('div');
  tokenActions.style.cssText = 'display:flex;gap:8px';
  tokenActions.appendChild(ui.button({
    label: '保存 Token', icon: 'check', size: 'sm', variant: 'primary',
    onClick: async () => { await saveToken(); },
  }));
  tokenActions.appendChild(ui.button({
    label: '清除 Token', icon: 'trash', size: 'sm',
    onClick: async () => { await saveToken(true); },
  }));
  tokenActions.appendChild(ui.button({
    label: '刷新仓库', icon: 'refresh-cw', size: 'sm',
    onClick: async () => { await reloadRepos(); },
  }));
  settingsBody.appendChild(ui.field({
    label: '全局 GitHub Token',
    children: tokenInput,
    help: '无 token 时公开仓库只读;代码搜索需 token。Token 仅保存在本机数据库。',
  }));
  settingsBody.appendChild(tokenActions);

  // 已绑定仓库:添加行 + 列表
  const repoInput = ui.input({ placeholder: 'owner/repo,如 octocat/Hello-World', onEnter: () => void addRepo() });
  const addRepoBtn = ui.button({ label: '添加', icon: 'plus', size: 'sm', variant: 'primary', onClick: () => void addRepo() });
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  addRow.appendChild(repoInput);
  addRow.appendChild(addRepoBtn);
  settingsBody.appendChild(ui.field({ label: '绑定仓库', children: addRow }));

  const repoListEl = document.createElement('div');
  repoListEl.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  settingsBody.appendChild(repoListEl);

  body.appendChild(ui.card({ title: '设置', children: settingsBody }));

  // ── 仓库选择 + Tab ──
  const repoRow = document.createElement('div');
  repoRow.style.cssText = 'display:flex;align-items:center;gap:8px';
  const repoLabel = document.createElement('span');
  repoLabel.style.cssText = 'font-size:13px;color:var(--text-mute);white-space:nowrap';
  repoLabel.textContent = '仓库';
  const repoSelect = ui.select({ options: [{ value: '', label: '未绑定仓库' }], onChange: (v) => void selectRepo(v) });
  repoSelect.style.cssText = 'flex:1;max-width:320px';
  repoRow.appendChild(repoLabel);
  repoRow.appendChild(repoSelect);
  body.appendChild(repoRow);

  const tabBar = ui.tabs({
    items: GH_TABS,
    active: activeTab,
    onChange: (id) => {
      activeTab = id as GithubTab;
      renderTab();
    },
  });
  tabBar.style.cssText = 'flex-shrink:0';
  body.appendChild(tabBar);

  const content = document.createElement('div');
  content.style.cssText = 'border:1px solid var(--border);border-radius:8px;background:var(--panel);min-height:120px';
  body.appendChild(content);

  // ── 搜索区:仓库搜索 / 代码搜索 ──
  const searchBody = document.createElement('div');
  searchBody.style.cssText = 'display:flex;flex-direction:column;gap:12px';

  const repoSearchInput = ui.input({ placeholder: '搜索仓库,如 peytchat', onEnter: () => void doRepoSearch() });
  const repoSearchBtn = ui.button({ label: '搜索仓库', icon: 'search', size: 'sm', variant: 'primary', onClick: () => void doRepoSearch() });
  const repoSearchRow = document.createElement('div');
  repoSearchRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  repoSearchRow.appendChild(repoSearchInput);
  repoSearchRow.appendChild(repoSearchBtn);
  searchBody.appendChild(ui.field({ label: '仓库搜索', children: repoSearchRow }));
  const repoResults = document.createElement('div');
  repoResults.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  searchBody.appendChild(repoResults);

  const codeSearchInput = ui.input({ placeholder: '搜索代码,如 fn main', onEnter: () => void doCodeSearch() });
  const codeSearchBtn = ui.button({ label: '搜索代码', icon: 'search', size: 'sm', onClick: () => void doCodeSearch() });
  const codeSearchRow = document.createElement('div');
  codeSearchRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  codeSearchRow.appendChild(codeSearchInput);
  codeSearchRow.appendChild(codeSearchBtn);
  searchBody.appendChild(ui.field({ label: '代码搜索', children: codeSearchRow, help: '需配置 GitHub Token' }));
  const codeResults = document.createElement('div');
  codeResults.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  searchBody.appendChild(codeResults);

  body.appendChild(ui.card({ title: '搜索', children: searchBody }));

  // ── 加载设置 + 绑定仓库列表 ──
  async function loadSettings(): Promise<void> {
    try {
      const s = await call<GithubSettingsDto>('get_github_settings');
      hasToken = !!s.token && s.token.trim() !== '';
      tokenInput.value = s.token || '';
      setTokenBadge();
    } catch { /* 忽略 */ }
  }
  function setTokenBadge(): void {
    headerBadge.className = `ui-badge${hasToken ? ' ui-badge-success' : ' ui-badge-muted'}`;
    headerBadge.textContent = hasToken ? '已配置 Token' : '未配置 Token';
  }
  async function saveToken(clear = false): Promise<void> {
    try {
      await call('set_github_token', { token: clear ? null : (tokenInput.value.trim() || null) });
      hasToken = !clear && tokenInput.value.trim() !== '';
      if (clear) tokenInput.value = '';
      setTokenBadge();
      ui.toast(clear ? 'Token 已清除' : 'Token 已保存');
      // 刷新仓库数据(可能从私有只读变为可写/私有可读)
      await reloadRepos();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }
  async function addRepo(): Promise<void> {
    const val = repoInput.value.trim();
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
      repoInput.value = '';
      ui.toast('已绑定');
      await reloadRepos();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }
  async function reloadRepos(): Promise<void> {
    let repos: GithubRepoDto[] = [];
    try {
      repos = await call<GithubRepoDto[]>('list_github_repos');
    } catch (e) {
      repoListEl.innerHTML = '';
      repoListEl.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    // 刷新下拉,保持当前选中
    const prevFull = repo?.full_name ?? '';
    repoSelect.innerHTML = '';
    if (repos.length === 0) {
      repoSelect.appendChild(new Option('未绑定仓库', ''));
    } else {
      for (const r of repos) repoSelect.appendChild(new Option(r.full_name, r.full_name));
    }
    // 渲染绑定列表
    repoListEl.innerHTML = '';
    if (repos.length === 0) {
      repoListEl.appendChild(ui.empty('暂无绑定仓库,输入 owner/repo 添加'));
      await applyRepo(null);
      return;
    }
    for (const r of repos) {
      repoListEl.appendChild(renderRepoRow(r));
    }
    // 恢复选中(若有对应项)
    if (prevFull) repoSelect.value = prevFull;
    const cur = repos.find((r) => r.full_name === repoSelect.value) ?? null;
    await applyRepo(cur);
  }
  function renderRepoRow(r: GithubRepoDto): HTMLElement {
    const row = ui.listItem({
      title: r.full_name,
      subtitle: `${r.owner} / ${r.repo}`,
      icon: 'git-branch',
      trailing: ui.iconButton({
        icon: 'trash', title: '删除', danger: true, size: 'sm',
        onClick: async () => {
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
              } catch (e) {
                ui.toast(e instanceof Error ? e.message : String(e));
              }
            },
          });
        },
      }),
    });
    row.style.cursor = 'default';
    return row;
  }
  async function selectRepo(fullName: string): Promise<void> {
    let repos: GithubRepoDto[] = [];
    try {
      repos = await call<GithubRepoDto[]>('list_github_repos');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
      return;
    }
    const cur = repos.find((r) => r.full_name === fullName) ?? null;
    if (fullName && !cur) {
      ui.toast(`仓库 ${fullName} 未绑定,请先在设置区添加`);
      return;
    }
    repoSelect.value = fullName || '';
    await applyRepo(cur);
  }
  async function applyRepo(next: GithubRepoDto | null): Promise<void> {
    repo = next;
    filesPath = '';
    if (!repo) {
      content.innerHTML = '';
      content.appendChild(ui.empty('选择或添加一个仓库后查看数据'));
      return;
    }
    renderTab();
  }

  // ── Tab 渲染 ──
  function renderTab(): void {
    content.innerHTML = '';
    if (!repo) {
      content.appendChild(ui.empty('选择或添加一个仓库后查看数据'));
      return;
    }
    content.appendChild(ui.spinner());
    void (async () => {
      try {
        content.innerHTML = '';
        if (activeTab === 'issues') await renderIssues();
        else if (activeTab === 'pulls') await renderPulls();
        else if (activeTab === 'commits') await renderCommits();
        else if (activeTab === 'files') await renderFiles();
        else if (activeTab === 'events') await renderEvents();
        else if (activeTab === 'details') await renderDetails();
      } catch (e) {
        content.innerHTML = '';
        content.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      }
    })();
  }

  // 列表区:内容区内滚动容器
  function listContainer(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:12px';
    content.appendChild(wrap);
    return wrap;
  }

  async function renderIssues(): Promise<void> {
    const list = listContainer();
    let issues: IssueDto[] = [];
    try {
      issues = await call<IssueDto[]>('github_list_issues', { owner: repo!.owner, repo: repo!.repo, state: 'open' });
    } catch (e) {
      list.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (issues.length === 0) {
      list.appendChild(ui.empty('暂无 Issue'));
      return;
    }
    for (const it of issues) list.appendChild(renderIssueRow(it));
  }
  function renderIssueRow(it: IssueDto): HTMLElement {
    const row = ui.listItem({
      title: `#${it.number} ${it.title}`,
      subtitle: `${it.state} · ${it.user} · 更新 ${fmtDate(it.updated_at)}${it.labels.length ? ' · ' + it.labels.join(', ') : ''}`,
      icon: 'alert-circle',
      onClick: () => void openIssueDetail(it),
    });
    return row;
  }
  async function openIssueDetail(it: IssueDto): Promise<void> {
    let detail = it;
    try {
      detail = await call<IssueDto>('github_get_issue', { owner: repo!.owner, repo: repo!.repo, number: it.number });
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
    const bodyHtml = document.createElement('div');
    bodyHtml.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    const head = document.createElement('div');
    head.style.cssText = 'font-size:14px;font-weight:600';
    head.textContent = `#${detail.number} ${detail.title}`;
    bodyHtml.appendChild(head);
    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-mute)';
    meta.appendChild(ui.badge({ text: detail.state, variant: detail.state === 'open' ? 'success' : 'muted' }));
    if (detail.labels.length) meta.appendChild(ui.badge({ text: detail.labels.slice(0, 5).join(', '), variant: 'default' }));
    bodyHtml.appendChild(meta);
    const body = document.createElement('pre');
    body.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;margin:0;max-height:320px;overflow-y:auto';
    body.textContent = detail.body || '(无正文)';
    bodyHtml.appendChild(body);
    const dlg = ui.dialog({
      title: 'Issue 详情',
      actions: [],
      size: 'lg',
    });
    const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
    dlg.overlay.querySelector('.ui-dialog')!.insertBefore(bodyHtml, actionsEl);
  }

  async function renderPulls(): Promise<void> {
    const list = listContainer();
    let pulls: PullDto[] = [];
    try {
      pulls = await call<PullDto[]>('github_list_pulls', { owner: repo!.owner, repo: repo!.repo, state: 'open' });
    } catch (e) {
      list.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (pulls.length === 0) {
      list.appendChild(ui.empty('暂无 Pull Request'));
      return;
    }
    for (const p of pulls) {
      list.appendChild(ui.listItem({
        title: `#${p.number} ${p.title}`,
        subtitle: `${p.state} · ${p.user} · +${p.additions}/-${p.deletions} · 更新 ${fmtDate(p.updated_at)}`,
        icon: 'git-branch',
      }));
    }
  }

  async function renderCommits(): Promise<void> {
    const list = listContainer();
    let commits: CommitDto[] = [];
    try {
      commits = await call<CommitDto[]>('github_list_commits', { owner: repo!.owner, repo: repo!.repo });
    } catch (e) {
      list.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (commits.length === 0) {
      list.appendChild(ui.empty('暂无 Commit'));
      return;
    }
    for (const c of commits) {
      list.appendChild(ui.listItem({
        title: `${c.sha.slice(0, 7)} ${c.message}`,
        subtitle: `${c.author ?? '未知'} · ${c.date ? fmtDate(c.date) : '未知时间'}`,
        icon: 'clock',
      }));
    }
  }

  // ── 文件 tab:目录浏览 + 文件内容 ──
  async function renderFiles(): Promise<void> {
    content.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px';
    content.appendChild(wrap);

    const crumb = document.createElement('div');
    crumb.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--text-mute)';
    const rootBtn = ui.button({ label: repo!.full_name, variant: 'ghost', size: 'sm', onClick: () => { filesPath = ''; void renderFiles(); } });
    crumb.appendChild(rootBtn);
    if (filesPath) {
      crumb.appendChild(document.createTextNode('/'));
      crumb.appendChild(document.createTextNode(filesPath));
    }
    wrap.appendChild(crumb);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    wrap.appendChild(list);

    let items: ContentDto[] = [];
    try {
      items = await call<ContentDto[]>('github_get_content', { owner: repo!.owner, repo: repo!.repo, path: filesPath });
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
          onClick: () => { filesPath = it.path; void renderFiles(); },
        }));
      } else {
        list.appendChild(ui.listItem({
          title: it.name,
          subtitle: `${it.size} bytes`,
          icon: 'file-text',
          onClick: () => void openFile(it),
        }));
      }
    }
  }
  async function openFile(it: ContentDto): Promise<void> {
    let item = it;
    try {
      item = await call<ContentDto[]>('github_get_content', { owner: repo!.owner, repo: repo!.repo, path: it.path }).then((a) => a[0]);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
      return;
    }
    const text = item.content ? decodeBase64(item.content) : '(无法读取内容)';
    const bodyHtml = document.createElement('div');
    bodyHtml.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const head = document.createElement('div');
    head.style.cssText = 'font-size:13px;font-weight:600;word-break:break-all';
    head.textContent = `${repo!.full_name}/${item.path}`;
    bodyHtml.appendChild(head);
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font-size:12px;line-height:1.6;margin:0;max-height:400px;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
    pre.textContent = text;
    bodyHtml.appendChild(pre);
    const dlg = ui.dialog({ title: item.name, actions: [], size: 'lg' });
    const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
    dlg.overlay.querySelector('.ui-dialog')!.insertBefore(bodyHtml, actionsEl);
  }

  async function renderEvents(): Promise<void> {
    const list = listContainer();
    let events: EventDto[] = [];
    try {
      events = await call<EventDto[]>('github_list_events', { owner: repo!.owner, repo: repo!.repo });
    } catch (e) {
      list.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (events.length === 0) {
      list.appendChild(ui.empty('暂无动态'));
      return;
    }
    for (const ev of events) {
      list.appendChild(ui.listItem({
        title: `${ev.typ}${ev.actor ? ' · ' + ev.actor : ''}`,
        subtitle: `${ev.summary || '(无摘要)'} · ${fmtDate(ev.created_at)}`,
        icon: 'clock',
      }));
    }
  }

  async function renderDetails(): Promise<void> {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:12px';
    content.appendChild(wrap);

    let d: RepoDto;
    try {
      d = await call<RepoDto>('github_repo', { owner: repo!.owner, repo: repo!.repo });
    } catch (e) {
      wrap.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }

    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center';
    if (d.language) meta.appendChild(ui.badge({ text: d.language, variant: 'default' }));
    meta.appendChild(ui.badge({ text: `★ ${d.stargazers_count}`, variant: 'default' }));
    meta.appendChild(ui.badge({ text: `fork ${d.forks_count}`, variant: 'default' }));
    meta.appendChild(ui.badge({ text: `open issues ${d.open_issues_count}`, variant: 'default' }));
    meta.appendChild(ui.badge({ text: `default branch ${d.default_branch}`, variant: 'muted' }));
    wrap.appendChild(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:13px;color:var(--text-mute)';
      desc.textContent = d.description;
      wrap.appendChild(desc);
    }

    // README:目录根下找 README* 文件读取(无专门 readme 命令,复用 github_get_content)
    const readmeTitle = document.createElement('div');
    readmeTitle.style.cssText = 'font-size:13px;font-weight:600';
    readmeTitle.textContent = 'README';
    wrap.appendChild(readmeTitle);
    const readmeEl = document.createElement('pre');
    readmeEl.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;margin:0;max-height:360px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px';
    wrap.appendChild(readmeEl);
    try {
      const root = await call<ContentDto[]>('github_get_content', { owner: repo!.owner, repo: repo!.repo, path: '' });
      const readme = root.find((x) => x.typ === 'file' && x.name.toLowerCase().startsWith('readme'));
      if (readme) {
        const file = await call<ContentDto[]>('github_get_content', { owner: repo!.owner, repo: repo!.repo, path: readme.path }).then((a) => a[0]);
        readmeEl.textContent = file.content ? decodeBase64(file.content) : '(无法读取)';
      } else {
        readmeEl.textContent = '(未找到 README)';
      }
    } catch (e) {
      readmeEl.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  // ── 搜索区逻辑 ──
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
      repoResults.appendChild(ui.listItem({
        title: r.full_name,
        subtitle: `${r.language ?? '未知语言'} · ★ ${r.stargazers_count}${r.description ? ' · ' + r.description : ''}`,
        icon: 'git-branch',
        onClick: () => { repoSearchInput.value = r.full_name; void selectRepo(r.full_name); },
      }));
    }
  }
  async function doCodeSearch(): Promise<void> {
    const q = codeSearchInput.value.trim();
    if (!q) { ui.toast('请输入搜索关键词'); return; }
    if (!hasToken) {
      ui.toast('代码搜索需要 GitHub Token,请先在设置区配置');
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

  // ── 初始化 ──
  await loadSettings();
  await reloadRepos();
}

// ── 工具函数 ──
function fmtDate(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleDateString();
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
