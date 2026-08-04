import type { AppState } from './types.js';

export const state: AppState = {
  currentPage: 'messages',
  currentSettingsSection: 'account',
  pluginsTab: 'market',
  currentWsId: null,
  currentChatId: null,
  workspaces: [],
  channels: [],
  messages: [],
  messagesOldestId: null,
  noMoreMsgs: false,
  currentMembers: [],
  currentChatIsGroup: false,
  cards: [],
  currentCardId: null,
  currentView: 'kanban',
  rightDrawerOpen: true,
  detailPanelOpen: true,
  detailTab: 'members',
  self: null,
  roles: [],
  wsMembers: {},
  collapsedCategories: {},
  searchOpen: false,
  peytBannerDismissed: false,
  inboxUnread: 0,
  currentWorkTab: 'channels',
  viewPrefs: {},
};

export function setState(partial: Partial<AppState>): void {
  Object.assign(state, partial);
}
