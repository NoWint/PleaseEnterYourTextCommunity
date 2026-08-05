# 全量视觉迁移:采纳 opencode 设计语言

**日期**:2026-08-05
**状态**:已批准(设计对话确认),只写 spec,不写实施计划
**参考**:/Users/xiatian/Downloads/opencode-dev(packages/ui v2 + packages/desktop renderer)
**范围**:前端全部表面(github 页除外),后端零改动

---

## 1. 背景与目标

当前 peytchat 前端(约 2 万行 Vanilla TS,无框架)功能完备但「精致程度」未达标杆。用户要求:参考 opencode desktop 的前端实现,让本项目达到与 opencode 相同的精致度。

**标杆 = opencode v2 设计体系**(packages/ui 的 oc-2 主题 + v2 组件层):分层表面 token、alpha 叠加状态、0.5px hairline、elevation 阴影阶梯、2px focus ring、4px 胶囊滚动条、Inter + 440/530 字重、micro-delay 动效、keybind 提示、scroll-timeline 渐变、零闪变主题注入。

### 已确认决策

| 决策点 | 结论 |
|--------|------|
| 视觉方向 | **完全采纳 opencode 作为设计语言**(github 页除外,保持默认) |
| 范围 | **一次全量**:shell + 聊天 + 全部 9 页 + 登录页 + 组件库 |
| 技术栈 | 保持 Vanilla TS + Vite,**不引入框架**;opencode 体系用原生 CSS 变量 + 现有 ui.ts 组件工厂复刻 |
| 主题 | 15 套主题**全部重构到新 token 体系**(主题 = 覆盖映射,不再直接改全局类) |
| 明暗模式 | **只做 dark**;默认主题 = opencode oc-2 dark 风格(`base #161616 / deep #080808`) |
| 文案 | **完整 i18n 框架**:字典 + key 抽取,zh 源 + en 字典,缺 key 回落 zh |
| 实施 | 只在 main 分支开发;另一个 agent 并发开发后端(src-tauri),其工作与本任务无关 |
| 产出 | **只写 spec,不写实施计划** |

---

## 2. 设计语言与 Token 体系

### 2.1 原始色板(primitives)

- 12 级灰阶:`--grey-50(#ffffff)` → `--grey-1200(#080808)`,中间值围绕 dark 基座生成(oklch 推导:1000/1100 接近 `#161616`、`#101010`)
- 强调色:`--blue-600 #3b5cf6`(主操作/accent)、`--blue-500 #7698fd`(focus)
- Alpha 梯度:`--alpha-dark-4/8/10/12/20/40`(如 `-4: #0000000a`、`-40: #00000066`)与镜像 `--alpha-light-4/8/10/12/20/40`
- 状态原色:success/warning/danger/info(红 `#ff5f57` 系、黄、绿 `#30a46c` 系、蓝)各生成 bg/fg/border

### 2.2 语义 token(取代现有 `--bg/--panel/--border/--text/--accent` 等)

| 组 | token | dark 值(oc-2) |
|----|-------|----------------|
| 表面 | `--surface-base` | `#161616` |
| | `--surface-deep` | `#080808`(同时作为原生窗口底色) |
| | `--surface-layer-01/02/03/04` | 逐层抬升的浅灰(alpha 或色阶推导) |
| 文字 | `--text-base` / `--text-muted` / `--text-faint` / `--text-inverse`(对比面) | 白 → 灰递减 |
| 边框 | `--border-base` / `--border-strong` / `--border-focus`(`--blue-500`) | 白 alpha 灰阶 |
| 状态层 | `--overlay-hover` / `--overlay-pressed` / `--overlay-contrast-hover` / `--scrim` | alpha 叠加,非改色 |
| 状态色 | `--state-bg-{success,warning,danger,info}` / `--state-fg-*` / `--state-border-*` | 三件套 |
| 图标 | `--icon-base` / `--icon-muted` / `--icon-faint` | 随文字 |

**硬规则**:hover / pressed / selected 一律用 alpha 叠加层(`linear-gradient(overlay, overlay)` 覆盖在表面之上),禁止单独改背景色值。

### 2.3 Elevation(招牌技法)

阴影 token = 多层 alpha 软阴影 + **0.5px hairline ring**:

