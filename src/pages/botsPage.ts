import { call, onEvent } from '../api.js';
import { ui } from '../components/ui.js';
import { iconSvg } from '../components/icon.js';
import { renderMessage } from '../chat/message.js';
import type { MsgDto } from '../types.js';

// Bot 管理中心:列表(状态/人设/规则/定时徽标) → 详情(对话 / LLM / 规则 / 定时 / 工具 / 时间线 / 统计)。
// 后端命令:list_bots / create_bot / delete_bot / set_bot_io / get_bot_config / update_bot_config /
// test_llm_config / bot_get_chatlist / bot_get_chat_msgs / bot_send_text / bot_mark_chat_seen /
// add_bot_to_chat / bot_list_schedules / bot_add_schedule / bot_delete_schedule /
// list_bot_tools / list_bot_personas / apply_bot_persona / list_bot_activities / get_bot_stats。
// 事件:bot-activity(实时活动/打字指示器)、IncomingMsg(实时刷新会话)。

export interface BotDto {
  id: number;
  bot_account_id: number;
  display_name: string;
  addr: string | null;
  io_running: boolean;
  created_at: number;
}

// 后端 bot_get_chatlist 返回的会话结构
interface ChatDto {
  chat_id: number;
  name: string;
  is_group: boolean;
  is_contact_request: boolean;
  is_self_talk: boolean;
  is_archived: boolean;
  last_msg: string | null;
  last_ts: number | null;
  unread: number;
}

// ── 后端 DTO(与 src-tauri/src/dto.rs 对应)──────────────────────────

interface LlmConfig {
  system_prompt?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
  provider?: string | null;
  temperature?: number;
  max_tokens?: number | null;
  top_p?: number | null;
  timeout_secs?: number;
  max_retries?: number;
}

interface BotLimits {
  max_concurrent?: number;
  reply_min_interval_secs?: number;
  allow_bot_interaction?: boolean;
  interaction_max_rounds?: number;
}

interface RuleDef {
  id: number;
  pattern: string;
  is_regex: boolean;
  replies: string[];
  enabled: boolean;
}

interface RuleConfig {
  rules: RuleDef[];
  welcome?: string | null;
  fallback?: string | null;
}

interface BotConfig {
  llm?: LlmConfig | null;
  limits?: BotLimits;
  tools?: string[] | null;
  rule?: RuleConfig | null;
  persona?: string | null;
}

interface ScheduleDto {
  id: number;
  bot_id: number;
  chat_id: number;
  minute: number;
  hour: number;
  day_of_week: number;
  message: string;
  enabled: boolean;
  next_run_at: number;
}

interface BotStatsDto {
  total_activities: number;
  reply_sent: number;
  rule_reply: number;
  schedule_sent: number;
  tool_called: number;
  llm_error: number;
  rate_limited: number;
  last_activity_at?: number | null;
  first_seen_at?: number | null;
}

interface BotActivityDto {
  id: number;
  bot_id: number;
  kind: string;
  chat_id?: number | null;
  msg_id?: number | null;
  summary: string;
  detail_json?: string | null;
  created_at: number;
}

interface BotToolDto {
  name: string;
  description: string;
  safe: boolean;
}

interface PersonaDto {
  id: string;
  name: string;
  description: string;
}

type DetailTab = 'chat' | 'llm' | 'rule' | 'schedule' | 'tools' | 'timeline' | 'stats';

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'chat', label: '对话' },
  { id: 'llm', label: 'LLM' },
  { id: 'rule', label: '规则' },
  { id: 'schedule', label: '定时' },
  { id: 'tools', label: '工具' },
  { id: 'timeline', label: '时间线' },
  { id: 'stats', label: '统计' },
];

// Base URL 预设:value 即完整 URL,`__custom__` 表示自定义地址
const LLM_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'https://api.openai.com/v1', label: 'OpenAI' },
  { value: 'https://api.deepseek.com', label: 'DeepSeek' },
  { value: 'http://localhost:11434/v1', label: 'Ollama' },
  { value: '__custom__', label: '自定义' },
];

const PROVIDERS: Array<{ value: string; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
];

const KIND_LABELS: Record<string, string> = {
  reply_sent: '自动回复',
  reply_skipped: '跳过回复',
  reply_rate_limited: '被限流',
  llm_error: 'LLM 错误',
  no_config: '未配置 LLM',
  driver_disabled: '驱动停用',
  thinking: '思考中',
  tool_called: '工具调用',
  schedule_sent: '定时消息',
  rule_reply: '规则回复',
};

function kindVariant(kind: string): 'default' | 'success' | 'danger' | 'muted' {
  if (kind === 'reply_sent' || kind === 'rule_reply' || kind === 'tool_called' || kind === 'schedule_sent') return 'success';
  if (kind === 'llm_error' || kind === 'reply_rate_limited') return 'danger';
  if (kind === 'thinking') return 'default';
  return 'muted';
}

// ── 模块级事件状态:bot-activity 全局监听一次,按当前上下文分发 ──────

let activityUnlisten: (() => void) | null = null;
let incomingUnlisten: (() => void) | null = null;

// 详情态上下文:chat(打字指示器/实时刷新)、timeline(实时追加)
let chatCtx: {
  botId: number;
  activeChatId: () => number | null;
  showTyping: () => void;
  hideTyping: () => void;
  reloadChat: () => Promise<void>;
} | null = null;

let timelineCtx: { botId: number; append: (a: BotActivityDto) => void } | null = null;

// 列表态:botId → 运行状态徽标元素(thinking 驱动临时变徽标)
const listRowBadges = new Map<number, HTMLSpanElement>();
const listRowRunning = new Map<number, boolean>();

function ensureActivityListener(): void {
  if (activityUnlisten) return;
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      activityUnlisten = await listen('bot-activity', (ev) => {
        handleBotActivity(ev.payload as BotActivityDto);
      });
    } catch {
      // 事件桥失败不影响页面
    }
  })();
}

