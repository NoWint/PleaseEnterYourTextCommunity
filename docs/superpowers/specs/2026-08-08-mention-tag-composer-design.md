# @ # / Mention Tag 输入框设计

日期:2026-08-08
状态:设计定稿
范围:composer 输入框从 textarea 改为 contenteditable,支持 @成员 / #频道 / /命令 三种有色 tag,整块删除;接收端 @任意成员高亮 + 点击弹名片。

## 1. 背景与动机

### 1.1 现状

- 输入框是纯 `<textarea id="composer-input">`,已有 @提及 / #频道 **建议列表**(`handleMentionInput` + `showMentionList`,键盘导航上下/Enter/Esc/Tab),选中后插入**纯文本** `@name `。
- `/` 命令已存在:输入后 `send()` 分发到插件注册的 `window.__peytchat_commands`(api.onCommand),**输入即执行**。
- 接收端 `highlightMentions` 只高亮 `@自己名字` 和 `@角色名`,普通成员不高亮。
- 输入框有两种模式:收起(单行 auto 增高,Enter 发送)+ 展开(大编辑区,顶部拖拽调高,Enter 换行)。

### 1.2 目标

1. `@成员`、`#频道`、`/命令` 输入时弹建议列表,选中插入**有色 tag**,Backspace 整块删除(不像纯文本逐字删)。
2. 发送时 tag 序列化成纯文本 `@名字 #频道 /命令`,信封协议不变。
3. 接收端:@**任意当前聊天成员** 高亮成 tag,点击弹成员名片(复用 memberPicker/contactCard);`#`、`/` 接收端保持纯文本。
4. 收起/展开两种模式 = 同一 contenteditable 组件,仅高度与建议面板定位适配,切换无缝、不重建 DOM。

### 1.3 非目标

- 不改信封协议 / core(发送仍是普通 markdown 文本)。
- 接收端不做 `#`、`/` 高亮或点击(仅 @ 成员)。
- 不做「@ 去重」「@ 限制次数」「mention 通知」等社交功能。
- 不迁移手写/录音/附件(这些按钮与输入框并存,不受影响)。

## 2. 输入框:contenteditable 迁移

`<textarea id="composer-input">` → `<div id="composer-input" contenteditable="true" role="textbox" aria-multiline="true">`。

唯一能渲染富文本 tag 的方案(Slack/Discord 同款)。原生 placeholder 对 contenteditable 无效 → 用 CSS `:empty::before { content: attr(data-placeholder) }`(属性存文案,`:empty` 保证无内容时显示;tag 内文本不算空——但 tag span 会被 `:empty` 视为非空,需 `:empty` 语义仅对**纯文本容器**成立,避免 tag 存在时残留 placeholder。实际判断:`#composer-input:empty::before` 在含 span 时不命中,天然正确)。

### 2.1 现有逻辑迁移对照

| 现有 | 迁移后 |
|---|---|
| `input.value` 读写 | `input.innerText`(草稿、发送、md 检测、send 状态);**注**:innerText 会保留换行、返回可见文本;空内容时 `innerText === ''` |
| `input.selectionStart/End`(建议定位、insertNewline) | DOM `Range` / caret API(`getCaretPosition` 从 `window.getSelection()` + 子节点遍历) |
| `scrollHeight` 自适应高度 | contenteditable 的 `scrollHeight` 同样可用,逻辑不变 |
| 收起/展开拖拽、`applyExpanded` | 改为仅切 class + 高度,见 §2.3 |
| Enter / Ctrl+Enter / Shift+Enter 键盘 | 统一 Enter 发送,Shift+Enter 换行(用户已定),见 §2.4 |
| 录音 / 手写 / 附件 / 回复预览 / 草稿 | 不变(这些不依赖 textarea) |

### 2.2 光标定位工具

新增 `src/chat/caret.ts`(或内联在 composer):
- `getCaretPos(el): {node, offset}` — 光标前最近文本节点 + 偏移。
- `setCaretPos(el, node, offset)` — 恢复光标。
- `textBeforeCaret(el)` — 光标前的 innerText(建议匹配用)。
- `caretRect(el)` — 光标处 DOMRect(建议面板定位锚点)。

## 3. Tag 结构与整块删除

### 3.1 三种 tag

```html
<span class="mention-tag tag-member" data-kind="member" data-name="张三" contenteditable="false">@张三</span>
<span class="mention-tag tag-channel" data-kind="channel" data-name="general" contenteditable="false">#general</span>
<span class="mention-tag tag-command" data-kind="command" data-name="ai" contenteditable="false">/ai</span>
```

- 三色:成员蓝、频道绿、命令橙(见 §6)。
- `contenteditable="false"` 锁住 tag 内部不可编辑 → 光标无法进入,天然支持「整块删除」。
- 插入位置:替换 `@query` / `#query` / `/query`,后补一个空格(`@张三 `),空格可编辑。

### 3.2 整块删除

用 Backspace/Delete 的 keydown 拦截(见 §2.4 键盘处理):
- 光标紧贴 tag 末尾(紧邻后续空格或文本边界)→ Backspace 删除整个 span。
- 光标紧贴 tag 开头 → Delete 删除整个 span。
- 其余情况(光标在普通文本里)走浏览器默认行为。
- 实现:`Range` 定位光标前后兄弟节点,若紧邻的是 `.mention-tag[contenteditable=false]` → `remove()` 该节点,并阻止默认。

## 4. 建议列表

复用现有 `mention-list` / `mention-item` / `mention-prefix` 结构与样式,保留键盘导航(上下/Enter/Esc/Tab)。改动:

