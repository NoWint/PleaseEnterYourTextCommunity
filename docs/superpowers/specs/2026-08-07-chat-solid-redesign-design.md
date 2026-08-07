# Peytchat Chat 模块 Solid 重构设计

> 日期:2026-08-07
> 范围:前端 chat 体验(消息时间线 + composer + 消息相关组件)用 Solid.js + @opencode-ai/ui 重构
> 参考质感:/Users/xiatian/Downloads/opencode-dev(opencode desktop)
> 架构决策:Solid 岛嵌入 vanilla TS shell(混合方案 A)

---

## 0. 背景与决策记录

### 0.1 现状

peytchat 前端为 Vanilla TypeScript + Vite(无框架),四栏骨架(rail / nav-panel / chat-main / right-drawer)。chat 模块(`src/chat/` + `src/components/` 中消息相关组件)功能完整但以命令式 DOM 操作实现:`shell.ts` 直接操作消息 DOM(`refreshCurrentChat` / `updateMsgState` / `removeMsg` / `refreshMsgReactions`),`message.ts` 用 `innerHTML` 拼接字符串,无虚拟化、无响应式、hover 操作靠手动事件绑定。

### 0.2 决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 技术栈 | Solid.js + @opencode-ai/ui(混合) | 复用参考项目组件与设计系统,不重写 shell |
| 范围 | 仅 chat 体验 | shell/work/pages/plugins/terminal 保留 vanilla TS,后续逐页迁移 |
| 完成标准 | 功能对等 + 交互品质提升 | 对标 Apple Message + Discord,不逊于 opencode desktop 质感 |
| 设计令牌 | 完整 v2 令牌系统 | 与 @opencode-ai/ui 对齐,放弃"纯黑白"偏好(本次决策转变) |
| 共存架构 | Solid 岛嵌入 `#chat-main` | shell 零侵入,Solid 边界清晰 |

### 0.3 质感对齐目标(来自 opencode desktop 研究)

对齐 opencode desktop 的 UI/UX 质感,不只是令牌,还包括:

1. **v2 语义令牌**:全面 `--v2-*` 前缀(background/text/icon/border/overlay/state/elevation)
2. **Inter 可变字体**:字重 530(medium)/ 440(regular),`letter-spacing: -0.04px`(-0.13px 用于 15px+),`line-height: 20px`,`font-variant-numeric: tabular-nums`,`font-variation-settings: "slnt" 0`
3. **虚拟化时间线**:`createVirtualizer` + projection(TimelineRow 联合类型)+ 会话切换缓存
4. **Spring 物理动效**:motion-one spring 用于交互反馈,fadeUp + nth-child 阶梯延迟用于列表进入
5. **三件套悬浮**:ContextMenu(右键操作)/ HoverCard(预览面板)/ Tooltip(文字),`suppressHover` 防冲突
6. **Toast 堆叠透视**:solid-sonner + 320px 固定宽 + 非前置 toast translateY+scale 压缩
7. **Dialog 复合组件**:四档尺寸(normal/large/x-large/fit)+ Header/TitleGroup/Body/Footer
8. **TS 内联 Sprite 图标**:TS 对象定义 + `ensureSprite` 动态注入 `<symbol>` + `<use>` 引用 + currentColor
9. **Aim-peek 交互**:rail 折叠时鼠标移上 200ms 预览,离开 300ms 收回(本次 chat 重构不涉及 rail,但 composer 附件/提及建议复用此延迟模式)
10. **粘底锚定 + jump-to-latest**:用户滚动后停止锚定,浮动按钮带 backdrop-blur + elevation 阴影

---

## 1. 架构

### 1.1 Solid 岛模型

`#chat-main` div 成为 Solid 唯一挂载点。shell 的 `renderMain()`(在 `src/shell/navPanel.ts`)路由到 chat 时,调用 Solid `render(() => <ChatApp />, chatMainEl)`。离开 chat(切到 work/settings 等)时 `cleanup()` 卸载 Solid 树,恢复 vanilla TS 行为。

