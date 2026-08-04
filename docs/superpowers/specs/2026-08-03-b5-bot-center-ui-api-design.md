# Bot 系统大扩展 · 子项目 B5：Bot 管理中心 UI + API/文档收口 设计文档

> **定位**: 前端收口。把 `botsPage.ts` 升级为完整管理中心(列表→详情多 Tab),落地打字指示器/状态徽标/时间线/统计可视化/人设/规则/定时/工具配置;补插件工具前端 API;更新 `docs/api-spec.md`。
>
> **前置决策**(brainstorming 确认): 打字指示器、Bot 状态徽标、可视化配置面板、管理页升级,全部真实可用。

## 1. 范围

**做**: 管理中心 UI(列表 + 详情 Tab)、`list_bot_activities` 命令、打字指示器、时间线、统计、插件工具前端 API、api-spec 更新。
**不做**: 其他页面改动(rail 入口已存在)。

## 2. 后端补充(commands.rs)

| 命令 | 入参 | 返回 |
|---|---|---|
| `list_bot_activities` | `botId: i64, limit?: i64`(默认 50) | `Vec<BotActivityDto>`(db.list_bot_activities 转 DTO,倒序) |

- 复用 `BotActivityDto`;db 返回的 `BotActivityRow` → 映射为 DTO(commands.rs 内私有 helper)。

## 3. botsPage.ts 重构

### 3.1 状态结构(页面内,无跨页)

```ts
interface BotDetailState {
  bot: BotDto;
  cfg: BotConfig | null;
  tab: 'chat' | 'llm' | 'rule' | 'schedule' | 'tools' | 'timeline' | 'stats';
}
```

### 3.2 视图结构

```
renderBots(main)              列表态(保留现有,加强徽标)
  └─ 每行:头像 / 名称+邮箱 / 状态徽标(运行中·已停止·思考中)/ 已配 LLM·规则·定时·人设徽标
      操作:配置(进详情)/ 启停开关 / 删除
  └─ 点击行 → renderBotDetail(bot)

renderBotDetail(bot, main)    详情态(替换主区)
  顶栏:返回列表 + Bot 头像/名称/邮箱 + 运行状态徽标 + 人设徽标
  Tab 栏:对话 | LLM | 规则 | 定时 | 工具 | 时间线 | 统计
  └─ 内容区按 tab 渲染
```

### 3.3 Tab 内容

- **对话**:现有双栏(会话列表 + 消息线程 + 输入框),搬入此 Tab。
- **LLM**:Provider 下拉(openai/anthropic/gemini)+ Base URL + API Key(密码框)+ 模型 + 温度(滑条 0–2)/max_tokens/top_p + 系统提示词(textarea)+「测试连接」;保存 → `update_bot_config`。
- **规则**:规则列表(模式/是否正则/回复集合/启用)+ 增删改;欢迎语 textarea;兜底 textarea。存 `config.rule`。
- **定时**:会话选择下拉(用 bot_get_chatlist)+ minute/hour/dayOfWeek 输入(-1=任意)+ 消息;列表(下次触发时间)+ 删除。用 `bot_list_schedules`/`bot_add_schedule`/`bot_delete_schedule`。
- **工具**:内置工具清单(名/说明/默认开放标记)+ 开关(存 `config.tools` 显式启用集)+ 已注册插件工具。
- **时间线**:`list_bot_activities` 列表(时间/类型/摘要)+ 实时 `bot-activity` 事件追加(仅当前 bot)。
- **统计**:`get_bot_stats` 卡片组(总活动/回复/规则回复/定时/工具调用/错误/限流/最近活动)。

### 3.4 打字指示器与状态徽标

- `bot-activity` 事件 payload 为 `BotActivityDto`(已有)。前端 `onEvent('bot-activity', ...)`:
  - `kind === 'thinking'` → 当前打开的 bot 会话线程顶部显示「正在输入…」
  - `kind === 'reply_sent'` → 隐藏 typing;若有对应 chat_id 且在当前线程 → 触发 `bot_get_chat_msgs` 刷新追加
  - `kind === 'llm_error'` → 隐藏 typing,toast 提示
