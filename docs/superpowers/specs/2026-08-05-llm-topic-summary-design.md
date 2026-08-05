# 主题总结 · LLM 双车道设计

日期:2026-08-05
状态:设计定稿
范围:将聊天主题总结从「纯前端词频聚类」升级为「LLM 智能总结」——本地小模型(旁路 llama-server 进程)或 OpenAI 兼容 API 双来源,气泡秒出短摘要 + 弹窗展开详细分析,带自定义标签解析与模糊跳转。

## 1. 背景与动机

现有主题总结 `computeTopics`(wordAnalysis.ts)是**纯前端共现聚类**,输出 2-3 词词簇短语。用户想要**更高质量的语义总结**:一句话短摘要 + 结构化详细分析(主题标签/关键要点/待办事项),且**允许用户选择本地 LLM 或 API 双来源**。

方案核心:**本地小模型通过旁路 llama-server 进程推理**(方案 A),而非前端 WASM(方案 B,WebGPU 不稳定)或 Rust 内嵌 ort(方案 C,编译爆炸)。旁路进程方案跨三端代码一致,零重编译负担。

## 2. 已敲定决策

| 维度 | 决策 |
|---|---|
| 引擎 | **方案 A:llama-server 旁路进程**(tokio `Command` 拉起,HTTP 查询) |
| LLM 来源 | **本地小模型 + API 双模式**(API 复用现有 `llm.rs` LlmClient) |
| 本地模型档位 | **0.5B / 1.5B 两档可选**,Q4_K_M 量化 |
| 模型源 | ModelScope 优先(HF 兜底),GGUF 直链 `resolve/<branch>/<file>` |
| 引擎源 | llama.cpp GitHub releases(锁定 tag,CPU 产物) |
| 输出 | 气泡短摘要(bubble 车道) + 弹窗详细分析(detail 车道),**两次独立请求** |
| 流式 | 两车道均 SSE 流式,「输出即答案」,气泡打字机效果 |
| 上下文窗口 | **方式 2:上次分析 + 最近 N 条**(非增量,无 after_id) |
| 附件隔离 | 只传 `payload.text`;附件仅留一行 `[附件: 文件名]`;信封非 text 字段不带 |
| AI 引用 id | 统一 `msg_id`(数字);不传 UUID;标签 `<message='...'>` 模糊匹配 |
| 状态 | `idle / summarizing(流式) / done / error / fallback` |
| 错误处理 | 后端集中,事件回传;任何失败降级到词频聚类,不阻断聊天 |
| 持久化 | 偏好→localStorage;引擎/模型状态+摘要缓存→`app-data/summary_state.json`;API 凭据→后端表 |

## 3. 架构

```
┌─ 前端 (webview) ─────────────────────────────────────────────┐
│  气泡状态机 (idle / summarizing / done / error / fallback)    │
│    ├ 词频模式 → 现 computeTopics() 不动                       │
│    └ LLM 模式 → 展示上次摘要 / 流式打字 / 降级词频             │
│  弹窗: 短摘要 + 标签 + 要点 + 待办, 解析 <user>/<message>      │
│  tagParser (白名单转义, 只放行两个标签)                        │
│  队列前端侧: 300ms 防抖 + 每聊天去重 + 切会话取消              │
└──────────────┬───────────────────────────────────────────────┘
               │ enqueue_summary{chatId, lane, window}
               │ ← events: summary-event {chatId, lane, status, ...}
┌─ Rust 后端 ──────────────────────────────────────────────────┐
│  SummaryQueue: 本地推理串行(信号量=1), API 并发,               │
│    每聊天每车道保留最新, 旧任务取消                            │
│  LocalRunner: 拉起/复用 llama-server 子进程(12700 起),         │
│    /health 就绪检查, POST /v1/chat/completions?stream=true     │
│  ApiRunner:   复用 llm.rs 的 LlmClient(零新增依赖)              │
│  Downloader:  引擎二进制(GitHub releases) + 模型 GGUF           │
│    (ModelScope 优先/HF 兜底), 进度事件, 断点续传, sha256        │
└───────────────────────────────────────────────────────────────┘
```

**关键设计点**

1. **窗口由前端决定,后端只负责推理。** 前端持有 `state.messages` 和 `resolveMessageText`(信封解析在前端),由前端截取上下文窗口传给后端,后端不碰 core 读库/信封解析。
2. **后端队列 = 本地串行 + API 并发。** 本地 llama-server 单进程,信号量容量 1;API 远端天然并发。前端只管何时入队,状态回传走 Tauri event。
3. **引擎 + 模型都走一键下载**,不打进安装包。
4. **零重编译负担**:tokio `Command` + reqwest 均已有,不引入 ML crate。
5. **两种模式都有降级路径**,不阻断聊天。

