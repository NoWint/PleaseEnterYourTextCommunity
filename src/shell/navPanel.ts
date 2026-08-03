import { call } from '../api.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import { escapeHtml as esc } from '../components/escape.js';
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
      case 'plugins': {
        const { renderPluginsNav } = await import('../plugins/view.js');
        await renderPluginsNav(panel);
        break;
      }
      case 'settings': {
        const { renderSettingsNav } = await import('../pages/settingsPage.js');
        await renderSettingsNav(panel);
        break;
      }
      case 'debug': {
        const { renderDebugNav } = await import('../pages/debugPage.js');
        await renderDebugNav(panel);
        break;
      }
    }
  } catch {
    panel.innerHTML = `<div class="empty">页面加载失败</div>`;
  }
}

export async function renderMain(): Promise<void> {
  const main = document.getElementById('chat-main');
  if (!main) return;

  // 离开消息/群聊页时释放麦克风(录音中切到 settings/work 等会持续占用)
  if (state.currentPage !== 'messages' && state.currentPage !== 'groups') {
    void import('../chat/composer.js').then((m) => m.cleanupVoiceRecorder()).catch(() => {});
  }

  if (state.currentPage === 'plugins') {
    try {
      const { renderPluginsMain } = await import('../plugins/view.js');
      await renderPluginsMain(main);
    } catch (err) {
      console.error('[plugins] renderPluginsMain failed:', err);
      main.innerHTML = `<div class="empty">插件页加载失败<br><span style="font-size:var(--font-scale-micro);color:var(--text-faint)">${esc(String(err))}</span></div>`;
    }
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
    try {
      const { renderInboxMain } = await import('../pages/inboxPage.js');
      await renderInboxMain(main);
    } catch {
      main.innerHTML = `<div class="empty">通知加载失败</div>`;
    }
    return;
  }

  if (state.currentPage === 'debug') {
    try {
      const { renderDebugMain } = await import('../pages/debugPage.js');
      await renderDebugMain(main);
    } catch {
      main.innerHTML = `<div class="empty">调试页加载失败</div>`;
    }
    return;
  }

  // bots 页:机器人管理,全屏主区化 (同 inbox/debug)
  if (state.currentPage === 'bots') {
    try {
      const { renderBots } = await import('../pages/botsPage.js');
      await renderBots(main);
    } catch {
      main.innerHTML = `<div class="empty">机器人页加载失败</div>`;
    }
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
  } catch {
    main.innerHTML = `<div class="empty">聊天视图加载失败</div>`;
  }
}
