import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import type { ChannelDto, Page, SpaceType } from '../types.js';

export async function refreshChannels(): Promise<void> {
  if (state.currentWsId == null) {
    state.channels = [];
    return;
  }
  try {
    state.channels = await call<ChannelDto[]>('list_channels', { workspaceId: state.currentWsId });
  } catch {
    state.channels = [];
  }
  try {
    const ws = state.workspaces.find((w) => w.id === state.currentWsId);
    if (ws?.master_chat_id) {
      const info = await call<{ members: unknown[] }>('get_chat_info', { chatId: ws.master_chat_id });
      state.wsMembers[state.currentWsId] = info.members?.length || 0;
    }
  } catch {}
}

const spaceTypeCache = new Map<number, SpaceType>();

export async function getSpaceType(chatId: number): Promise<SpaceType> {
  if (spaceTypeCache.has(chatId)) return spaceTypeCache.get(chatId)!;
  try {
    const st = await call<SpaceType>('get_channel_space_type', { chatId });
    spaceTypeCache.set(chatId, st);
    return st;
  } catch {
    return 'chat';
  }
}

export function clearSpaceTypeCache(): void {
  spaceTypeCache.clear();
}

// 这些页面主区已承载全部内容,中间栏 (nav-panel) 纯占位 → 隐藏,让主区占满。
// github 除外:Task A 改为 VSCode 式三栏,侧边栏显示仓库树(renderGithubNav)。
const HIDDEN_NAV_PAGES: ReadonlySet<Page> = new Set(['inbox', 'bots']);

export async function renderNavPanel(): Promise<void> {
  const panel = document.getElementById('channel-tree');
  if (!panel) return;
  panel.className = 'nav-panel';

  const hidden = HIDDEN_NAV_PAGES.has(state.currentPage);
  panel.style.display = hidden ? 'none' : '';
  const navResizer = document.getElementById('nav-resizer');
  if (navResizer) navResizer.style.display = hidden ? 'none' : '';

  try {
    switch (state.currentPage) {
      case 'messages': {
        const { renderMessagesPage } = await import('../pages/messagesPage.js');
        await renderMessagesPage(panel);
        break;
      }
      case 'groups': {
        const { renderGroupsPage } = await import('../pages/groupsPage.js');
        await renderGroupsPage(panel);
        break;
      }
      case 'work': {
        const { renderWorkPage } = await import('../pages/workPage.js');
        await renderWorkPage(panel);
        break;
      }
      case 'inbox': {
        // 中间栏已隐藏,通知完全主区化 (renderInboxMain)
        panel.innerHTML = '';
        break;
      }
      case 'github': {
        // GitHub 页已迁移至 v2 路由(/github,原生 Solid 组件);legacy 壳仅占位。
        panel.innerHTML = '';
        break;
      }
      case 'intelligence': {
        // 智能中心页已迁移至 v2 路由(/intelligence,原生 Solid 组件);legacy 壳仅占位。
        panel.innerHTML = '';
        break;
      }
      case 'plugins': {
        // 已迁移至 v2 原生页（/plugins 路由），legacy 壳仅保留占位
        panel.innerHTML = `<div class="nav-empty">插件页已迁移至新版界面</div>`;
        break;
      }
      case 'settings': {
        const { renderSettingsNav } = await import('../pages/settingsPage.js');
        await renderSettingsNav(panel);
        break;
      }
      case 'debug': {
        // 已迁移至 v2 原生页（/debug 路由），legacy 壳仅保留占位
        panel.innerHTML = `<div class="nav-empty">调试页已迁移至新版界面</div>`;
        break;
      }
    }
  } catch {
    panel.innerHTML = `<div class="empty">页面加载失败</div>`;
  }
  // macOS 顶栏:页面/工作区变化后更新上下文面包屑 + 搜索定位
  try {
    const { updateTitlebar } = await import('./titlebar.js');
    updateTitlebar();
  } catch {}
}

