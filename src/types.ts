export type Page = 'messages' | 'groups' | 'work' | 'inbox' | 'bots' | 'plugins' | 'settings' | 'debug';
export type SettingsSection = 'account' | 'appearance' | 'team' | 'notifications' | 'plugins' | 'about';
export type PluginsTab = 'market' | 'installed';

/** Plugin permission keys — gate which plugin API surfaces are usable. */
export type PluginPermission =
  | 'messages:read'
  | 'messages:send'
  | 'ui:css'
  | 'ui:theme'
  | 'commands'
  | 'llm'
  | 'network';
export type SpaceType = 'chat' | 'card';
export type CurrentView = 'kanban' | 'list' | 'calendar' | 'timeline';
export type WorkTab = 'channels' | 'activity';
export type InboxEventType = 'mention' | 'reply' | 'card_assign' | 'system';
export type MsgState = 'pending' | 'delivered' | 'failed' | 'read';
export type CardType = 'card' | 'task';
export type CardStatus = 'todo' | 'in_progress' | 'done';

export interface WorkspaceDto {
  id: number;
  name: string;
  master_chat_id: number;
  icon: string | null;
  created_at: number;
}

export interface ChannelDto {
  id: number;
  workspace_id: number;
  chat_id: number;
  name: string;
  category: string;
  position: number;
  topic: string | null;
  unread: number;
}

export interface MemberDto {
  contact_id: number;
  name: string;
  addr: string;
  avatar: string | null;
  color: number | null;
  is_self: boolean;
}

export interface MsgDto {
  msg_id: number;
  chat_id: number;
  from_id: number;
  from_name: string;
  text: string;
  ts: number;
  state: MsgState;
  view_type: string | null;
  file: string | null;
  file_mime: string | null;
  file_name: string | null;
  file_size: number | null;
  quote_text: string | null;
  quote_from: string | null;
  reactions: Record<string, number[]> | null;
}

export interface CardDto {
  id: number;
  workspace_id: number;
  channel_chat_id: number;
  msg_id: number | null;
  type: CardType;
  title: string;
  description: string | null;
  status: CardStatus;
  assignee_contact_id: number | null;
  assignee_name: string | null;
  due_date: number | null;
  created_at: number;
}

// Inbox 通知事件 (后端 inbox_events 表, type 字段经 serde rename)
export interface InboxEventDto {
  id: number;
  workspace_id: number;
  type: string; // InboxEventType
  source_chat_id: number;
  msg_id: number | null;
  actor_id: number;
  actor_name: string;
  summary: string;
  created_at: number;
  read_at: number | null;
}

// Activity 活动流记录 (后端 activities 表)
export interface ActivityDto {
  id: number;
  workspace_id: number;
  channel_chat_id: number | null;
  actor_id: number;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: number;
  payload: string | null;
  created_at: number;
}

export interface SelfProfile {
  id: number;
  name: string;
  addr: string;
  avatar: string | null;
  color: number | null;
}

export interface RoleDto {
  id: number;
  workspace_id: number;
  name: string;
  color: number | null;
}

export interface AppState {
  currentPage: Page;
  currentSettingsSection: SettingsSection;
  pluginsTab: PluginsTab;
  currentWsId: number | null;
  currentChatId: number | null;
  workspaces: WorkspaceDto[];
  channels: ChannelDto[];
  messages: MsgDto[];
  messagesOldestId: number | null;
  noMoreMsgs: boolean;
  currentMembers: MemberDto[];
  currentChatIsGroup: boolean;
  cards: CardDto[];
  currentCardId: number | null;
  currentView: CurrentView;
  rightDrawerOpen: boolean;
  detailPanelOpen: boolean;
  detailTab: 'members' | 'pin';
  self: SelfProfile | null;
  roles: RoleDto[];
  wsMembers: Record<number, number>;
  collapsedCategories: Record<number, Record<string, boolean>>;
  searchOpen: boolean;
  peytBannerDismissed: boolean;
  // SP6: Inbox 未读数 + 协作页 tab + 按频道记忆视图偏好
  inboxUnread: number;
  currentWorkTab: WorkTab;
  viewPrefs: Record<number, CurrentView>; // key = channel chat_id
}

export interface ChatListItem {
  chat_id: number;
  name: string;
  last_msg: string | null;
  last_ts: number | null;
  unread: number;
  is_archived: boolean;
  is_group: boolean;
  is_contact_request: boolean;
  is_self_talk: boolean;
  chat_type: string;
}

export interface ContactDto {
  id: number;
  name: string;
  addr: string;
}
