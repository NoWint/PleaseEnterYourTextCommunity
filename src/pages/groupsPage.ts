import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { saveState } from '../persist.js';
import { iconSvg } from '../components/icon.js';
import { renderAvatarHtml } from '../components/avatar.js';
import { escapeHtml, escapeAttr } from '../components/escape.js';
import { ui, type MenuItem } from '../components/ui.js';
import { getSpaceType, refreshChannels } from '../shell/navPanel.js';
import { refreshWorkspaces } from '../shell/rail.js';
import type { ChannelDto, WorkspaceDto } from '../types.js';

export async function renderGroupsPage(panel: HTMLElement): Promise<void> {
  const ws = state.workspaces.find((w) => w.id === state.currentWsId);
  const multiWs = state.workspaces.length > 1;
  const headerClickable = multiWs ? 'clickable' : '';
  const avatarHtml = state.self ? await renderAvatarHtml(state.self) : '';

  panel.innerHTML = `
    <div class="nav-header ${headerClickable}" id="groups-header">
      <div class="nav-title">${escapeHtml(ws?.name || '未选择团队')}</div>
      <div class="nav-subtitle">${state.wsMembers[state.currentWsId || 0] || 0} members</div>
    </div>
    <div class="nav-list" id="groups-list"></div>
    <div class="nav-user">
      ${avatarHtml}
      <div class="nav-user-info">
        <div class="nav-user-name">${escapeHtml(state.self?.name || 'me')}</div>
        <div class="nav-user-role">core</div>
      </div>
    </div>
  `;

  await renderChannelList();
  if (multiWs) bindWsSwitcher();
}

async function renderChannelList(): Promise<void> {
  const list = document.getElementById('groups-list');
  if (!list) return;
  const channels = state.channels;
  // 过滤 space_type=chat
  const chatChannels: ChannelDto[] = [];
  for (const ch of channels) {
    const st = await getSpaceType(ch.chat_id);
    if (st === 'chat') chatChannels.push(ch);
  }

  const collapsed = JSON.parse(localStorage.getItem('collapsedCategories') || '{}');
  const wsId = state.currentWsId || 0;
  const wsCats: Record<string, boolean> = collapsed[wsId] || {};

  const byCategory: Record<string, ChannelDto[]> = {};
  for (const ch of chatChannels) {
    if (!byCategory[ch.category]) byCategory[ch.category] = [];
    byCategory[ch.category].push(ch);
  }
  const categories = Object.keys(byCategory).sort();

  const catHtml = categories.map((cat) => {
    const isCollapsed = wsCats[cat] === true;
    const arrowIcon = isCollapsed ? 'chevron-right' : 'chevron-down';
    const chans = byCategory[cat].map((ch) => {
      const active = state.currentChatId === ch.chat_id ? 'active' : '';
      const unread = ch.unread > 0 ? `<span class="nav-unread">${ch.unread}</span>` : '';
      return `<div class="nav-channel ${active}" data-id="${ch.chat_id}" ${isCollapsed ? 'style="display:none"' : ''}>
        ${iconSvg('hash', { width: 14, height: 14 })}
        <span class="nav-channel-name">${escapeHtml(ch.name)}</span>
        ${unread}
      </div>`;
    }).join('');
    return `<div class="nav-category" data-cat="${escapeAttr(cat)}">
      <span class="nav-category-arrow">${iconSvg(arrowIcon, { width: 12, height: 12 })}</span>
      <span class="nav-category-name">${escapeHtml(cat)}</span>
      <span class="nav-category-add" data-cat="${escapeAttr(cat)}">${iconSvg('plus', { width: 14, height: 14 })}</span>
    </div>
    ${chans}`;
  }).join('');

  list.innerHTML = catHtml || `<div class="nav-empty">暂无频道,点击分类 + 创建</div>`;

  bindChannelClicks();
  bindCategoryToggles();
  bindCategoryAdd();
  bindChannelContextMenus();
}

function bindChannelClicks(): void {
  document.querySelectorAll<HTMLElement>('.nav-channel').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = Number(el.dataset.id);
      state.currentChatId = id;
      saveState();
      const { renderNavPanel, renderMain } = await import('../shell/navPanel.js');
      await renderNavPanel();
      await renderMain();
    });
  });
}