```
┌─────────────────────────────────────────────────────────────┐
│  vanilla TS shell (main.ts / shell.ts / rail / navPanel)    │
│  ┌────────┬───────────┬──────────────────────┬───────────┐  │
│  │ rail   │ navPanel  │  #chat-main          │ rightDrawer│  │
│  │ (TS)   │ (TS)      │  ┌────────────────┐  │ (TS)      │  │
│  │        │           │  │ Solid <ChatApp>│  │           │  │
│  │        │           │  │  响应式消息流   │  │           │  │
│  │        │           │  │  @opencode-ai/ui│  │           │  │
│  │        │           │  └────────────────┘  │           │  │
│  └────────┴───────────┴──────────────────────┴───────────┘  │
│         │ state.currentChatId 变化 → Solid signal            │
│         │ Tauri onEvent → 适配层 → Solid signals              │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 边界契约

- **shell → Solid**:仅传 `chatId` signal(由 `state.currentChatId` 驱动)与 `locale` signal。shell 不再操作 chat DOM。
- **Solid → shell**:通过 `shellBridge` 回调通知副作用(未读清零、badge 更新、打开 rightDrawer 看成员、切到其他 page)。不反向耦合。
- **Solid → Tauri**:直接调 `call()`(`src/api.ts` 已封装),不经 shell。
- **生命周期**:Solid app 内部用 `onMount`/`onCleanup` 管理事件订阅、滚动恢复。卸载时自动取消订阅。

### 1.3 shell 改动(最小化)

`src/shell/shell.ts` 中以下 chat 相关逻辑迁移到 Solid 后退役(由 Solid 内部响应式接管):

| 退役函数 | 替代 |
|---|---|
| `refreshCurrentChat()` | Solid `chatId` signal 变化触发 `createResource` 拉消息 |
| `appendNewMessages()` | `MsgsChanged` 事件 → Solid signal → 增量追加到 store |
| `updateMsgState()` | `MsgDelivered/Failed/Read` 事件 → store 更新 → 自动重渲染 |
| `removeMsg()` | `MsgDeleted` 事件 → store filter |
| `refreshMsgReactions()` | `ReactionsChanged` 事件 → store 更新 |
| `updateReadCount()` | `MsgReadCountChanged` 事件 → store 更新 |

shell 保留:badge 更新、通知队列、提及检测(或迁移到 Solid,见 §6)、全局快捷键。

### 1.4 目录结构

```
src/
  chat-solid/                     # 新建:Solid chat 模块
    ChatApp.tsx                   # 根组件:订阅 chatId signal,路由子视图
    state/
      chatStore.ts                # createStore:消息列表 + reactions/read 缓存
      signals.ts                  # chatId/locale/typing/scroll 锚定 signal 源
    bridge/
      eventBridge.ts              # Tauri onEvent → Solid signals 适配层
      shellBridge.ts              # Solid → vanilla shell 回调接口
    timeline/
      projection.ts               # MsgDto[] → TimelineRow[] 投影
      useVirtualTimeline.ts       # createVirtualizer 封装 + 会话切换缓存
      MessageTimeline.tsx         # 虚拟化列表 + 粘底锚定 + jump-to-latest
      rows/
        DateDivider.tsx           # 日期分隔
        UnreadSeparator.tsx       # 未读分隔线
        MessageBubble.tsx         # 单条消息(含 hover 操作/reactions/已读)
        SystemMessage.tsx         # 系统消息(加群/退群/改名)
        SummaryBubble.tsx         # LLM 摘要气泡
    components/
      Composer.tsx                # 输入区(@提及/回复预览/附件/草稿)
      ReplyPreview.tsx            # 回复引用预览
      MentionSuggest.tsx          # @提及/#频道建议面板
      ReactionPicker.tsx          # 反应选择器(快捷栏 + 完整面板)
      VoicePlayer.tsx             # 语音播放
      WebxdcCard.tsx              # webxdc 消息卡片
      Gallery.tsx                 # 画廊视图
      MessageHoverActions.tsx     # hover 浮现操作(回复/反应/转发/置顶/删除)
      JumpToLatest.tsx            # 跳到最新浮动按钮
    icons/
      chat-icons.ts               # chat 专用图标定义(TS 内联 sprite)
    styles/
      chat.css                    # chat 专属样式(用 v2 令牌)
    index.tsx                     # mount(chatMainEl, chatIdSignal) 入口
  # 现有 vanilla TS 文件保留;src/chat/ 旧目录迁移完成后删除