function handleBotActivity(a: BotActivityDto): void {
  // 列表态:thinking 驱动该行徽标临时变化
  const badge = listRowBadges.get(a.bot_id);
  if (badge) {
    if (a.kind === 'thinking') {
      setBadge(badge, '思考中', 'default');
    } else if (a.kind === 'reply_sent' || a.kind === 'llm_error' || a.kind === 'reply_skipped' || a.kind === 'reply_rate_limited') {
      const running = listRowRunning.get(a.bot_id) ?? false;
      setBadge(badge, running ? '运行中' : '已停止', running ? 'success' : 'muted');
    }
  }
  // 详情态-对话:打字指示器 + 实时刷新
  if (chatCtx && chatCtx.botId === a.bot_id) {
    if (a.kind === 'thinking') {
      chatCtx.showTyping();
    } else if (a.kind === 'reply_sent' || a.kind === 'llm_error') {
      chatCtx.hideTyping();
      if (a.chat_id != null && chatCtx.activeChatId() === a.chat_id) void chatCtx.reloadChat();
    }
  }
  // 详情态-时间线:实时追加
  if (timelineCtx && timelineCtx.botId === a.bot_id) {
    timelineCtx.append(a);
  }
}

function clearLiveCtx(): void {
  chatCtx = null;
  timelineCtx = null;
  if (incomingUnlisten) {
    incomingUnlisten();
    incomingUnlisten = null;
  }
}

// 徽标文本/样式就地替换(不重建 DOM)
function setBadge(el: HTMLElement, text: string, variant: 'default' | 'success' | 'danger' | 'muted'): void {
  el.textContent = text;
  el.className = `ui-badge${variant === 'default' ? '' : ` ui-badge-${variant}`}`;
}

// ── 列表态 ─────────────────────────────────────────────────────────

export async function renderBots(main: HTMLElement): Promise<void> {
  clearLiveCtx();
  listRowBadges.clear();
  listRowRunning.clear();
  ensureActivityListener();

  main.innerHTML = '';

  // 头部:标题 + 新建按钮
  const header = document.createElement('div');
  header.className = 'main-header';
  const titleBox = document.createElement('div');
  titleBox.innerHTML = `
    <div class="main-title">机器人</div>
    <div class="main-subtitle">由 LLM 自动回复的 Bot 账号</div>
  `;
  const actions = document.createElement('div');
  actions.className = 'main-actions';
  actions.appendChild(ui.button({
    label: '新建 Bot',
    icon: 'plus',
    variant: 'primary',
    onClick: () => onCreateBot(main),
  }));
  header.appendChild(titleBox);
  header.appendChild(actions);
  main.appendChild(header);

  // 拉取 Bot 列表
  let bots: BotDto[];
  try {
    bots = await call<BotDto[]>('list_bots');
  } catch (e) {
    main.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }

  if (bots.length === 0) {
    const empty = ui.empty('还没有 Bot。\nBot 是一个独立的 AI 邮箱账号：创建后把它的邮箱发给任何人，对方发消息就会收到 LLM 自动回复。');
    empty.style.whiteSpace = 'pre-line';
    main.appendChild(empty);
    return;
  }

  // 并行加载:人设名映射 + 每个 Bot 的配置(已配 LLM / 人设 / 规则徽标)与定时数量
  let personas: PersonaDto[] = [];
  try {
    personas = await call<PersonaDto[]>('list_bot_personas');
  } catch { /* 忽略 */ }
  const personaName = new Map(personas.map((p) => [p.id, p.name]));

  type RowInfo = { bot: BotDto; cfg: BotConfig | null; scheduleCount: number };
  const rows = await Promise.all(
    bots.map(async (bot): Promise<RowInfo> => {
      let cfg: BotConfig | null = null;
      let scheduleCount = 0;
      try { cfg = await call<BotConfig | null>('get_bot_config', { botId: bot.id }); } catch { /* 忽略 */ }
      try { scheduleCount = (await call<ScheduleDto[]>('bot_list_schedules', { botId: bot.id })).filter((s) => s.enabled).length; } catch { /* 忽略 */ }
      return { bot, cfg, scheduleCount };
    })
  );

  const list = document.createElement('div');
  for (const row of rows) {
    list.appendChild(renderBotRow(row.bot, row.cfg, row.scheduleCount, personaName, () => void renderBots(main), main));
  }
  main.appendChild(list);
}

// 单行:头像 + 名称/地址 + 徽章区(运行状态 / 已配 LLM / 人设 / 规则 / 定时)+ 右侧操作。
// 点击整行进入详情视图。
function renderBotRow(
  bot: BotDto,
  cfg: BotConfig | null,
  scheduleCount: number,
  personaName: Map<string, string>,
  onChanged: () => void,
  main: HTMLElement,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ui-list-item';
  row.style.cursor = 'pointer';
  row.title = '查看详情';
  row.addEventListener('click', () => void renderBotDetail(bot, main, 'chat'));

  row.appendChild(ui.avatar({ name: bot.display_name, size: 36 }));

  const meta = document.createElement('div');
  meta.className = 'ui-list-meta';
  const title = document.createElement('div');
  title.className = 'ui-list-title';
  title.textContent = bot.display_name;
  const sub = document.createElement('div');
  sub.className = 'ui-list-sub';
  sub.textContent = bot.addr ?? '地址未知';
  meta.appendChild(title);
  meta.appendChild(sub);
  row.appendChild(meta);

  // 徽章区:运行状态 + 已配 LLM + 人设 + 规则 + 定时
  const badges = document.createElement('div');
  badges.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0';
  const runBadge = ui.badge({
    text: bot.io_running ? '运行中' : '已停止',
    variant: bot.io_running ? 'success' : 'muted',
  });
  listRowBadges.set(bot.id, runBadge);
  listRowRunning.set(bot.id, bot.io_running);
  badges.appendChild(runBadge);
  if (isLlmConfigured(cfg?.llm)) badges.appendChild(ui.badge({ text: '已配 LLM', variant: 'success' }));
  if (cfg?.persona) badges.appendChild(ui.badge({ text: personaName.get(cfg.persona) ?? cfg.persona, variant: 'default' }));
  if (cfg?.rule && (cfg.rule.rules.some((r) => r.enabled) || cfg.rule.welcome || cfg.rule.fallback)) {
    badges.appendChild(ui.badge({ text: '规则', variant: 'default' }));
  }
  if (scheduleCount > 0) badges.appendChild(ui.badge({ text: `${scheduleCount} 定时`, variant: 'muted' }));
  row.appendChild(badges);

  // 右侧操作
  const ops = document.createElement('div');
  ops.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';
  // 阻止操作按钮点击冒泡到行级
  ops.addEventListener('click', (e) => e.stopPropagation());
  ops.appendChild(ui.iconButton({
    icon: 'message-circle',
    title: '对话',
    size: 'sm',
    onClick: () => void renderBotDetail(bot, main, 'chat'),
  }));
  ops.appendChild(ui.iconButton({
    icon: 'users',
    title: '拉入群聊',
    size: 'sm',
    onClick: () => void openAddBotToChat(bot),
  }));
  ops.appendChild(ui.iconButton({
    icon: 'settings',
    title: '配置',
    size: 'sm',
    onClick: () => void renderBotDetail(bot, main, 'llm'),
  }));
  ops.appendChild(ui.switch_({
    checked: bot.io_running,
    onChange: async (v) => {
      try {
        await call('set_bot_io', { botId: bot.id, running: v });
        onChanged();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
        onChanged(); // 重渲染以回滚开关状态
      }
    },
  }));
  ops.appendChild(ui.iconButton({
    icon: 'trash',
    title: '删除',
    danger: true,
    size: 'sm',
    onClick: () => {
      ui.confirm({
        title: '删除 Bot',
        message: '删除后该 Bot 账号及其数据将彻底移除',
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
          try {
            await call('delete_bot', { botId: bot.id });
            ui.toast('已删除');
            onChanged();
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e));
          }
        },
      });
    },
  }));
  row.appendChild(ops);

  return row;
}