- 后端在 driver 调度前 record `THINKING` 活动(即 B2/B3 接线时加入 `pub const THINKING: &str = "thinking";`)——**本条由后端补**:runtime `handle_bot_message` 在通过限流、即将调驱动前 `activity.record(bot_id, THINKING, ...)`,进入 `dispatch` 阶段;typing 即基于此。

### 3.5 交互细节

- 详情页打开时并行拉:`get_bot_config` + `get_bot_stats`;tab 切换按需拉取(懒加载)。
- 每次 `update_bot_config` 保存后刷新 `cfg` 与列表徽标;LLM 配置变化不重启 Bot(runtime 每次消息重读 config,天然生效)。
- 复用 `ui.ts` 组件(dialog/input/switch/select/toast/empty);不新增全局 CSS,少量内联样式。

## 4. 插件工具前端 API(plugins/api.ts + types.ts)

新增插件 API 方法 + 全局事件桥:

```ts
// api.ts: PluginApi 增加
registerTool(name: string, description: string, parameters: unknown, handler: (args: any) => Promise<string>): Promise<void>;
unregisterTool(name: string): Promise<void>;
// 内部:
//  - registerTool → call('register_bot_tool', { name, description, parameters })
//  - 监听 'bot-tool-request' → 按 payload.name 匹配已注册 handler → await handler(args)
//    → call('bot_tool_result', { id: payload.id, result }) ;handler 抛错 → call bot_tool_result({id, result: '工具执行失败: ...'})
//  - 插件卸载(uninstall)时自动 unregisterTool
```
- 需要权限 `tools`(permissions.ts 新增: `{ id: 'tools', label: '注册 Bot 工具' }`)。
- types.ts:`PluginApi` 接口增 `registerTool/unregisterTool`;新增全局监听常量。
- 桥生命周期:监听器在 api.ts 模块级启动一次(`listen('bot-tool-request', ...)`),按插件名→handler 表分发。

## 5. API/文档收口

更新 `docs/api-spec.md`:
- §2 新增命令:Bot 系统整段(含 B1 get/update_bot_config、B2 无新命令、B3 schedules/plugin-tools、B4 personas/stats、B5 list_bot_activities)
- §4 事件新增:`bot-activity`(BotActivityDto)、`bot-tool-request`(bridge)
- §5 插件 API 新增:`registerTool/unregisterTool` + 权限 `tools`
- DTO 章节:`BotConfig/LlmConfig/BotLimits/RuleConfig/RuleDef/ScheduleDto/BotStatsDto/PersonaDto/BotActivityDto`

## 6. 测试验收

### 编译/类型
- [ ] `npx tsc --noEmit` 通过
- [ ] `cargo build` / `cargo test --lib` 通过(后端新增命令不回归)

### 手动
- [ ] 机器人页列表:状态徽标、人设徽标正确;点击进入详情
- [ ] LLM Tab:provider 切换 + 保存 +「测试连接」成功
- [ ] 规则 Tab:加规则(关键词命中)→ 主账号发关键词 → Bot 规则回复;欢迎语首次触发
- [ ] 定时 Tab:添加每天 9 点任务 → 时间线出现 `schedule_sent`
- [ ] 工具 Tab:开/关 `write_file`;Bot 收到"写文件"指令 → 沙箱内生成
- [ ] 时间线:进入显示历史 + 实时追加;Bot 回复时看到「正在输入…」
- [ ] 统计:数字随活动增长
- [ ] 插件:示例插件 `registerTool` → Bot 触发该工具 → 前端 handler 返回 → LLM 使用结果
- [ ] 错误路径:Bot 配错 key → 状态徽标/时间线显示 llm_error,无崩溃

## 7. 改动文件

- 修改:`src/pages/botsPage.ts`(重构)、`src/plugins/api.ts`、`src/plugins/types.ts`、`src/plugins/permissions.ts`、`src/api.ts`(如需)、`docs/api-spec.md`、`src-tauri/src/commands.rs`(`list_bot_activities`)