```

---

## 2. 设计令牌与排版

### 2.1 v2 令牌引入

在 `src/chat-solid/styles/chat.css` 顶部 import @opencode-ai/ui 的 v2 令牌:

```css
@import "@opencode-ai/ui/v2/styles/theme.css" layer(theme);
@import "@opencode-ai/ui/v2/styles/colors.css" layer(theme);
```

明暗模式由 `data-color-scheme="light|dark"` 属性控制(由 shell `theme.ts` 同步设置到 `document.documentElement`,与现有 `data-theme` 共存)。

### 2.2 语义令牌使用规范

组件中**禁止**使用原始色阶(`--v2-grey-1100`),必须用语义令牌:

| 场景 | 令牌 |
|---|---|
| 消息气泡背景(自己) | `--v2-background-bg-layer-02` |
| 消息气泡背景(对方) | `--v2-background-bg-layer-01` |
| 主文本 | `--v2-text-text-base` |
| 次要文本(时间/已读) | `--v2-text-text-muted` |
| 弱化文本(占位) | `--v2-text-text-faint` |
| 边框 | `--v2-border-border-base` |
| 聚焦环 | `--v2-border-border-focus` |
| hover 覆盖 | `--v2-overlay-simple-overlay-hover` |
| pressed 覆盖 | `--v2-overlay-simple-overlay-pressed` |
| 浮层阴影(气泡操作) | `--v2-elevation-floating` |
| 错误状态 | `--v2-state-fg-danger` / `--v2-state-bg-danger` |
| 成功状态(已读/已送达) | `--v2-state-fg-success` |
| 头像色板 | `--v2-avatar-bg-*` / `--v2-avatar-border-*`(8 色) |

### 2.3 排版规范

| 元素 | 字号 | 字重 | 行高 | 字距 |
|---|---|---|---|---|
| 消息正文 | 13px | 440 | 20px | -0.04px |
| 消息发送者名 | 13px | 530 | 20px | -0.04px |
| 时间戳/已读 | 11px | 440 | 16px | -0.04px |
| composer 输入 | 13px | 440 | 20px | -0.04px |
| 反应计数 | 11px | 530 | 16px | -0.04px |
| 摘要气泡标题 | 15px | 530 | 20px | -0.13px |
| 日期分隔 | 11px | 530 | 16px | -0.04px |

字体:`"Inter", sans-serif`,可变字体(`font-variation-settings: "slnt" 0`),数字用 `font-variant-numeric: tabular-nums`。

### 2.4 密度规范

| 元素 | 尺寸 |
|---|---|
| 消息最大宽度 | `max-w-[640px]`(对话流居中,大屏防拉伸) |
| 消息间距(同发送者) | 4px |
| 消息间距(切换发送者) | 12px |
| 头像 | 28px(normal)/ 20px(dense) |
| 反应胶囊 | height 20px,padding 0 6px,radius 10px |
| hover 操作按钮 | 24x24(icon-button small) |
| composer 最小高度 | 44px(单行),最大 200px |

---

## 3. 消息时间线

### 3.1 TimelineRow Projection

将异质消息抽象成统一的 `TimelineRow` 联合类型,避免组件树深浅不一导致虚拟化测量跳变:

```typescript
type TimelineRow =
  | { kind: "date-divider"; date: string; key: string }
  | { kind: "unread-separator"; key: string }
  | { kind: "message"; msg: MsgDto; key: string; showAvatar: boolean; showSender: boolean; groupedWithPrev: boolean }
  | { kind: "system"; msg: MsgDto; key: string }
  | { kind: "summary"; summary: SummaryData; key: string }
  | { kind: "typing"; userId: number; key: string }
```

projection 逻辑(`projection.ts`):
1. 按时间排序消息
2. 插入日期分隔(跨天)
3. 插入未读分隔线(第一条未读消息前)
4. 合并连续同发送者消息(`groupedWithPrev: true`,隐藏头像与名字)
5. 系统消息(加群/退群)单独投影
6. LLM 摘要气泡插入到消息流顶部或按时间位置

### 3.2 虚拟化

使用 `@tanstack/solid-virtual` 的 `createVirtualizer`:

```typescript
const virtualizer = createVirtualizer({
  count: rows().length,
  getScrollElement: () => scrollRef(),
  estimateSize: (i) => estimateRowHeight(rows()[i]),
  overscan: 50,
  paddingEnd: 64,
  getItemKey: (i) => rows()[i].key,
  initialMeasurementsCache: cacheFor(chatId())?.measurements,
});
```

- **estimateSize**:按 row kind 估测(message 60px / summary 120px / date-divider 32px / system 28px / typing 24px)
- **会话切换缓存**:`Map<chatId, { measurements, toolOpen }>`,最多 16 个,LRU 淘汰。切换回来时 `initialMeasurementsCache` 防闪烁。
- **行渲染**:绝对定位 `position: absolute; top: item.start`,`transform: translateY`。

### 3.3 粘底锚定

```typescript
const shouldAnchorBottom = createSignal(true);

// 新消息到达时,若 shouldAnchorBottom 则 scrollToEnd
createEffect(() => {
  const last = rows()[rows().length - 1];
  if (last && shouldAnchorBottom()) {
    queueMicrotask(() => virtualizer.scrollToEnd());
  }
});

// 用户手动滚动 → 停止锚定
const onScroll = (e) => {
  const atBottom = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80;
  shouldAnchorBottom.set(atBottom);
};
```

### 3.4 Jump-to-Latest 浮动按钮

用户不在底部时显示,对齐 opencode 质感:

```tsx
<Show when={!shouldAnchorBottom()}>
  <button
    class="jump-to-latest"
    style={{
      "background": "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
      "backdrop-filter": "blur(2px)",
      "box-shadow": "var(--v2-elevation-raised), 0px 2px 8px var(--v2-background-bg-base)",
    }}
    onClick={() => virtualizer.scrollToEnd()}
  >
    <svg width="16" height="16" viewBox="0 0 16 16"><!-- 内联箭头 SVG --></svg>
  </button>
