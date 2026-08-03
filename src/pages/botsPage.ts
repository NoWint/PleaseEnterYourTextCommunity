import { call } from '../api.js';
import { ui } from '../components/ui.js';
import { iconSvg } from '../components/icon.js';
import { renderMessage } from '../chat/message.js';
import type { MsgDto } from '../types.js';

// Bot 管理页:列出所有 Bot 账号,支持新建、LLM 配置、启停、删除、会话查看。
// 后端命令:list_bots / create_bot / delete_bot / set_bot_io / update_bot_llm / get_bot_llm /
// bot_get_chatlist / bot_get_chat_msgs / bot_send_text / bot_mark_chat_noticed。

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

export interface LlmConfigInput {
  system_prompt?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
  provider?: string | null;
}

// Base URL 预设:value 即完整 URL,`__custom__` 表示自定义地址
const LLM_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'https://api.openai.com/v1', label: 'OpenAI' },
  { value: 'https://api.deepseek.com', label: 'DeepSeek' },
  { value: 'http://localhost:11434/v1', label: 'Ollama' },
  { value: '__custom__', label: '自定义' },
];

export async function renderBots(main: HTMLElement): Promise<void> {
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
    main.appendChild(ui.empty('还没有 Bot，点击右上角新建'));
    return;
  }

  // 并行探测每个 Bot 的 LLM 配置,用于「已配 LLM」徽章
  const rows = await Promise.all(
    bots.map(async (bot): Promise<{ bot: BotDto; cfg: LlmConfigInput | null }> => {
      try {
        return { bot, cfg: await call<LlmConfigInput | null>('get_bot_llm', { botId: bot.id }) };
      } catch {
        return { bot, cfg: null };
      }
    })
  );

  const list = document.createElement('div');
  for (const row of rows) {
    list.appendChild(renderBotRow(row.bot, row.cfg, () => void renderBots(main), main));
  }
  main.appendChild(list);
}

