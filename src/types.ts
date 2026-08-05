export type Page = 'messages' | 'groups' | 'work' | 'inbox' | 'bots' | 'plugins' | 'settings' | 'debug' | 'github';
export type SettingsSection = 'account' | 'appearance' | 'team' | 'notifications' | 'plugins' | 'about' | 'github' | 'intelligence';
export type PluginsTab = 'market' | 'installed';

/** Plugin permission keys — gate which plugin API surfaces are usable. */
export type PluginPermission =
  | 'messages:read'
  | 'messages:send'
  | 'ui:css'
  | 'ui:theme'
  | 'commands'
  | 'llm'
  | 'network'
  | 'tools';
export type SpaceType = 'chat' | 'card';
export type CurrentView = 'kanban' | 'list' | 'calendar' | 'timeline';
export type WorkTab = 'channels' | 'activity';
export type InboxEventType = 'mention' | 'reply' | 'card_assign' | 'system';
export type MsgState = 'pending' | 'delivered' | 'failed' | 'read';
export type CardType = 'card' | 'task';
export type CardStatus = 'todo' | 'in_progress' | 'done';
/** GitHub 数据抽屉的 tab:issues/pulls/commits/files/events/details */
export type GithubTab = 'issues' | 'pulls' | 'commits' | 'files' | 'events' | 'details';
/** 当前选中的 GitHub 仓库标识(抽屉数据渲染用) */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

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
  // 最后活跃时间(unix 秒)。在线状态判断(600s 窗口)与群聊在线列表用。
  last_seen: number;
}

export interface MsgDto {
  msg_id: number;
  chat_id: number;
  from_id: number;
  from_name: string;
  from_avatar: string | null;
  from_color: number | null;
  text: string;
  ts: number;
  state: MsgState;
  view_type: string | null;
  file: string | null;
  file_mime: string | null;
  file_name: string | null;
  file_bytes: number | null;
  quote_text: string | null;
  quote_from: string | null;
  reactions: Record<string, number[]> | null;
  /** 系统消息(群成员变更/群资料变更/加密状态等),渲染为居中信息行 */
  is_info: boolean;
  /** 是否为本人发出的消息(后端 get_state().is_outgoing() 计算) */
  is_out: boolean;
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
  detailTab: 'members' | 'pin' | 'github' | 'media' | 'archive';
  /** 当前选中的 GitHub 仓库(detailTab==='github' 时抽屉渲染其数据),null = 未选中 */
  currentGithubRepo: GithubRepoRef | null;
  /** GitHub 抽屉当前 tab(选中仓库时重置为 'issues') */
  githubTab: GithubTab;
  self: SelfProfile | null;
  roles: RoleDto[];
  wsMembers: Record<number, number>;
  collapsedCategories: Record<number, Record<string, boolean>>;
  searchOpen: boolean;
  peytBannerDismissed: boolean;
  // SP6: Inbox 未读数 + 协作页 tab + 按频道记忆视图偏好
  inboxUnread: number;
  // 全部会话(常规+归档)未读总数:左侧功能栏消息图标角标 + 任务栏 badge
  totalUnread: number;
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
  avatar: string | null;
  color: number | null;
  // 最后一条消息元信息: 会话预览据此显示已读状态
  last_msg_is_out: boolean;
  last_msg_state: string; // "pending" | "delivered" | "failed" | "read"
  last_msg_read_count: number;
  last_msg_is_info: boolean;
  // 单聊对方最后活跃时间(unix 秒;非单聊为 0)。在线绿点/tooltip 用。
  contact_last_seen: number;
}

export interface ContactDto {
  id: number;
  name: string;
  addr: string;
  avatar: string | null;
  color: number | null;
}

/** vCard 名片消息里解析出的单个联系人(Delta 协议名片)。 */
export interface VcardContactDto {
  addr: string;
  name: string;
  /** 头像 data URL(base64 PNG) */
  avatar_data: string | null;
  biography: string | null;
}

/** 与某联系人共有的会话(资料卡片右侧列表)。 */
export interface CommonChatDto {
  chat_id: number;
  name: string;
  avatar: string | null;
  color: number | null;
  is_group: boolean;
}

/** get_chat_info 返回结构(群/单聊/邮件列表/广播通用) */
export interface ChatInfoDto {
  chat_id: number;
  name: string;
  is_group: boolean;
  is_contact_request: boolean;
  is_self_talk: boolean;
  chat_type: string;
  is_encrypted: boolean;
  members: MemberDto[];
  description: string;
  avatar: string | null;
  color: number | null;
  past_members: MemberDto[];
  can_send: boolean;
  self_in_group: boolean;
}
