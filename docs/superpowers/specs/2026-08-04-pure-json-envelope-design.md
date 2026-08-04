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
2. **全量化**:聊天系统的所有消息形态(文本/引用回复/媒体)都走信封;媒体用 payload 描述 + core 附件 blob。
3. 组装在后端;消息体(显示层)承担解析 + 渲染。
4. 解析失败 → 显示原文(旧消息/未知类型/异常格式自然兜底)。
5. 旧协议不做兼容,直接重做。

### 1.3 本期范围(先跑通)

**V0 只做 `text` 一条链路**:`send_text` → 后端组 JSON → 前端 `tryParseEnvelope` 还原渲染 → 解析失败显示原文。这条通了,协议地基(识别/还原/渲染管线)即验证。

**V0 之后**:`reply` / `media` 加 type 分派。业务扩展(卡片/邀请/角色/置顶/待办)的 type 与 payload **后置设计**,本期不进协议。本协议的 type 集合是**聊天消息类型**,不含业务实体。

## 2. 信封体

### 2.1 载体

消息正文就是**纯 JSON**,无任何前缀、无附件信封文件。core 不感知信封——正文只是一个普通字符串。

```
普通消息(新): text = {"type":"text","id":"<uuid>","timestamp":1754100000,"payload":{"text":"你好"}}
```

### 2.2 结构(四字段)

```json
{
  "type": "text",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1754100000,
  "payload": {}
}
```

| 字段 | 类型 | 作用 |
|---|---|---|
| `type` | string | 注册表判别符(见 §3)。匹配完整 type,未知则显示原文保底。 |
| `id` | UUID | 发送端幂等键。接收端按 `(from_id, id)` 去重业务副作用。**不是实体身份**——实体身份在 payload。 |
| `timestamp` | int | 发送端单调时钟,冲突消解(后到者胜)。 |
| `payload` | object | 类型专属载荷。 |

已删除定稿时的 `from` 字段:发送者身份取消息 `from_id`,app 版本对分派无用。
**无 `version` 字段**:兼容性不靠版本号,靠 payload 强校验——必需字段缺失 → 显示原文,未知字段 → 忽略(见 §5.1)。

### 2.3 识别(形状启发式)

接收端对每条消息:

```
text 以 "{" 开头
  → JSON.parse 成功
  → type/id/timestamp/payload 四字段齐全
  → 是信封;否则 → 普通文本(显示原文)
```

误报分析:用户需恰好发出四字段齐全且 `type` 命中注册表的 JSON 才算信封,实际不可能。这是纯 JSON 载体下唯一可行的识别方式,协议保证由「type ∈ 注册表」兜底。

## 3. 类型注册表(聊天消息类型)

本期只有三个 type,均为**聊天消息形态**,不含业务实体(卡片/邀请等后置):

| type | 语义 | payload | 发送命令 |
|---|---|---|---|
| `text` | 普通文本 | `{text}` | `send_text` |
| `reply` | 引用回复 | `{text, quote_msg_id}` | `send_reply` |
| `media` | 媒体(统一,`media_type` 区分) | `{media_type, mime, name, size}` | `send_voice`(其余留位) |

`media.media_type` ∈ `image / voice / video / file / audio`(webxdc 后置)。

分派规则:

- `type` 命中注册表 → 渲染对应气泡 + 附件 + 执行业务副作用。
- 结构合法但 `type` 未知(如新版本类型、老端)→ 显示原文保底,不丢消息。
- `type` 命中注册表但 payload **必需字段缺失**(读不懂)→ 显示原文保底。

## 4. 发送端(后端统一组装)

### 4.1 buildEnvelope 纯 JSON 版

`envelope.rs` 的 `build_envelope(type, payload)` **去掉 `[PEYT]` 前缀**,输出纯 JSON 字符串。字段:type/id(uuid)/timestamp/payload。无 version、无 `from`。

### 4.2 发送路径收敛(V0:send_text)

| 发送路径 | type | payload | 备注 |
|---|---|---|---|
| `send_text` | `text` | `{text}` | **V0 唯一实现** |
| `send_reply` | `reply` | `{text, quote_msg_id}` | 保留 core `set_quote`(引用关系给通知/跨端) |
| `send_voice` / 图片 / 视频 / 文件 / webxdc | `media` | `{media_type, mime, name, size}` | 二进制 blob 仍挂 core 附件(`view_type` + file) |

### 4.3 媒体表示

媒体消息的正文是信封 JSON(`media`),**文件 blob 由 core 管理**(`view_type=Image/File/Voice/...` + file,接收端经现有 `transformBlobURL` 读取)。信封负责「类型语义 + 可读描述」,core 负责「文件传输」。**core 零改动**。

## 5. 接收端(前端统一解析 + 渲染管线)

### 5.1 管线

