import { call, onEvent, type DcEvent } from '../api.js';
import { ui } from '../components/ui.js';
import { iconSvg, type IconName } from '../components/icon.js';
import { escapeHtml } from '../components/escape.js';
import { state } from '../state.js';
import { saveState } from '../persist.js';
import type { IntelligenceTab } from '../types.js';

// 智能中心聚合页:知识库 / 主题总结 / 自动总结配置 / 智能设置 四 Tab。
// 布局复用 GitHubPage 范式:玻璃工具栏(main-header)+ Tab 条(gh-editor-tabs)+ 内容区;
// Tab id 存 state.intelligenceTab + saveState();内容渲染用 contentRenderToken 防竞态。
//
// 命令契约(与 src-tauri 侧 commands.rs 对应;入参经 Tauri 自动 camelCase,响应为 snake_case):
//   list_knowledge({ chatId?, tag?, keyword?, page?, pageSize? }) -> KnowledgeDto[]
//   get_knowledge({ id }) -> KnowledgeDto
//   delete_knowledge({ id }) -> ()
//   update_knowledge({ id, title?, summary?, tags? }) -> KnowledgeDto
//   summarize_store_now({ chatId, count? }) -> KnowledgeDto
//   list_knowledge_config() -> KnowledgeConfigDto[]
//   set_knowledge_config({ chatId, dailyEnabled, dailyTime, windowCount, autoStore }) -> KnowledgeConfigDto
//   get_intelligence_settings() -> IntelligenceSettingsDto
//   set_intelligence_settings({ mode, source, modelTier, windowN, baseUrl?, apiKey?, model? }) -> ()
//   get_llm_model_status() -> ModelStatusDto
//   start_engine_download({ which: 'engine'|'model' }) -> ()
//   test_llm_config({ config: { base_url?, api_key?, model? } }) -> string (已有命令)
// 事件:download-progress { id: 'engine'|'model', bytesDone, total, rate }

// ── 后端 DTO(与 src-tauri/src/dto.rs 对应,snake_case 响应)────
interface KnowledgeDto {
  id: number;
  chat_id: number;
  chat_name: string;
  date: string;
  title: string;
  summary: string;
  tags: string[];
  msg_count: number;
  source: string;
  created_at: number;
  updated_at: number;
}
interface KnowledgeConfigDto {
  chat_id: number;
  chat_name: string;
  daily_enabled: boolean;
  daily_time: string;
  window_count: number;
  auto_store: boolean;
}
interface IntelligenceSettingsDto {
  mode: string;
  source: string;
  model_tier: string;
  window_n: number;
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
}
interface ModelStatusDto {
  mode: string;
  source: string;
  engine_ready: boolean;
  model_ready: boolean;
  engine_path?: string;
  model_path?: string;
  engine_version?: string;
  model_sha256?: string;
}

// ── 模块级共享状态(renderIntelligenceNav 与 renderIntelligenceMain 共用) ──
// 侧边栏刷新按钮 → 重渲染主区当前 Tab
let mainRefresher: (() => void) | null = null;
// 智能设置 Tab 注册的 download-progress 监听(离开/重渲染时注销)
let settingsUnlisten: (() => void) | null = null;

const IG_TABS: Array<{ id: IntelligenceTab; label: string; icon: IconName }> = [
  { id: 'knowledge', label: '知识库', icon: 'book-open' },
  { id: 'summary', label: '主题总结', icon: 'message-circle' },
  { id: 'config', label: '自动总结配置', icon: 'settings' },
  { id: 'settings', label: '智能设置', icon: 'sparkles' },
];

// ── 侧边栏:标题 + 刷新入口 ──────────────────────────────────────────────
export async function renderIntelligenceNav(panel: HTMLElement): Promise<void> {
  panel.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'nav-header';
  const titleBox = document.createElement('div');
  titleBox.innerHTML = `<div class="nav-title">智能中心</div><div class="nav-subtitle">知识沉淀 · 主题总结 · 模型配置</div>`;
  const headerActions = document.createElement('div');
  headerActions.className = 'nav-header-actions';
  const refreshBtn = ui.iconButton({
    icon: 'refresh-cw', title: '刷新', size: 'sm',
    onClick: () => mainRefresher?.(),
  });
  headerActions.appendChild(refreshBtn);
  header.append(titleBox, headerActions);
  panel.appendChild(header);

  const hint = document.createElement('div');
  hint.style.cssText = 'padding:10px 12px;font-size:var(--font-scale-micro);color:var(--text-faint);line-height:1.7';
  hint.textContent = '知识库 · 主题总结 · 自动总结配置 · 智能设置';
  panel.appendChild(hint);
}