function bindCategoryToggles(): void {
  document.querySelectorAll<HTMLElement>('.nav-category').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.nav-category-add')) return;
      const catName = el.dataset.cat!;
      const collapsed = JSON.parse(localStorage.getItem('collapsedCategories') || '{}');
      const wsId = state.currentWsId || 0;
      if (!collapsed[wsId]) collapsed[wsId] = {};
      collapsed[wsId][catName] = !collapsed[wsId][catName];
      localStorage.setItem('collapsedCategories', JSON.stringify(collapsed));
      void renderChannelList();
    });
  });
}

function bindCategoryAdd(): void {
  document.querySelectorAll<HTMLElement>('.nav-category-add').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const cat = el.dataset.cat!;
      showInlineCreateChannel(cat);
    });
  });
}

function showInlineCreateChannel(category: string): void {
  const list = document.getElementById('groups-list');
  if (!list) return;
  const catEl = findCategoryElement(list, category);
  if (!catEl) return;
  const input = ui.inlineInput({
    placeholder: '输入频道名',
    confirmLabel: '创建',
    extra: `分类:${category}`,
    onConfirm: async (name) => {
      try {
        await call('create_channel', {
          workspaceId: state.currentWsId,
          name,
          category,
          spaceType: 'chat',
        });
        await refreshChannels();
        await renderChannelList();
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    onCancel: () => { void renderChannelList(); },
  });
  catEl.insertAdjacentElement('afterend', input);
}

function findCategoryElement(list: HTMLElement, category: string): HTMLElement | null {
  const cats = list.querySelectorAll<HTMLElement>('.nav-category');
  for (const el of cats) {
    if (el.dataset.cat === category) return el;
  }
  return null;
}

function bindChannelContextMenus(): void {
  document.querySelectorAll<HTMLElement>('.nav-channel').forEach((el) => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = Number(el.dataset.id);
      showChannelContextMenu(el, id);
    });
  });
}

async function setChatMuted(chatId: number, muted: boolean): Promise<void> {
  try {
    await call('set_chat_muted', { chatId, muted });
    showToast(muted ? '已静音' : '已取消静音');
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  }
}

async function setChatPinned(chatId: number, pinned: boolean): Promise<void> {
  try {
    await call('set_chat_pinned', { chatId, pinned });
    showToast(pinned ? '已置顶' : '已取消置顶');
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  }
}