## 4. 双车道队列 + 流式

### 4.1 两条请求车道

| 车道 | 请求 | 内容 | 触发 | 优先级 |
|---|---|---|---|---|
| **Bubble** | `summarize_bubble` | 一句话摘要(<100字) | 入会/新消息/刷新 | **高**(抢占) |
| **Detail** | `analyze_detail` | 结构化分析(摘要+标签+要点+待办,含 `<user>`/`<message>`) | popup 打开/手动刷新 | 低(后台) |

两车道共享同一输入上下文(方式 2:上次分析 + 最近 N 条),仅 prompt 不同。

### 4.2 流式「输出即答案」

```
前端入队 → 气泡"总结中…"+呼吸灯 → 引擎/API 生成 token
        → Rust 解析 SSE → 逐块 event {chatId, delta}
        → 前端逐字追加到气泡文本, 呼吸灯继续
        → 流结束 → 呼吸灯淡出, 状态 done, 摘要落盘
```

- llama-server `/v1/chat/completions?stream=true` 返回 OpenAI 兼容 SSE;API 模式同格式,Rust 一个 SSE 解析器两者复用。
- 「总结中…」被首 token 实时替换成摘要本身(打字机),不干等转圈。
- `done` 后新消息进来 → 回到 `summarizing`:**旧摘要保留**(不清空),新 token 追加/覆盖,不闪空。

### 4.3 双车道优先级(本地单进程关键)

- **bubble 优先于 detail**:detail 生成中若 bubble 到达 → 中断 detail(Rust 断开 HTTP 流,llama-server 检测断连即取消生成),detail 标记 stale 排到队尾。popup 开着显示「分析被新消息打断,点击刷新重试」。
- API 模式无此压力(远端并发),两车道可并行,仅 Rust 侧限单聊天不重复。

### 4.4 上下文窗口(方式 2:上次分析 + 最近 N 条)

```
输入 = 上次分析结果(结构化) + 最近 N 条消息(N≈50,或 ~1500 字先到先停)
输出 = 更新后的完整分析(同格式)
```

- 不做增量窗口(after_id),不传 UUID。
- 首次进入无上次分析 → 退化为首窗口(最近 ~100 条 / ~1500 字)。
- 分析结果持久化,重启恢复 `done` 状态。

## 5. 附件隔离(只传 text + id)

`MsgDto` 附件是 `file/file_mime/file_name/file_bytes` 平级字段。构造 LLM 输入时**根本不读附件字段**,附件进不了上下文。

每条消息进 LLM 输入的一行:

```
[id=<msg_id>] <sender_name>: <payload.text 或 原文>       ← 普通文本/信封正文
[id=<msg_id>] <sender_name>: [附件: <file_name>]         ← text 空且有 file(仅文件名,无内容)
```

- 信封:只取 `payload.text`,**其它 payload 字段不带**;锚点 id 统一用 `msg_id`,不用信封 uuid。
- 附件行:仅文件名,无正文无内容(默认开,可开关控制)。
- 系统消息 `is_info` 跳过(与 `computeTopics` 一致)。

## 6. 标签解析(白名单 + 模糊匹配)

### 6.1 AI 输出格式约定

AI 输出里嵌入类 XML 标签,客户端解析成可点击元素。**只放行两个标签**,其余一律转义。

| 标签 | 语义 | 客户端解析 |
|---|---|---|
| `<message='...'>` | 引用一条消息 | 按 msg_id 精确/内容模糊匹配 → 跳转原文 |
| `<user='...'>` | 引用一位用户 | 按名字匹配成员 → 成员 popup |

**渲染顺序(防注入)**:先对整段 `escapeHtml`,再用白名单正则把两个标签替换成受控 HTML;标签参数值也要 escapeHtml(防 `<text_id='"><script>'>`)。即「先整体转义,再白名单解包」。

### 6.2 `<message>` 模糊匹配(客户端)