// ── 主编辑区:玻璃工具条 + Tab 条 + 内容区(VSCode 式,同 GitHubPage) ──────
export async function renderIntelligenceMain(main: HTMLElement): Promise<void> {
  main.innerHTML = '';
  const root = document.createElement('div');
  root.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';
  main.appendChild(root);

  // 玻璃工具条(复用 .main-header 玻璃材质)
  const header = document.createElement('div');
  header.className = 'main-header';
  header.style.cssText = [
    'flex-shrink:0',
    'position:sticky;top:0;z-index:10',
    'background:color-mix(in srgb, var(--panel) 86%, transparent)',
    '-webkit-backdrop-filter:blur(18px) saturate(150%)',
    'backdrop-filter:blur(18px) saturate(150%)',
    'box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 40%, transparent)',
  ].join(';');
  const titleBox = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'main-title';
  t.textContent = '智能中心';
  const s = document.createElement('div');
  s.className = 'main-subtitle';
  s.textContent = '知识库 · 主题总结 · 自动总结配置 · 智能设置';
  titleBox.append(t, s);
  const refreshBtn = ui.iconButton({ icon: 'refresh-cw', title: '刷新', onClick: () => void renderEditorContent() });
  const actions = document.createElement('div');
  actions.className = 'main-actions';
  actions.appendChild(refreshBtn);
  header.append(titleBox, actions);
  root.appendChild(header);

  // Tab 条(gh-editor-tabs:紧凑堆叠,active 下划线高亮)
  const tabsEl = document.createElement('div');
  tabsEl.className = 'gh-editor-tabs';
  const tabEls = IG_TABS.map((tab) => {
    const b = document.createElement('button');
    b.className = 'gh-editor-tab';
    b.dataset.tab = tab.id;
    b.title = tab.label;
    b.innerHTML = `${iconSvg(tab.icon, { width: 14, height: 14 })}<span>${tab.label}</span>`;
    b.addEventListener('click', () => {
      if (state.intelligenceTab === tab.id) return;
      state.intelligenceTab = tab.id;
      saveState();
      syncTabActive();
      void renderEditorContent();
    });
    return b;
  });
  for (const b of tabEls) tabsEl.appendChild(b);
  root.appendChild(tabsEl);

  // 内容区(每次渲染独立 wrap:旧异步结果写旧 DOM,避免跨 Tab 竞态覆盖)
  const content = document.createElement('div');
  content.style.cssText = 'flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column';
  root.appendChild(content);

  function syncTabActive(): void {
    for (const b of tabEls) b.classList.toggle('active', b.dataset.tab === state.intelligenceTab);
  }

  let contentRenderToken = 0;
  async function renderEditorContent(): Promise<void> {
    const token = ++contentRenderToken;
    content.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
    content.appendChild(wrap);
    wrap.appendChild(ui.spinner());
    try {
      if (state.intelligenceTab === 'knowledge') await renderKnowledgeTab(wrap);
      else if (state.intelligenceTab === 'summary') await renderSummaryTab(wrap);
      else if (state.intelligenceTab === 'config') await renderConfigTab(wrap);
      else await renderSettingsTab(wrap);
    } catch (e) {
      if (token !== contentRenderToken) return;
      wrap.innerHTML = '';
      wrap.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    }
  }

  mainRefresher = () => { void renderEditorContent(); };

  // 初始化 + right-drawer 对智能中心禁用(同 githubPage)
  syncTabActive();
  await renderEditorContent();
  const hadDrawer = state.detailPanelOpen || state.rightDrawerOpen;
  state.detailTab = 'members';
  state.detailPanelOpen = false;
  state.rightDrawerOpen = false;
  if (hadDrawer) {
    saveState();
    void import('../shell/rightDrawer.js').then(({ renderRightDrawer }) => renderRightDrawer());
  }
}