</Show>
```

位置:`absolute bottom-8 right-8`,过渡 `transition-all duration-200 ease-out`(出现 opacity-100 translate-y-0 scale-100,消失 opacity-0 translate-y-2 scale-[0.8])。

### 3.5 嵌套滚动边界

代码块、webxdc 卡片内部可滚动时,`data-scrollable` 标记,滚动事件触底才透传给外层时间线(对齐 opencode `markBoundaryGesture`)。

---

## 4. 组件设计

### 4.1 MessageBubble

```tsx
function MessageBubble(props: { row: MessageRow }) {
  const msg = () => props.row.msg;
  const isOut = () => msg().is_out;
  const reactions = () => chatStore.reactions(msg().msg_id);
  const readCount = () => chatStore.readCount(msg().msg_id);

  return (
    <div
      class="message-row"
      classList={{ "is-out": isOut(), "grouped": props.row.groupedWithPrev }}
      data-msg={msg().msg_id}
    >
      <Show when={!props.row.groupedWithPrev && !isOut()}>
        <Avatar size="small" fallback={msg().from_name} src={msg().from_avatar} />
      </Show>
      <div class="message-content">
        <Show when={!props.row.groupedWithPrev}>
          <span class="message-sender">{msg().from_name}</span>
          <span class="message-time">{formatTime(msg().ts)}</span>
        </Show>
        <div class="message-bubble" data-state={msg().state}>
          <MessageContent msg={msg()} />
          <Show when={reactions().length > 0}>
            <ReactionCapsules msgId={msg().msg_id} reactions={reactions()} />
          </Show>
        </div>
        <Show when={isOut()}>
          <span class="message-state" data-read-popup={msg().state === "read"}>
            {stateLabel(msg().state, state.currentChatIsGroup, readCount())}
          </span>
        </Show>
      </div>
      <MessageHoverActions msg={msg()} />
    </div>
  );
}
```

**MessageContent** 按 `view_type` 分发:
- `text` → markdown 渲染(@opencode-ai/ui 的 `Marked` 组件,配 shiki 代码高亮)
- `image` → 图片预览(@opencode-ai/ui `ImagePreview`)
- `file` → 文件卡片(@opencode-ai/ui `FileIcon` + 文件名 + 大小 + 下载按钮)
- `voice` → `<VoicePlayer>`
- `webxdc` → `<WebxdcCard>`
- `video` → 视频播放器

### 4.2 MessageHoverActions

对齐 opencode 三件套悬浮 + suppressHover:

```tsx
function MessageHoverActions(props: { msg: MsgDto }) {
  const [suppressHover, setSuppressHover] = useSuppressHover();
  return (
    <ContextMenu
      modal={!suppressHover()}
      trigger={(triggerProps) => (
        <div class="hover-actions" {...triggerProps}>
          <IconButton icon="reaction" size="small" variant="ghost" onClick={() => openReactionPicker(props.msg)} />
          <IconButton icon="reply" size="small" variant="ghost" onClick={() => setReplyTo(props.msg)} />
          <IconButton icon="more" size="small" variant="ghost" />
        </div>
      )}
    >
      <ContextMenuItem data-action="reply" onSelect={() => setReplyTo(props.msg)}>回复</ContextMenuItem>
      <ContextMenuItem data-action="react" onSelect={() => openReactionPicker(props.msg)}>添加反应</ContextMenuItem>
      <ContextMenuItem data-action="forward" onSelect={() => openForward(props.msg)}>转发</ContextMenuItem>
      <ContextMenuItem data-action="copy" onSelect={() => copyMessage(props.msg)}>复制</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem data-action="pin" onSelect={() => togglePin(props.msg)}>{isPinned ? "取消置顶" : "置顶"}</ContextMenuItem>
      <Show when={props.msg.is_out}>
        <ContextMenuItem data-action="delete" variant="danger" onSelect={() => confirmDelete(props.msg)}>删除</ContextMenuItem>
      </Show>
    </ContextMenu>
  );
}
```

- hover 时 `.hover-actions` `opacity-100`(默认 `opacity-0`),`transition-opacity duration-150`
- 右键菜单打开时 `suppressHover=true`,关闭后恢复
- 所有可点击元素带 `data-action` + `data-msg` 语义属性(便于 e2e 测试)

### 4.3 ReactionPicker

```tsx
function ReactionPicker(props: { msg: MsgDto; onClose: () => void }) {
  // 快捷栏 7 个 + 展开完整面板 44 个(与现有 reactionPanel 一致)
  return (
    <Popover placement="top" gutter={4}>
      <div class="reaction-picker">
        <div class="reaction-quick">
          <For each={REACTION_QUICK}>{(emoji) => (
            <button class="reaction-item" onClick={() => sendReaction(props.msg, emoji)}>{emoji}</button>
          )}</For>
        </div>
        <Show when={expanded()}>
          <div class="reaction-panel">
            <For each={REACTION_PANEL}>{(emoji) => (
              <button class="reaction-item" onClick={() => sendReaction(props.msg, emoji)}>{emoji}</button>
            )}</For>
          </div>
        </Show>
        <IconButton icon="expand" size="small" onClick={() => setExpanded(!expanded())} />
      </div>
    </Popover>
  );
}
```

反应胶囊 pop 动效:spring(scale 0→1)+ fadeUp,nth-child 阶梯延迟(对齐 opencode fadeUp)。

### 4.4 Composer

Controller + State 分离(对齐 opencode `createPromptInputController`):

```typescript
// useComposerController.ts
function createComposerController(chatId: Accessor<number>) {
  const [text, setText] = createSignal("");
  const [replyTo, setReplyTo] = createSignal<MsgDto | null>(null);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [mode, setMode] = createSignal<"collapsed" | "expanded">("collapsed");
  const blank = createMemo(() => !text() && attachments().length === 0 && !replyTo());
  const sending = createSignal(false);

  // 草稿防抖 500ms
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(on(text, (t) => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => call("set_draft", { chatId: chatId(), draft: t }), 500);
  }));

  // 加载草稿
  createEffect(on(chatId, async (id) => {
    const draft = await call<string | null>("get_draft", { chatId: id });
    setText(draft ?? "");
    setReplyTo(null);
    setAttachments([]);
  }));

  const send = async () => {
    if (blank() || sending[0]()) return;
    sending[1](true);
    // 乐观更新:临时消息
    const tempId = `temp-${Date.now()}`;
    chatStore.appendOptimistic({ msg_id: tempId, text: text(), _state: "sending", ... });
    try {
      await call("send_msg", { chatId: chatId(), text: text(), replyTo: replyTo()?.msg_id, attachments: attachments() });
      setText(""); setReplyTo(null); setAttachments([]);
    } catch (e) {
      chatStore.updateMsgState(tempId, "failed");
      toasterV2.show(({ toastId }) => <div class="text-13-regular text-v2-state-fg-danger">{e instanceof Error ? e.message : String(e)}</div>, { persistent: false });
    } finally {
      sending[1](false);
    }
  };

  return { text, setText, replyTo, setReplyTo, attachments, setAttachments, mode, setMode, blank, sending: sending[0], send };
}
```

**交互**:
- 收起模式:单行自动增高,Enter 发送,Ctrl+Enter 换行
- 展开模式:大 textarea(顶部可拖拽调高),Enter 换行,Ctrl+Enter 发送
- `@` 触发 MentionSuggest(成员名),`#` 触发频道引用
- 附件按钮 → 文件选择器(系统)→ 附件预览缩略图
- 回复预览(ReplyPreview)在输入区上方,可关闭
- **空输入 + 会话进行中 = 停止信号**(对齐 opencode):若 `sending` 且 `blank`,发送按钮变停止按钮(本次 IM 场景发送是瞬时的,此条降级为:发送中禁用按钮 + 显示 spinner)