```
正则 /<message='([^']+)'>/ → 值可能是 "42"、"下午三点"、"张" 等子串

解析流程:
  1. 值能解析成单个数字 → 精确匹配 msg_id
  2. 否则 → 在当前会话 state.messages 里模糊匹配:
     · 维度: msg_id 数字、from_name、payload.text 内容、文件名
     · 按相关性排序, Top N(默认 3)
  3. 命中 1 条 → 直接跳转(滚动 + 高亮闪烁)
  4. 命中 >1 条 → 鼠标旁 popup 列表, 点击消息项跳转
  5. 0 条 → toast「未找到匹配消息」(不报错,不可点文本)
```

### 6.3 `text_id` 的来源与语义

- **`text_id` = 消息的 `msg_id` = Delta core `MsgId::to_u32()`**(`msg_to_dto`,commands.rs:560)。单账号数据库内全局唯一、单调递增、稳定,不因消息类型而异。
- 前端构造输入用 `[id=<MsgDto.msg_id>]`;AI 引用 `<message='123'>`(数字=msg_id);客户端按 `msg_id` 精确/模糊查找。`send_text` 返回同一套 `to_u32()`——全链路同源。
- 信封的 uuid **不参与** AI 上下文。

### 6.4 跨库撞号的处理(本地锚定义)

`msg_id` 是**单账号本地主键**,跨数据库/跨用户会撞号。但引用只在**生成它的那台机器、那个账号、那个会话**内解析(总结本地生成、本地持久化、本地消费),`msg_id` 单账号全局唯一 + 限定当前会话 = 本地永远无歧义。

- 定义:**引用为本地锚,非可移植标识**。
- 解析限定当前会话,绝不去别的会话/用户撞 id。
- **内容优先,id 只是提示**:AI 可发 `<message='内容片段'>`,客户端先精确 id 后内容模糊匹配,解析正确性不依赖 id 唯一性。
- 若将来做分享/跨设备同步,再换稳定标识(内容 hash / 协议层定位),本期不做。

## 7. 下载器

### 7.1 下载源(已核实)

**引擎** — llama.cpp GitHub releases,锁定 tag(本期 `b10276`),CPU 产物:

| 平台 | 文件 |
|---|---|
| Windows x64 | `llama-b10276-bin-win-cpu-x64.zip` |
| macOS Apple Silicon | `llama-b10276-bin-macos-arm64.tar.gz` |
| macOS Intel | `llama-b10276-bin-macos-x64.tar.gz` |
| Linux x64 | `llama-b10276-bin-ubuntu-x64.tar.gz` |
| Linux arm64 | `llama-b10276-bin-ubuntu-arm64.tar.gz` |

URL 模板 `https://github.com/ggml-org/llama.cpp/releases/download/<tag>/<asset>`。

**模型** — GGUF,ModelScope 优先(HF 兜底),`resolve/<branch>/<file>` 直链:

| 档位 | 模型 | 文件 | 体积 |
|---|---|---|---|
| 0.5B | `second-state/Qwen2.5-0.5B-Instruct-GGUF` | `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` | ~0.4GB |
| 1.5B | `Qwen/Qwen2.5-1.5B-Instruct-GGUF` | `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` | ~1GB |

- ModelScope: `https://modelscope.cn/models/<repo>/resolve/master/<file>`
- HF 兜底: `https://huggingface.co/<repo>/resolve/main/<file>`
- 下载后 **sha256 校验**。

### 7.2 落地与跨端 post-process

```
app-data/models/
  ├─ llama-server(.exe)
  ├─ qwen2.5-0.5b-q4km.gguf (或 1.5b)
  └─ summary_state.json   { engineVersion, model, sha256, lastSummary }
```

下载器返回 `{ path, needExecBit, needQuarantineClear }`,统一 post-process(平台差异收在一个函数):

- Windows: 解压 zip。
- macOS: `xattr -d com.apple.quarantine <path>`(网络下载带隔离属性,不清会触发 Gatekeeper)。
- Linux: `chmod +x`(zip 解压默认无执行位)。

### 7.3 跨端结论

进程模型把平台差异压缩到一行表(资产名 + 可执行名),Rust spawn/HTTP 三端一致,Tauri 三端编译,下载源纯 HTTPS 三端通用。**方案 A 是三个方案里唯一三端同一套代码能跑起来的。**

### 7.4 明确不做(本期)

- 不内置 Ollama 作为替代引擎(另一个下载源 + 协议)。
- 不做引擎「检查更新」自动检查(锁定 tag,手动更新)。

## 8. 设置页(新增「智能」section)

`settingsPage.ts` sections 数组加 `{ id: 'intelligence', icon: 'sparkles', label: '智能' }`,`SettingsSection` 类型加 `'intelligence'`。

### 8.1 总结引擎