// 是否已配置完整 LLM(base_url + api_key + model 三者齐全)
function isLlmConfigured(cfg: LlmConfig | null | undefined): boolean {
  return !!cfg && !!cfg.base_url && !!cfg.api_key && !!cfg.model;
}

// ── 详情态 ─────────────────────────────────────────────────────────

async function renderBotDetail(bot: BotDto, main: HTMLElement, initialTab: DetailTab): Promise<void> {
  clearLiveCtx();
  ensureActivityListener();
  main.innerHTML = '';

  const root = document.createElement('div');
  root.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';
  main.appendChild(root);

  // 配置状态:进入时加载一次,保存后刷新
  const cfgState: { value: BotConfig | null } = { value: null };
  try {
    cfgState.value = await call<BotConfig | null>('get_bot_config', { botId: bot.id });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
  const getCfg = (): BotConfig | null => cfgState.value;
  const setCfg = (next: BotConfig | null): void => { cfgState.value = next; };

  let personas: PersonaDto[] = [];
  try {
    personas = await call<PersonaDto[]>('list_bot_personas');
  } catch { /* 忽略 */ }
  const personaName = new Map(personas.map((p) => [p.id, p.name]));

  // 顶栏:返回 + 头像 + 名称/地址 + 运行徽标 + 人设徽标 + 启停 switch
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--panel);flex-shrink:0';
  head.appendChild(ui.button({
    label: '返回列表',
    icon: 'chevron-left',
    variant: 'ghost',
    size: 'sm',
    onClick: () => void renderBots(main),
  }));
  head.appendChild(ui.avatar({ name: bot.display_name, size: 40 }));
  const info = document.createElement('div');
  info.style.cssText = 'min-width:0;flex:1';
  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  nameEl.textContent = bot.display_name;
  const addrEl = document.createElement('div');
  addrEl.style.cssText = 'font-size:12px;color:var(--text-mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  addrEl.textContent = bot.addr ?? '';
  info.appendChild(nameEl);
  info.appendChild(addrEl);
  head.appendChild(info);

  const runBadge = ui.badge({ text: bot.io_running ? '运行中' : '已停止', variant: bot.io_running ? 'success' : 'muted' });
  head.appendChild(runBadge);
  const personaNameHeader = getCfg()?.persona ?? null;
  const personaBadge = ui.badge({ text: personaNameHeader ? (personaName.get(personaNameHeader) ?? personaNameHeader) : '无人设', variant: 'muted' });
  head.appendChild(personaBadge);
  head.appendChild(ui.switch_({
    checked: bot.io_running,
    onChange: async (v) => {
      try {
        const updated = await call<BotDto>('set_bot_io', { botId: bot.id, running: v });
        bot.io_running = updated.io_running;
        setBadge(runBadge, updated.io_running ? '运行中' : '已停止', updated.io_running ? 'success' : 'muted');
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  }));
  root.appendChild(head);

  // Tab 栏
  let tab: DetailTab = initialTab;
  const tabBar = ui.tabs({
    items: DETAIL_TABS,
    active: initialTab,
    onChange: (id) => {
      tab = id as DetailTab;
      renderTabContent();
    },
  });
  tabBar.style.cssText = 'flex-shrink:0;border-bottom:1px solid var(--border)';
  root.appendChild(tabBar);

  // 内容区(切换时清空重渲染)
  const content = document.createElement('div');
  content.style.cssText = 'flex:1;min-height:0;overflow-y:auto';
  root.appendChild(content);

  function renderTabContent(): void {
    clearLiveCtx();
    content.innerHTML = '';
    if (tab === 'chat') {
      content.style.cssText = 'flex:1;min-height:0;overflow:hidden;display:flex';
    } else {
      content.style.cssText = 'flex:1;min-height:0;overflow-y:auto';
    }
    switch (tab) {
      case 'chat': void renderChatTab(bot, content); break;
      case 'llm': void renderLlmTab(bot, content, getCfg, setCfg); break;
      case 'rule': void renderRuleTab(bot, content, getCfg, setCfg); break;
      case 'schedule': void renderScheduleTab(bot, content); break;
      case 'tools': void renderToolsTab(bot, content, getCfg, setCfg); break;
      case 'timeline': void renderTimelineTab(bot, content); break;
      case 'stats': void renderStatsTab(bot, content); break;
    }
  }

  // 会话 tab 需要高度自适应(消息线程滚动),其余 tab 直接滚动容器
  function renderChatTab(b: BotDto, c: HTMLElement): Promise<void> {
    return buildChatPane(b, c);
  }

  renderTabContent();
}

// 滚动态 tab 的通用容器:内边距 + 纵向排列
function scrollContent(children: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:12px;max-width:760px';
  for (const el of children) wrap.appendChild(el);
  return wrap;
}

// ── Tab:对话(双栏 + 打字指示器 + 实时刷新)────────────────────────

async function buildChatPane(bot: BotDto, content: HTMLElement): Promise<void> {
  const pane = document.createElement('div');
  pane.style.cssText = 'flex:1;min-height:0;display:flex;overflow:hidden';
  content.appendChild(pane);

  // ── 左栏:Bot 信息 + 会话列表 ──
  const left = document.createElement('div');
  left.style.cssText = 'width:260px;flex-shrink:0;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--border);background:var(--panel)';
  pane.appendChild(left);

  const leftHead = document.createElement('div');
  leftHead.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px;border-bottom:1px solid var(--border);flex-shrink:0';
  const info = document.createElement('div');
  info.style.cssText = 'min-width:0';
  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  nameEl.textContent = bot.display_name;
  const addrEl = document.createElement('div');
  addrEl.style.cssText = 'font-size:12px;color:var(--text-mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  addrEl.textContent = bot.addr ?? '';
  info.appendChild(nameEl);
  info.appendChild(addrEl);
  leftHead.appendChild(info);
  left.appendChild(leftHead);

  const convList = document.createElement('div');
  convList.style.cssText = 'flex:1;overflow-y:auto;min-height:0';
  left.appendChild(convList);

  // 拉取会话列表
  let chats: ChatDto[] = [];
  try {
    chats = await call<ChatDto[]>('bot_get_chatlist', { botId: bot.id });
  } catch (e) {
    convList.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
  }
  if (chats.length === 0) {
    convList.appendChild(ui.empty('暂无会话'));
  }

  // ── 右栏:会话头部 + 消息线程 + 打字指示器 + 发送框 ──
  const right = document.createElement('div');
  right.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--bg)';
  pane.appendChild(right);

  const rightHead = document.createElement('div');
  rightHead.className = 'main-header';
  rightHead.style.cssText = 'flex-shrink:0';
  const rightTitle = document.createElement('div');
  rightTitle.className = 'main-title';
  rightTitle.style.cssText = 'font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  rightTitle.textContent = '选择一个会话';
  rightHead.appendChild(rightTitle);
  right.appendChild(rightHead);

  const thread = document.createElement('div');
  thread.className = 'messages';
  thread.style.cssText = 'flex:1;min-height:0;position:relative';
  right.appendChild(thread);
  thread.appendChild(ui.empty('从左侧选择一个会话'));

  // 打字指示器:bot-activity thinking 时显示在消息底部
  const typingEl = document.createElement('div');
  typingEl.style.cssText = 'display:none;padding:6px 14px;font-size:12px;color:var(--text-mute);align-items:center;gap:6px;flex-shrink:0';
  const dot = document.createElement('span');
  dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--text-mute)';
  typingEl.appendChild(dot);
  typingEl.appendChild(document.createTextNode('正在输入…'));
  right.appendChild(typingEl);

  // 发送框(单行输入 + 圆形发送按钮)
  const composer = document.createElement('div');
  composer.className = 'composer';
  composer.style.cssText = 'flex-shrink:0';
  const cRow = document.createElement('div');
  cRow.className = 'composer-row';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'composer-send';
  sendBtn.title = '发送';
  sendBtn.innerHTML = iconSvg('send', { width: 18, height: 18 });
  sendBtn.disabled = true;
  const inputEl = ui.input({
    placeholder: '输入消息，Enter 发送',
    onChange: updateSendBtn,
    onEnter: () => void doSend(),
  });
  cRow.appendChild(inputEl);
  cRow.appendChild(sendBtn);
  composer.appendChild(cRow);
  right.appendChild(composer);

  let activeChat: ChatDto | null = null;
  let sending = false;

  function updateSendBtn(): void {
    sendBtn.disabled = sending || inputEl.value.trim().length === 0;
  }

  async function doSend(): Promise<void> {
    if (!activeChat || sending) return;
    const text = inputEl.value.trim();
    if (!text) return;
    sending = true;
    updateSendBtn();
    try {
      const msg = await call<MsgDto>('bot_send_text', { botId: bot.id, chatId: activeChat.chat_id, text });
      thread.insertAdjacentHTML('beforeend', await renderMessage(msg, 'solo'));
      inputEl.value = '';
      updateSendBtn();
      thread.scrollTop = thread.scrollHeight;
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    } finally {
      sending = false;
      updateSendBtn();
    }
  }
  sendBtn.addEventListener('click', () => void doSend());

  // 会话行:名称 + 最后一条消息(截断) + 未读徽章
  const makeConvRow = (chat: ChatDto): HTMLElement => {
    const r = document.createElement('div');
    r.className = 'ui-list-item';
    r.dataset.chatId = String(chat.chat_id);
    r.style.cursor = 'pointer';
    const meta = document.createElement('div');
    meta.className = 'ui-list-meta';
    const t = document.createElement('div');
    t.className = 'ui-list-title';
    t.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    t.textContent = chat.name;
    const s = document.createElement('div');
    s.className = 'ui-list-sub';
    s.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    s.textContent = chat.last_msg ? truncateText(chat.last_msg, 40) : '';
    meta.appendChild(t);
    meta.appendChild(s);
    r.appendChild(meta);
    if (chat.unread > 0) {
      const b = ui.badge({ text: String(chat.unread), variant: 'danger' });
      b.classList.add('bot-unread');
      b.style.cssText = 'flex-shrink:0';
      r.appendChild(b);
    }
    r.addEventListener('click', () => void openChat(chat));
    return r;
  };

  // 打开会话:加载消息线程(清空后重建) + 贴底 + 标记已读 + 清空左侧未读徽章
  async function openChat(chat: ChatDto): Promise<void> {
    if (activeChat && activeChat.chat_id === chat.chat_id) return;
    activeChat = chat;
    rightTitle.textContent = chat.name;
    thread.innerHTML = '';
    thread.appendChild(ui.spinner());
    let msgs: MsgDto[] = [];
    try {
      msgs = await call<MsgDto[]>('bot_get_chat_msgs', { botId: bot.id, chatId: chat.chat_id });
    } catch (e) {
      thread.innerHTML = '';
      thread.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    thread.innerHTML = '';
    if (msgs.length === 0) {
      thread.appendChild(ui.empty('暂无消息，发送第一条吧'));
    } else {
      const htmls: string[] = [];
      for (const m of msgs) htmls.push(await renderMessage(m, 'solo'));
      thread.innerHTML = htmls.join('');
    }
    thread.scrollTop = thread.scrollHeight;
    // 标记已读(seen,失败忽略):打开会话即已读,并让对方看到已读回执
    try { await call('bot_mark_chat_seen', { botId: bot.id, chatId: chat.chat_id }); } catch { /* 忽略 */ }
    // 清空该会话未读徽章并高亮当前行
    const rowEl = convList.querySelector<HTMLElement>(`[data-chat-id="${chat.chat_id}"]`);
    if (rowEl) {
      rowEl.querySelector('.bot-unread')?.remove();
      convList.querySelectorAll('.ui-list-item.active').forEach((el) => el.classList.remove('active'));
      rowEl.classList.add('active');
    }
  }

  // 打字指示器显示/隐藏
  function showTyping(): void {
    typingEl.style.display = 'flex';
    thread.scrollTop = thread.scrollHeight;
  }
  function hideTyping(): void {
    typingEl.style.display = 'none';
  }

  // 实时刷新当前会话消息(保留滚动位置)
  async function reloadChat(): Promise<void> {
    if (!activeChat) return;
    let msgs: MsgDto[] = [];
    try {
      msgs = await call<MsgDto[]>('bot_get_chat_msgs', { botId: bot.id, chatId: activeChat.chat_id });
    } catch { return; }
    const scrollTop = thread.scrollTop;
    const scrollHeight = thread.scrollHeight;
    thread.innerHTML = '';
    if (msgs.length === 0) {
      thread.appendChild(ui.empty('暂无消息，发送第一条吧'));
    } else {
      const htmls: string[] = [];
      for (const m of msgs) htmls.push(await renderMessage(m, 'solo'));
      thread.innerHTML = htmls.join('');
    }
    // 若之前已贴底则继续贴底,否则保持相对位置
    if (scrollTop + (right.clientHeight || 0) >= scrollHeight - 40) {
      thread.scrollTop = thread.scrollHeight;
    }
  }

  // 注册实时事件:IncomingMsg 刷新当前线程;bot-activity 由模块级监听分发
  try {
    incomingUnlisten = await onEvent('IncomingMsg', (e) => {
      const cid = e.chat_id as number | undefined;
      if (cid != null && activeChat && cid === activeChat.chat_id) void reloadChat();
    });
  } catch { /* 忽略 */ }

  chatCtx = {
    botId: bot.id,
    activeChatId: () => activeChat?.chat_id ?? null,
    showTyping,
    hideTyping,
    reloadChat,
  };

  for (const chat of chats) {
    convList.appendChild(makeConvRow(chat));
  }
}

// ── Tab:LLM ────────────────────────────────────────────────────────

async function renderLlmTab(bot: BotDto, content: HTMLElement, getCfg: () => BotConfig | null, setCfg: (c: BotConfig | null) => void): Promise<void> {
  const providerSelect = ui.select({
    options: PROVIDERS,
    onChange: () => {},
  });
  const presetSelect = ui.select({
    options: LLM_PRESETS,
    onChange: (v) => {
      customRow.style.display = v === '__custom__' ? 'flex' : 'none';
    },
  });
  const customInput = ui.input({ placeholder: 'https://api.example.com/v1' });
  const customRow = document.createElement('div');
  customRow.style.cssText = 'display:none;gap:8px;align-items:center';
  const customRowLabel = document.createElement('span');
  customRowLabel.style.cssText = 'font-size:12px;color:var(--text-mute);white-space:nowrap';
  customRowLabel.textContent = '自定义';
  customRow.appendChild(customRowLabel);
  customRow.appendChild(customInput);

  const apiKeyInput = ui.input({ type: 'password', placeholder: 'sk-…' });
  const modelInput = ui.input({ placeholder: 'gpt-4o-mini' });

  // 温度滑条 0–2 step 0.1
  const tempRange = document.createElement('input');
  tempRange.type = 'range';
  tempRange.min = '0';
  tempRange.max = '2';
  tempRange.step = '0.1';
  tempRange.style.cssText = 'flex:1;accent-color:var(--primary)';
  const tempVal = document.createElement('span');
  tempVal.style.cssText = 'font-size:12px;color:var(--text-mute);width:40px;text-align:right';
  tempRange.addEventListener('input', () => { tempVal.textContent = tempRange.value; });
  const tempRow = document.createElement('div');
  tempRow.style.cssText = 'display:flex;align-items:center;gap:10px';
  tempRow.appendChild(tempRange);
  tempRow.appendChild(tempVal);

  const maxTokensInput = ui.input({ placeholder: '例如 4096' });
  const topPInput = ui.input({ placeholder: '例如 0.9' });
  const promptArea = ui.textarea({ placeholder: '你是一个乐于助人的助手…', rows: 4 });

  const testBtn = ui.button({ label: '测试连接', variant: 'ghost', onClick: () => void doTest() });
  const saveBtn = ui.button({ label: '保存', variant: 'primary', onClick: () => void doSave() });
  const testLabel = document.createElement('div');
  testLabel.style.cssText = 'font-size:12px;min-height:16px;word-break:break-all;color:var(--text-mute)';

  const body = scrollContent([
    ui.field({ label: 'Provider', children: providerSelect }),
    ui.field({ label: 'Base URL 预设', children: presetSelect }),
    ui.field({ label: '自定义 Base URL', children: customRow }),
    ui.field({ label: 'API Key', children: apiKeyInput }),
    ui.field({ label: '模型名', children: modelInput }),
    ui.field({ label: '温度', children: tempRow, help: '0–2,越高越有创造性' }),
    ui.field({ label: 'Max Tokens', children: maxTokensInput }),
    ui.field({ label: 'Top P', children: topPInput }),
    ui.field({ label: '系统提示词', children: promptArea }),
    testLabel,
    (() => { const a = document.createElement('div'); a.style.cssText = 'display:flex;gap:8px'; a.appendChild(testBtn); a.appendChild(saveBtn); return a; })(),
  ]);
  content.appendChild(body);

  // 预填已有配置
  const llm = getCfg()?.llm ?? null;
  if (llm) {
    const prov = PROVIDERS.find((p) => p.value === llm.provider);
    if (prov) providerSelect.value = prov.value;
    const preset = LLM_PRESETS.find((p) => p.value === llm.base_url);
    if (llm.base_url && preset) {
      presetSelect.value = preset.value;
      customRow.style.display = 'none';
    } else if (llm.base_url) {
      presetSelect.value = '__custom__';
      customInput.value = llm.base_url;
      customRow.style.display = 'flex';
    }
    apiKeyInput.value = llm.api_key || '';
    modelInput.value = llm.model || '';
    if (llm.temperature != null) {
      tempRange.value = String(llm.temperature);
      tempVal.textContent = String(llm.temperature);
    }
    if (llm.max_tokens != null) maxTokensInput.value = String(llm.max_tokens);
    if (llm.top_p != null) topPInput.value = String(llm.top_p);
    promptArea.value = llm.system_prompt || '';
  }

  function collectConfig(): LlmConfig {
    const llmCfg: LlmConfig = {
      provider: providerSelect.value,
      temperature: Number(tempRange.value),
    };
    const sp = promptArea.value.trim();
    llmCfg.system_prompt = sp || null;
    const baseUrl = presetSelect.value === '__custom__' ? customInput.value.trim() : presetSelect.value;
    llmCfg.base_url = baseUrl || null;
    const ak = apiKeyInput.value.trim();
    llmCfg.api_key = ak || null;
    const m = modelInput.value.trim();
    llmCfg.model = m || null;
    const mt = maxTokensInput.value.trim();
    llmCfg.max_tokens = mt ? Number(mt) : null;
    const tp = topPInput.value.trim();
    llmCfg.top_p = tp ? Number(tp) : null;
    return llmCfg;
  }

  async function doTest(): Promise<void> {
    testBtn.disabled = true;
    testLabel.textContent = '测试中…';
    testLabel.style.color = 'var(--text-mute)';
    try {
      const reply = await call<string>('test_llm_config', { config: collectConfig() });
      testLabel.textContent = `✓ 连接成功: ${reply.slice(0, 60)}`;
      testLabel.style.color = 'var(--success)';
    } catch (e) {
      testLabel.textContent = '✗ ' + (e instanceof Error ? e.message : String(e));
      testLabel.style.color = 'var(--danger)';
    } finally {
      testBtn.disabled = false;
    }
  }

  async function doSave(): Promise<void> {
    try {
      const current = getCfg() ?? {};
      const merged: BotConfig = { ...current, llm: { ...(current.llm ?? {}), ...collectConfig() } };
      await call('update_bot_config', { botId: bot.id, config: merged });
      setCfg(merged);
      ui.toast('配置已保存');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }
}

// ── Tab:规则 ───────────────────────────────────────────────────────

async function renderRuleTab(bot: BotDto, content: HTMLElement, getCfg: () => BotConfig | null, setCfg: (c: BotConfig | null) => void): Promise<void> {
  const existing = getCfg()?.rule ?? null;
  const rules: RuleDef[] = existing ? existing.rules.map((r) => ({ ...r, replies: [...r.replies] })) : [];
  let welcome = existing?.welcome ?? '';
  let fallback = existing?.fallback ?? '';

  const welcomeArea = ui.textarea({ placeholder: '首次对话时的欢迎语(留空则不启用)', rows: 2, value: welcome });
  welcomeArea.addEventListener('input', () => { welcome = welcomeArea.value; });
  const fallbackArea = ui.textarea({ placeholder: '未命中任何规则时的兜底回复(留空则不启用)', rows: 2, value: fallback });
  fallbackArea.addEventListener('input', () => { fallback = fallbackArea.value; });

  const rulesList = document.createElement('div');
  rulesList.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const saveBtn = ui.button({ label: '保存规则', variant: 'primary', onClick: () => void doSave() });
  const addBtn = ui.button({
    label: '添加规则',
    icon: 'plus',
    variant: 'ghost',
    onClick: () => {
      rules.push({ id: Date.now(), pattern: '', is_regex: false, replies: [], enabled: true });
      renderRules();
    },
  });

  const body = scrollContent([
    ui.field({ label: '欢迎语', children: welcomeArea }),
    ui.field({ label: '兜底回复', children: fallbackArea }),
    (() => { const a = document.createElement('div'); a.style.cssText = 'display:flex;gap:8px'; a.appendChild(addBtn); a.appendChild(saveBtn); return a; })(),
    rulesList,
  ]);
  content.appendChild(body);

  function renderRules(): void {
    rulesList.innerHTML = '';
    if (rules.length === 0) {
      rulesList.appendChild(ui.empty('暂无规则。添加关键词规则后，命中即自动回复。'));
      return;
    }
    for (const rule of rules) {
      rulesList.appendChild(buildRuleRow(rule));
    }
  }

  function buildRuleRow(rule: RuleDef): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--panel)';

    const patternRow = document.createElement('div');
    patternRow.style.cssText = 'display:flex;align-items:center;gap:8px';
    const patternInput = ui.input({ placeholder: '关键词或正则', value: rule.pattern });
    patternInput.addEventListener('input', () => { rule.pattern = patternInput.value; });
    patternRow.appendChild(patternInput);
    patternRow.appendChild(ui.checkbox({
      label: '正则',
      checked: rule.is_regex,
      onChange: (v) => { rule.is_regex = v; },
    }));
    patternRow.appendChild(ui.checkbox({
      label: '启用',
      checked: rule.enabled,
      onChange: (v) => { rule.enabled = v; },
    }));
    patternRow.appendChild(ui.iconButton({
      icon: 'trash',
      title: '删除规则',
      danger: true,
      size: 'sm',
      onClick: () => {
        const idx = rules.indexOf(rule);
        if (idx >= 0) rules.splice(idx, 1);
        renderRules();
      },
    }));
    card.appendChild(patternRow);

    const repliesArea = ui.textarea({
      placeholder: '回复内容(每行一条，随机取一条)',
      rows: 2,
      value: rule.replies.join('\n'),
    });
    repliesArea.addEventListener('input', () => {
      rule.replies = repliesArea.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    });
    card.appendChild(repliesArea);
    return card;
  }

  async function doSave(): Promise<void> {
    try {
      const current = getCfg() ?? {};
      const merged: BotConfig = {
        ...current,
        rule: {
          rules,
          welcome: welcome.trim() || null,
          fallback: fallback.trim() || null,
        },
      };
      await call('update_bot_config', { botId: bot.id, config: merged });
      setCfg(merged);
      ui.toast('规则已保存');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }

  renderRules();
}

// ── Tab:定时 ───────────────────────────────────────────────────────

async function renderScheduleTab(bot: BotDto, content: HTMLElement): Promise<void> {
  let chats: ChatDto[] = [];
  try {
    chats = await call<ChatDto[]>('bot_get_chatlist', { botId: bot.id });
  } catch { /* 忽略 */ }

  const chatSelect = ui.select({
    options: chats.length ? chats.map((c) => ({ value: String(c.chat_id), label: c.name })) : [{ value: '', label: '暂无会话' }],
  });
  const minuteInput = ui.input({ placeholder: '0-59,留空=任意(-1)' });
  const hourInput = ui.input({ placeholder: '0-23,留空=任意(-1)' });
  const dowInput = ui.input({ placeholder: '0-6,0=周日,留空=任意(-1)' });
  const messageInput = ui.input({ placeholder: '要定时发送的内容' });

  const addBtn = ui.button({
    label: '添加定时',
    icon: 'plus',
    variant: 'primary',
    disabled: chats.length === 0,
    onClick: () => void doAdd(),
  });
  const timeRow = document.createElement('div');
  timeRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px';
  timeRow.appendChild(minuteInput);
  timeRow.appendChild(hourInput);
  timeRow.appendChild(dowInput);

  const schedulesList = document.createElement('div');
  schedulesList.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const body = scrollContent([
    ui.field({ label: '发送到会话', children: chatSelect }),
    ui.field({ label: '时间(分钟 / 小时 / 星期)', children: timeRow, help: '留空或 -1 表示任意;dayOfWeek 0=周日' }),
    ui.field({ label: '消息内容', children: messageInput }),
    addBtn,
    (() => { const t = document.createElement('div'); t.style.cssText = 'font-size:13px;font-weight:600'; t.textContent = '已设定时'; return t; })(),
    schedulesList,
  ]);
  content.appendChild(body);

  async function doAdd(): Promise<void> {
    if (chats.length === 0) {
      ui.toast('该 Bot 还没有会话');
      return;
    }
    const chatId = Number(chatSelect.value);
    const toInt = (s: string): number => {
      const n = Number(s);
      return s.trim() === '' || !Number.isFinite(n) ? -1 : Math.trunc(n);
    };
    const msg = messageInput.value.trim();
    if (!msg) {
      ui.toast('请输入消息内容');
      return;
    }
    try {
      await call('bot_add_schedule', {
        botId: bot.id,
        chatId,
        minute: toInt(minuteInput.value),
        hour: toInt(hourInput.value),
        dayOfWeek: toInt(dowInput.value),
        message: msg,
      });
      messageInput.value = '';
      ui.toast('定时已添加');
      await loadSchedules();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadSchedules(): Promise<void> {
    schedulesList.innerHTML = '';
    let schedules: ScheduleDto[] = [];
    try {
      schedules = await call<ScheduleDto[]>('bot_list_schedules', { botId: bot.id });
    } catch (e) {
      schedulesList.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (schedules.length === 0) {
      schedulesList.appendChild(ui.empty('暂无定时任务'));
      return;
    }
    for (const s of schedules) {
      const row = document.createElement('div');
      row.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;align-items:center;gap:10px;background:var(--panel)';
      const meta = document.createElement('div');
      meta.style.cssText = 'flex:1;min-width:0';
      const mTitle = document.createElement('div');
      mTitle.style.cssText = 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      mTitle.textContent = s.message;
      const mSub = document.createElement('div');
      mSub.style.cssText = 'font-size:12px;color:var(--text-mute)';
      mSub.textContent = `下次: ${new Date(s.next_run_at * 1000).toLocaleString()} · ${cronLabel(s.minute, s.hour, s.day_of_week)}`;
      meta.appendChild(mTitle);
      meta.appendChild(mSub);
      row.appendChild(meta);
      if (!s.enabled) row.appendChild(ui.badge({ text: '已停用', variant: 'muted' }));
      row.appendChild(ui.iconButton({
        icon: 'trash',
        title: '删除定时',
        danger: true,
        size: 'sm',
        onClick: async () => {
          try {
            await call('bot_delete_schedule', { scheduleId: s.id });
            ui.toast('已删除');
            await loadSchedules();
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e));
          }
        },
      }));
      schedulesList.appendChild(row);
    }
  }

  await loadSchedules();
}

function cronLabel(minute: number, hour: number, dow: number): string {
  const m = minute < 0 ? '*' : String(minute);
  const h = hour < 0 ? '*' : String(hour);
  const d = dow < 0 ? '*' : `周${['日', '一', '二', '三', '四', '五', '六'][dow] ?? dow}`;
  return `${m}:${h} ${d}`;
}

// ── Tab:工具 ───────────────────────────────────────────────────────

async function renderToolsTab(bot: BotDto, content: HTMLElement, getCfg: () => BotConfig | null, setCfg: (c: BotConfig | null) => void): Promise<void> {
  let tools: BotToolDto[] = [];
  try {
    tools = await call<BotToolDto[]>('list_bot_tools');
  } catch (e) {
    content.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }

  // 生效集合:null → 默认安全集;显式列表 → 该集合
  const defaultSafe = tools.filter((t) => t.safe).map((t) => t.name);
  const explicit = getCfg()?.tools ?? null;
  const enabledSet = new Set(explicit ?? defaultSafe);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const saveBtn = ui.button({
    label: '保存工具设置',
    variant: 'primary',
    onClick: async () => {
      try {
        const current = getCfg() ?? {};
        const isDefault = defaultSafe.length === enabledSet.size && defaultSafe.every((n) => enabledSet.has(n));
        const merged: BotConfig = { ...current, tools: isDefault ? null : [...enabledSet] };
        await call('update_bot_config', { botId: bot.id, config: merged });
        setCfg(merged);
        ui.toast('工具设置已保存');
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:12px;color:var(--text-mute)';
  hint.textContent = '安全工具默认开放;启用不安全工具或关闭安全工具会生成显式工具清单。';

  const body = scrollContent([
    hint,
    (() => { const a = document.createElement('div'); a.style.cssText = 'display:flex;gap:8px'; a.appendChild(saveBtn); return a; })(),
    list,
  ]);
  content.appendChild(body);

  if (tools.length === 0) {
    list.appendChild(ui.empty('暂无可用工具'));
    return;
  }

  for (const t of tools) {
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;align-items:center;gap:10px;background:var(--panel)';
    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0';
    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:8px';
    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:13px;font-weight:600;font-family:monospace';
    nameEl.textContent = t.name;
    nameRow.appendChild(nameEl);
    nameRow.appendChild(ui.badge({
      text: t.safe ? '默认开放' : '需显式启用',
      variant: t.safe ? 'success' : 'muted',
    }));
    const descEl = document.createElement('div');
    descEl.style.cssText = 'font-size:12px;color:var(--text-mute)';
    descEl.textContent = t.description;
    meta.appendChild(nameRow);
    meta.appendChild(descEl);
    row.appendChild(meta);
    row.appendChild(ui.switch_({
      checked: enabledSet.has(t.name),
      onChange: (v) => {
        if (v) enabledSet.add(t.name);
        else enabledSet.delete(t.name);
      },
    }));
    list.appendChild(row);
  }
}

// ── Tab:时间线 ─────────────────────────────────────────────────────

async function renderTimelineTab(bot: BotDto, content: HTMLElement): Promise<void> {
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:16px;max-width:760px';
  content.appendChild(list);

  let activities: BotActivityDto[] = [];
  try {
    activities = await call<BotActivityDto[]>('list_bot_activities', { botId: bot.id, limit: 100 });
  } catch (e) {
    list.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  // 后端倒序返回,展示时正序(旧 → 新)
  activities = [...activities].reverse();

  if (activities.length === 0) {
    list.appendChild(ui.empty('暂无活动记录'));
  } else {
    for (const a of activities) list.appendChild(renderActivityItem(a));
  }
  content.scrollTop = content.scrollHeight;

  // 实时追加
  timelineCtx = {
    botId: bot.id,
    append: (a) => {
      list.appendChild(renderActivityItem(a));
      content.scrollTop = content.scrollHeight;
    },
  };
}

function renderActivityItem(a: BotActivityDto): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;align-items:flex-start;gap:10px;background:var(--panel)';
  const time = document.createElement('div');
  time.style.cssText = 'font-size:11px;color:var(--text-mute);white-space:nowrap;padding-top:2px';
  time.textContent = new Date(a.created_at * 1000).toLocaleString();
  row.appendChild(time);
  row.appendChild(ui.badge({ text: KIND_LABELS[a.kind] ?? a.kind, variant: kindVariant(a.kind) }));
  const summary = document.createElement('div');
  summary.style.cssText = 'flex:1;min-width:0;font-size:13px;word-break:break-word';
  summary.textContent = a.summary || '—';
  row.appendChild(summary);
  return row;
}

// ── Tab:统计 ───────────────────────────────────────────────────────

async function renderStatsTab(bot: BotDto, content: HTMLElement): Promise<void> {
  let stats: BotStatsDto | null = null;
  try {
    stats = await call<BotStatsDto>('get_bot_stats', { botId: bot.id });
  } catch (e) {
    content.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  const items: Array<{ label: string; value: string }> = [
    { label: '总活动', value: String(stats.total_activities) },
    { label: '自动回复', value: String(stats.reply_sent) },
    { label: '规则回复', value: String(stats.rule_reply) },
    { label: '定时消息', value: String(stats.schedule_sent) },
    { label: '工具调用', value: String(stats.tool_called) },
    { label: 'LLM 错误', value: String(stats.llm_error) },
    { label: '被限流', value: String(stats.rate_limited) },
    { label: '最近活动', value: stats.last_activity_at ? new Date(stats.last_activity_at * 1000).toLocaleString() : '—' },
  ];
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:16px;max-width:760px';
  for (const it of items) {
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:14px;background:var(--panel);display:flex;flex-direction:column;gap:4px';
    const val = document.createElement('div');
    val.style.cssText = 'font-size:22px;font-weight:700';
    val.textContent = it.value;
    const lab = document.createElement('div');
    lab.style.cssText = 'font-size:12px;color:var(--text-mute)';
    lab.textContent = it.label;
    card.appendChild(val);
    card.appendChild(lab);
    grid.appendChild(card);
  }
  content.appendChild(grid);
}

// ── 新建 / 引导 / 通用工具 ─────────────────────────────────────────

// 新建 Bot:输入显示名 → 创建 → 引导对话框(说明怎么用 + 去配置/打开对话)
function onCreateBot(main: HTMLElement): void {
  ui.inputDialog({
    title: '新建 Bot',
    placeholder: 'Bot 显示名',
    confirmLabel: '创建',
    onConfirm: async (displayName) => {
      const bot = await call<BotDto>('create_bot', { displayName });
      showCreateGuide(bot, main);
    },
  });
}

// 创建成功引导:展示 Bot 邮箱 + 使用说明,提供「配置 LLM」「打开对话」入口
function showCreateGuide(bot: BotDto, main: HTMLElement): void {
  const email = bot.addr || '';
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  body.innerHTML = `
    <div style="font-size:13px;color:var(--text-mute);line-height:1.6">
      已创建 <b>${escapeHtml(bot.display_name)}</b>。<br>
      Bot 邮箱: <b>${escapeHtml(email)}</b><br>
      把邮箱发给任何人即可对话，Bot 会用 AI 自动回复。
      配置 LLM 后自动回复才会生效。
    </div>
  `;
  const copyBtn = ui.button({ label: '复制邮箱', variant: 'ghost', size: 'sm', onClick: () => void copyText(email) });
  body.appendChild(copyBtn);

  const configBtn = ui.button({
    label: '配置 LLM',
    variant: 'primary',
    onClick: () => { dlg?.close(); void renderBotDetail(bot, main, 'llm'); },
  });
  const chatBtn = ui.button({
    label: '打开对话',
    variant: 'ghost',
    onClick: () => { dlg?.close(); void renderBotDetail(bot, main, 'chat'); },
  });
  let dlg: ReturnType<typeof ui.dialog> | null = null;
  dlg = ui.dialog({
    title: 'Bot 已创建',
    actions: [chatBtn, configBtn],
  });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(body, actionsEl);
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ui.toast('已复制');
  } catch {
    ui.toast('复制失败');
  }
}

// 把 bot 拉入主账号的某个群聊/频道:选主账号的群组会话 → add_bot_to_chat
async function openAddBotToChat(bot: BotDto): Promise<void> {
  let chats: Array<{ chat_id: number; name: string }>;
  try {
    const all = await call<Array<{ chat_id: number; name: string; is_group: boolean }>>('get_chatlist');
    chats = all.filter((c) => c.is_group);
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
    return;
  }
  if (chats.length === 0) {
    ui.toast('还没有群聊或频道');
    return;
  }
  const list = document.createElement('div');
  list.style.cssText = 'max-height:320px;overflow-y:auto;display:flex;flex-direction:column';
  for (const c of chats) {
    list.appendChild(ui.listItem({
      title: c.name,
      onClick: async () => {
        dlg?.close();
        try {
          await call('add_bot_to_chat', { botId: bot.id, chatId: c.chat_id });
          ui.toast(`已把 ${bot.display_name} 加入「${c.name}」`);
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        }
      },
    }));
  }
  let dlg: ReturnType<typeof ui.dialog> | null = null;
  dlg = ui.dialog({
    title: `把 ${bot.display_name} 拉入群聊`,
    body: '',
    actions: [],
  });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(list, actionsEl);
}

// 截断长文本(超长加省略号)
function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