### 4.5 MentionSuggest

```tsx
function MentionSuggest(props: { query: string; kind: "@" | "#"; position: number; onPick: (item) => void }) {
  const items = createMemo(() => {
    if (props.kind === "@") return filterMembers(props.query);
    return filterChannels(props.query);
  });
  return (
    <Popover placement="top-start" gutter={4} open={items().length > 0}>
      <div class="mention-suggest">
        <For each={items()}>{(item) => (
          <button class="mention-item" data-action="mention-pick" onClick={() => props.onPick(item)}>
            <Show when={item.type === "member"}><Avatar size="small" fallback={item.name} /></Show>
            <span>{item.name}</span>
          </button>
        )}</For>
      </div>
    </Popover>
  );
}
```

键盘导航:↑↓ 选择,Enter 插入,Esc 关闭。

### 4.6 VoicePlayer / WebxdcCard / Gallery

- **VoicePlayer**:波形 + 播放/暂停 + 进度 + 倍速。用 `@solid-primitives/media`。
- **WebxdcCard**:卡片预览(图标 + 名称 + 描述)+ 打开按钮(点击在 rightDrawer 或新窗口打开 webxdc)。
- **Gallery**:频道内所有图片/视频网格视图,点击放大(@opencode-ai/ui `ImagePreview`)。

### 4.7 SummaryBubble(LLM 摘要)

保留现有 60s 防抖逻辑,迁移到 Solid:

```tsx
function SummaryBubble(props: { chatId: number }) {
  const [summary, setSummary] = createSignal<SummaryData | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);

  // 60s 防抖:新消息到达后 60s 触发重算
  let timer: ReturnType<typeof setTimeout> | null = null;
  createEffect(on(() => chatStore.lastMsgTs(props.chatId), () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => refreshSummary(), 60_000);
  }));

  return (
    <Show when={summary()} fallback={refreshing() && <TextShimmer />}>
      <div class="summary-bubble">
        <div class="summary-title">{summary().title}</div>
        <For each={summary().topics}>{(t) => <div class="summary-topic">{t}</div>}</For>
      </div>
    </Show>
  );
}
```

---

## 5. 数据流与状态

### 5.1 chatStore

