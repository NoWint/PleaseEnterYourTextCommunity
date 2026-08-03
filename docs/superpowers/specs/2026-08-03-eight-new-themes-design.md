# 新增 8 套主题 设计文档

> **定位**: 在现有 Nowint / Violet / GoldenHour 三套主题基础上，新增 4 深 4 浅共 8 套主题（总计 11 套），沿用 CSS 变量 + `data-theme` 的零侵入切换机制。
>
> **前置决策**（brainstorming 问答确认）:
> - 主题构成: 4 套深色（渐变底 + 半透明面板，同 Violet 机制）+ 4 套浅色（实色表面，可读性优先）
> - 实现路线: 路线 C — 8 个 `[data-theme]` CSS 变量块写进 `styles.css`（与 violet/goldenhour 同约定），`theme.ts` 导出 `BUILTIN_THEMES` 元数据作为选择器唯一数据源
> - 选择器位置: 完整网格选择器只在设置页「外观」tab；rail 头像菜单 / 命令面板 / 搜索的「切换主题」列表改为单条「外观设置」入口，直达外观 tab
> - 主题名称: 全部英文（与现有 Nowint / Violet / GoldenHour 一致）

## 1. 目标与范围

### 1.1 目标
1. 新增 8 套主题: Forest / Midnight / Ember / Graphite（深）+ Paper / Frost / Sage / Blush（浅），总计 11 套
2. 每套完整覆盖全部 28 个 CSS 变量，独立定义文本 / 面板 / 气泡 / 危险 / 成功色
3. 设置页「外观」网格从 `BUILTIN_THEMES` 元数据渲染，色板由内联渐变驱动，不再依赖 `.swatch-*` 固定类
4. rail 头像菜单 / 命令面板 / 搜索改为单条「外观设置」入口直达外观 tab
5. 现有 Nowint 默认效果零变化

### 1.2 不做
- 自定义主题色（用户自选渐变）
- 主题导入 / 导出 / 市场
- 登录页主题（保持 Nowint）
- 动态主题 / 切换动画
- 下拉菜单二级主题子菜单（dropdown 组件 mouseleave 即关，引入二级菜单需重做关闭逻辑）

## 2. 8 套新主题色板

### 2.1 深色 ×4（渐变底 + 半透明面板 + 深色遮罩）

| id | 名称 | 渐变 (135deg) | 遮罩 | 气泡色 bubble-self | 主文本 |
|---|---|---|---|---|---|
| `forest` | Forest | `#0a2318 → #164a33 → #2f9e6e` | `rgba(0,0,0,.85)` | `#1f6b4d` | `#e6efe9` |
| `midnight` | Midnight | `#0a1630 → #163a6e → #3f7bd9` | `rgba(0,0,0,.85)` | `#1f54a8` | `#e7eef6` |
| `ember` | Ember | `#230a12 → #5e1626 → #c23a4d` | `rgba(0,0,0,.85)` | `#8e2235` | `#f6e7ea` |
| `graphite` | Graphite | `#121419 → #1f242e → #3f4a5c` | `rgba(0,0,0,.85)` | `#2e3b4d` | `#e8eaee` |

深色套沿用 Violet 的半透明面板写法（`--bg/--panel` 用白色低透明 rgba，浮动菜单 `--surface` 用不透明实色保证可读）。

### 2.2 浅色 ×4（实色表面）

| id | 名称 | 背景 bg | 面板 panel | 主文本 | 气泡色 bubble-self |
|---|---|---|---|---|---|
| `paper` | Paper | `#f5efe6` | `#fbf7f0` | `#3a332b` | `#c05a2e` |
| `frost` | Frost | `#eef3f8` | `#f7fafc` | `#2e3a45` | `#3f7fb5` |
| `sage` | Sage | `#eef3ec` | `#f8faf4` | `#2f3a31` | `#3f7a55` |
| `blush` | Blush | `#f7eef1` | `#fcf8f9` | `#423039` | `#b55670` |

浅色套 `--theme-gradient: none`、`--theme-mask: none`（实色背景，无渐变遮罩），`--surface` 用不透明浅色，`--on-accent` 用亮色。

### 2.3 每套覆盖的变量清单（28 个）

`--bg / --panel / --border / --border-strong / --active / --capsule / --text / --text-body / --text-mute / --text-weak / --text-faint / --border-dashed / --text-action / --hover-bright / --theme-gradient / --theme-mask / --surface / --surface-hover / --control-bg / --control-bg-hover / --danger / --danger-bg / --danger-bg-hover / --success / --on-accent / --bubble-self / --bubble-self-text`，加上 `--danger-bg-strong` 按需。

`--danger` / `--danger-bg` / `--danger-bg-hover` / `--success` 的具体 hex 属于实现细节，由各套主题的色相族派生（如 Forest 用绿色系 success），具体取值在实施计划中逐个钉死并校验对比度。

