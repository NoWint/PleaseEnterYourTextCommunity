import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { showToast } from '../toast.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { iconSvg } from '../components/icon.js';
import { ui } from '../components/ui.js';
import { updatePinnedCache } from '../chat/message.js';
import { escapeHtml, escapeAttr } from '../components/escape.js';
import type { MemberDto, MsgDto } from '../types.js';

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

  // 页1/页2: messages/groups — members/pin tab
  const collapsed = !state.rightDrawerOpen || !state.detailPanelOpen;
  drawer.classList.toggle('collapsed', collapsed);
  if (!state.detailPanelOpen) {
    showExpandButton();
    unbindOutsideDismiss();
    return;
  }
  bindOutsideDismiss();

  // detail panel 展开时清理残留的 expand 按钮,并去掉消息区让位类
  document.querySelectorAll('#chat-main .detail-expand').forEach((el) => el.remove());
  document.getElementById('chat-main')?.classList.remove('detail-collapsed');

  const tab = state.detailTab;
  const tabsHtml = `
    <span class="rd-tab ${tab === 'members' ? 'active' : ''}" data-tab="members">${iconSvg('users', { width: 14, height: 14 })}<span>成员</span></span>
    <span class="rd-tab ${tab === 'media' ? 'active' : ''}" data-tab="media">${iconSvg('image', { width: 14, height: 14 })}<span>媒体消息</span></span>
    <span class="rd-tab ${tab === 'archive' ? 'active' : ''}" data-tab="archive">${iconSvg('pin', { width: 14, height: 14 })}<span>存档消息</span></span>
    <span class="rd-collapse" title="折叠">${iconSvg('chevron-right', { width: 16, height: 16 })}</span>
  `;
  drawer.innerHTML = `<div class="rd-tabs">${tabsHtml}</div><div id="rd-body" style="flex:1;overflow-y:auto"></div>`;

  drawer.querySelectorAll<HTMLElement>('.rd-tab').forEach((el) => {
    el.addEventListener('click', () => {
      state.detailTab = el.dataset.tab as 'members' | 'media' | 'archive';
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
  // 标记:自己发的消息(右对齐)向右让出展开按钮区域
  main.classList.add('detail-collapsed');
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
  } else if (state.detailTab === 'media') {
    await renderMedia(body);
  } else {
    await renderPins(body);
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
              const roleSelectHtml = m.is_self ? '' : `<select class="rd-role-select" data-cid="${m.contact_id}" title="分配角色">
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

// 媒体消息 tab:列出当前聊天的图片/视频/语音/文件,点击跳转并高亮。
async function renderMedia(body: HTMLElement): Promise<void> {
  if (!state.currentChatId) {
    body.innerHTML = `<div class="rd-empty">未选中频道</div>`;
    return;
  }
  let msgs: MsgDto[];
  try {
    msgs = await call<MsgDto[]>('get_chat_media', { chatId: state.currentChatId, viewType: null });
  } catch (e) {
    body.innerHTML = `<div class="rd-empty">加载失败</div>`;
    showToast(e instanceof Error ? e.message : String(e));
    return;
  }
  if (!msgs || msgs.length === 0) {
    body.innerHTML = `<div class="rd-empty">暂无媒体消息</div>`;
    return;
  }
  const items = msgs.map((m) => `
    <div class="rd-media-item" data-msg="${m.msg_id}">
      <div class="rd-media-icon">${mediaIcon(m.view_type)}</div>
      <div class="rd-media-body">
        <div class="rd-media-name">${escapeHtml(m.file_name || viewLabel(m.view_type))}</div>
        <div class="rd-media-meta">${escapeHtml(m.from_name || '')} · ${formatRelativeTime(m.ts)}</div>
      </div>
    </div>
  `).join('');
  body.innerHTML = items;
  body.querySelectorAll<HTMLElement>('.rd-media-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const chatId = state.currentChatId;
      if (chatId == null) return;
      const msgId = Number(el.dataset.msg);
      const { renderChatView } = await import('../chat/chatView.js');
      await renderChatView(chatId);
      setTimeout(() => {
        const msgEl = document.querySelector(`[data-msg="${msgId}"]`);
        if (msgEl) {
          msgEl.scrollIntoView({ behavior: 'smooth' });
          (msgEl as HTMLElement).style.background = 'var(--active)';
          setTimeout(() => { (msgEl as HTMLElement).style.background = ''; }, 2000);
        }
      }, 200);
    });
  });
}

function mediaIcon(viewType: string | null): string {
  switch (viewType) {
    case 'Image': case 'Gif': return iconSvg('image', { width: 18, height: 18 });
    case 'Video': return iconSvg('play', { width: 18, height: 18 });
    case 'Voice': case 'Audio': return iconSvg('mic', { width: 18, height: 18 });
    case 'Webxdc': return iconSvg('package', { width: 18, height: 18 });
    default: return iconSvg('file-text', { width: 18, height: 18 });
  }
}

function viewLabel(viewType: string | null): string {
  const labels: Record<string, string> = {
    Image: '图片', Gif: 'GIF', Video: '视频', Voice: '语音', Audio: '音频', File: '文件', Webxdc: '应用',
  };
  return labels[viewType ?? ''] ?? '文件';
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