```css
--elevation-raised:   0 2px 4px var(--alpha-dark-8),  0 0 0 0.5px var(--alpha-dark-12);
--elevation-floating: 0 8px 16px var(--alpha-dark-4), 0 4px 8px var(--alpha-dark-8),
                      0 0 0 0.5px var(--alpha-dark-12);
--elevation-overlay:  0 16px 32px var(--alpha-dark-8), 0 0 0 0.5px var(--alpha-dark-12);
--elevation-contrast: 上方 + inset 0 1px 2px var(--alpha-light-14) 顶部高光;
```

**0.5px hairline 无处不在**:卡片边框、头像描边、附件图、分割线均用 `inset 0 0 0 0.5px` 阴影而非 1px border,保证叠加在图片/色块上时仍清晰。

### 2.4 圆角刻度

`xs 2 / sm 4 / md 6 / lg 8 / xl 10 / big 12 / pill 9999`。

| 元素 | 圆角 |
|------|------|
| 按钮 / 菜单 / 对话框 / toast | md 6 |
| 菜单项 / tooltip | sm 4 |
| 消息气泡(自己与他人) | xl 10 |
| Composer / 命令面板 / 全局搜索 | big 12 |
| keybind 键帽 | 2 |
| 徽章(badge) | 2 |
| 未读角标 / 反应胶囊 / 滚动条 | pill |

现有 16px 大圆角气泡、14/20 圆角统一收窄到上表。

### 2.5 字体与排版

- **Latin:打包 Inter Variable(100-900 可变字重,woff2)**;CJK 回落 `-apple-system, 'PingFang SC', 'Microsoft YaHei'`;mono 保持 `'SF Mono', Menlo, Consolas`
- 字重:正文 **440**,标题/按钮/行名 **530**,keybind **11px / 530 / 大写**
- tracking:13px → `-0.04px`,15px → `-0.13px`;其他字号按比例递减;数字一律 `font-variant-numeric: tabular-nums`
- 全局:`text-rendering: geometricPrecision` + `-webkit-font-smoothing: antialiased`,`font-variation-settings: "slnt" 0`
- 现有 `--font-scale-*` 缩放机制保留,作用于字号基准

### 2.6 动效 token

| 场景 | 值 |
|------|-----|
| 浮层(菜单/工具提示/下拉)入场 | 120ms,`opacity 0 + scale(.96) → 1`,`transform-origin` 随锚点 |
| 浮层退出 | 80ms |
| hover 揭示(消息操作栏/行内按钮) | 150ms opacity 过渡 |
| toast 入场/堆叠 | 280ms `cubic-bezier(.2,0,0,1)`,堆叠 `translateY(-N*9.5px) scale(1-N*.05)` |
| 布局形变(抽屉/手风琴/面板) | spring:visualDuration .25,bounce 0 |
| 消息入场 | spring + blur-in(0.32s,`cubic-bezier(.16,1,.3,1)`) |
| 文字替换/数字滚动 | 450-560ms `cubic-bezier(.22,1,.36,1)` |
| thinking/加载 shimmer | 1200ms 逐字扫光 |
| 旋转(chevron) | 120ms |

统一 `prefers-reduced-motion: reduce` 块(全库合并为一个),所有动效归零。

### 2.7 滚动条

- 隐藏原生滚动条;自定义 **4px 胶囊** thumb(`border-radius: 9999px`,`backdrop-filter: blur(4px)`)
- 仅在可滚动时淡入;hover 时颜色加深(`--border-weak-base → --border-strong-base`)
- 全库统一 `.scroll-view` 类;列表类长页面使用

### 2.8 焦点环

- 全局 `:focus-visible` = `outline: 2px solid var(--border-focus)` + `outline-offset: 2.5px`(按钮/输入/菜单项等)
- 文本输入聚焦:outline-color 切换 + 85ms 过渡 + 移除阴影
- 键盘可达元素全覆盖(rail 图标、列表行、菜单项、tab、开关)

### 2.9 兼容策略(关键)

1. 新 token 层以独立变量组落地,值直接引用 opencode 数值
2. **旧变量名保留为别名**:`--bg: var(--surface-base)`、`--panel: var(--surface-layer-01)`、`--border: var(--border-base)`、`--text: var(--text-base)`、`--accent: var(--blue-600)` 等
3. 逐表面迁移:surface 换新 token + 新组件类;未迁移面靠别名自动跟随色板,不破不闪
4. **全部表面迁移完成后,删除别名**(最终态不含旧变量)

github 页经由别名自动吃到新色板,视觉风格保持默认不动。

---

## 3. 主题系统重构