function showChannelContextMenu(anchor: HTMLElement, chatId: number): void {
  const items: MenuItem[] = [
    {
      label: '频道信息',
      icon: 'info',
      action: async () => {
        state.rightDrawerOpen = true;
        state.detailPanelOpen = true;
        state.detailTab = 'members';
        saveState();
        const { renderRightDrawer } = await import('../shell/rightDrawer.js');
        renderRightDrawer();
      },
    },
    { label: '静音', icon: 'volume-x', action: () => void setChatMuted(chatId, true) },
    { label: '置顶', icon: 'pin', action: () => void setChatPinned(chatId, true) },
    {
      label: '标记已读',
      icon: 'check',
      action: async () => {
        try {
          await call('mark_chat_noticed', { chatId });
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      label: '复制邀请链接',
      icon: 'copy',
      action: async () => {
        try {
          const qr = await call<string>('get_securejoin_qr', { chatId });
          await navigator.clipboard.writeText(qr);
          showToast('邀请链接已复制');
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      label: '重命名频道',
      icon: 'edit',
      action: async () => {
        const ch = state.channels.find((c) => c.chat_id === chatId);
        ui.inputDialog({
          title: '重命名频道',
          placeholder: '频道名称',
          confirmLabel: '保存',
          value: ch?.name || '',
          onConfirm: async (name) => {
            try {
              await call('update_channel', { chatId, name });
              await refreshChannels();
              await renderChannelList();
              showToast('频道已重命名');
            } catch (e) {
              showToast(e instanceof Error ? e.message : String(e));
            }
          },
        });
      },
    },
    {
      label: '设置话题',
      icon: 'hash',
      action: async () => {
        const ch = state.channels.find((c) => c.chat_id === chatId);
        ui.inputDialog({
          title: '设置话题',
          placeholder: '频道话题',
          confirmLabel: '保存',
          value: ch?.topic || '',
          onConfirm: async (topic) => {
            try {
              await call('set_channel_topic', { chatId, topic });
              await refreshChannels();
              await renderChannelList();
              showToast('话题已更新');
            } catch (e) {
              showToast(e instanceof Error ? e.message : String(e));
            }
          },
        });
      },
    },
    {
      label: '删除频道',
      icon: 'trash',
      danger: true,
      action: async () => {
        ui.confirm({
          message: '删除该频道？',
          danger: true,
          onConfirm: async () => {
            try {
              await call('delete_channel', { chatId });
              await refreshChannels();
              await renderChannelList();
              if (state.currentChatId === chatId) {
                state.currentChatId = null;
                saveState();
                const { renderMain } = await import('../shell/navPanel.js');
                await renderMain();
              }
              showToast('频道已删除');
            } catch (e) {
              showToast(e instanceof Error ? e.message : String(e));
            }
          },
        });
      },
    },
    {
      label: '离开频道',
      icon: 'log-out',
      danger: true,
      action: async () => {
        try {
          await call('leave_channel', { chatId });
          await refreshChannels();
          await renderChannelList();
          if (state.currentChatId === chatId) {
            state.currentChatId = null;
            saveState();
            const { renderMain } = await import('../shell/navPanel.js');
            await renderMain();
          }
          showToast('已离开');
        } catch (e) {
          showToast(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
  ui.menu(anchor, items, 'bottom-right', { closeOn: 'hover', toggle: true });
}

function bindWsSwitcher(): void {
  const header = document.getElementById('groups-header');
  if (!header) return;
  header.addEventListener('click', (e) => {
    e.stopPropagation();
    const items: MenuItem[] = state.workspaces.map((ws) => ({
      label: ws.name,
      icon: 'users',
      action: async () => {
        state.currentWsId = ws.id;
        state.currentChatId = null;
        saveState();
        await refreshChannels();
        const { renderNavPanel } = await import('../shell/navPanel.js');
        await renderNavPanel();
      },
    }));
    items.push({
      label: '创建新团队',
      icon: 'plus',
      action: () => {
        ui.inputDialog({
          title: '创建新团队',
          placeholder: '团队名称',
          confirmLabel: '创建',
          onConfirm: async (name) => {
            try {
              const ws = await call<WorkspaceDto>('create_workspace', { name });
              await refreshWorkspaces();
              state.currentWsId = ws.id;
              state.currentChatId = null;
              saveState();
              await refreshChannels();
              const { renderNavPanel } = await import('../shell/navPanel.js');
              await renderNavPanel();
              showToast('团队已创建');
            } catch (e) {
              showToast(e instanceof Error ? e.message : String(e));
            }
          },
        });
      },
    });
    const currentWs = state.workspaces.find((w) => w.id === state.currentWsId);
    if (currentWs) {
      items.push({
        label: '重命名团队',
        icon: 'edit',
        action: () => {
          ui.inputDialog({
            title: '重命名团队',
            placeholder: '团队名称',
            confirmLabel: '保存',
            value: currentWs.name,
            onConfirm: async (name) => {
              try {
                await call('update_workspace', { id: currentWs.id, name });
                await refreshWorkspaces();
                const { renderNavPanel } = await import('../shell/navPanel.js');
                await renderNavPanel();
                showToast('团队已重命名');
              } catch (e) {
                showToast(e instanceof Error ? e.message : String(e));
              }
            },
          });
        },
      });
      items.push({
        label: '删除团队',
        icon: 'trash',
        danger: true,
        action: () => {
          ui.confirm({
            message: '删除团队及其全部频道与数据？',
            danger: true,
            onConfirm: async () => {
              try {
                await call('delete_workspace', { id: currentWs.id });
                state.currentWsId = null;
                state.currentChatId = null;
                saveState();
                await refreshWorkspaces();
                await refreshChannels();
                const { renderNavPanel } = await import('../shell/navPanel.js');
                await renderNavPanel();
                showToast('团队已删除');
              } catch (e) {
                showToast(e instanceof Error ? e.message : String(e));
              }
            },
          });
        },
      });
    }
    ui.menu(header, items, 'bottom-left', { closeOn: 'hover', toggle: true });
  });
}

