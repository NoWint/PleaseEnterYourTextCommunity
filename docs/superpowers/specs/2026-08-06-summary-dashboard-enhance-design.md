# 主题总结看板增强设计

日期:2026-08-06
状态:设计定稿
范围:深化现有 6 分析板块 + 新增情绪氛围板块 + `<time>` 时间定位标签 + 提示词 few-shot 示例与标签规范。

## 1. 背景与动机

### 1.1 现状

- 看板 6 板块:总结 / 行动项 / 参与度 / 悬而未决 / 话题演变 / 决策。
- 每个板块独立入队/流式/渲染;JSON 类走 schema 结构化渲染,summary/participation 走 markdown。
- 标签仅 `<message>`(跳原文)与 `<user>`(弹名片),已支持无引号/撇号值。
- 提示词在 `summary/commands.rs::system_prompt`(旧全屏看板)与 `intelligence/queue.rs`(远端)。

### 1.2 目标

1. **深化现有板块**:
   - 参与度:活跃时段分布(柱状条)、消息趋势(逐日密度)、最活跃成员对比。
   - 悬而未决:优先级/过期时间标注(JSON schema 可选字段 + `<time>`),高亮未回应。
   - 决策:状态(已执行/待执行)与影响范围(JSON schema 可选字段),可追踪卡片。
   - 行动项:进度条/分类(个人/团队),勾选本地持久化。
   - **注**:priority/status 走 JSON schema 字段(渲染器读),不新增 XML 标签;本期唯一新增标签是 `<time>`。
2. **新增情绪氛围板块**:JSON 结构化 `{overall, score, emoji, summary, highlights}`。
3. **新增 `<time>` 标签**:时间戳 chip,点击滚动定位到该时刻最近消息并高亮。
4. **提示词优化**:每板块 few-shot 理想示例 + 标签规范(正反例)。

### 1.3 非目标

- 不改 marked/渲染引擎本身。
- 不改 intelligence 的 prompt(远端体系;本期只改旧 summary 模块 prompt,若远端也要则后置)。
- 不做跨端设置同步。

## 2. 标签扩展:`<time>`

### 2.1 语法

```
<time='2026-08-05 14:30'>  完整时间
<time='14:30'>             仅时分(定位当天)
<time='2026-08-05'>        仅日期(定位当天 00:00 后第一条)
```

### 2.2 解析与渲染

- tagParser/markdown 增加 `<time>` 白名单标签,渲染成 `data-time-ref` chip(`🕐 14:30`)。
- 点击 → 看板/气泡内 `jumpToTime(ts)`:
  - 解析时间为 unix 秒;仅时分 → 拼当天日期。
  - 在 state.messages 里找 `msg.ts >= ts` 最近一条(二分或线性)。
  - `jumpToMessage(msgId)` 滚动定位 + 高亮 2s(复用现有)。
  - 找不到(超出窗口)→ toast。

### 2.3 安全

- 时间值严格校验(数字/分隔符),非法 → 渲染为纯文本。
- 与 `<message>`/`<user>` 同白名单机制。

## 3. 新增情绪氛围板块

### 3.1 位置

ANALYSIS_TYPES 插入 `{ kind: 'mood', title: '情绪氛围', icon: 'smile', engine: 'llm', priority: 0 }`,置于 summary 之后。

### 3.2 Schema

```json
{
  "overall": "积极|中立|消极|混合",
  "score": 0-100,
  "emoji": "🔥",
  "summary": "一句话解读(2-4句)",
  "highlights": [ { "text": "代表消息摘要", "emoji": "😄" } ]
}
```

### 3.3 渲染

- 顶部大 emoji + overall 徽章 + 色带(绿/黄/红按 score)。
- 解读 markdown。
- highlights 列表(每条 emoji + 文本)。

## 4. 深化现有板块

### 4.1 参与度可视化

前端 `computeParticipation` 已有:per_member(msg_count/char_count/active_days)、时段分布、每日密度。新增 UI:
- 活跃时段柱状条(24h 分桶,高度=消息数)。
- 消息趋势(逐日条)。
- 最活跃成员对比条(相对宽度)。

### 4.2 悬而未决增强

Schema(JSON 字段)加可选 `priority`(`high|medium|low`)、`due`(字符串时间):
- priority high → 红色高亮;due → 过期判断(红/正常)。
- 未回应标记(提问后无回答)。

### 4.3 决策加状态

Schema(JSON 字段)加可选 `status`(`done|pending`)、`impact`(影响范围字符串):
- status done → 绿色勾;pending → 待办样式。
- impact → 副标题。

### 4.4 行动项增强

- 分类 chip(个人/团队,`assignee` 区分)。
- 进度条(已完成/总数,本地勾选统计)。
- 勾选状态 localStorage 持久化(`sd-action-done:{chatId}:{kind}:{index}`)。

## 5. 提示词优化

### 5.1 summary/commands.rs system_prompt

- 每板块示例段:`例如:<action_items> 输入 ... 输出 {...}`。
- 标签规范段:强调必须用 `<message>`/`<user>`/`<time>`,给正反例。
- mood 板块新 prompt(JSON schema 说明)。

### 5.2 保持简洁

- 每板块示例 1 条,避免 prompt 过长(token 成本)。
- 标签规范合并到通用段(不每板块重复)。

## 6. 数据流

```
提示词(few-shot + 标签规范) → LLM 输出(含 <time>/<priority>/<status> 标签)
→ 渲染器:JSON schema 结构化 + 标签解析成 chip
→ 交互:chip 点击 → jumpToTime/jumpToMessage/名片/priority 高亮
```

## 7. 错误处理

- `<time>` 非法值 → 纯文本。
- mood JSON 缺字段 → 降级纯文本。
- 参与度数据缺失 → 空态。
- 勾选持久化失败 → 静默(内存态保留)。

## 8. 测试

- tagParser:`<time>` 解析(完整/时分/日期/非法)。
- jumpToTime:找到/超出窗口。
- mood 渲染:完整 JSON/缺字段降级。
- 参与度可视化:数据正确。
- 勾选持久化:localStorage 往返。

## 9. 兼容性

- 新增板块/标签对旧消息无影响(无 mood 字段 → 请求;无 `<time>` → 纯文本)。
- 现有 6 板块 schema 向后兼容(加可选字段,老端忽略)。