- 15 套主题 → `src/themes/*.ts`,每套为 token 覆盖映射:**色板覆盖**(grey 系/blue 系/alpha 系)+ **结构覆盖**(半径/纹理/字体/阴影——仅 crt/brutal/toon/zzz 等激进主题需要)
- 主题应用逻辑:`theme.ts` 读取主题映射 → 注入 CSS 变量到 `:root` + `data-theme` 属性;激进主题的纹理(scanlines/渐变 mask)保留现有实现,但挂到新语义 token 上
- **Preload 零闪变**:`index.html` 内联脚本,首帧前读 `localStorage('peyt.theme')` 设置 `data-theme`(当前逻辑在 `main.ts` 里,启动存在闪变,必须前移)
- 只做 dark 变体
- 设置页主题选择器:网格预览 + **hover 即时预览不提交**,选中才写入并持久化

---

## 4. Shell 改造

### 4.1 Titlebar(36px)

- 保留现有原生窗口策略(mac `window-overlay` 红绿灯 / Win+Linux `window-frame` 自绘控件),**不动 src-tauri 窗口配置**
- 背景 `--surface-deep` + hairline 底边;`app-region: drag`,交互子元素 `no-drag`
- 全局搜索框:聚焦 focus ring;占位符带 **⌘K keybind 提示**;hover alpha
- 图标按钮:28px、md 圆角、hover alpha 叠加、tooltip 统一带 keybind 提示

### 4.2 Rail(56px)

- 图标 24px stroke-1.5;active = 填充 + 指示条;hover/pressed alpha 叠加
- 键盘可达(`tabindex=0` + `role=button` + `aria-label`);tooltip 带 keybind
- 底部头像:presence 圆点、hover 展开用户菜单

### 4.3 Nav panel(240px)

- `--surface-base` + hairline 右缘;`.scroll-view` 胶囊滚动条
- 列表行:md 圆角 hover alpha;active = `--overlay-hover` + 左 2px 指示条;折叠 chevron 120ms 旋转
- 未读角标:pill 胶囊 + tabular 数字;内联输入/下拉/右键菜单全部走 `ui.ts` + 新 token(120ms scale-fade 入场,`transform-origin` 随锚点)

### 4.4 右侧栏(300px)

- `--surface-layer-01` + hairline 左缘 + `--elevation-overlay`;展开 spring 平移(visualDuration .25,bounce 0)
- members/pin tab 分段控件 restyle

### 4.5 列拖拽

保留橡胶带物理;拖拽手柄 hover 出现 hairline 视觉。

---

## 5. 聊天体验

### 5.1 聊天列表(messagesPage)

- 行:头像(presence 点)+ 名称 530 + 预览 muted + 时间 tabular 右对齐;未读 accent 点/胶囊
- hover 揭示「更多」按钮(150ms opacity);active 行 alpha 状态
- 首次加载骨架屏(脉冲行 shimmer,2s,reduced-motion 停用)

### 5.2 消息流(chatView / message.ts)

- 自己气泡:`--surface-contrast` 风格(白字 + 顶部 inset 高光 + text-shadow);他人气泡:`--surface-layer-01` + 0.5px hairline;圆角 10px;连续消息折叠头像(Discord 式)保留
- 入场:spring(visualDuration .25,bounce 0)+ blur-in 0.32s
- hover 操作栏:右上浮出 150ms,28px 按钮 + tooltip;反应胶囊 hairline + mine 态 accent
- 时间戳/已读回执:tabular 数字 + 微妙图标
- hljs 代码块主题对齐新色板(定制 hljs CSS 变量)

### 5.3 Composer

- 自增 textarea;圆角 12px;`--elevation-raised` + hairline;focus ring
- 提到 chip 语法着色(「@名字」token 用 accent 系色);@/# 建议列表沿用现有逻辑、全新视觉
- 附件行:渐变淡出边缘;发送按钮对比面(白渐变 + inset 高光 + text-shadow);loading 变体(flat + hairline + `pointer-events: none`)
- 拖文件进入:全区域虚线遮罩 drag 态

### 5.4 浮层类(gallery / search / commandPalette / 各类弹窗)

- **合并运行时注入的 `<style>` 进 styles.css**(gallery.ts、commandPalette.ts 等),消灭隐藏第二样式层
- 命令面板/搜索:12px 圆角 + scale-fade 入场 + 结果行 hover + 底部 keybind 提示行
- 对话框:6px 圆角 + `--elevation-overlay` + scrim;入场 120ms scale-fade

### 5.5 空态与首屏

