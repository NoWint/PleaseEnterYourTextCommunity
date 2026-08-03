# 样式 Token 主题扩展 + 三套大胆主题 设计文档

> **定位**: 在现有「颜色变量 + `data-theme`」主题体系基础上，把主题能力从**纯配色**扩展到**完整样式维度**（圆角 / 阴影 / 字体 / 密度 / 动效 / 背景质感），并新增 3 套大胆夸张、冲击力强的主题：Brutalism（粗野主义）、CRT Terminal（老式终端）、Toon（卡通漫画）。
>
> **前置决策**（brainstorming 问答确认）:
> - 样式维度: 全部 6 项 — 圆角、阴影与辉光、字体与字号尺度、密度与间距、动效与过渡、背景质感/纹理/动画
> - 新主题方向: 粗野主义 / 老式终端 / 卡通漫画 三套（预计总数 14 套）
> - 夸张边界: 冲击力优先但保可读 — 消息气泡/输入框/弹窗/终端/菜单等核心功能区必须清晰可读可操作，夸张集中在背景/装饰/边框/字体个性/动效上
> - 实现路线: 方案 A — token 化扩展（样式 token + 效果层 token），`[data-theme]` 块同时覆盖颜色与样式；零侵入，Nowint 渲染零变化
> - 插件兼容: 插件 `registerTheme` 注入的任意 `--*` 变量自动获得样式能力，无需改插件系统

## 1. 目标与范围

### 1.1 目标
1. 建立样式 token 体系：圆角、阴影/辉光、字体、密度、动效、边框宽度全部可被主题覆盖
2. 新增 `.theme-effect` 效果层，支持背景质感（噪点/网格/扫描线）与效果层动画
3. 新增 3 套大胆主题：`brutal` / `crt` / `toon`（颜色 + 样式 token 全覆盖）
4. 设置页外观网格预览块升级：`BuiltinTheme` 支持可选 `preview` CSS，未定义回退现有渐变
5. 无障碍：`prefers-reduced-motion` 下效果层动画与弹性过渡全部归零
6. Nowint 及现有 11 套主题渲染零变化

### 1.2 不做
- 自定义主题色 / 主题导入导出 / 市场（沿用现有范围）
- 登录页主题（保持 Nowint）
- 动态主题（随时间切换）
- 修改插件主题注册机制（样式能力白捡，不动）
- 不收敛全部 288 处间距等细碎硬编码——只收敛**结构性**尺寸（见 4.1）

## 2. Token 体系扩展

### 2.1 新增样式 token（`:root` 定义默认，主题可覆盖）

| token | 含义 | Nowint 默认 |
|---|---|---|
| `--glow-color` | 彩色外发光色（文字/按钮辉光） | `transparent` |
| `--font-weight-strong` | 粗体档 | `700` |
| `--anim-duration` | 全局过渡基准时长 | `120ms` |
| `--anim-ease` | 全局过渡缓动曲线 | `ease` |
| `--border-width` | 常规边框宽度 | `1px` |
| `--border-width-strong` | 强调边框宽度 | `1px` |

已存在的 token 沿用（主题可覆盖）：`--radius-*`、`--shadow-*`、`--font`、`--font-mono`、`--font-scale-*`、`--space-*`。

### 2.2 效果层 token

| token | 含义 | Nowint 默认 |
|---|---|---|
| `--theme-texture` | 背景质感 `background-image`（噪点/网格/圆点） | `none` |
| `--theme-texture-opacity` | 质感层不透明度 | `0` |
| `--theme-scanlines` | CRT 扫描线叠加层 | `none` |

### 2.3 DOM 与渲染

在 `.theme-mask` 层之后、`#app` 之前新增 `.theme-effect` 层：

```html
<body>  ← background: var(--theme-gradient, var(--bg))
  ├── <div class="theme-mask"></div>
  ├── <div class="theme-effect"></div>  ← 新增
  └── <div id="app">...
```

