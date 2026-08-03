# Bot 系统 · 子项目 C：Bot 管理 UI 设计文档

> **定位**: 大特性「Bot 系统」的分解子项目 C（前端），在 A/B 后端之上实现 Bot 管理页面：列表 / 创建 / LLM 配置 / 启停 / 删除。
>
> **前置决策**（brainstorming 问答确认）:
> - 放置位置: 独立顶级页面（rail 加机器人图标，`Page = 'bots'`）
> - 创建流程: 输入显示名 → `create_bot` 自动配号 → 成功自动弹 LLM 配置对话框（可跳过）
> - 配置对话框: 系统提示词(textarea) + Base URL + API Key + 模型名；Base URL 带常用预设下拉（OpenAI/DeepSeek/Ollama/自定义）
> - 实现路线: C1 — 新 `botsPage.ts` + 4 处轻接线，全部复用 `ui.ts` 组件与现有页面样式

## 1. 目标与范围

### 1.1 目标
1. 独立「机器人」顶级页面：Bot 列表（名称 / 邮箱 / 状态 / 已配 LLM 徽标）
2. 新建 Bot（自动配号）+ 创建后自动弹 LLM 配置
3. LLM 配置读写（含 Base URL 预设下拉）
4. 单个 Bot 启停（`set_bot_io`）与删除（确认弹窗）
5. 复用现有组件与样式，无新增 CSS 体系

### 1.2 不做（后续子项目）
- 会话 UX（以 Bot 身份收发消息）→ D
- 状态筛选 tab / 轮询（进入页面即刷新，无后台状态变化）
- Provider 选择器（后端预留 `provider`，当前仅 openai，UI 不暴露）

## 2. 新图标

- `src/components/tdesignIcons.ts` 加 `'robot': [...]`（从 TDesign `robot.svg` 提取 2 个 stroke path）
- `src/components/icon.ts` 的 `IconName` 加 `'robot'`

## 3. 接线

- `src/types.ts`：`Page` 加 `'bots'`
- `src/shell/rail.ts`：图标组加 `{ page: 'bots', icon: 'robot', label: '机器人' }`（通知图标之后）
- `src/shell/navPanel.ts`：
  - `renderMain` switch 加 `case 'bots'` → `botsPage.renderBots(main)`
  - `HIDDEN_NAV_PAGES` 加 `'bots'`（整页内容，隐藏中间栏）
- `src/state.ts`：无新状态（无跨页状态；列表数据页内持有）

## 4. `botsPage.ts` 布局

新增 `src/pages/botsPage.ts`，`export async function renderBots(main: HTMLElement)`：

```
main-header: 「机器人」标题 + 副标题「由 LLM 自动回复的 Bot 账号」+ 「新建 Bot」按钮
Bot 列表（空时 ui.empty("还没有 Bot，点击右上角新建")）
每行（复用 ui.listItem 结构）：
  ├─ 字母头像（显示名首字，ui.avatar）
  ├─ 标题：显示名
  ├─ 副标题：邮箱地址
  ├─ 徽标：状态「运行中/已停止」+「已配 LLM」(success，仅配置齐全时)
  └─ 操作：配置(编辑图标) · 启停(ui.switch_) · 删除(danger 图标)
```

数据：进入页面 `call('list_bots')` 拿 `BotDto[]`；「已配 LLM」由后端 `get_bot_llm` 判断配置齐全。

## 5. 交互

- **新建**：`ui.inputDialog`（"新建 Bot"，placeholder "Bot 显示名"）→ `call('create_bot', { displayName })` → toast「Bot 已创建」→ 自动弹 LLM 配置对话框（可关闭跳过）。
- **配置对话框**（`ui.dialog`，标题「配置 Bot · {name}」）：
  - Base URL 预设下拉：OpenAI `https://api.openai.com/v1` / DeepSeek `https://api.deepseek.com` / Ollama `http://localhost:11434/v1` / 自定义（选中自定义显示输入框）
  - 系统提示词（`ui.textarea`）、API Key（`ui.input` type=password）、模型名（`ui.input` placeholder "gpt-4o-mini"）
  - 打开时 `get_bot_llm` 回显；保存 → `update_bot_llm` → toast + 刷新列表
- **启停**：`ui.switch_` → `set_bot_io(botId, running)` → 更新该行状态徽标；失败 toast 并回滚开关。
- **删除**：`ui.confirm`（"删除后该 Bot 账号及其数据将彻底移除"，danger）→ `delete_bot` → toast + 刷新列表。
- **刷新**：每次进入页面 `list_bots`；无轮询。

## 6. 测试验收

- [ ] `npx tsc --noEmit` 通过
- [ ] `npm run tauri dev`：rail 出现机器人图标，点击进入「机器人」页
- [ ] 新建 Bot（后端配号成功）→ 自动弹配置对话框 → 填真实 LLM 配置保存 → 列表出现「运行中」「已配 LLM」徽标
- [ ] 启停开关切换状态徽标；删除后 Bot 消失且后端账号目录被清
- [ ] 主账号向 Bot 发消息 → Bot 自动回复（B 联动）；主界面不出现 Bot 收件通知
- [ ] 空列表显示 empty 状态