| 控件 | 说明 |
|---|---|
| 模式开关 | `off / 词频(当前) / LLM` 三选一 |
| LLM 来源 | 本地模型 / API 二选一(LLM 模式启用时显示) |
| 本地模型 | 0.5B / 1.5B 两档 radio,**仅记录选择,不触发下载** |
| 下载按钮 | 点「下载」→ 展开进度面板(见 8.3) |

### 8.2 API 配置(来源=API 时显示)

复用 Bot 的 `LLM_PRESETS` 式表单:`base_url` + `api_key` + `model` + 测试按钮。落盘到后端设置表,**与 Bot 的 LLM 配置独立**(主题总结 api_key 不共用/不泄露到插件面)。

- 复用 `llm.rs` 的 `LlmClient` 做**纯文本补全**(无 tool 调用);`test_llm_config` 即纯文本路径,直接沿用。
- API 模式仅支持 OpenAI 兼容协议(base_url + api_key + model 三者齐即视为可配置,对齐 `is_llm_configured`)。

### 8.3 下载进度面板(合理排版)

```
引擎    [████████░░] 80% · 3.2/4.0 MB · 00:12 · 剩余 00:03
模型    [等待引擎完成 →] 排队中
校验    sha256 … 待校验
```

| 状态 | 显示 |
|---|---|
| 选档后 | 右侧「下载」按钮(不自动下载) |
| 进行中 | 进度条 + 百分比 + 已下载/总大小 + 已耗时(mm:ss) + ETA(mm:ss) |
| 完成 | 「已下载」徽章 + 总耗时 + sha256 打勾 |
| 失败/断点 | 「继续」按钮(断点续传) + 失败原因 |

- 引擎优先下载,模型排队(`waiting` 状态),避免并发争带宽。
- 数据来自 `download-progress` 事件 `{id, bytesDone, total, rate}`,前端节流更新(如每 200ms)。

### 8.4 持久化分层

| 数据 | 存储 |
|---|---|
| 偏好(模式/来源/所选档位) | localStorage(`peyt.summary.*`) |
| 引擎/模型状态 + 版本 + sha256 + 上次摘要缓存 | `app-data/summary_state.json`(后端读写) |
| API 凭据 | 后端设置表(对齐 `github_settings`,key 不进 localStorage) |

重启后前端 `get_llm_model_status` 恢复开关。

## 9. 气泡状态机(纯前端)

```
          ┌──────────────────────────────────────┐
          │         LLM 模式开 + 模型已下载        │
          ▼                                      │
  idle ──► summarizing ──► done ──┐              │
   │          │   ▲              │              │
   │          ▼   └──error───────┘              │
   └────────► fallback ──────────────────────────┘
              (词频聚类结果)
```

| 状态 | 气泡显示 | 触发 |
|---|---|---|
| `idle` | 上次的 `done` 摘要(若有),否则占位 | 初始 |
| `summarizing` | 阴影呼吸灯 + 「总结中…」→ 首 token 实时替换 | 入队后立即 |
| `done` | LLM 短摘要(`<user>`/`<message>` 已解析) | `summary-event` status=done |
| `error` | 词频聚类短语(降级),可点刷新重试 | 引擎失败/超时 |
| `fallback` | 词频聚类短语 | 未下载模型 / 关闭 LLM 模式 |

- `done → summarizing`:新消息触发重新总结,**旧摘要保留**直到新结果回来(避免闪空)。
- `error` 可点刷新重试(对应弹窗刷新按钮)。
- 状态由 `summary-event` 事件驱动,后端只发数据不碰 DOM;前端维护 `Map<chatId, state>`。
- 呼吸灯只在 `summarizing` 亮。

### 分析 popup(复用 `wc-popup`)

- 头部「会话主题分析」+ **刷新按钮**(重新入队 `analyze_detail`,立即执行)。
- 区块:短摘要 → 主题标签(chips) → 关键要点(list) → 待办事项(list,checkbox 样式仅展示)。
- `streaming` 中逐块追加;被新消息打断 → 显示「分析已过期,点击刷新」。
- 渲染用标签解析;内容为空显示占位。

## 10. 错误处理与降级

### 10.1 错误分层

错误在**后端**集中处理(它拥有引擎/队列/下载),前端只接收 `summary-event` 的 `status`,不重复判断。

```ts
{ chatId, lane: 'bubble'|'detail', status: 'done'|'error',
  result?: string, error?: { code, message } }
```

### 10.2 错误码表