```typescript
// chatStore.ts
import { createStore, produce } from "solid-js/store";

interface ChatStoreState {
  messages: Record<number, MsgDto[]>;        // chatId → messages
  reactions: Record<number, Reaction[]>;     // msgId → reactions
  readCounts: Record<number, number>;        // msgId → read count
  pinnedMsgIds: Record<number, Set<number>>; // chatId → pinned set
  lastMsgTs: Record<number, number>;         // chatId → last msg ts
}

const [store, setStore] = createStore<ChatStoreState>({
  messages: {}, reactions: {}, readCounts: {}, pinnedMsgIds: {}, lastMsgTs: {},
});

export const chatStore = {
  messages: (chatId: number) => store.messages[chatId] ?? [],
  reactions: (msgId: number) => store.reactions[msgId] ?? [],
  // ... getters
  appendMessages: (chatId: number, msgs: MsgDto[]) => setStore("messages", chatId, (prev) => [...(prev ?? []), ...msgs]),
  appendOptimistic: (chatId: number, msg: MsgDto) => setStore("messages", chatId, (prev) => [...(prev ?? []), msg]),
  updateMsgState: (msgId: number, state: MsgState) => {/* 遍历找到并更新 */},
  removeMsg: (msgId: number) => {/* filter */},
  setReactions: (msgId: number, reactions: Reaction[]) => setStore("reactions", msgId, reactions),
  setReadCount: (msgId: number, count: number) => setStore("readCounts", msgId, count),
  clearChat: (chatId: number) => {/* 切换会话时清理 */},
};
```

### 5.2 eventBridge(Tauri 事件 → Solid signals)

```typescript
// eventBridge.ts
import { onEvent } from "../../api.js";
import { chatStore } from "../state/chatStore";

export function bindChatEvents(chatId: Accessor<number>): void {
  onEvent("MsgsChanged", (e) => {
    if (e.chat_id !== chatId()) return;
    void chatStore.reloadMessages(e.chat_id);
  });
  onEvent("MsgDelivered", (e) => chatStore.updateMsgState(e.msg_id, "delivered"));
  onEvent("MsgFailed", (e) => chatStore.updateMsgState(e.msg_id, "failed"));
  onEvent("MsgRead", (e) => chatStore.updateMsgState(e.msg_id, "read"));
  onEvent("MsgDeleted", (e) => chatStore.removeMsg(e.msg_id));
  onEvent("ReactionsChanged", (e) => setTimeout(() => void chatStore.reloadReactions(e.msg_id), 200));
  onEvent("MsgReadCountChanged", (e) => void chatStore.reloadReadCount(e.msg_id));
  onEvent("IncomingMsg", (e) => {
    // 接受 contact request(幂等)+ 检测提及
    void call("accept_chat", { chatId: e.chat_id });
    void detectMention(e.chat_id, e.msg_id, e.text);
  });
}
```

### 5.3 shellBridge(Solid → vanilla shell)

```typescript
// shellBridge.ts
export interface ShellBridge {
  onUnreadCleared: (chatId: number) => void;        // 通知 shell 更新 badge
  onUpdateBadge: () => void;                         // 通知 shell 重算角标
  onOpenRightDrawer: (chatId: number) => void;       // 打开成员/置顶面板
  onShowNotification: (n: QueuedNotif) => void;      // 系统通知(复用 shell 队列)
  onNavigate: (page: Page, chatId?: number) => void; // 跳转其他页
}

export const shellBridge: ShellBridge = { /* 由 shell.ts 注入实现 */ };
```

`main.ts` 启动时注入 shellBridge 实现,Solid 通过回调解耦。

### 5.4 chatId signal 驱动

```typescript
// signals.ts
import { state } from "../../state.js";

// 把 vanilla state.currentChatId 包成 Solid signal
const [chatId, setChatId] = createSignal(state.currentChatId);
// 监听 state 变化(由 shell persist + 路由触发)
const originalSetCurrentChatId = Object.getOwnPropertyDescriptor(state, "currentChatId")?.set;
// 实际做法:shell 在改变 currentChatId 后调用 syncChatIdSignal()
export function syncChatIdSignal(id: number | null): void {
  setChatId(id);
}
export { chatId };
```

ChatApp 订阅 `chatId` signal:
```tsx
function ChatApp() {
  const chatId = chatIdSignal();
  createEffect(on(chatId, (id) => {
    if (id == null) return;
    void chatStore.reloadMessages(id);
    void chatStore.loadPins(id);
  }));
  // ...
}
```

---

## 6. 功能对等清单

现有 chat 能力 → 新实现映射:

