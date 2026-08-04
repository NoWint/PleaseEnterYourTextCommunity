import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { showToast } from '../toast.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { ui } from '../components/ui.js';
import { updatePinnedCache } from '../chat/message.js';
import { escapeHtml, escapeAttr } from '../components/escape.js';
import type { MemberDto, MsgDto, GithubTab, GithubRepoRef } from '../types.js';

// ── GitHub 数据 DTO(与 src-tauri/src/github/types.rs + dto.rs 对应,snake_case 响应)────
interface GithubIssueDto {
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
interface GithubPullDto {
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
interface GithubCommitDto { sha: string; message: string; author: string | null; date: string | null; }
interface GithubEventDto { typ: string; actor: string | null; created_at: string; summary: string; }
interface GithubContentDto { name: string; path: string; typ: string; size: number; content: string | null; }
interface GithubRepoInfoDto {
  full_name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  html_url: string;
}
type GithubTabId = GithubTab;

interface ContactRole {
  contact_id: number;
  role_id: number;
  role_name: string;
}

interface RoleDto {
  id: number;
  name: string;
  color?: string | null;
}

// 角色选择器中的特殊选项值:触发「新建角色」输入弹窗
const NEW_ROLE_VALUE = '__new';

interface ChannelPin {
  msg_id: number;
  channel_chat_id: number;
}

// 外部点击关闭:抽屉展开时绑定 document click,点击抽屉外区域隐藏侧栏。
// 模块级管理,避免 renderRightDrawer 多次调用时重复绑定。
let outsideClickHandler: ((e: MouseEvent) => void) | null = null;

// GitHub 文件 tab 的当前目录路径 + 所属仓库 key(切换仓库时重置)
let githubFilesPath = '';
let githubFilesRepoKey = '';

// Task 8: 4 页不同处理 — settings 隐藏 / work 卡片详情 / messages·groups 成员·置顶。
// renderRightDrawer 为同步函数 (rail.ts 未 await),内部异步渲染通过 void 触发。
export function renderRightDrawer(): void {
  const drawer = document.getElementById('right-drawer');
  if (!drawer) return;
  // github 模式只在 github 页有效:离开页后清理残留 tab/仓库,避免泄漏到 messages/groups 的 members/pin
  if (state.detailTab === 'github' && state.currentPage !== 'github') {
    state.detailTab = 'members';
    state.detailPanelOpen = false;
    state.rightDrawerOpen = false;
    state.currentGithubRepo = null;
    state.githubTab = 'issues';
    saveState();
  }
  // 每次渲染都同步头部按钮选中态:抽屉折叠/切换/隐藏时,成员/置顶按钮的 active 随弹窗关闭恢复
  syncHeaderButtons();

  // 页4: settings — 不显示 detail panel
  if (state.currentPage === 'settings') {
    drawer.classList.add('collapsed');
    drawer.innerHTML = '';
    unbindOutsideDismiss();
    return;
  }

  // 调试页 — 不显示 detail panel (消息原文列表为主区全宽)
  if (state.currentPage === 'debug') {
    drawer.classList.add('collapsed');
    drawer.innerHTML = '';
    unbindOutsideDismiss();
    return;
  }

  // 页3: work + 选中卡片 — 渲染卡片详情 (dynamic import 避免循环依赖)
  if (state.currentPage === 'work' && state.currentCardId) {
    drawer.classList.remove('collapsed');
    void import('../work/cardDetail.js').then(({ renderCardDetail }) =>
      renderCardDetail(state.currentCardId!)
    );
    return;
  }

  // 页3: work 无选中卡片 — 隐藏
  if (state.currentPage === 'work') {
    drawer.classList.add('collapsed');
    drawer.innerHTML = '';
    unbindOutsideDismiss();
    return;
  }

  // GitHub 页:选中仓库 → 数据 Tab (issues/pulls/commits/files/events/details)
  // github 模式只在 github 页有效且选中了仓库;离开页/取消选中即折叠抽屉
  if (state.currentPage === 'github') {
    if (state.detailTab !== 'github' || !state.currentGithubRepo || !state.detailPanelOpen || !state.rightDrawerOpen) {
      drawer.classList.add('collapsed');
      drawer.innerHTML = '';
      unbindOutsideDismiss();
      return;
    }
    drawer.classList.remove('collapsed');
    bindOutsideDismiss();
    const gtab = state.githubTab;
    const ghTabs = (['issues', 'pulls', 'commits', 'files', 'events', 'details'] as const).map((id) => {
      const label = { issues: 'Issues', pulls: 'Pulls', commits: 'Commits', files: '文件', events: '动态', details: '详情' }[id];
      const icon = { issues: 'alert-circle', pulls: 'git-branch', commits: 'clock', files: 'package', events: 'timeline', details: 'info' }[id] as IconName;
      return `<span class="rd-tab ${gtab === id ? 'active' : ''}" data-tab="${id}" title="${label}">${iconSvg(icon, { width: 14, height: 14 })}<span>${label}</span></span>`;
    }).join('');
    drawer.innerHTML = `
      <div style="flex-shrink:0;display:flex;align-items:center;background:var(--panel);min-width:0">
        <div class="rd-tabs rd-tabs-gh" style="flex:1;min-width:0">${ghTabs}</div>
        <span class="rd-collapse" title="折叠" style="flex-shrink:0;padding:12px 16px 12px 4px">${iconSvg('chevron-right', { width: 16, height: 16 })}</span>
      </div>
      <div id="rd-body" style="flex:1;overflow-y:auto"></div>
    `;
    drawer.querySelectorAll<HTMLElement>('.rd-tab').forEach((el) => {
      el.addEventListener('click', () => {
        state.githubTab = el.dataset.tab as GithubTab;
        saveState();
        renderRightDrawer();
      });
    });
    drawer.querySelector<HTMLElement>('.rd-collapse')?.addEventListener('click', () => {
      state.detailPanelOpen = false;
      saveState();
      renderRightDrawer();
    });
    void renderGithubBody();
    return;
  }

  // 页1/页2: messages/groups — members/pin tab
  const collapsed = !state.rightDrawerOpen || !state.detailPanelOpen;
  drawer.classList.toggle('collapsed', collapsed);
  if (!state.detailPanelOpen) {
    showExpandButton();
    unbindOutsideDismiss();
    return;
  }
  bindOutsideDismiss();

  // detail panel 展开时清理残留的 expand 按钮
  document.querySelectorAll('#chat-main .detail-expand').forEach((el) => el.remove());

  const tab = state.detailTab;
  const tabsHtml = `
    <span class="rd-tab ${tab === 'members' ? 'active' : ''}" data-tab="members">${iconSvg('users', { width: 14, height: 14 })}<span>成员</span></span>
    <span class="rd-tab ${tab === 'pin' ? 'active' : ''}" data-tab="pin">${iconSvg('pin', { width: 14, height: 14 })}<span>置顶</span></span>
    <span class="rd-flex"></span>
    <span class="rd-collapse" title="折叠">${iconSvg('chevron-right', { width: 16, height: 16 })}</span>
  `;
  drawer.innerHTML = `<div class="rd-tabs">${tabsHtml}</div><div id="rd-body" style="flex:1;overflow-y:auto"></div>`;

  drawer.querySelectorAll<HTMLElement>('.rd-tab').forEach((el) => {
    el.addEventListener('click', () => {
      state.detailTab = el.dataset.tab as 'members' | 'pin';
      saveState();
      renderRightDrawer();
    });
  });
  drawer.querySelector<HTMLElement>('.rd-collapse')?.addEventListener('click', () => {
    state.detailPanelOpen = false;
    saveState();
    renderRightDrawer();
  });
  void renderRdBody();
}

// 同步 chat-header 的 members/pin 按钮 active 态,使与抽屉当前 tab 一致
function syncHeaderButtons(): void {
  document.querySelectorAll<HTMLElement>('.chat-header-btn[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    const active = state.detailPanelOpen && state.detailTab === action;
    btn.classList.toggle('active', !!active);
  });
}

// 抽屉展开时绑定:点击抽屉外区域 (非抽屉、非折叠按钮、非头部触发按钮) 即关闭侧栏。
// 用 capture + 延迟到事件冒泡后判断,避免点击展开按钮/菜单本身时误关。
function bindOutsideDismiss(): void {
  if (outsideClickHandler) return;
  outsideClickHandler = (e: MouseEvent) => {
    const drawer = document.getElementById('right-drawer');
    if (!drawer || drawer.classList.contains('collapsed')) return;
    const target = e.target as Node;
    // 点击侧栏内部 → 不关 (成员/置顶内容可交互)
    if (drawer.contains(target)) return;
    // 点击头部触发按钮 (members/pin) → 不关,交给按钮自身 toggle 逻辑
    if ((e.target as HTMLElement).closest?.('.chat-header-btn[data-action]')) return;
    // 点击折叠/展开按钮 → 不关
    if ((e.target as HTMLElement).closest?.('.rd-collapse, .detail-expand')) return;
    state.detailPanelOpen = false;
    saveState();
    renderRightDrawer();
  };
  document.addEventListener('click', outsideClickHandler, true);
}

function unbindOutsideDismiss(): void {
  if (outsideClickHandler) {
    document.removeEventListener('click', outsideClickHandler, true);
    outsideClickHandler = null;
  }
}

// detail panel 折叠时在 chat-main 右侧显示展开按钮
function showExpandButton(): void {
  const main = document.getElementById('chat-main');
  if (!main) return;
  if (main.querySelector('.detail-expand')) return;
  const btn = document.createElement('div');
  btn.className = 'detail-expand';
  btn.innerHTML = iconSvg('chevron-left', { width: 16, height: 16 });
  btn.title = '展开详情面板';
  btn.addEventListener('click', () => {
    state.detailPanelOpen = true;
    saveState();
    renderRightDrawer();
    btn.remove();
  });
  main.appendChild(btn);
}

async function renderRdBody(): Promise<void> {
  const body = document.getElementById('rd-body');
  if (!body) return;
  if (state.detailTab === 'members') {
    await renderMembers(body);
  } else {
    await renderPins(body);
  }
}

// ── GitHub 数据渲染(选中仓库 → 抽屉数据 tab)────────────────────────────
// 每次 tab 切换 / 仓库切换都会整抽屉重渲染,#rd-body 引用随之重建,旧异步结果写旧 DOM 无副作用。
async function renderGithubBody(): Promise<void> {
  const body = document.getElementById('rd-body');
  const repo = state.currentGithubRepo;
  if (!body || !repo) return;
  body.innerHTML = '';
  body.appendChild(ui.spinner());
  try {
    if (state.githubTab === 'issues') await renderGhIssues(body, repo);
    else if (state.githubTab === 'pulls') await renderGhPulls(body, repo);
    else if (state.githubTab === 'commits') await renderGhCommits(body, repo);
    else if (state.githubTab === 'files') await renderGhFiles(body, repo);
    else if (state.githubTab === 'events') await renderGhEvents(body, repo);
    else await renderGhDetails(body, repo);
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
  }
}

// 富行:状态 badge + 标签 chip + 作者/时间。点击 → Issue 详情弹窗
async function renderGhIssues(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  let issues: GithubIssueDto[];
  try {
    issues = await call<GithubIssueDto[]>('github_list_issues', { owner: repo.owner, repo: repo.repo, state: 'open' });
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
async function openGhIssue(it: GithubIssueDto, repo: GithubRepoRef): Promise<void> {
  let detail = it;
  try {
    detail = await call<GithubIssueDto>('github_get_issue', { owner: repo.owner, repo: repo.repo, number: it.number });
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
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
  let pulls: GithubPullDto[];
  try {
    pulls = await call<GithubPullDto[]>('github_list_pulls', { owner: repo.owner, repo: repo.repo, state: 'open' });
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
async function openGhPull(p: GithubPullDto): Promise<void> {
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
  let commits: GithubCommitDto[];
  try {
    commits = await call<GithubCommitDto[]>('github_list_commits', { owner: repo.owner, repo: repo.repo });
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

// 文件:面包屑 + 目录/文件项。目录可进(更新 githubFilesPath + 重渲染),文件 → 内容弹窗
async function renderGhFiles(body: HTMLElement, repo: GithubRepoRef): Promise<void> {
  const key = `${repo.owner}/${repo.repo}`;
  if (githubFilesRepoKey !== key) {
    githubFilesRepoKey = key;
    githubFilesPath = '';
  }
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px';
  body.appendChild(wrap);

  const crumb = document.createElement('div');
  crumb.style.cssText = 'display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:var(--font-scale-secondary);color:var(--text-mute)';
  const rootBtn = ui.button({ label: repo.repo, variant: 'ghost', size: 'sm', onClick: () => { githubFilesPath = ''; void renderGhFiles(body, repo); } });
  crumb.appendChild(rootBtn);
  if (githubFilesPath) {
    const segs = githubFilesPath.split('/');
    segs.forEach((seg, idx) => {
      crumb.appendChild(document.createTextNode('/'));
      const b = ui.button({ label: seg, variant: 'ghost', size: 'sm', onClick: () => { githubFilesPath = segs.slice(0, idx + 1).join('/'); void renderGhFiles(body, repo); } });
      crumb.appendChild(b);
    });
  }
  wrap.appendChild(crumb);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px';
  wrap.appendChild(list);

  // 上一级目录入口(不在根目录时)
  if (githubFilesPath) {
    list.appendChild(ui.listItem({
      title: '..',
      subtitle: '上一级',
      icon: 'arrow-up',
      onClick: () => { githubFilesPath = githubFilesPath.split('/').slice(0, -1).join('/'); void renderGhFiles(body, repo); },
    }));
  }

  let items: GithubContentDto[];
  try {
    items = await call<GithubContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: githubFilesPath });
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
        onClick: () => { githubFilesPath = it.path; void renderGhFiles(body, repo); },
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
async function openGhFile(it: GithubContentDto, repo: GithubRepoRef): Promise<void> {
  let item = it;
  try {
    item = await call<GithubContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: it.path }).then((a) => a[0]);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
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
  let events: GithubEventDto[];
  try {
    events = await call<GithubEventDto[]>('github_list_events', { owner: repo.owner, repo: repo.repo });
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
  let d: GithubRepoInfoDto;
  try {
    d = await call<GithubRepoInfoDto>('github_repo', { owner: repo.owner, repo: repo.repo });
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
    const root = await call<GithubContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: '' });
    const readme = root.find((x) => x.typ === 'file' && x.name.toLowerCase().startsWith('readme'));
    if (readme) {
      const file = await call<GithubContentDto[]>('github_get_content', { owner: repo.owner, repo: repo.repo, path: readme.path }).then((a) => a[0]);
      readmeEl.textContent = file.content ? decodeBase64(file.content).slice(0, 3000) : '(无法读取)';
    } else {
      readmeEl.textContent = '(未找到 README)';
    }
  } catch (e) {
    readmeEl.textContent = e instanceof Error ? e.message : String(e);
  }
}

// ── GitHub 工具函数 ──
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

// 迁移自 rightDrawer.js: 按 role 分组成员,self 归 core,无 role 归 Members。
async function renderMembers(body: HTMLElement): Promise<void> {
  if (!state.currentChatId) {
    body.innerHTML = `<div style="padding:16px;color:var(--text-weak)">未选中频道</div>`;
    return;
  }
  try {
    const info = await call<{ members: MemberDto[] }>('get_chat_info', { chatId: state.currentChatId });
    let allRoles: ContactRole[] = [];
    try {
      allRoles = await call<ContactRole[]>('list_all_contact_roles', { workspaceId: state.currentWsId });
    } catch {}
    const contactRoles = new Map<number, string[]>();
    for (const r of allRoles) {
      if (!contactRoles.has(r.contact_id)) contactRoles.set(r.contact_id, []);
      contactRoles.get(r.contact_id)!.push(r.role_name);
    }
    // 成员当前角色 id 映射 (取首个),用于角色选择器回显
    const memberRoleIds = new Map<number, number>();
    for (const r of allRoles) {
      if (!memberRoleIds.has(r.contact_id)) memberRoleIds.set(r.contact_id, r.role_id);
    }
    // 工作区全部角色,供角色选择器下拉 (失败降级为空列表)
    let roles: RoleDto[] = [];
    try {
      roles = await call<RoleDto[]>('list_roles', { workspaceId: state.currentWsId });
    } catch {}
    const grouped = new Map<string, MemberDto[]>();
    grouped.set('core', []);
    grouped.set('Members', []);
    for (const m of info.members) {
      if (m.is_self) {
        grouped.get('core')!.push(m);
        continue;
      }
      const roles = contactRoles.get(m.contact_id);
      if (roles && roles.length > 0) {
        const primary = roles[0];
        if (!grouped.has(primary)) grouped.set(primary, []);
        grouped.get(primary)!.push(m);
      } else {
        grouped.get('Members')!.push(m);
      }
    }
    const order = ['core', 'Members'];
    for (const r of allRoles) {
      if (!order.includes(r.role_name) && grouped.has(r.role_name)) order.push(r.role_name);
    }
    const addMemberHtml = `
      <div style="padding:8px 12px 0">
        <button id="rd-add-member" style="width:100%;padding:6px 10px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;background:var(--capsule);color:var(--text)">添加成员</button>
      </div>`;
    // 已添加的联系人 addr 集合,用于成员行「已添加」标记 (群成员加好友复用 create_chat_by_email)
    let existingAddrs = new Set<string>();
    try {
      const contacts = await call<Array<{ addr: string }>>('get_contacts');
      existingAddrs = new Set(contacts.map((c) => c.addr));
    } catch {}
    const sectionResults = await Promise.all(
      order
        .filter((name) => grouped.has(name) && grouped.get(name)!.length > 0)
        .map(async (name) => {
          const list = grouped.get(name)!;
          const items = await Promise.all(
            list.map(async (m) => {
              const avatarHtml = await renderAvatarHtml(m);
              const isAdded = !m.is_self && m.addr && existingAddrs.has(m.addr);
              const addBtn = !m.is_self && m.addr
                ? `<button class="rd-add-friend ${isAdded ? 'added' : ''}" data-addr="${escapeAttr(m.addr)}" title="${isAdded ? '已是好友' : '添加为好友'}">${isAdded ? '已添加' : '添加'}</button>`
                : '';
              const roleId = memberRoleIds.get(m.contact_id);
              const roleSelectHtml = m.is_self ? '' : `<select class="rd-role-select" data-cid="${m.contact_id}" title="分配角色" style="flex:none;max-width:88px;font-size:11px;padding:1px 4px;background:var(--capsule);color:var(--text);border:1px solid var(--border-strong);border-radius:4px;font-family:inherit">
                <option value="" disabled ${roleId ? '' : 'selected'}>无角色</option>
                ${roles.map((r) => `<option value="${r.id}" ${roleId === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
                <option value="${NEW_ROLE_VALUE}">＋ 新建角色</option>
              </select>`;
              return `<div class="rd-member ${m.is_self ? 'self' : 'clickable'}" data-name="${escapeAttr(m.name)}" ${m.is_self ? '' : `data-cid="${m.contact_id}"`}>
                ${avatarHtml}
                <span class="rd-name">${escapeHtml(m.name)}</span>
                ${m.is_self ? `<span class="rd-self-tag">我</span>` : ''}
                ${roleSelectHtml}
                ${addBtn}
              </div>`;
            })
          );
          return `<div class="rd-group">${escapeHtml(groupLabel(name))} · ${list.length}</div>${items.join('')}`;
        })
    );
    const searchWrap = document.createElement('div');
    searchWrap.className = 'rd-search';
    const searchInput = ui.input({ placeholder: '搜索成员...' });
    searchInput.id = 'rd-member-search';
    searchWrap.appendChild(searchInput);
    body.insertAdjacentHTML('beforeend', addMemberHtml);
    body.appendChild(searchWrap);
    body.insertAdjacentHTML('beforeend', sectionResults.join('') || `<div style="padding:16px;color:var(--text-weak)">无成员</div>`);
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      body.querySelectorAll<HTMLElement>('.rd-member').forEach((el) => {
        const name = el.dataset.name?.toLowerCase() || '';
        el.style.display = name.includes(q) ? '' : 'none';
      });
    });
    body.querySelectorAll<HTMLElement>('.rd-member[data-cid]').forEach((el) => {
      el.addEventListener('click', async () => {
        const cid = Number(el.dataset.cid);
        const { renderMemberDetail } = await import('../components/memberDetail.js');
        await renderMemberDetail(body, cid);
      });
    });
    // 群成员添加为好友:点击按钮建会话 + 标记已添加 (按钮 click 需阻止冒泡,避免触发成员详情)
    body.querySelectorAll<HTMLElement>('.rd-add-friend:not(.added)').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const addr = btn.dataset.addr || '';
        if (!addr) return;
        try {
          await call('create_chat_by_email', { email: addr });
          btn.classList.add('added');
          btn.textContent = '已添加';
          showToast('已添加为好友');
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      });
    });
    // 添加成员:成员选择器(搜索+多选+手输邮箱)加入当前群聊,成功后刷新成员列表。
    // 仿 Delta AddMemberInnerDialog。
    body.querySelector<HTMLElement>('#rd-add-member')?.addEventListener('click', () => {
      void import('../components/group/memberPicker.js').then(({ openMemberPicker }) => {
        openMemberPicker({
          title: '添加成员',
          existing: new Set(info.members.map((m) => m.contact_id)),
          onOk: async (picks) => {
            try {
              for (const p of picks) {
                await call('add_group_member', {
                  chatId: state.currentChatId,
                  email: p.email,
                  contactId: p.contact_id || null,
                });
              }
              showToast(`已添加 ${picks.length} 位成员`);
              await renderMembers(body);
            } catch (e) {
              showToast(e instanceof Error ? e.message : String(e));
            }
          },
        });
      });
    });
    // 成员角色选择:阻止冒泡避免触发成员详情;分配已有角色或走「新建角色」流程
    body.querySelectorAll<HTMLSelectElement>('.rd-role-select').forEach((sel) => {
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', async () => {
        const cid = Number(sel.dataset.cid);
        const val = sel.value;
        try {
          if (val === NEW_ROLE_VALUE) {
            ui.inputDialog({
              title: '新建角色',
              placeholder: '角色名称',
              onConfirm: async (name) => {
                const roleId = await call<number>('create_role', { workspaceId: state.currentWsId, name, color: null });
                await call('set_contact_role', { workspaceId: state.currentWsId, contactId: cid, roleId });
                showToast('角色已设置');
                await renderMembers(body);
              },
            });
          } else if (val) {
            await call('set_contact_role', { workspaceId: state.currentWsId, contactId: cid, roleId: Number(val) });
            showToast('角色已设置');
            await renderMembers(body);
          }
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      });
    });
  } catch (e) {
    body.innerHTML = `<div style="padding:16px;color:var(--text-weak)">加载失败</div>`;
    showToast(e instanceof Error ? e.message : String(e));
  }
}

// 迁移自 rightDrawer.js: pin 使用 channel_chat_id 拉取消息,点击跳转并高亮。
async function renderPins(body: HTMLElement): Promise<void> {
  if (!state.currentChatId) {
    body.innerHTML = `<div class="rd-empty">未选中频道</div>`;
    return;
  }
  let pins: ChannelPin[];
  try {
    pins = await call<ChannelPin[]>('get_channel_pins', { chatId: state.currentChatId });
  } catch {
    body.innerHTML = `<div class="rd-empty">加载失败</div>`;
    return;
  }
  // 同步 chat-header 置顶按钮的计数徽标
  document.querySelectorAll<HTMLElement>('.chat-header-btn[data-action="pin"]').forEach((btn) => {
    btn.title = `置顶 · ${pins.length}`;
  });
  if (pins.length === 0) {
    body.innerHTML = `<div class="rd-empty">无置顶消息</div>`;
    return;
  }
  const pinItems = await Promise.all(
    pins.map(async (p): Promise<string> => {
      try {
        const msgs = await call<MsgDto[]>('get_chat_msgs', { chatId: p.channel_chat_id });
        const msg = msgs.find((m) => m.msg_id === p.msg_id);
        if (!msg) return '';
        return `<div class="rd-pin-item" data-chat="${p.channel_chat_id}" data-msg="${p.msg_id}">
          <div class="rd-pin-icon">${iconSvg('pin', { width: 12, height: 12 })}</div>
          <div class="rd-pin-body">
            <div class="rd-pin-from">${escapeHtml(msg.from_name)}</div>
            <div class="rd-pin-text">${escapeHtml((msg.text || '').slice(0, 60))}</div>
            <div class="rd-pin-time">${formatRelativeTime(msg.ts)}</div>
          </div>
          <button class="rd-pin-unpin" title="取消置顶" data-chat="${p.channel_chat_id}" data-msg="${p.msg_id}">${iconSvg('pin-off', { width: 14, height: 14 })}</button>
        </div>`;
      } catch {
        return '';
      }
    })
  );
  body.innerHTML = pinItems.filter(Boolean).join('') || `<div class="rd-empty">无置顶消息</div>`;
  body.querySelectorAll<HTMLElement>('.rd-pin-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const chatId = Number(el.dataset.chat);
      const msgId = Number(el.dataset.msg);
      state.currentChatId = chatId;
      const { renderChatView } = await import('../chat/chatView.js');
      await renderChatView(chatId);
      setTimeout(() => {
        const msgEl = document.querySelector(`[data-msg="${msgId}"]`);
        if (msgEl) {
          msgEl.scrollIntoView({ behavior: 'smooth' });
          (msgEl as HTMLElement).style.background = 'var(--active)';
          setTimeout(() => {
            (msgEl as HTMLElement).style.background = '';
          }, 2000);
        }
      }, 200);
    });
  });
  // 取消置顶按钮:阻止冒泡到整条点击,调后端移除后刷新 pin 列表
  body.querySelectorAll<HTMLElement>('.rd-pin-unpin').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const chatId = Number(btn.dataset.chat);
      const msgId = Number(btn.dataset.msg);
      try {
        await call('toggle_pin', {
          workspaceId: state.currentWsId,
          chatId,
          msgId,
        });
        showToast('已取消置顶');
        // 同步右键菜单的置顶缓存,避免下一次右键显示过期状态
        const remaining = await call<ChannelPin[]>('get_channel_pins', { chatId: state.currentChatId });
        updatePinnedCache(remaining.map((p) => p.msg_id));
        await renderPins(body);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    });
  });
}

// 成员分组标题本地化:core/Members → 中文,其余 role 名保留
function groupLabel(name: string): string {
  const labels: Record<string, string> = { core: '核心', Members: '成员' };
  return labels[name] ?? name;
}

function formatRelativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts * 1000;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