// 单行:头像 + 名称/地址 + 状态徽章 + 右侧操作(配置 / 启停 / 删除)。
// 点击整行进入该 Bot 的会话双栏视图。
function renderBotRow(bot: BotDto, cfg: LlmConfigInput | null, onChanged: () => void, main: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ui-list-item';
  row.style.cursor = 'pointer';
  row.title = '查看会话';
  row.addEventListener('click', () => void openBotChats(bot, main));

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

  // 徽章区:运行状态 + 已配 LLM
  const badges = document.createElement('div');
  badges.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0';
  badges.appendChild(ui.badge({
    text: bot.io_running ? '运行中' : '已停止',
    variant: bot.io_running ? 'success' : 'muted',
  }));
  if (isLlmConfigured(cfg)) badges.appendChild(ui.badge({ text: '已配 LLM', variant: 'success' }));
  row.appendChild(badges);

  // 右侧操作
  const ops = document.createElement('div');
  ops.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';
  // 阻止操作按钮点击冒泡到行级「查看会话」
  ops.addEventListener('click', (e) => e.stopPropagation());
  ops.appendChild(ui.iconButton({
    icon: 'settings',
    title: '配置',
    size: 'sm',
    onClick: () => openLlmConfig(bot, onChanged),
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
function isLlmConfigured(cfg: LlmConfigInput | null): boolean {
  return !!cfg && !!cfg.base_url && !!cfg.api_key && !!cfg.model;
}

// 新建 Bot:输入显示名 → 创建 → 自动打开 LLM 配置
function onCreateBot(main: HTMLElement): void {
  ui.inputDialog({
    title: '新建 Bot',
    placeholder: 'Bot 显示名',
    confirmLabel: '创建',
    onConfirm: async (displayName) => {
      const bot = await call<BotDto>('create_bot', { displayName });
      ui.toast('Bot 已创建');
      openLlmConfig(bot, () => void renderBots(main));
    },
  });
}

// 配置对话框:Base URL 预设/自定义 + 系统提示词 + API Key + 模型名。
// 关闭(保存/取消)时统一回调 onSaved,调用方负责重渲染列表。
function openLlmConfig(bot: BotDto, onSaved: () => void): void {
  const presetSelect = ui.select({
    options: LLM_PRESETS,
    value: LLM_PRESETS[0].value,
    onChange: (v) => {
      customRow.style.display = v === '__custom__' ? 'block' : 'none';
    },
  });
  const customInput = ui.input({ placeholder: 'https://api.example.com/v1' });
  const customRow = document.createElement('div');
  customRow.style.cssText = 'display:none';
  customRow.appendChild(customInput);

  const promptArea = ui.textarea({ placeholder: '你是一个乐于助人的助手…', rows: 4 });
  const keyInput = ui.input({ type: 'password', placeholder: 'sk-…' });
  const modelInput = ui.input({ placeholder: 'gpt-4o-mini' });

  const body = document.createElement('div');
  body.className = 'ui-dialog-body';
  body.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  body.appendChild(ui.field({ label: 'Base URL 预设', children: presetSelect }));
  body.appendChild(ui.field({ label: '自定义 Base URL', children: customRow }));
  body.appendChild(ui.field({ label: '系统提示词', children: promptArea }));
  body.appendChild(ui.field({ label: 'API Key', children: keyInput }));
  body.appendChild(ui.field({ label: '模型名', children: modelInput }));

  const cancel = ui.button({ label: '取消', variant: 'ghost', onClick: () => dlg?.close() });
  const save = ui.button({
    label: '保存',
    variant: 'primary',
    onClick: async () => {
      try {
        const config: LlmConfigInput = {};
        const sp = promptArea.value.trim();
        if (sp) config.system_prompt = sp;
        const baseUrl = presetSelect.value === '__custom__' ? customInput.value.trim() : presetSelect.value;
        if (baseUrl) config.base_url = baseUrl;
        const ak = keyInput.value.trim();
        if (ak) config.api_key = ak;
        const m = modelInput.value.trim();
        if (m) config.model = m;
        await call('update_bot_llm', { botId: bot.id, config });
        ui.toast('配置已保存');
        dlg?.close();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });

  let dlg: ReturnType<typeof ui.dialog> | null = null;
  dlg = ui.dialog({
    title: `配置 Bot · ${bot.display_name}`,
    actions: [cancel, save],
    onClose: onSaved,
  });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(body, actionsEl);

  // 预填已存的 LLM 配置
  void (async () => {
    let cfg: LlmConfigInput | null = null;
    try {
      cfg = await call<LlmConfigInput | null>('get_bot_llm', { botId: bot.id });
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!cfg) return;
    const preset = LLM_PRESETS.find((p) => p.value === cfg.base_url);
    if (cfg.base_url && preset) {
      presetSelect.value = preset.value;
      customRow.style.display = 'none';
    } else if (cfg.base_url) {
      presetSelect.value = '__custom__';
      customInput.value = cfg.base_url;
      customRow.style.display = 'block';
    }
    promptArea.value = cfg.system_prompt || '';
    keyInput.value = cfg.api_key || '';
    modelInput.value = cfg.model || '';
  })();
}

// 截断长文本(超长加省略号)
function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Bot 会话双栏视图:左栏 = 返回 + Bot 信息 + 会话列表(固定 260px),
// 右栏 = 会话头部 + 消息线程 + 单行发送框。替换 main 内的列表内容。
export async function openBotChats(bot: BotDto, main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const pane = document.createElement('div');
  pane.style.cssText = 'flex:1;min-height:0;display:flex;overflow:hidden';
  main.appendChild(pane);

  // ── 左栏:返回按钮 + Bot 信息 + 会话列表 ──
  const left = document.createElement('div');
  left.style.cssText = 'width:260px;flex-shrink:0;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--border);background:var(--panel)';
  pane.appendChild(left);

  const leftHead = document.createElement('div');
  leftHead.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px;border-bottom:1px solid var(--border);flex-shrink:0';
  leftHead.appendChild(ui.button({
    label: '返回列表',
    icon: 'chevron-left',
    variant: 'ghost',
    size: 'sm',
    onClick: () => void renderBots(main),
  }));
  const info = document.createElement('div');
  info.style.cssText = 'min-width:0';
  const nameEl = document.createElement('div');
  nameEl.className = 'main-title';
  nameEl.style.cssText = 'font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  nameEl.textContent = bot.display_name;
  const addrEl = document.createElement('div');
  addrEl.className = 'main-subtitle';
  addrEl.style.cssText = 'font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
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

  // ── 右栏:会话头部 + 消息线程 + 发送框 ──
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
  thread.style.cssText = 'flex:1;min-height:0';
  right.appendChild(thread);
  thread.appendChild(ui.empty('从左侧选择一个会话'));

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

  // 发送按钮状态:空内容 / 发送中 均禁用
  function updateSendBtn(): void {
    sendBtn.disabled = sending || inputEl.value.trim().length === 0;
  }

  // 发送文本:成功后把返回的 MsgDto 追加为气泡
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
    // 标记已读(失败忽略)
    try { await call('bot_mark_chat_noticed', { botId: bot.id, chatId: chat.chat_id }); } catch {}
    // 清空该会话未读徽章并高亮当前行
    const rowEl = convList.querySelector<HTMLElement>(`[data-chat-id="${chat.chat_id}"]`);
    if (rowEl) {
      rowEl.querySelector('.bot-unread')?.remove();
      convList.querySelectorAll('.ui-list-item.active').forEach((el) => el.classList.remove('active'));
      rowEl.classList.add('active');
    }
  }

  for (const chat of chats) {
    convList.appendChild(makeConvRow(chat));
  }
}