## 3. 架构改动

### 3.1 `src/styles.css`
- 在 GoldenHour 块后新增 8 个 `[data-theme="..."]` 块，结构与注释风格与 violet/goldenhour 一致。
- 删除设置页已不再引用的 `.swatch-nowint` / `.swatch-violet` / `.swatch-goldenhour` 三个预览类（第 1887–1889 行附近），色板改由内联渐变驱动。

### 3.2 `src/theme.ts`
- `ThemeName` 联合类型扩展为 11 个 id。
- 新增唯一数据源:

```ts
export interface BuiltinTheme { id: string; label: string; swatch: string }
export const BUILTIN_THEMES: BuiltinTheme[] = [
  { id: 'nowint', label: 'Nowint', swatch: 'linear-gradient(135deg,#0d0d0d,#1a1a1a)' },
  { id: 'violet', label: 'Violet', swatch: 'linear-gradient(135deg,#1a0d2e,#6b3fa0)' },
  { id: 'goldenhour', label: 'GoldenHour', swatch: 'linear-gradient(135deg,#2e1a0d,#d4a043)' },
  { id: 'forest', label: 'Forest', swatch: 'linear-gradient(135deg,#0a2318,#2f9e6e)' },
  { id: 'midnight', label: 'Midnight', swatch: 'linear-gradient(135deg,#0a1630,#3f7bd9)' },
  { id: 'ember', label: 'Ember', swatch: 'linear-gradient(135deg,#230a12,#c23a4d)' },
  { id: 'graphite', label: 'Graphite', swatch: 'linear-gradient(135deg,#121419,#3f4a5c)' },
  { id: 'paper', label: 'Paper', swatch: 'linear-gradient(135deg,#f5efe6,#fbf7f0)' },
  { id: 'frost', label: 'Frost', swatch: 'linear-gradient(135deg,#eef3f8,#f7fafc)' },
  { id: 'sage', label: 'Sage', swatch: 'linear-gradient(135deg,#eef3ec,#f8faf4)' },
  { id: 'blush', label: 'Blush', swatch: 'linear-gradient(135deg,#f7eef1,#fcf8f9)' },
];
```
- `applyTheme` / `getCurrentTheme` / `initTheme` 逻辑不变（`nowint` 移除 `data-theme`，其余设置属性）。

### 3.3 不改动
- `src/main.ts`、主题持久化（localStorage `peyt.theme`）
- 插件主题机制（`window.__peytchat_themes`，仍追加在 11 套之后）
- `src/pages/terminalPage.ts`（已通过 `peyt:theme-change` 事件 + CSS 变量自动跟随，新主题自动生效）

## 4. 选择器改动

### 4.1 设置页「外观」网格（`src/pages/settingsPage.ts` `renderAppearance`）
- 硬编码 3 项数组 → 从 `BUILTIN_THEMES` 渲染（插件主题仍追加在后面）。
- 色板改为内联 `style="background:${t.swatch}"`（与插件主题同款），`BuiltinTheme` 不再含 `cls` 字段，`.swatch-*` 类随之删除。
- `.settings-themes` 增加 `flex-wrap: wrap` 保证 11 套换行。

### 4.2 rail 头像菜单 / 命令面板 / 搜索
- `src/shell/rail.ts` `showUserMenu`、`src/components/commandPalette.ts`、`src/components/search.ts`: 三处各自的 3 条「切换主题: ...」项 → 替换为 1 条「外观设置」项:
```ts
{ label: '外观设置', icon: 'palette', action: () => {
  state.currentSettingsSection = 'appearance';
  navigateToPage('settings');
} }
```
- `navigateToPage('settings')` 已保留 `currentSettingsSection`，无需改动。
- 图标复用现有 `palette`，不新增。

## 5. 测试验收

### 5.1 静态校验
- [ ] `npx tsc --noEmit` 通过

### 5.2 视觉验收（`npm run tauri dev`）
- [ ] 设置 → 外观可见 11 个色板，网格正常换行
- [ ] 逐一点击 11 套: 文本对比度可读、面板 / 气泡颜色正确、渐变背景（深色 4 套）正确
- [ ] 浅色 4 套（Paper/Frost/Sage/Blush）: 下拉菜单 / 浮动表面（`--surface`）不透明可读
- [ ] 终端页面配色跟随主题切换
- [ ] Nowint 默认渲染与改动前无差异

### 5.3 功能验收
- [ ] rail 头像菜单、命令面板、搜索中不再有逐主题切换项，只有「外观设置」入口且能直达外观 tab
- [ ] 刷新后主题保持（localStorage 持久化）
- [ ] 插件注册的主题仍显示在 11 套之后