```
renderMessage(text):
  env = tryParseEnvelope(text)
  ├─ 失败(null)          → 渲染原文(旧消息/非信封兜底;is_info 保持信息行样式)
  ├─ 成功但 type 未知     → 渲染原文保底
  ├─ 成功、type 已知但
  │   payload 必需字段缺失 → 渲染原文保底
  └─ 成功且 type 已知     → 渲染对应气泡/附件(payload 多余未知字段忽略)
```

兼容性靠「读不读得懂」决定,不靠版本号:加字段 → 老端忽略新字段;删字段/改类型 → 老端必需字段缺失 → 显示原文。

### 5.2 幂等去重

- 信封消息**始终显示在聊天流**,去重不删除 UI。
- 业务副作用按 `(from_id, id)` 幂等:模块级 `Map<string, boolean>` 记录已处理 id,重复消息跳过副作用、正常显示 UI。重启后重处理一次,底层 upsert 命令本身幂等,无脏数据。
- 事件路径(`handleIncomingMsg`)+ 历史加载路径(`renderAllMessages`)都过同一管线,防止「事件已处理、历史又处理一次」。

### 5.3 渲染

| type | 渲染 |
|---|---|
| `text` | 普通气泡,取 `payload.text` |
| `reply` | 引用块(`quote_text` 先 `tryParseEnvelope` 还原)+ 回复正文 |
| `media` | 现有附件渲染(图片/语音/文件卡片),`payload` 提供名称/大小 |
| 未知 type / 解析失败 | 显示原文(降级为普通文本气泡) |

## 6. 显示点全覆盖

普通文本变 JSON 后,凡「把消息当文本用」的地方都要先还原:

| 显示点 | 处理 |
|---|---|
| 消息气泡 | `renderMessage` 走 §5 管线 |
| 引用回复 | `quote_text` 存的是被引用的 JSON → 渲染时 `tryParseEnvelope(quote_text)` 取 `payload.text`;解析失败显示原文 |
| 原生通知 | 自建通知(notifications.rs + shell 拼 body)→ 拼 body 前先还原文本 |
| 搜索 | **前端化**(`get_all_messages` + 前端过滤)→ 索引还原后的文本;`search_msgs` core 命令失效,不再使用 |
| 媒体附件 | `media` 信封 + core blob 附件渲染 |
| 已读回执 / 反应 / reply 关系 | core 原生,不经正文,不受影响 |

## 7. 兼容与降级

- 解析失败 / type 未知 / payload 必需字段缺失 → 显示原文(旧消息、异常格式、读不懂的数据都自然兜底)。
- 原生 Delta Chat 用户看到 JSON 文本(不做互通,接受)。
- `is_info` 系统消息由 core 生成,不经我们的发送端 → 天然非信封 → 显示原文 + 信息行样式。
- 弃用后旧 `[CARD]`/`[PEYT]`/`[PEYT_INVITE]` 消息不再解析,显示原文(历史数据保留,不可读但可见)。

## 8. 关键实现注意

### 8.1 身份引用约束

payload 内实体引用禁用本地 id(跨设备不一致),必须用稳定标识。V0 的 `text` 不涉及实体引用;`reply.quote_msg_id` 引用 core 的 `msg_id`(DC 稳定 id,随消息图生灭,无悬空)。业务类型(卡片等)的稳定标识约束在**后置设计**时承接。

### 8.2 字段全名风格

信封 JSON 会出现在聊天流(降级时)和调试页,字段不缩写,payload 内部同样约束。

## 9. 明确不做(本期)

- `reply` / `media` 的发送、渲染本期不实现(type 已入注册表,后一批加)。
- 转发(`forward`)、webxdc、名片、通话 type 后置。
- **业务扩展 type 后置设计**:卡片(create/update/delete)、邀请、角色、置顶、待办的 type 与 payload 本期不进协议——它们不是聊天消息形态,是业务实体,另行设计。
- inbox_events / activities 是本地派生投影,不入协议。
- 插件共享数据留作未来扩展点。
- **core 零改动**:本协议全部实现在 `src-tauri` + `src`,不碰 `core/` submodule。
- **不做互通**:不注册/不处理 Delta 其他客户端的前缀协议,与 Delta 抢的只是 scheme(OPENPGP4FPR)既定决策。

## 10. 验收要点(V0)

1. 发送文本 → 聊天流显示普通气泡(还原 `payload.text`),正文实为 JSON。
2. 旧普通消息(非 JSON 文本)→ 显示原文,不崩。
3. `text` 信封的 payload 必需字段缺失 / type 未知 / 非 JSON → 显示原文,不崩。
4. 通知 body 显示还原后的文本,而非 JSON(涉及时)。
5. 搜索能命中普通文本内容(走前端过滤,涉及时)。