| 能力 | 现有实现 | 新实现 | 组件 |
|---|---|---|---|
| 文本消息 | `message.ts` renderMarkdown + hljs | @opencode-ai/ui `Marked`(shiki 高亮) | MessageBubble |
| 图片消息 | `innerHTML` img | `ImagePreview` 组件 | MessageContent |
| 文件消息 | 文件卡片字符串 | `FileIcon` + 卡片 | MessageContent |
| 语音消息 | `voicePlayer.ts` | `VoicePlayer.tsx`(@solid-primitives/media) | VoicePlayer |
| webxdc | `webxdc.ts` | `WebxdcCard.tsx` | WebxdcCard |
| 消息状态 | `stateLabel()` 字符串 | 响应式 span(data-state) | MessageBubble |
| 已读人数 | `getReadCount` + popup | store + HoverCard | MessageBubble |
| 反应 | reactionQuick + panel | ReactionPicker(Popover) | ReactionPicker |
| 回复 | reply-preview DOM | ReplyPreview signal | ReplyPreview |
| 转发 | dropdown 菜单 | ContextMenuItem | MessageHoverActions |
| 复制 | execCommand | navigator.clipboard | MessageHoverActions |
| 置顶 | pinnedMsgIds Set | store.pinnedMsgIds | MessageHoverActions |
| 删除 | inlineConfirm | DialogV2 fit(对齐 opencode 删除确认) | confirmDelete |
| @提及 | mentionList DOM | MentionSuggest(Popover) | MentionSuggest |
| #频道 | mentionList DOM | MentionSuggest | MentionSuggest |
| 草稿 | draftTimer 500ms | createEffect 防抖 | Composer |
| 收起/展开 | expanded 变量 | mode signal | Composer |
| 乐观更新 | appendOptimisticMessage | store.appendOptimistic | Composer |
| 画廊 | gallery.ts | Gallery.tsx | Gallery |
| LLM 摘要 | summaryBubble + Dashboard | SummaryBubble + 防抖 | SummaryBubble |
| envelope 信封 | envelope.ts 解析 | 保留 utils,envelope 渲染 | MessageContent |
| 发送者主题色 | msgTheme.ts | 保留,映射到 v2 avatar 色板 | MessageBubble |
| 代码高亮 | highlight.js | shiki(对齐 opencode) | Marked |
| markdown | marked 自定义 | @opencode-ai/ui Marked | MessageContent |

**删除确认的权衡**:现有"零弹窗"原则用 inlineConfirm,但 opencode 质感用 DialogV2。本次决策:删除会话/删除消息用 DialogV2 fit(对齐 opencode),其余交互(反应/回复/转发/置顶)保持内联。这是质感对齐优先于原"零弹窗"偏好的决策转变。

---

## 7. 交互品质提升点

对标"不逊于 Apple Message + Discord":

1. **虚拟滚动**:当前无虚拟化,千条消息卡顿。新实现 createVirtualizer + 会话切换缓存,流畅滚动万条消息。
2. **消息进入动效**:新消息 fadeUp + spring scale,对齐 opencode 列表级联。
3. **反应 pop 动效**:反应胶囊 spring(scale 0→1)+ nth-child 阶梯,而非直接出现。
4. **hover 操作浮现**:opacity 过渡 150ms,而非始终可见/不可见。
5. **打字指示器**(新增):对方输入时显示 TypingIndicator(三点 pulse),需后端支持(本次前端预留,后端事件未就绪时降级为不显示)。
6. **jump-to-latest 按钮**:用户上滑后浮动按钮,backdrop-blur + elevation,点击平滑滚到底。
7. **composer 智能展开**:输入多行自动增高到 200px,超过则内滚动;Shift+Enter 强制换行。
8. **消息分组**:连续同发送者消息合并(隐藏头像/名字),间距收紧,对齐 Apple Message。
9. **代码块复制按钮**:代码块右上角 hover 显示复制按钮(对齐 opencode)。
10. **图片懒加载 + 渐进**:IntersectionObserver 懒加载,加载中 TextShimmer 占位。

---

## 8. 样式策略

### 8.1 Tailwind v4 限定 chat 子树

安装 `@tailwindcss/vite` + `tailwindcss`,在 `vite.config.ts` 配置 Tailwind 仅扫描 `src/chat-solid/**`:

```typescript
// vite.config.ts
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [
    tailwindcss({ config: { content: ["src/chat-solid/**/*.{ts,tsx}"] } }),
    // ... 现有插件
  ],
});
```

chat-solid 组件用 Tailwind 类(`flex gap-2 px-3` 等)+ v2 令牌 CSS 变量,shell 保留现有 `styles.css`。两套样式系统通过作用域隔离:Tailwind 类只在 chat-solid 组件中使用,shell 不用 Tailwind 类。

### 8.2 @opencode-ai/ui 依赖

```json
// package.json
{
  "dependencies": {
    "@opencode-ai/ui": "workspace:*",  // 或 npm 版本
    "@kobalte/core": "^0.13.0",
    "solid-js": "^1.9.0",
    "@tanstack/solid-virtual": "^3.0.0",
    "motion": "^12.0.0",
    "solid-sonner": "^0.2.0",
    "@solid-primitives/media": "^2.3.0"
  }
}
```

@opencode-ai/ui 若无法直接 npm 安装,则复制 `packages/ui/src/v2/` 与 `src/styles/`、`src/theme/` 到 `src/chat-solid/vendor/`,作为 vendored 依赖。

### 8.3 与 shell styles.css 共存