// ── Tab1 知识库 ────────────────────────────────────────────────────────
async function renderKnowledgeTab(body: HTMLElement): Promise<void> {
  let all: KnowledgeDto[] = [];
  try {
    all = await call<KnowledgeDto[]>('list_knowledge', { page: 1, pageSize: 200 });
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  body.innerHTML = '';

  // 会话列表(从条目提取 chatId/chatName 去重;无条目不显示总结入口)
  const chats = new Map<number, string>();
  for (const k of all) {
    if (!chats.has(k.chat_id)) chats.set(k.chat_id, k.chat_name || `会话 #${k.chat_id}`);
  }
  const chatOptions = [...chats.entries()].map(([id, name]) => ({ value: String(id), label: name }));

  // 工具条:会话过滤 + 标签过滤 + 搜索 + 刷新
  let chatId = 0;
  let tagFilter = '';
  let keyword = '';
  const chatSelect = ui.select({
    options: [{ value: '0', label: '全部会话' }, ...chatOptions],
    value: '0',
    onChange: (v) => { chatId = Number(v); renderList(); },
  });
  const tagInput = ui.input({ placeholder: '标签过滤', onChange: (v) => { tagFilter = v.trim(); renderList(); } });
  tagInput.style.width = '130px';
  const kwInput = ui.input({ placeholder: '搜索标题/摘要', onChange: (v) => { keyword = v.trim(); renderList(); } });
  kwInput.style.width = '150px';
  const refreshBtn = ui.iconButton({ icon: 'refresh-cw', title: '刷新', onClick: () => void renderKnowledgeTab(body) });
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:12px 12px 0;flex-wrap:wrap';
  toolbar.append(chatSelect, tagInput, kwInput, refreshBtn);
  body.appendChild(toolbar);

  // 「总结本会话入库」卡片
  if (chatOptions.length > 0) {
    const sumCard = ui.card({
      title: '总结本会话入库',
      children: (() => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        const sumChatSelect = ui.select({ options: chatOptions, value: String(chatOptions[0].value) });
        const countInput = ui.input({ type: 'number', value: '30', placeholder: '条数' });
        countInput.style.width = '80px';
        const sumBtn = ui.button({
          label: '立即总结入库', icon: 'download', size: 'sm', variant: 'primary',
          onClick: async () => {
            const cid = Number(sumChatSelect.value);
            if (!cid) { ui.toast('请先选择会话'); return; }
            const n = Math.max(1, Math.min(200, Number(countInput.value) || 30));
            sumBtn.disabled = true;
            try {
              const k = await call<KnowledgeDto>('summarize_store_now', { chatId: cid, count: n });
              ui.toast(`已入库:${k.title}`);
              void renderKnowledgeTab(body);
            } catch (e) {
              ui.toast(e instanceof Error ? e.message : String(e));
            } finally {
              sumBtn.disabled = false;
            }
          },
        });
        row.append(sumChatSelect, countInput, sumBtn);
        return row;
      })(),
    });
    body.appendChild(sumCard);
  }

  // 列表区(可滚动)
  const list = document.createElement('div');
  list.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:10px 12px 16px;display:flex;flex-direction:column;gap:8px';
  body.appendChild(list);

  function filtered(): KnowledgeDto[] {
    return all.filter((k) => {
      if (chatId && k.chat_id !== chatId) return false;
      if (tagFilter && !(k.tags || []).some((t) => t.includes(tagFilter))) return false;
      if (keyword) {
        const kw = keyword.toLowerCase();
        if (!k.title.toLowerCase().includes(kw) && !k.summary.toLowerCase().includes(kw)) return false;
      }
      return true;
    });
  }

  function renderList(): void {
    list.innerHTML = '';
    const items = filtered();
    if (items.length === 0) {
      list.appendChild(ui.empty(all.length === 0 ? '暂无知识条目,可用「总结本会话入库」或聊天中 /summarize 存入' : '无匹配条目'));
      return;
    }
    for (const k of items) list.appendChild(renderCard(k));
  }

  function renderCard(k: KnowledgeDto): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ui-card';
    card.style.cssText = 'cursor:pointer;transition:box-shadow .15s;flex-shrink:0';
    const tags = (k.tags || []).length
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${(k.tags || []).map((t) => `<span class="ui-chip" style="cursor:default">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const srcLabel = k.source === 'daily' ? '每日自动' : '手动';
    card.innerHTML = `
      <div class="ui-card-head">
        <span class="ui-card-title">${escapeHtml(k.title)}</span>
        <span style="display:flex;gap:6px;align-items:center;flex-shrink:0">
          <span class="ui-badge${k.source === 'daily' ? ' ui-badge-success' : ''}">${escapeHtml(srcLabel)}</span>
          <span class="ui-badge ui-badge-muted">${k.msg_count} 条</span>
        </span>
      </div>
      <div class="ui-card-body">
        <div style="font-size:var(--font-scale-secondary);color:var(--text-mute)">${escapeHtml(k.chat_name || `会话 #${k.chat_id}`)} · ${escapeHtml(k.date)}</div>
        ${tags}
        <div style="font-size:var(--font-scale-secondary);color:var(--text-faint);line-height:1.6;margin-top:6px">${escapeHtml(k.summary.length > 160 ? k.summary.slice(0, 160) + '…' : k.summary)}</div>
      </div>`;
    card.addEventListener('click', () => openKnowledgeDetail(k));
    return card;
  }

  renderList();
}

// 条目详情弹窗:标题/摘要/标签编辑 + 保存/删除
function openKnowledgeDetail(k: KnowledgeDto): void {
  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  const titleInput = ui.input({ value: k.title, placeholder: '标题' });
  const summaryArea = ui.textarea({ value: k.summary, rows: 8, placeholder: '摘要' });
  const tagsInput = ui.input({ value: (k.tags || []).join(', '), placeholder: '标签,逗号分隔' });
  bodyEl.appendChild(ui.field({ label: '标题', children: titleInput }));
  bodyEl.appendChild(ui.field({ label: '摘要', children: summaryArea }));
  bodyEl.appendChild(ui.field({ label: '标签', children: tagsInput, help: '多个标签用逗号分隔' }));
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:var(--font-scale-secondary);color:var(--text-faint)';
  meta.textContent = `${k.chat_name || `会话 #${k.chat_id}`} · ${k.date} · ${k.msg_count} 条消息 · ${k.source === 'daily' ? '每日自动' : '手动'}入库`;
  bodyEl.appendChild(meta);

  const saveBtn = ui.button({
    label: '保存', icon: 'check', variant: 'primary',
    onClick: async () => {
      try {
        await call('update_knowledge', {
          id: k.id,
          title: titleInput.value.trim(),
          summary: summaryArea.value.trim(),
          tags: parseTags(tagsInput.value),
        });
        dlg.close();
        ui.toast('已保存');
        mainRefresher?.();
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e));
      }
    },
  });
  const delBtn = ui.button({
    label: '删除', icon: 'trash', danger: true,
    onClick: () => {
      ui.confirm({
        title: '删除条目',
        message: `确定删除「${k.title}」?`,
        confirmLabel: '删除',
        danger: true,
        onConfirm: async () => {
          try {
            await call('delete_knowledge', { id: k.id });
            dlg.close();
            ui.toast('已删除');
            mainRefresher?.();
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e));
          }
        },
      });
    },
  });
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  actions.append(delBtn, saveBtn);
  bodyEl.appendChild(actions);

  const dlg = ui.dialog({ title: '知识条目', actions: [], size: 'md' });
  const actionsEl = dlg.overlay.querySelector('.ui-dialog-actions')!;
  dlg.overlay.querySelector('.ui-dialog')!.insertBefore(bodyEl, actionsEl);
}

// 标签解析:中文/英文逗号 + 顿号分隔,去空白去重
function parseTags(raw: string): string[] {
  return [...new Set(raw.split(/[,，、]/).map((t) => t.trim()).filter(Boolean))];
}

// ── Tab2 主题总结(本期为引导卡;看板组件由另一任务在聊天流中提供) ────────
async function renderSummaryTab(body: HTMLElement): Promise<void> {
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;min-height:0;overflow-y:auto';
  body.appendChild(wrap);
  const inner = document.createElement('div');
  inner.style.cssText = 'max-width:760px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:14px';
  wrap.appendChild(inner);

  inner.appendChild(ui.card({
    title: '主题总结看板',
    children: `
      <div style="font-size:var(--font-scale-body);color:var(--text-mute);line-height:1.7">
        主题总结在<b>聊天气泡</b>中使用:每轮分析后气泡底部出现一句话短摘要,
        点击可打开详情看板(摘要 / 参与度 / 待办 / 资源 / 开放问题 / 时间线 / 决策)。
        请打开任一会话,在消息流中查看气泡与看板。
      </div>`,
  }));

  const kinds: Array<{ label: string; icon: IconName }> = [
    { label: '摘要', icon: 'message-circle' },
    { label: '参与度', icon: 'users' },
    { label: '待办', icon: 'check' },
    { label: '资源', icon: 'paperclip' },
    { label: '开放问题', icon: 'alert-circle' },
    { label: '时间线', icon: 'timeline' },
    { label: '决策', icon: 'star' },
  ];
  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center';
  chips.appendChild(ui.badge({ text: '看板分析维度', variant: 'muted' }));
  for (const kd of kinds) chips.appendChild(ui.chip({ label: kd.label, icon: kd.icon }));
  inner.appendChild(chips);

  inner.appendChild(ui.card({
    title: '相关命令',
    children: `
      <div style="font-size:var(--font-scale-secondary);color:var(--text-mute);line-height:1.8">
        <code>/summarize [N] [save]</code> — 总结最近 N 条(默认 30,上限 200);save 后缀同时存入知识库<br>
        <code>/ask &lt;问题&gt;</code> — 基于知识库检索 + LLM 回答
      </div>`,
  }));
}

// ── Tab3 自动总结配置 ───────────────────────────────────────────────────
async function renderConfigTab(body: HTMLElement): Promise<void> {
  let configs: KnowledgeConfigDto[] = [];
  try {
    configs = await call<KnowledgeConfigDto[]>('list_knowledge_config');
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(ui.empty(e instanceof Error ? e.message : String(e)));
    return;
  }
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;min-height:0;overflow-y:auto';
  body.appendChild(wrap);
  const inner = document.createElement('div');
  inner.style.cssText = 'max-width:760px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:12px';
  wrap.appendChild(inner);

  if (configs.length === 0) {
    inner.appendChild(ui.card({
      title: '暂无可配置会话',
      children: `
        <div style="font-size:var(--font-scale-body);color:var(--text-mute);line-height:1.7">
          先在知识库 Tab 或聊天中使用 /summarize 后配置。
          每个会话可独立设置每日自动总结:开关 / 触发时间 / 窗口条数 / 是否自动入库。
        </div>`,
    }));
    const refreshBtn = ui.button({ label: '刷新', icon: 'refresh-cw', size: 'sm', onClick: () => void renderConfigTab(body) });
    inner.appendChild(refreshBtn);
    return;
  }

  for (const cfg of configs) inner.appendChild(renderConfigCard(cfg));

  function renderConfigCard(cfg: KnowledgeConfigDto): HTMLElement {
    const children = document.createElement('div');
    children.style.cssText = 'display:flex;flex-direction:column;gap:10px';

    const name = document.createElement('div');
    name.style.cssText = 'font-size:var(--font-scale-body);font-weight:600';
    name.textContent = cfg.chat_name || `会话 #${cfg.chat_id}`;
    children.appendChild(name);

    const dailySwitch = ui.switch_({ checked: !!cfg.daily_enabled });
    children.appendChild(switchRow('每日自动总结', dailySwitch, '每天到点自动总结本会话并入库'));

    const timeInput = ui.input({ type: 'time', value: cfg.daily_time || '00:00' });
    timeInput.style.width = '130px';
    children.appendChild(ui.field({ label: '触发时间', children: timeInput }));

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '10';
    slider.max = '200';
    slider.value = String(cfg.window_count || 100);
    slider.style.cssText = 'flex:1;accent-color:var(--accent)';
    const sliderVal = document.createElement('span');
    sliderVal.style.cssText = 'width:44px;text-align:right;font-size:var(--font-scale-secondary);color:var(--text-mute)';
    sliderVal.textContent = slider.value;
    slider.addEventListener('input', () => { sliderVal.textContent = slider.value; });
    const sliderRow = document.createElement('div');
    sliderRow.style.cssText = 'display:flex;gap:8px;align-items:center';
    sliderRow.append(slider, sliderVal);
    children.appendChild(ui.field({ label: '窗口条数', children: sliderRow, help: '最近 N 条消息参与总结(10-200)' }));

    const autoSwitch = ui.switch_({ checked: !!cfg.auto_store });
    children.appendChild(switchRow('自动入库', autoSwitch, '总结结果同时写入知识库(关闭则仅回复摘要)'));

    const saveBtn = ui.button({
      label: '保存', icon: 'check', size: 'sm', variant: 'primary',
      onClick: async () => {
        saveBtn.disabled = true;
        try {
          await call('set_knowledge_config', {
            chatId: cfg.chat_id,
            dailyEnabled: dailySwitch.querySelector('input')!.checked,
            dailyTime: timeInput.value || '00:00',
            windowCount: Number(slider.value),
            autoStore: autoSwitch.querySelector('input')!.checked,
          });
          ui.toast('已保存');
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        } finally {
          saveBtn.disabled = false;
        }
      },
    });
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end';
    actions.appendChild(saveBtn);
    children.appendChild(actions);

    return ui.card({ children });
  }
}

function switchRow(label: string, sw: HTMLElement, help?: string): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px';
  const labels = document.createElement('div');
  labels.style.cssText = 'display:flex;flex-direction:column;gap:2px';
  const t = document.createElement('span');
  t.style.cssText = 'font-size:var(--font-scale-body)';
  t.textContent = label;
  labels.appendChild(t);
  if (help) {
    const h = document.createElement('span');
    h.style.cssText = 'font-size:var(--font-scale-micro);color:var(--text-faint)';
    h.textContent = help;
    labels.appendChild(h);
  }
  row.append(labels, sw);
  return row;
}