export async function renderMain(): Promise<void> {
  const main = document.getElementById('chat-main');
  if (!main) return;

  // 离开消息/群聊页时释放麦克风(录音中切到 settings/work 等会持续占用)
  if (state.currentPage !== 'messages' && state.currentPage !== 'groups') {
    void import('../chat/composer.js').then((m) => m.cleanupVoiceRecorder()).catch(() => {});
  }

  if (state.currentPage === 'plugins') {
    // 已迁移至 v2 原生页（/plugins 路由），legacy 壳仅保留占位
    main.innerHTML = `<div class="empty">插件页已迁移至新版界面</div>`;
    return;
  }

  if (state.currentPage === 'settings') {
    try {
      const { renderSettingsMain } = await import('../pages/settingsPage.js');
      await renderSettingsMain(main);
    } catch {
      main.innerHTML = `<div class="empty">设置页加载失败</div>`;
    }
    return;
  }

  if (state.currentPage === 'inbox') {
    // 已迁移至 v2 原生页（/inbox 路由），legacy 壳仅保留占位
    main.innerHTML = `<div class="empty">通知页已迁移至新版界面</div>`;
    return;
  }

  if (state.currentPage === 'debug') {
    // 已迁移至 v2 原生页（/debug 路由），legacy 壳仅保留占位
    main.innerHTML = `<div class="empty">调试页已迁移至新版界面</div>`;
    return;
  }

  if (state.currentPage === 'github') {
    // GitHub 页已迁移至 v2 路由(/github,原生 Solid 组件);legacy 壳仅占位。
    main.innerHTML = `<div class="empty">GitHub 页已迁移至新界面(v2 路由 /github)</div>`;
    return;
  }

  if (state.currentPage === 'intelligence') {
    // 智能中心页已迁移至 v2 路由(/intelligence,原生 Solid 组件);legacy 壳仅占位。
    main.innerHTML = `<div class="empty">智能中心已迁移到新版界面，请从主界面打开</div>`;
    return;
  }

  // bots 页:机器人管理已迁移到新版界面(/bots 路由,src/app/pages/bots);legacy 壳仅占位
  if (state.currentPage === 'bots') {
    main.innerHTML = `<div class="empty">机器人中心已迁移到新版界面，请从主界面打开</div>`;
    return;
  }

  if (state.currentPage === 'work') {
    if (state.currentChatId == null) {
      main.innerHTML = `<div class="empty">选择一个协作频道</div>`;
      return;
    }
    // 优先按频道记忆的视图偏好,回退到 state.currentView
    const chatId = state.currentChatId;
    const view = state.viewPrefs[chatId] ?? state.currentView;
    state.currentView = view;
    try {
      if (view === 'kanban') {
        const { renderKanban } = await import('../work/kanban.js');
        await renderKanban(chatId);
      } else if (view === 'list') {
        const { renderList } = await import('../work/list.js');
        await renderList(chatId);
      } else if (view === 'calendar') {
        const { renderCalendar } = await import('../work/calendar.js');
        await renderCalendar(chatId);
      } else if (view === 'timeline') {
        const { renderTimeline } = await import('../work/timeline.js');
        await renderTimeline(chatId);
      }
    } catch {
      main.innerHTML = `<div class="empty">视图加载失败</div>`;
    }
    return;
  }

  // messages / groups 页:聊天视图
  if (state.currentChatId == null) {
    main.innerHTML = `<div class="empty">选择一个频道</div>`;
    return;
  }
  try {
    const { renderChatView } = await import('../chat/chatView.js');
    await renderChatView(state.currentChatId);
    // macOS 顶栏:频道切换后刷新面包屑(工作区 › 页面 › 频道)
    try {
      const { updateTitlebar } = await import('./titlebar.js');
      updateTitlebar();
    } catch {}
  } catch {
    main.innerHTML = `<div class="empty">聊天视图加载失败</div>`;
  }
}