- `styles.css` 保留,服务 shell(rail/navPanel/rightDrawer/login)
- chat-solid 内部用 Tailwind + v2 令牌,不污染 shell
- 全局重置(base.css)由 chat-solid 引入,可能与 shell 冲突 → 仅引入 v2 theme.css + colors.css,不引入 base.css 的全局重置

---

## 9. 错误处理

- **IPC 失败**:每个 `call()` 用 try/catch,失败时 `toasterV2.show` 错误 toast(variant: danger),不阻塞 UI。
- **消息发送失败**:乐观消息标记 `_state: "failed"`,气泡显示重试按钮,点击重发。
- **图片/文件加载失败**:占位符 + 错误图标 + 重试按钮。
- **虚拟化测量异常**:fallback 到非虚拟化渲染(Show when virtualizer.error)。
- **会话切换竞态**:用 `createResource` 的 `latest` 语义 + chatId signal 驱动,旧请求结果丢弃。
- **Solid 卸载清理**:`onCleanup` 取消所有事件订阅、清除 timer、释放 media 资源。

---

## 10. 测试策略

- **类型检查**:`tsc --noEmit` 严格模式,禁止 `any`(继承现有约束)。
- **单元测试**:projection 逻辑(消息分组/日期分隔/未读分隔)、chatStore(append/update/remove/reactions)、composer controller(草稿防抖/发送/乐观更新)。
- **组件测试**:@solidjs/testing-library,渲染 MessageBubble/Composer/ReactionPicker,断言 DOM 与交互。
- **e2e(手动)**:`npm run tauri dev` 启动,验证:发消息/收消息/反应/回复/转发/置顶/删除/提及/草稿/多附件/语音/webxdc/画廊/摘要/会话切换/明暗切换。
- **质感验证**:与 opencode desktop 截图对比(字号/字重/间距/阴影/动效)。

---

## 11. 迁移与回退

### 11.1 迁移步骤(高层,详细计划由 writing-plans 生成)

1. 安装依赖(Solid/Tailwind/@opencode-ai/ui/@tanstack/solid-virtual/motion)
2. 搭建 chat-solid 骨架(ChatApp mount/unmount + chatId signal + eventBridge)
3. 实现 chatStore + projection + 虚拟化时间线(仅文本消息)
4. 实现 Composer(文本 + 草稿 + 发送)
5. 逐步迁移消息内容类型(image/file/voice/webxdc)
6. 实现 hover 操作 + 反应 + 回复 + 转发 + 置顶 + 删除
7. 实现 @提及/#频道 + 画廊 + 摘要
8. 退役 shell.ts 中 chat DOM 操作 + 退役 src/chat/ 旧目录
9. 质感对齐验收(与 opencode 截图对比)

### 11.2 回退

迁移期间 `src/chat/` 旧代码保留,通过 `main.ts` 功能开关切换:

```typescript
const USE_SOLID_CHAT = true; // 迁移完成后删除
if (USE_SOLID_CHAT) {
  await mountChatSolid(chatMainEl);
} else {
  // 旧 vanilla chat 渲染逻辑
}
```

切换开关即可回退到旧实现,不影响 shell 与后端。

---

## 12. 不在本次范围

以下保留 vanilla TS,后续逐页迁移:

- shell(rail/navPanel/rightDrawer/titlebar/columnResizer)
- pages(messagesPage/groupsPage/workPage/inboxPage/settingsPage/botsPage/debugPage/githubPage/intelligencePage/messagesPage)
- work(kanban/list/calendar/timeline/cardDetail)
- plugins(manager/api/permissions/settings/storage/view)
- terminal
- login
- components 中非 chat 相关(avatar/dropdown/inlineConfirm/inlineInput/navBanner/search/commandPalette/contactCard/contactsPicker/memberPicker 等通用组件,逐步被 @opencode-ai/ui 替代)

---

## 13. 关键参考文件(opencode desktop)

| 方面 | 文件 |
|---|---|
| 布局 | `packages/app/src/pages/session.tsx`、`packages/app/src/pages/layout.tsx`、`packages/app/src/pages/layout/sidebar-shell.tsx` |
| 消息流 | `packages/app/src/pages/session/timeline/message-timeline.tsx` |
| 输入区 | `packages/app/src/components/prompt-input-v2.tsx`、`packages/app/src/context/prompt.tsx` |
| 主题令牌 | `packages/ui/src/v2/styles/theme.css`、`packages/ui/src/styles/base.css`、`packages/ui/src/theme/context.tsx` |
| 动效 | `packages/ui/src/components/motion-spring.tsx`、`packages/ui/src/styles/animations.css` |
| 组件 | `packages/ui/src/v2/components/{button-v2,toast-v2,dialog-v2,avatar-v2,icon}.tsx` |
| 悬浮 | `packages/ui/src/components/{context-menu,hover-card,tooltip}.tsx` |
| 打字效果 | `packages/ui/src/components/typewriter.tsx`、`text-shimmer.tsx`、`text-reveal.tsx` |
| Markdown | `packages/ui/src/context/marked.tsx` |
| 滚动 | `packages/ui/src/components/scroll-view.tsx` |