```css
.theme-effect {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background-image: var(--theme-texture);      /* none → 不可见 */
  background-size: var(--theme-texture-size, auto);
  opacity: var(--theme-texture-opacity);
}
.theme-effect::after {
  content: ""; position: absolute; inset: 0;
  background: var(--theme-scanlines);          /* none → 不可见 */
  pointer-events: none;
}
```

- `index.html` 在 `#app` 前插入 `<div class="theme-effect"></div>`。
- Nowint 下 `--theme-texture:none`、`--theme-texture-opacity:0`、`--theme-scanlines:none`，层不可见、无叠加成本外的副作用。
- 效果层动画（扫描线上滚/闪烁）只作用于 `.theme-effect` 内部，不触发布局重排。

### 2.4 动效 token 用法

- `--anim-duration` / `--anim-ease` 作为「主题切换 + 效果层动画」的基准。局部组件已有 `transition: background 120ms` 等写法保持不动（避免大面积动效回归），除非主题需要整体放缓时统一用 `--anim-duration`。
- Toon 弹性曲线：`--anim-ease: cubic-bezier(.34,1.56,.64,1)`（弹跳感）。

## 3. 三套新主题

通用原则：核心功能区（消息气泡、输入框、菜单、弹窗、终端、保存的消息）对比度可读；夸张集中在背景/描边/字体个性/动效。全部 `[data-theme]` 块写进 `styles.css`（与 violet/goldenhour 同约定）。

### 3.1 Brutalism（粗野主义）`brutal`

- **颜色**: 高对比黑白 + 单一酸性强调色（亮黄 `#FFD60A`），`--theme-gradient:none`（纯色底）
- **圆角**: `--radius-*` 全 `0`（直角）
- **边框**: `--border-width:2px`、`--border-width-strong:3px` 粗黑边框
- **阴影**: `--shadow-*` 全 `none`（无阴影），`--glow-color:transparent`
- **字体**: `--font` / `--font-mono` 用等宽（`'IBM Plex Mono'`，后备系统 monospace）；`--font-weight-strong:900`
- **密度**: `--space-*` 整体缩小（紧凑）
- **效果**: 无纹理、无动画
- 气质: 瑞士国际主义海报 / 反设计，直角 + 粗框 + 强烈对比

### 3.2 CRT Terminal（老式终端）`crt`

- **颜色**: 近黑底 `#0a0e0a` + 磷光绿 `#33ff66` 主文本；`--danger` 用琥珀 `#ffb000`，`--success` 用绿
- **字体**: `--font` / `--font-mono` 全等宽（`'Cascadia Mono'` / `'JetBrains Mono'`，后备系统 monospace）
- **圆角**: `--radius-*` 偏小（`2px`）
- **阴影**: `--shadow-*` 去掉或极淡；`--glow-color:rgba(51,255,102,.35)`（文字/按钮辉光）
- **效果**: `--theme-texture` 细噪点 + `--theme-scanlines` 扫描线（重复线性渐变）+ 缓慢上滚或微闪烁动画
- 气质: 真正的老式终端，绿色磷光辉光

### 3.3 Toon（卡通漫画）`toon`

- **颜色**: 高饱和撞色背景（暖黄底 `#FFE156`，或深靛蓝底二选一，实施计划钉死）+ 泡泡糖粉 `#ff4fd8` / 电光蓝 `#2f6bff` 强调
- **圆角**: `--radius-*` 超大（`24px`+，接近胶囊）
- **边框**: `--border-width:3px` 粗描边（黑色描边感）
- **阴影**: `--shadow-*` 用卡通「掉在地上」式硬阴影（如 `0 6px 0 rgba(0,0,0,.4)`，无模糊）
- **字体**: `--font-weight-strong:900`
- **动效**: `--anim-duration` 加长 + `--anim-ease` 弹性曲线（弹跳感）
- **效果**: `--theme-texture` 圆点底纹
- 气质: 漫画书，粗描边 + 弹跳动效 + 高饱和

### 3.4 变量覆盖范围

每套覆盖：全部现有颜色变量（~28 个，与 2026-08-03-eight-new-themes-design.md 清单一致）+ 第 2.1 节样式 token + 第 2.2 节效果 token。具体 hex / 曲线值属实现细节，在实施计划中逐个钉死并校验对比度。