1. **定位锚点**:从 `input.getBoundingClientRect()` 改为 `caretRect(el)`(光标处),在两种高度模式下都弹在输入框上方(`mention-pop` 动画保留)。
2. **匹配源**:`@`→ `state.currentMembers`;`#`→ `state.channels`;**`/` 新增** → `Object.keys(window.__peytchat_commands)`(枚举已注册命令名)。
3. **匹配方式**:基于 `textBeforeCaret(el)` 的正则(`/@(\w*)$/`、`/#(\w*)$/`、`/\/(\w*)$/`),`queryStart` 从 innerText 偏移反推 DOM 位置。
4. **选中插入**:替换 `@query`/`#query`/`/query` 为对应 span + 空格(见 §3.1)。

**`/` 命令语义**(用户已确认):输入 `/` 弹命令建议,选中插入 `/cmd` tag,**不立即执行**;发送时才走现有 slash 分发。发送后命令 tag 序列化成 `/cmd`。

## 5. 发送 / 草稿序列化

### 5.1 序列化函数

新增 `serializeComposer(el): string`:
- 遍历子节点:文本节点原样,`.mention-tag` → 取 `data-name` 拼前缀(`@`/`#`/`/`)。
- 拼接时保留 tag 后空格:遍历 innerText 时 tag 本身不带空格,把「tag + 后续空格」压成「tag 文本 + 单个空格」,避免多空格。

### 5.2 发送

`send()` 改用 `serializeComposer(input)` 取文本(替代 `input.value.trim()`)。
- `/` 命令:序列化结果 `以 / 开头` → 走现有 slash 分发分支(`window.__peytchat_commands[cmd]`),`args` 取命令后文本。
- 普通文本:信封 payload 不变(`send_text`/`send_reply` + markdown),协议不动。

### 5.3 草稿

`get_draft` 恢复:恢复的是**纯文本**,存回 contenteditable 时以纯文本填充(`el.textContent = draft`),**不重建成 tag**(简单可靠;草稿里已有 @ 文本不重新高亮成 tag)。`set_draft` 存序列化后的文本,与恢复对称。

### 5.4 md 检测

`MD_RE` 检测与 md-hint 呼吸灯:改用 `innerText` 判断,逻辑不变。

## 6. 接收端:@成员高亮 + 点击名片

### 6.1 高亮扩展

`highlightMentions`(message.ts:663)扩展:在现有「@自己名/@角色名」基础上,增加「@任意当前聊天成员」。数据源 `state.currentMembers`。输出:

```html
<span class="mention-tag tag-member" data-kind="member" data-name="张三">@张三</span>
```

匹配顺序:优先精确成员名;`highlightMentions` 输入已是 `escapeHtml` + `autolink` 后的 HTML,需在 html 层面做 tag 化(与现状一致)。

### 6.2 点击弹名片

并入 chatView.ts 已有的 `document` 级点击委托(bindTopicChipClick,chatView.ts:796)。新增分支:点击 `.mention-tag[data-kind="member"]` →
- 名字是 self(`data-name` === `state.self.name`)→ `openContactCard`(现有 self 分支复用)。
- 其他 → `openUserPicker(name, el)`(memberPicker 自动模糊匹配 → 单名片 / 多人列表)。

复用现有委托,不新增监听器(避免累积)。`.mention-tag.tag-member` 加入委托选择器。

### 6.3 接收端边界

- `#`、`/` 接收端保持纯文本(发送端 tag 只是输入体验,信封里是普通文本)。
- 虚拟化渲染:委托在消息容器/document 级,不随消息重渲染丢失。

## 7. 样式

```css
.mention-tag {
  display: inline-block; padding: 0 6px; border-radius: var(--radius-xs);
  font-weight: 500; line-height: 1.4; cursor: pointer; user-select: none;
}
.tag-member  { background: var(--mention-member-bg, rgba(10,132,255,.18)); color: var(--mention-member-fg, #0a84ff); }
.tag-channel { background: var(--mention-channel-bg, rgba(52,199,89,.16)); color: var(--mention-channel-fg, #34c759); }
.tag-command { background: var(--mention-command-bg, rgba(255,159,10,.16)); color: var(--mention-command-fg, #ff9f0a); }
.tag-member:active, .tag-channel:active, .tag-command:active { filter: brightness(.92); }
```

- 输入框内 tag:与接收端同款,靠 `contenteditable="false"` 区分可编辑性。
- 三色基于现有 CSS 变量体系(可被主题覆盖,参照 token 化风格)。
- `.msg-mention`(旧高亮)保留,新 `.mention-tag` 仅在接收端 @成员高亮处使用。

## 8. 数据流

```
输入 `@张` → caret 检测 → 建议列表(成员)
  → 选「张三」 → 插入 <span.tag-member data-name="张三">@张三</span> + 空格
  → 发送 serializeComposer → "@张三 ..."(纯文本)
  → 信封 text 普通文本 → 接收端 renderText → highlightMentions 高亮 → 点击 → openUserPicker → 名片
```

## 9. 风险与边界

- **粘贴带格式**:contenteditable 粘贴 HTML → 拦截 `paste`,取 `text/plain` 纯文本插入;若纯文本含 `@名字` 且命中成员,提升为 tag(可选,最低限度先纯文本)。
- **IME 中文**:`isComposing` / keyCode 229 对 contenteditable 同样有效,发送/建议导航不误触发(现有判断保留)。
- **innerText 与 `:empty`**:tag span 使容器非 `:empty` → placeholder 自动隐藏,正确。
- **拖拽高度锁定**:展开时 `height` 固定(非 auto),CSS `overflow:hidden` 防内容撑破;收起 `height:auto` + `max-height:120px`。
- **草稿重建成 tag**:不做(纯文本填充),避免恢复复杂度;用户可重新输入。
