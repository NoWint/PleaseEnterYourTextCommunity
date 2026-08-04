# 纯 JSON 信封协议(Envelope V2)设计

日期:2026-08-04
状态:设计定稿
范围:摒弃所有前缀协议(`[CARD]`/`[PEYT]`/`[PEYT_INVITE]`),统一为「纯 JSON 二次包装」—— 客户端发送时组装 JSON,消息体显示时解析渲染。

## 1. 背景与动机

### 1.1 旧协议的问题

当前结构化消息散落在三种前缀协议里,互不统一:

| 协议 | 用途 | 现状 |
|---|---|---|
| `[CARD]{json}` | 卡片同步 | 接收端拦截(shell.ts `CARD_PREFIX`),不进聊天流 |
| `[PEYT_INVITE]{json}` | Studio 频道邀请 | 接收端拦截(`PEYT_INVITE_PREFIX`) |
| `[PEYT]{json}`(envelope.rs) | 设计中的统一信封 | 发送端已迁移,但接收端仍找 `[CARD]`/`[PEYT_INVITE]` → **前缀失配,卡片同步/频道邀请当前是断的** |

### 1.2 目标

1. 摒弃所有前缀协议,统一为「纯 JSON 二次包装」。
2. **全量化**:普通文本、结构化数据(卡片/邀请/角色/置顶/待办)全部走信封;媒体用 payload 描述 + core 附件 blob。
3. 组装在后端;消息体(显示层)承担解析 + 渲染。
4. 解析失败 → 显示原文(旧消息/未知类型/异常格式自然兜底)。
5. 旧协议不做兼容,直接重做。

## 2. 信封体

### 2.1 载体

消息正文就是**纯 JSON**,无任何前缀、无附件信封文件。core 不感知信封——正文只是一个普通字符串。

```
普通消息(新): text = {"version":1,"type":"text","id":"<uuid>","timestamp":1754100000,"payload":{"text":"你好"}}
```

### 2.2 结构(五字段)

```json
{
  "version": 1,
  "type": "text",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1754100000,
  "payload": {}
}
```

| 字段 | 类型 | 作用 |
|---|---|---|
| `version` | int | payload schema 版本。与 type 解耦;老端收到高版本 → 显示原文保底。 |
| `type` | string | 注册表判别符(见 §3)。匹配完整 type,未知则显示原文保底。 |
| `id` | UUID | 发送端幂等键。接收端按 `(from_id, id)` 去重业务副作用。**不是实体身份**——实体身份在 payload。 |
| `timestamp` | int | 发送端单调时钟,冲突消解(后到者胜)。 |
| `payload` | object | 类型专属载荷。 |

已删除定稿时的 `from` 字段:发送者身份取消息 `from_id`,app 版本对分派无用。

### 2.3 识别(形状启发式)

接收端对每条消息:

```
text 以 "{" 开头
  → JSON.parse 成功
  → version/type/id/timestamp/payload 五字段齐全
  → 是信封;否则 → 普通文本(显示原文)
```

误报分析:用户需恰好发出五字段齐全且 `type` 命中注册表的 JSON 才算信封,实际不可能。这是纯 JSON 载体下唯一可行的识别方式,协议保证由「type ∈ 注册表」兜底。

## 3. 类型注册表

```
text          普通文本             text
media.*       媒体                media.image / media.voice / media.audio / media.video / media.file / media.webxdc
card.*        看板卡片            card.create / card.update / card.delete
channel.*     频道                channel.invite / channel.subscribe / channel.unsubscribe / channel.topic / channel.space
project.*     立项/产品线          project.create / project.update / project.delete / project.invite
role.*        成员角色            role.create / role.assign / role.update / role.remove
pin.*         置顶                pin.toggle
todo.*        待办                todo.create / todo.update / todo.complete / todo.delete
```

分派规则:

- `type` 命中注册表 → 渲染对应卡片 + 执行业务副作用。
- 结构合法但 `type` 未知(如新版本类型、老端)→ 显示原文保底,不丢消息。
- `version` 高于本地 → 显示原文保底。

## 4. 发送端(后端统一组装)

### 4.1 buildEnvelope 纯 JSON 版

`envelope.rs` 的 `build_envelope(type, payload)` **去掉 `[PEYT]` 前缀**,输出纯 JSON 字符串。字段:version/type/id(uuid)/timestamp/payload。`from` 删除。

### 4.2 所有发送路径收敛

| 发送路径 | type | payload | 备注 |
|---|---|---|---|
| `send_text` | `text` | `{text}` | 普通文本 |
| `send_voice` / 图片 / 视频 / 文件 / webxdc | `media.*` | `{mime, name, size}` | 二进制 blob 仍挂 core 附件(`view_type` + file) |
| `create_card` / `update_card` / `delete_card` | `card.*` | 规范化卡片数据 | 稳定 id、`position`、`updated_at`(见 §8.1) |
| Studio 频道邀请 | `channel.invite` | 频道邀请数据 | 替代 `[PEYT_INVITE]` |
| 后续 project / role / pin / todo | 对应 type | 各类型载荷 | 按注册表扩展 |

### 4.3 媒体表示