// ── Tab4 智能设置 ──────────────────────────────────────────────────────
async function renderSettingsTab(body: HTMLElement): Promise<void> {
  // 重新进入设置 Tab 时注销上一轮的下载进度监听
  if (settingsUnlisten) { settingsUnlisten(); settingsUnlisten = null; }

  let settings: IntelligenceSettingsDto | null = null;
  let status: ModelStatusDto | null = null;
  try { settings = await call<IntelligenceSettingsDto>('get_intelligence_settings'); } catch { /* 未接后端 */ }
  try { status = await call<ModelStatusDto>('get_llm_model_status'); } catch { /* 未接后端 */ }

  const form: { mode: string; source: string; modelTier: string; windowN: number; baseUrl: string; apiKey: string; model: string } = {
    mode: settings?.mode || 'off',
    source: settings?.source || 'local',
    modelTier: settings?.model_tier || '0.5b',
    windowN: settings?.window_n != null ? settings.window_n : 50,
    baseUrl: settings?.base_url || '',
    apiKey: settings?.api_key || '',
    model: settings?.model || '',
  };

  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;min-height:0;overflow-y:auto';
  body.appendChild(wrap);
  const inner = document.createElement('div');
  inner.style.cssText = 'max-width:760px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:14px';
  wrap.appendChild(inner);

  // 运行状态卡(引擎/模型就绪徽章 + 版本)
  const statusCard = document.createElement('div');
  inner.appendChild(statusCard);
  function renderStatusCard(): void {
    statusCard.innerHTML = '';
    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    const modeLabel = form.mode === 'llm' ? 'LLM' : form.mode === 'wordfreq' ? '词频' : '关闭';
    badges.appendChild(ui.badge({ text: `模式:${modeLabel}`, variant: 'muted' }));
    const engineReady = !!status?.engine_ready;
    badges.appendChild(ui.badge({ text: engineReady ? `引擎就绪${status?.engine_version ? ` · v${status.engine_version}` : ''}` : '引擎未就绪', variant: engineReady ? 'success' : 'danger' }));
    const modelReady = !!status?.model_ready;
    const sha = status?.model_sha256 ? ` · ${status.model_sha256.slice(0, 8)}` : '';
    badges.appendChild(ui.badge({ text: modelReady ? `模型就绪${sha}` : '模型未就绪', variant: modelReady ? 'success' : 'danger' }));
    statusCard.appendChild(ui.card({ title: '运行状态', children: badges }));
  }
  renderStatusCard();

  // 下载区(mode=llm && source=local 时显示;进度面板在此卡片内)
  const dlHost = document.createElement('div');
  inner.appendChild(dlHost);
  let progressWrap: HTMLElement | null = null;
  function renderDlCard(): void {
    const show = form.mode === 'llm' && form.source === 'local';
    dlHost.style.display = show ? '' : 'none';
    dlHost.innerHTML = '';
    if (!show) return;
    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const engineBtn = ui.button({
      label: status?.engine_ready ? '引擎已就绪' : '下载引擎',
      icon: 'download', size: 'sm',
      disabled: !!status?.engine_ready,
      onClick: () => void startDownload('engine'),
    });
    const modelBtn = ui.button({
      label: status?.model_ready ? '模型已就绪' : '下载模型',
      icon: 'download', size: 'sm',
      disabled: !!status?.model_ready,
      onClick: () => void startDownload('model'),
    });
    buttons.append(engineBtn, modelBtn);
    progressWrap = document.createElement('div');
    progressWrap.style.cssText = 'display:none;flex-direction:column;gap:6px';
    const track = document.createElement('div');
    track.style.cssText = 'height:6px;border-radius:3px;background:var(--border);overflow:hidden';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:0%;background:var(--accent);transition:width .2s';
    track.appendChild(fill);
    const text = document.createElement('div');
    text.style.cssText = 'font-size:var(--font-scale-micro);color:var(--text-mute)';
    text.textContent = '';
    progressWrap.append(track, text);
    const children = document.createElement('div');
    children.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    children.append(buttons, progressWrap);
    dlHost.appendChild(ui.card({ title: '本地模型下载', children }));
  }

  async function startDownload(which: 'engine' | 'model'): Promise<void> {
    if (progressWrap) {
      progressWrap.style.display = 'flex';
      progressWrap.querySelector<HTMLElement>('div')!.style.width = '0%';
      progressWrap.querySelector<HTMLElement>('div:last-child')!.textContent = `${which === 'engine' ? '引擎' : '模型'}下载中…`;
    }
    try {
      await call('start_engine_download', { which });
      ui.toast(which === 'engine' ? '引擎下载完成' : '模型下载完成');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    }
    try { status = await call<ModelStatusDto>('get_llm_model_status'); } catch {}
    renderStatusCard();
    renderDlCard();
  }

  // 表单区(模式/来源变化时整块重建)
  const formEl = document.createElement('div');
  formEl.style.cssText = 'display:flex;flex-direction:column;gap:14px';
  inner.appendChild(formEl);

  function renderForm(): void {
    formEl.innerHTML = '';

    const modeSeg = ui.segmented({
      items: [
        { value: 'off', label: '关闭' },
        { value: 'wordfreq', label: '词频' },
        { value: 'llm', label: 'LLM' },
      ],
      value: form.mode,
      onChange: (v) => { form.mode = v; renderForm(); },
    });
    formEl.appendChild(ui.field({ label: '智能模式', children: modeSeg, help: '关闭 = 不启用;词频 = 本地统计聚类;LLM = 大模型智能总结' }));

    if (form.mode === 'llm') {
      const srcSeg = ui.segmented({
        items: [
          { value: 'local', label: '本地模型' },
          { value: 'api', label: 'API' },
        ],
        value: form.source,
        onChange: (v) => { form.source = v; renderForm(); },
      });
      formEl.appendChild(ui.field({ label: '模型来源', children: srcSeg }));

      if (form.source === 'local') {
        const tierSeg = ui.segmented({
          items: [
            { value: '0.5b', label: '0.5B' },
            { value: '1.5b', label: '1.5B' },
          ],
          value: form.modelTier,
          onChange: (v) => { form.modelTier = v; },
        });
        formEl.appendChild(ui.field({ label: '模型档位', children: tierSeg, help: 'Q4_K_M 量化,ModelScope 优先' }));
      } else {
        const baseUrlInput = ui.input({ value: form.baseUrl, placeholder: 'https://api.openai.com/v1' });
        baseUrlInput.addEventListener('input', () => { form.baseUrl = baseUrlInput.value; });
        formEl.appendChild(ui.field({ label: 'Base URL', children: baseUrlInput }));
        const apiKeyInput = ui.input({ type: 'password', value: form.apiKey, placeholder: 'API Key' });
        apiKeyInput.addEventListener('input', () => { form.apiKey = apiKeyInput.value; });
        formEl.appendChild(ui.field({ label: 'API Key', children: apiKeyInput }));
        const modelInput = ui.input({ value: form.model, placeholder: '如 gpt-4o-mini' });
        modelInput.addEventListener('input', () => { form.model = modelInput.value; });
        formEl.appendChild(ui.field({ label: '模型', children: modelInput }));
        const testLabel = document.createElement('span');
        testLabel.style.cssText = 'font-size:var(--font-scale-secondary);color:var(--text-mute)';
        const testBtn = ui.button({
          label: '测试连接', icon: 'check', size: 'sm',
          onClick: async () => {
            testBtn.disabled = true;
            testLabel.textContent = '测试中…';
            try {
              const reply = await call<string>('test_llm_config', {
                config: {
                  base_url: form.baseUrl.trim() || null,
                  api_key: form.apiKey.trim() || null,
                  model: form.model.trim() || null,
                },
              });
              testLabel.textContent = '✓ 连接成功';
              testLabel.style.color = 'var(--success)';
              ui.toast(`连接成功: ${reply.slice(0, 60)}`);
            } catch (e) {
              testLabel.textContent = '✗ 连接失败';
              testLabel.style.color = 'var(--danger)';
              ui.toast(e instanceof Error ? e.message : String(e));
            } finally {
              testBtn.disabled = false;
            }
          },
        });
        const testRow = document.createElement('div');
        testRow.style.cssText = 'display:flex;gap:10px;align-items:center';
        testRow.append(testBtn, testLabel);
        formEl.appendChild(testRow);
      }
    }

    if (form.mode !== 'off') {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '10';
      slider.max = '200';
      slider.value = String(form.windowN);
      slider.style.cssText = 'flex:1;accent-color:var(--accent)';
      const sliderVal = document.createElement('span');
      sliderVal.style.cssText = 'width:44px;text-align:right;font-size:var(--font-scale-secondary);color:var(--text-mute)';
      sliderVal.textContent = String(form.windowN);
      slider.addEventListener('input', () => { form.windowN = Number(slider.value); sliderVal.textContent = slider.value; });
      const sliderRow = document.createElement('div');
      sliderRow.style.cssText = 'display:flex;gap:8px;align-items:center';
      sliderRow.append(slider, sliderVal);
      formEl.appendChild(ui.field({ label: '上下文条数', children: sliderRow, help: '最近 N 条消息参与总结(10-200)' }));
    }

    const saveBtn = ui.button({
      label: '保存设置', icon: 'check', variant: 'primary',
      onClick: async () => {
        saveBtn.disabled = true;
        const isApi = form.source === 'api';
        try {
          await call('set_intelligence_settings', {
            mode: form.mode,
            source: form.source,
            modelTier: form.modelTier,
            windowN: form.windowN,
            baseUrl: isApi ? form.baseUrl.trim() || null : null,
            apiKey: isApi ? form.apiKey.trim() || null : null,
            model: isApi ? form.model.trim() || null : null,
          });
          ui.toast('已保存');
        } catch (e) {
          ui.toast(e instanceof Error ? e.message : String(e));
        } finally {
          saveBtn.disabled = false;
        }
      },
    });
    formEl.appendChild(saveBtn);

    renderDlCard();
  }
  renderForm();

  // 下载进度事件:200ms 节流更新进度条(面板元素随下载卡重建,断连则跳过)
  let lastPaint = 0;
  let pending: DcEvent | null = null;
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  settingsUnlisten = await onEvent('download-progress', (ev) => {
    pending = ev;
    const paint = (): void => {
      const p = pending;
      pending = null;
      if (!p || !progressWrap || !progressWrap.isConnected) return;
      const bytesDone = Number(p.bytesDone ?? 0);
      const total = Number(p.total ?? 0);
      const rate = Number(p.rate ?? 0);
      const pct = total > 0 ? Math.min(100, Math.round((bytesDone / total) * 100)) : 0;
      const fill = progressWrap.querySelector<HTMLElement>('div');
      const text = progressWrap.querySelector<HTMLElement>('div:last-child');
      if (fill) fill.style.width = `${pct}%`;
      if (text) text.textContent = `${p.id === 'model' ? '模型' : '引擎'} ${fmtBytes(bytesDone)} / ${fmtBytes(total)}${rate > 0 ? ` · ${fmtRate(rate)}` : ''} (${pct}%)`;
    };
    if (Date.now() - lastPaint >= 200) {
      lastPaint = Date.now();
      paint();
    } else if (!paintTimer) {
      paintTimer = setTimeout(() => {
        paintTimer = null;
        lastPaint = Date.now();
        paint();
      }, 200);
    }
  });
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
function fmtRate(n: number): string {
  return `${fmtBytes(n)}/s`;
}