| code | 含义 | 前端表现 |
|---|---|---|
| `engine_not_ready` | 引擎/模型未下载或未就绪 | 退 `fallback`(词频) + toast 去设置 |
| `engine_start_failed` | 拉起 llama-server 失败 | 退 `fallback` + 日志 |
| `engine_timeout` | 推理超时(如 60s) | 退 `fallback` + toast |
| `engine_crash` | 进程异常退出 | 退 `fallback` + 自动重启一次重试 |
| `api_auth` | API 401/403 | 退 `fallback` + toast「API 凭据错误」 |
| `api_quota` | **API 余额/配额不足(402 或 body 含 quota/insufficient/billing/credit)** | 退 `fallback` + toast「API 余额不足,请充值或在设置切换本地模型」;**停掉该聊天队列,不自动重试**(手动刷新/切换来源后恢复) |
| `api_rate_limit` | API 429 | 退 `fallback` + 提示稍后再试 |
| `api_bad_request` | API 400(如 model 不存在) | 退 `fallback` + toast |
| `api_network` | 网络错误 | 退 `fallback` + toast |
| `window_empty` | 输入窗口为空(无可总结内容) | 气泡隐藏 |
| `cancelled` | 被新消息/切会话打断 | 静默(不 toast,不闪) |

**`api_quota` 识别**:HTTP 402 一律算;429/400 时检查 body 含 `quota|insufficient|billing|credit` 之一命中才算,否则按原类。

### 10.3 降级链

```
LLM done ──失败──► 词频聚类(fallback) ──失败──► 隐藏气泡
```

- 任何时候失败都不阻断聊天。
- `cancelled` 是正常中断(新消息/切会话),**不触发降级、不 toast**——被更新的任务取代,气泡保持当前显示。

### 10.4 超时与引擎生命周期

- 单次推理超时:bubble 60s / detail 120s(超时杀请求,引擎不重启)。
- 引擎不随会话存活:空闲 10 分钟无任务 → kill(释放 ~1GB 内存);下次入队懒启动(`GET /health`,未就绪才 spawn)。
- 崩溃自愈:退出码非 0 → 记 `engine_crash`,自动重启一次再试;连失败两次 → `engine_start_failed`。

### 10.5 幂等与并发护栏

- 同 chat 同 lane 同时只跑一个任务:新入队丢旧(前端防抖 + 后端每 chat 保留最新)。
- 引擎未就绪入队 → `pending` 挂起,引擎就绪后自动消费,不丢任务。

## 11. 测试

### 单元测试(Rust,llm.rs 同目录)

| 测什么 | 断言 |
|---|---|
| 窗口序列化 | 信封/普通/附件/系统消息 → 正确 `[id=n] 名字: 文本` 行 |
| SSE 解析 | llama-server 流式 chunk → 增量 delta |
| 标签白名单 | `<user>`/`<message>` 之外的 `<tag>` 被转义 |
| 队列信号量 | 同 chat 丢旧留新;并发上限 |

### 前端测试(Vitest,src/ 侧)

| 测什么 | 断言 |
|---|---|
| tagParser | 合法/非法标签、转义、多标签、嵌套 |
| 模糊匹配 | 精确命中 1 条 / 多结果排序 / 0 条 |
| 气泡状态机 | 状态转移、呼吸灯 class、降级路径 |

### 手动验证(tauri dev)

- 下载流程:选档 → 点下载 → 进度条/计时/ETA → 断点续传(断网再连)。
- 首次总结:入会 → 呼吸灯 → 流式打字 → done。
- 新消息:旧摘要保留 + 重新总结 → 新摘要覆盖。
- popup:打开 → streaming → done → 刷新。
- 降级:删除模型文件后重启 → 气泡退词频。
- 跨端:三平台跑一遍下载 + 推理冒烟。

**诚实标注**:
- 本地引擎真实推理在 CI 不跑(要下模型 + 推理慢),标为**手动冒烟**;CI 只跑不依赖引擎的纯逻辑单测(序列化/SSE/标签/队列)。
- 下载器的解压/post-process/sha256 是纯逻辑,可单测;但**真实下载真实文件**不进 CI(体积 + 网络),用 fixture 小文件测解压与校验逻辑。

## 12. 明确不做(本期)

- 不做增量窗口(after_id)。
- 不内置 Ollama / 其它引擎。
- 不做分享/跨设备同步总结(本地锚定义)。
- 不做引擎自动更新检查(锁定 tag)。
- 不做信封非 text 字段进上下文。
- 不做附件正文进上下文。