媒体消息的正文是信封 JSON(`media.*`),**文件 blob 由 core 管理**(`view_type=Image/File/Voice/...` + file,接收端经现有 `transformBlobURL` 读取)。信封负责「类型语义 + 可读描述」,core 负责「文件传输」。**core 零改动**。

## 5. 接收端(前端统一解析 + 渲染管线)

### 5.1 管线

```
renderMessage(text):
  env = tryParseEnvelope(text)
  ├─ 失败(null)        → 渲染原文(旧消息/非信封兜底;is_info 保持信息行样式)
  ├─ 成功但 type 未知   → 渲染原文保底
  └─ 成功且 type 已知   → 渲染对应类型卡片
```

### 5.2 业务副作用与幂等去重

- 信封消息**始终显示在聊天流**(以卡片形态),去重不删除 UI。
- 业务副作用(建卡、securejoin)按 `(from_id, id)` 幂等:模块级 `Map<string, boolean>` 记录已处理 id,重复消息跳过副作用、正常显示 UI。重启后重处理一次,upsert 命令本身幂等,无脏数据。
- 事件路径(`handleIncomingMsg`)+ 历史加载路径(`renderAllMessages`)都过同一管线,防止「事件已处理、历史又处理一次」。

### 5.3 渲染卡片

| type | 渲染 |
|---|---|
| `text` | 普通气泡,取 `payload.text` |
| `media.*` | 现有附件渲染(图片/语音/文件卡片),`payload` 提供名称/大小 |
| `card.*` | 卡片气泡(标题 + 状态 + 负责人,点击进卡片详情) |
| `channel.invite` | 频道邀请卡片(频道名 + 「加入」按钮) |
| 其余已知 type | 各类型结构化卡片 |
| 未知 type / 解析失败 | 显示原文(降级为普通文本气泡) |

## 6. 显示点全覆盖

普通文本变 JSON 后,凡「把消息当文本用」的地方都要先还原:

| 显示点 | 处理 |
|---|---|
| 消息气泡 | `renderMessage` 走 §5 管线 |
| 引用回复 | `quote_text` 存的是被引用的 JSON → 渲染时 `tryParseEnvelope(quote_text)` 取 `payload.text`;解析失败显示原文 |
| 原生通知 | 自建通知(notifications.rs + shell 拼 body)→ 拼 body 前先还原文本 |
| 搜索 | **前端化**(`get_all_messages` + 前端过滤)→ 索引还原后的文本;`search_msgs` core 命令失效,不再使用 |
| 媒体附件 | `media.*` 信封 + core blob 附件渲染 |
| 已读回执 / 反应 / reply 关系 | core 原生,不经正文,不受影响 |

## 7. 兼容与降级

- 解析失败 → 显示原文(旧消息、未知 type、异常格式、高 version)。
- 原生 Delta Chat 用户看到 JSON 文本(不做互通,接受)。
- `is_info` 系统消息由 core 生成,不经我们的发送端 → 天然非信封 → 显示原文 + 信息行样式。
- 弃用后旧 `[CARD]`/`[PEYT]`/`[PEYT_INVITE]` 消息不再解析,显示原文(历史数据保留,不可读但可见)。

## 8. 关键实现注意

### 8.1 card payload 规范化(承接旧定稿 §8)

- 现有 `[CARD]` 载荷的根因问题:`id`/`workspace_id`/`assignee_contact_id`/`created_by` 全是本地 id,跨设备必冲突。重写时全部换稳定标识(`master_chat_id`/`chat_id`/邮箱/UUID)。
- card update 载荷携带 `updated_at`(现状错误地发 `created_at`)。
- `position`(看板排序)已在 DB 但从未进载荷——重写时补上。

### 8.2 身份引用约束

payload 内实体引用禁用本地 id(跨设备不一致),必须用稳定标识:
- 立项 → `master_chat_id`(DC 稳定 id)
- 频道 → `chat_id`(DC 稳定 id)
- 联系人 → 邮箱(短期)/ UUID(长期)
- 实体 → UUID(发送端生成)

### 8.3 字段全名风格

信封 JSON 会出现在聊天流(降级时)和调试页,字段不缩写,payload 内部同样约束。

## 9. 明确不做

- `todo.*` 推后(无落地页面,功能落地时再加类型)。
- inbox_events / activities 是本地派生投影,不入协议。
- 插件共享数据留作未来扩展点。
- **core 零改动**:本协议全部实现在 `src-tauri` + `src`,不碰 `core/` submodule。
- **不做互通**:不注册/不处理 Delta 其他客户端的前缀协议,与 Delta 抢的只是 scheme(OPENPGP4FPR)既定决策。

## 10. 验收要点

1. 发送文本 → 聊天流显示普通气泡(还原 `payload.text`),正文实为 JSON。
2. 发送图片/语音 → 附件正常渲染,信封提供描述。
3. 建卡/改卡/删卡 → 聊天流显示卡片气泡 + 看板同步,多设备去重不重复建卡。
4. Studio 邀请 → 显示邀请卡片,可一键加入。
5. 旧 `[CARD]`/`[PEYT]` 历史消息 → 显示原文,不崩。
6. 引用回复一条信封消息 → 引用块显示还原后的文本。
7. 通知 body 显示还原后的文本,而非 JSON。
8. 搜索能命中普通文本内容(走前端过滤)。