- 聊天空态:居中巨型 PEYT wordmark,渐变 mask 底部淡出(0.6/0.16 分层 opacity)
- 可关闭提示条(ProviderTip 式,presence 动画)
- 启动 LoadingSplash:脉冲 logo(2s,reduced-motion 停用)

---

## 6. 页面(github 页除外)

| 页面 | 要点 |
|------|------|
| groupsPage | 分类 chevron 旋转;频道行 hover 揭示操作;新建/右键菜单统一组件 |
| workPage + work/* | 看板列 = 分层表面 + hairline;卡片 layer-01 + hairline,拖拽 elevation-floating;列表/日历/时间线同 token;视图切换 segmented |
| inboxPage | 通知行 hover 揭示「跳到来源」;未读状态点 |
| settingsPage | macOS 式侧栏保留;账号/外观/团队/通知/插件/关于;开关 = track/thumb alpha 结构;主题网格 hover 预览;危险操作红态 + 内联确认 |
| botsPage(1544 行) | **只做视觉迁移,逻辑零改动**;LLM 卡片/规则表/时间线等子面统一到 ui.ts 组件 + 新 token |
| debugPage | mono 排版,事件流等宽,工具页气质 |
| login | onboarding 级:居中卡片(hairline + elevation-floating)、quick-start/邮箱 segmented、加载按钮 |
| **githubPage** | **视觉完全不动**,仅经别名吃到新色板 |

---

## 7. 工程治理

### 7.1 CSS 治理

- `styles.css` 4355 行 → 目标 ~2500 行;删除死代码(.app-rail/.homeView 等)、合并 reduced-motion 块为 1、消灭运行时注入、`style="..."` 内联迁移为类
- 目录重排:`tokens → base(排版/滚动条/焦点) → shell → chat → 页面 → 组件 → 主题`

### 7.2 i18n 框架(完整版)

- 新增 `src/i18n/`:`index.ts`(`t(key, params)` + 插值)、`zh.ts`(源语言完整字典)、`en.ts`(完整英文,缺 key 回落 zh)、`glossary.md` 术语表
- 全库硬编码字符串抽成 key(所有页面含 botsPage/githubPage 文案)
- 当前语言持久化 + 设置页语言选择器
- 术语统一:频道/消息/协作/卡片/成员/置顶/归档/已读等

### 7.3 a11y

- 交互 div 补 role/aria(`tabindex`、`aria-label`、`aria-expanded`、`aria-current`);rail/nav/菜单方向键导航;Esc 级联关闭;图标按钮 aria-label;`:focus-visible` 全覆盖

### 7.4 后端边界与协作

- **零改动 `src-tauri/`、`core/`**;只消费 `docs/api-spec.md` 现有 IPC 契约
- 只在 main 开发,按表面原子提交,信息标注 `feat(ui): …`;不碰后端 agent 的目录与契约文档
- 若后端并发改动破坏契约,只记录问题,不抢修后端

---

## 8. 验证

- 每阶段:`npx tsc --noEmit` + `npm run build` 通过
- 每面完成截屏对照检查(对照 opencode oc-2 参考截图):色板、hairline、圆角、焦点环、动效
- 最终整体走查:全页面截屏、`prefers-reduced-motion` 检查、纯键盘走查、主题切换全量检查(15 套无破版)

---

## 9. 不在范围内

- 后端 Rust/Tauri 代码(他人并发开发)
- githubPage 视觉
- 业务逻辑改动(bots 管理、github 集成、看板、卡片等逻辑不变)
- 消息收发核心逻辑
- light 模式
- 自动化测试框架引入(验证以 tsc + build + 人工检查为主)
- 实施计划(按要求只写 spec)

---

## 10. 验收标准

1. 默认主题完全呈现 opencode oc-2 dark 视觉(分层表面、hairline、10px 气泡、12px composer、2px focus ring、4px 胶囊滚动条、Inter 440/530 排版、alpha 状态)
2. 15 套主题全部在新 token 体系下可切换,无破版
3. 启动零闪变(preload 生效)
4. styles.css 收敛至 ~2500 行,无运行时注入样式
5. i18n 框架可用:全库中文字典 + en 字典 + 设置页语言切换
6. 键盘全可达:tab 导航 + focus ring 可见 + 方向键菜单 + Esc 关闭
7. `npx tsc --noEmit` 与 `npm run build` 通过
8. githubPage 视觉保持默认,仅跟随色板
9. 后端(src-tauri/core)零改动