## 4. 硬编码 → token 收敛

### 4.1 收敛范围

只收敛**结构性尺寸**，不收敛细碎间距：
- 圆角（~105 处中影响观感者）→ `var(--radius-*)`
- 阴影（~31 处）→ `var(--shadow-*)`
- 字号档位与粗体（~110 处）→ `var(--font-scale-*)` / `var(--font-weight-strong)`
- 结构性间距（面板 padding、卡片 gap 等）→ `var(--space-*)`；`padding:4px` 之类细碎值保持字面量

原则：Nowint 下每处替换前后解析值完全相同。

### 4.2 涉及文件
- `src/styles.css`：主要审计面
- `src/**/*.ts` 内联 style 中已用 `var(--radius-*)` 等（grep 已确认 gallery/memberDetail/webxdc 等大量在用），缺失处补齐

## 5. 选择器 UI 改动

### 5.1 `src/theme.ts`
- `ThemeName` 联合类型扩展：`'brutal' | 'crt' | 'toon'`（总计 14 个 id）
- `BuiltinTheme` 新增可选字段 `preview?: string`（自定义预览 CSS，如「带圆角/描边/阴影的小卡片」示意）
- `BUILTIN_THEMES` 追加三套元数据，含 `preview`；现有 11 套无 `preview`，回退现有渐变 `swatch`

### 5.2 `src/pages/settingsPage.ts` `renderAppearance`
- 预览块渲染：`preview` 存在则渲染该 CSS 示意，否则 `style="background:${t.swatch}"`
- 网格 `flex-wrap: wrap` 已具备，14 套自动换行

### 5.3 不改动
- `src/main.ts`、主题持久化（localStorage `peyt.theme`）
- 插件主题机制（仍追加在 14 套之后）
- `src/pages/terminalPage.ts`（通过 `peyt:theme-change` + CSS 变量自动跟随，新主题自动生效）

## 6. 无障碍（reduced motion）

```css
@media (prefers-reduced-motion: reduce) {
  .theme-effect::after { animation: none !important; }
  .theme-effect { animation: none !important; }
  /* Toon 弹性过渡归零 */
  * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

- 扫描线上滚/闪烁、Toon 弹跳全部归零为静态
- 纹理（噪点/网格/圆点）保留但静止

## 7. 错误处理

- 主题块全部是静态、人工校验过的 CSS，无运行时注入，无 JS 错误路径
- token 漏覆盖只回退到 `:root` 现值（Nowint 外观），不白屏——每个 token 有默认值兜底
- `.theme-effect` 层 `pointer-events:none`，绝不拦截点击
- 拼写错误的 `var(--x)` 静默回退 inherit，由默认值语义兜底

## 8. 测试验收

### 8.1 静态校验
- [ ] `npx tsc --noEmit` 通过

### 8.2 视觉验收（`npm run tauri dev`）
- [ ] 设置 → 外观可见 14 个色板，网格正常换行
- [ ] 逐套切换 `brutal` / `crt` / `toon`：圆角/边框/阴影/字体/纹理/动效按预期生效
- [ ] 核心功能区（消息气泡、输入框、弹窗、下拉菜单、终端）在 3 套下对比度可读
- [ ] `crt` 下扫描线 + 辉光 + 等宽字体生效，`toon` 下大圆角 + 粗描边 + 硬阴影 + 弹跳生效，`brutal` 下直角 + 粗框 + 无阴影生效
- [ ] 新 3 套预览块（自定义 `preview` CSS）正确渲染
- [ ] Nowint 及现有 11 套渲染与改动前无差异

### 8.3 无障碍验收
- [ ] 系统开启「减弱动态效果」后：扫描线/闪烁/弹跳全部静止，纹理保留

### 8.4 功能验收
- [ ] 刷新后主题保持（localStorage）
- [ ] 插件注册的主题仍显示在 14 套之后，且可覆盖样式 token（如 `--radius-*`）
- [ ] 终端页面配色跟随 3 套新主题
