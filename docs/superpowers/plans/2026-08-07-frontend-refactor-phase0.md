# 前端重构 Phase 0：基础设施搭建 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@opencode-ai/ui` 本地源码包引入 peytchat，配置 Vite + Tailwind v4 + Solid 转译链，挂载 ThemeProvider + DialogProvider，验证 `<ButtonV2>` 在 oc-2 主题下渲染质感对齐 opencode 桌面端。

**Architecture:** 从 opencode-dev 复制 `packages/ui` 到 peytchat 作为本地 workspace 包，裁剪 v1/AI 专有组件与多余主题；根 package.json 添加 workspaces 配置；vite.config.ts 接入 `@tailwindcss/vite` 插件并排除 `@opencode-ai/ui` 预构建；新建 `src/app/` 目录承载 Solid app 入口（index.css + entry.tsx + App.tsx），通过 `src/app.html` 独立访问验证，不破坏现有旧 shell。

**Tech Stack:** Vite 5.4（不升级，验证兼容性）、vite-plugin-solid 2.11.14、@tailwindcss/vite 4.3.3、Tailwind v4 CSS-first、solid-js 1.9.14、@opencode-ai/ui 1.18.13（本地源码包）

**后续计划说明：** 本计划仅覆盖 Phase 0（基础设施验证）。Phase 1–7 的计划将在 Phase 0 验收通过后逐个制定。spec 文档：`docs/superpowers/specs/2026-08-07-frontend-refactor-design.md`

## Global Constraints

- core/ 子模块禁止修改
- 仅黑白配色：只保留 oc-2（暗）+ amoled（纯黑）两个主题
- v1 组件不引入（仅保留 font/resize-handle/scroll-view/popover/context-menu/image-preview/list 共 7 个 v1 组件 + app-icons/file-icons/provider-icons sprite）
- AI 专有 v2 组件删除：diff-changes-v2、file-tree-v2、line-comment-v2
- 不引入 @opencode-ai/sdk / @opencode-ai/client / Effect-TS / @tanstack/solid-query
- Vite 保持 5.4 不升级（如果 Phase 0 验证失败再升级到 7）
- solid-js 保持 1.9.14 不打 patch
- 旧 shell（src/main.ts 的 renderShell）不动，Phase 0 通过独立 HTML 入口验证

---

## File Structure

### 新建文件

| 文件 | 职责 |
|---|---|
| `packages/ui/` | 从 opencode-dev 复制的 @opencode-ai/ui 本地 workspace 包 |
| `packages/ui/package.json` | 替换 catalog: 为实际版本号后的包配置 |
| `src/app/index.css` | Solid app 全局 CSS 入口（@import ui 包 tailwind + v2 styles + @source 声明） |
| `src/app/entry.tsx` | Solid app 渲染入口（render(() => <App />)） |
| `src/app/App.tsx` | 根组件（ThemeProvider + DialogProvider + ButtonV2 验证） |
| `src/app.html` | Solid app 独立 HTML 入口（不修改 src/index.html） |

### 修改文件

| 文件 | 改动 |
|---|---|
| `package.json` | 添加 workspaces 配置 + @solidjs/meta + tw-animate-css 依赖 |
| `vite.config.ts` | 添加 @tailwindcss/vite 插件 + optimizeDeps.exclude @opencode-ai/ui |
| `tsconfig.json` | 确保 packages/ui 纳入编译范围（如果需要） |

### 删除文件

| 文件 | 原因 |
|---|---|
| `tailwind.config.ts` | 改用 Tailwind v4 CSS-first @source 指令 |
| `packages/ui/src/v2/components/diff-changes-v2.*` | AI 专有 |
| `packages/ui/src/v2/components/file-tree-v2.*` | AI 专有 |
| `packages/ui/src/v2/components/line-comment-v2.*` | AI 专有 |
| `packages/ui/src/theme/themes/` 下除 oc-2.json 和 amoled.json 外的所有 JSON | 仅保留 2 个主题 |
| `packages/ui/src/components/` 下 v1 组件（保留 font/resize-handle/scroll-view/popover/context-menu/image-preview/list + app-icons/file-icons/provider-icons） | v1 不引入 |

---

### Task 1: 复制 @opencode-ai/ui 包并裁剪

**Files:**
- Create: `packages/ui/`（从 `/Users/xiatian/Downloads/opencode-dev/packages/ui` 复制）
- Modify: `packages/ui/package.json`
- Delete: `packages/ui/src/v2/components/{diff-changes-v2,file-tree-v2,line-comment-v2}.*`
- Delete: `packages/ui/src/theme/themes/` 下除 `oc-2.json`、`amoled.json` 外的所有 JSON
- Delete: `packages/ui/src/components/` 下 v1 组件（保留 7 个 + 3 个 sprite 目录）

**Interfaces:**
- Produces: 本地 workspace 包 `@opencode-ai/ui`，可通过 `import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"` 引用

- [ ] **Step 1: 复制 ui 包目录**

```bash
cp -R /Users/xiatian/Downloads/opencode-dev/packages/ui /Users/xiatian/Desktop/peytchat/packages/ui
```

验证：`ls /Users/xiatian/Desktop/peytchat/packages/ui/package.json` 存在。

- [ ] **Step 2: 删除 AI 专有 v2 组件**

```bash
cd /Users/xiatian/Desktop/peytchat/packages/ui/src/v2/components
rm -f diff-changes-v2.tsx diff-changes-v2.css diff-changes-v2.stories.tsx
rm -f file-tree-v2.css
rm -f line-comment-v2.tsx line-comment-v2.css line-comment-v2.stories.tsx
```

验证：`ls diff-changes-v2* file-tree-v2* line-comment-v2* 2>/dev/null` 无输出。

- [ ] **Step 3: 裁剪主题 JSON（只保留 oc-2 + amoled）**

```bash
cd /Users/xiatian/Desktop/peytchat/packages/ui/src/theme/themes
ls *.json | grep -v -E '^(oc-2|amoled)\.json$' | xargs rm -f
```

验证：`ls` 只显示 `amoled.json` 和 `oc-2.json`。

- [ ] **Step 4: 裁剪 v1 组件（保留 7 个 + 3 个 sprite 目录）**

```bash
cd /Users/xiatian/Desktop/peytchat/packages/ui/src/components

# 保留的 v1 组件（白名单）
# font.tsx, font.stories.tsx
# resize-handle.tsx, resize-handle.css, resize-handle.stories.tsx
# scroll-view.tsx, scroll-view.css, scroll-view.test.ts, scroll-view.stories.tsx
# popover.tsx, popover.css, popover.stories.tsx
# context-menu.tsx, context-menu.css, context-menu.stories.tsx
# image-preview.tsx, image-preview.css, image-preview.stories.tsx
# list.tsx, list.css, list.stories.tsx
# app-icons/, file-icons/, provider-icons/（sprite 目录）

# 删除白名单之外的所有 .tsx/.css/.stories.tsx/.test.ts
find . -maxdepth 1 -type f \( -name "*.tsx" -o -name "*.css" -o -name "*.stories.tsx" -o -name "*.test.ts" \) \
  ! -name "font.*" \
  ! -name "resize-handle.*" \
  ! -name "scroll-view.*" \
  ! -name "popover.*" \
  ! -name "context-menu.*" \
  ! -name "image-preview.*" \
  ! -name "list.*" \
  -delete
```

验证：`ls *.tsx` 只显示 font/resize-handle/scroll-view/popover/context-menu/image-preview/list 的 .tsx 文件。

- [ ] **Step 5: 替换 package.json 的 catalog: 为实际版本号**

把 `packages/ui/package.json` 的 `dependencies` 和 `devDependencies` 里所有 `"catalog:"` 替换为实际版本号。版本号来自 opencode-dev 根 package.json 的 `workspaces.catalog` 字段。

替换映射表（`catalog:` → 实际版本）：

| 包名 | 版本 |
|---|---|
| `@kobalte/core` | `0.13.11` |
| `@pierre/diffs` | `1.2.10` |
| `@shikijs/stream` | `4.2.0` |
| `@shikijs/transformers` | `3.9.2`（已是实际版本，不改） |
| `diff` | `8.0.2` |
| `dompurify` | `3.3.1` |
| `fuzzysort` | `3.1.0` |
| `luxon` | `3.6.1` |
| `marked` | `18.0.7` |
| `marked-shiki` | `1.2.1` |
| `remend` | `1.3.0` |
| `shiki` | `4.2.0` |
| `solid-list` | `0.3.0` |
| `solid-sonner` | `0.3.1` |
| `remeda` | `2.26.0` |
| `@solidjs/meta` | `0.29.4` |
| `solid-js` | `1.9.10`（devDep，但 peytchat 根已有 1.9.14，peerDep 保持 ^1.9.0） |
| `vite-plugin-solid` | `2.11.10`（devDep） |
| `@tailwindcss/vite` | `4.1.11`（devDep） |
| `tailwindcss` | `4.1.11`（devDep） |
| `vite` | `7.1.4`（devDep） |
| `typescript` | `5.8.2`（devDep） |
| `@types/luxon` | `3.7.1` |
| `@types/bun` | `1.3.13` |
| `@tsconfig/node22` | `22.0.2` |
| `@typescript/native-preview` | `7.0.0-dev.20251207.1` |

用 sed 批量替换（在 `packages/ui/` 目录下执行）：

```bash
cd /Users/xiatian/Desktop/peytchat/packages/ui

# 先备份
cp package.json package.json.bak

# 逐个替换 catalog: 为实际版本
sed -i '' \
  -e 's/"@kobalte\/core": "catalog:"/"@kobalte\/core": "0.13.11"/' \
  -e 's/"@pierre\/diffs": "catalog:"/"@pierre\/diffs": "1.2.10"/' \
  -e 's/"@shikijs\/stream": "catalog:"/"@shikijs\/stream": "4.2.0"/' \
  -e 's/"diff": "catalog:"/"diff": "8.0.2"/' \
  -e 's/"dompurify": "catalog:"/"dompurify": "3.3.1"/' \
  -e 's/"fuzzysort": "catalog:"/"fuzzysort": "3.1.0"/' \
  -e 's/"luxon": "catalog:"/"luxon": "3.6.1"/' \
  -e 's/"marked": "catalog:"/"marked": "18.0.7"/' \
  -e 's/"marked-shiki": "catalog:"/"marked-shiki": "1.2.1"/' \
  -e 's/"remend": "catalog:"/"remend": "1.3.0"/' \
  -e 's/"shiki": "catalog:"/"shiki": "4.2.0"/' \
  -e 's/"solid-list": "catalog:"/"solid-list": "0.3.0"/' \
  -e 's/"solid-sonner": "catalog:"/"solid-sonner": "0.3.1"/' \
  -e 's/"remeda": "catalog:"/"remeda": "2.26.0"/' \
  -e 's/"@solidjs\/meta": "catalog:"/"@solidjs\/meta": "0.29.4"/' \
  -e 's/"solid-js": "catalog:"/"solid-js": "1.9.10"/' \
  -e 's/"vite-plugin-solid": "catalog:"/"vite-plugin-solid": "2.11.10"/' \
  -e 's/"@tailwindcss\/vite": "catalog:"/"@tailwindcss\/vite": "4.1.11"/' \
  -e 's/"tailwindcss": "catalog:"/"tailwindcss": "4.1.11"/' \
  -e 's/"vite": "catalog:"/"vite": "7.1.4"/' \
  -e 's/"typescript": "catalog:"/"typescript": "5.8.2"/' \
  -e 's/"@types\/luxon": "catalog:"/"@types\/luxon": "3.7.1"/' \
  -e 's/"@types\/bun": "catalog:"/"@types\/bun": "1.3.13"/' \
  -e 's/"@tsconfig\/node22": "catalog:"/"@tsconfig\/node22": "22.0.2"/' \
  -e 's/"@typescript\/native-preview": "catalog:"/"@typescript\/native-preview": "7.0.0-dev.20251207.1"/' \
  package.json

# 验证无残留 catalog:
grep "catalog:" package.json && echo "ERROR: still has catalog:" || echo "OK: no catalog: remaining"

# 删除备份
rm package.json.bak
```

- [ ] **Step 6: 配置根 package.json workspaces**

修改 `/Users/xiatian/Desktop/peytchat/package.json`，添加 `workspaces` 字段和缺失的依赖。

在 `package.json` 里添加（在 `"private": true` 之后）：

```json
"workspaces": ["packages/*"],
```

在 `devDependencies` 里添加（如果不存在）：

```json
"@solidjs/meta": "^0.29.4",
"tw-animate-css": "^1.4.0",
```

完整示例（仅展示改动部分）：

```json
{
  "name": "peytchat",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["packages/*"],
  "type": "module",
  ...
  "devDependencies": {
    "@solidjs/meta": "^0.29.4",
    "@solidjs/testing-library": "^0.8.10",
    "@tailwindcss/vite": "^4.3.3",
    "@tauri-apps/cli": "^2.0.0",
    "@testing-library/jest-dom": "^7.0.0",
    "@types/node": "^26.1.2",
    "jsdom": "^29.1.1",
    "tailwindcss": "^4.3.3",
    "tw-animate-css": "^1.4.0",
    "typescript": "^7.0.2",
    "vite": "^5.4.0",
    "vite-plugin-solid": "^2.11.14",
    "vitest": "^3.2.7"
  }
}
```

- [ ] **Step 7: 安装依赖**

```bash
cd /Users/xiatian/Desktop/peytchat
npm install
```

验证：`ls node_modules/@opencode-ai/ui` 存在（workspace symlink）。如果 npm 报版本冲突，检查根 package.json 的依赖版本是否与 ui 包冲突（特别是 solid-js：根 1.9.14 vs ui 包 devDep 1.9.10，npm 会用根的 1.9.14）。

- [ ] **Step 8: 验证 symlink 和基本结构**

```bash
ls -la node_modules/@opencode-ai/ui
# 应该显示 symlink -> ../../packages/ui

ls node_modules/@opencode-ai/ui/src/v2/components/button-v2.tsx
# 应该存在
```

- [ ] **Step 9: Commit**

```bash
cd /Users/xiatian/Desktop/peytchat
git add packages/ui package.json package-lock.json
git commit -m "feat(ui): vendor @opencode-ai/ui as local workspace package

- Copy packages/ui from opencode-dev
- Trim v1 components (keep font/resize-handle/scroll-view/popover/context-menu/image-preview/list + sprite dirs)
- Remove AI-only v2 components (diff-changes-v2/file-tree-v2/line-comment-v2)
- Keep only oc-2 + amoled themes
- Replace catalog: with actual versions
- Add workspaces config to root package.json"
```

---

### Task 2: 配置 Vite + Tailwind v4 + Solid 转译

**Files:**
- Modify: `vite.config.ts`
- Delete: `tailwind.config.ts`

**Interfaces:**
- Consumes: Task 1 的 `@opencode-ai/ui` workspace 包
- Produces: Vite 配置支持 solid 转译 `@opencode-ai/ui` 的 .tsx + Tailwind v4 CSS-first

- [ ] **Step 1: 修改 vite.config.ts**

把 `/Users/xiatian/Desktop/peytchat/vite.config.ts` 替换为：

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "src",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "../dist",
    emptyOutDir: true,
  },
  // jieba-wasm: wasm-bindgen 产物, 预构建会破坏 wasm 定位
  // @opencode-ai/ui: 源码型包(.tsx), 必须排除预构建让 solid 插件转译
  optimizeDeps: {
    exclude: ["jieba-wasm", "@opencode-ai/ui"],
  },
  plugins: [
    solid(),
    tailwindcss(),
  ],
  test: {
    root: projectRoot,
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
```

关键改动：
1. 新增 `import tailwindcss from "@tailwindcss/vite"`
2. `plugins` 数组添加 `tailwindcss()`
3. `optimizeDeps.exclude` 添加 `"@opencode-ai/ui"`（让 solid 插件转译其 .tsx 源码，而非走 esbuild 预构建）

- [ ] **Step 2: 删除 tailwind.config.ts**

```bash
rm /Users/xiatian/Desktop/peytchat/tailwind.config.ts
```

Tailwind v4 改用 CSS-first `@source` 指令声明扫描范围，不再需要 JS 配置文件。

- [ ] **Step 3: 验证 vite dev 启动**

```bash
cd /Users/xiatian/Desktop/peytchat
npm run dev
```

验证：dev server 在 `http://localhost:1420` 启动无报错。如果有报错，检查：
- `@tailwindcss/vite` 版本是否兼容 Vite 5.4
- `@opencode-ai/ui` 是否在 node_modules 里（Task 1 的 symlink）
- solid 插件是否能转译 `@opencode-ai/ui` 的 .tsx（如果报 JSX 语法错误，可能需要 solid 插件的 `solid: { include }` 选项）

停掉 dev server（Ctrl+C）。

- [ ] **Step 4: Commit**

```bash
cd /Users/xiatian/Desktop/peytchat
git add vite.config.ts
git rm tailwind.config.ts
git commit -m "build(vite): add @tailwindcss/vite plugin and exclude @opencode-ai/ui from optimizeDeps

- Add tailwindcss() to vite plugins for Tailwind v4 CSS-first
- Exclude @opencode-ai/ui from optimizeDeps so solid plugin can transpile its .tsx source
- Delete tailwind.config.ts (replaced by @source CSS directives)
- Keep Vite 5.4 (no upgrade needed)"
```

---

### Task 3: 创建 Solid app 入口并验证 ButtonV2 渲染

**Files:**
- Create: `src/app/index.css`
- Create: `src/app/entry.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app.html`

**Interfaces:**
- Consumes: Task 1 的 `@opencode-ai/ui` 包 + Task 2 的 Vite 配置
- Produces: `http://localhost:1420/app.html` 渲染一个带 oc-2 主题的 `<ButtonV2>`

- [ ] **Step 1: 创建 src/app/index.css**

```css
@import "@opencode-ai/ui/styles/tailwind";
@import "@opencode-ai/ui/v2/styles/tailwind.css";
@import "tw-animate-css";

/* Tailwind v4 CSS-first: 显式声明扫描范围 */
@source "../../packages/ui/src";
@source "./";

/* 字体 */
@font-face {
  font-family: "Inter";
  src: url("@opencode-ai/ui/fonts/Inter.ttf") format("truetype");
  font-weight: 100 900;
  font-style: normal;
}

@font-face {
  font-family: "JetBrainsMono Nerd Font Mono";
  src: url("/assets/JetBrainsMonoNerdFontMono-Regular.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
}

html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: var(--v2-background-bg-deep, #0a0a0a);
  color: var(--v2-text-text-base, #e5e5e5);
  font-family: "Inter", sans-serif;
}

#app {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

- [ ] **Step 2: 创建 src/app/entry.tsx**

```tsx
/* @refresh reload */
import { render } from "solid-js/web"
import App from "./App"
import "./index.css"

const root = document.getElementById("app")
if (!root) throw new Error("Root element #app not found")

render(() => <App />, root)
```

- [ ] **Step 3: 创建 src/app/App.tsx**

```tsx
import type { Component } from "solid-js"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { Font } from "@opencode-ai/ui/font"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"

const App: Component = () => {
  return (
    <ThemeProvider defaultTheme="oc-2">
      <Font>
        <DialogProvider>
          <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "align-items": "center" }}>
            <h1 style={{ "font-size": "20px", "font-weight": 600 }}>Phase 0 验证</h1>
            <ButtonV2 variant="neutral" size="normal">Neutral Button</ButtonV2>
            <ButtonV2 variant="contrast" size="normal">Contrast Button</ButtonV2>
            <ButtonV2 variant="ghost" size="small">Ghost Small</ButtonV2>
          </div>
        </DialogProvider>
      </Font>
    </ThemeProvider>
  )
}

export default App
```

- [ ] **Step 4: 创建 src/app.html**

```html
<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PEYT Chat - Solid App</title>
    <!-- 主题 preload: 首帧前应用持久化主题,避免闪变 -->
    <!-- 注意: ThemeProvider 内部用 'opencode-theme-id' 作为 localStorage key -->
    <script>
      (function () {
        try {
          var t = localStorage.getItem('opencode-theme-id') || 'oc-2';
          document.documentElement.setAttribute('data-theme', t);
        } catch (e) {}
      })();
    </script>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/app/entry.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 验证 TypeScript 编译**

```bash
cd /Users/xiatian/Desktop/peytchat
npx tsc --noEmit
```

验证：0 errors。如果有错误，常见原因：
- `@opencode-ai/ui/font` 找不到 → 检查 `packages/ui/src/components/font.tsx` 是否存在（Task 1 Step 4 应保留）
- `@opencode-ai/ui/theme/context` 找不到 → 检查 `packages/ui/src/theme/context.tsx` 是否存在
- `@opencode-ai/ui/context/dialog` 找不到 → 检查 `packages/ui/src/context/dialog.tsx` 是否存在
- tsconfig.json 的 `paths` 未映射 → 检查 tsconfig.json 是否有 `"@/*": ["./src/*"]`，但 `@opencode-ai/ui` 走 node_modules symlink 不需要 paths

如果 tsc 报 `@opencode-ai/ui` 内部文件的类型错误（因为裁剪了 v1 组件导致 import 断链），在 `tsconfig.json` 的 `exclude` 里添加 `"packages/ui"`（ui 包有自己的 tsconfig，不依赖根的 tsc 检查）。

- [ ] **Step 6: 验证 vite build**

```bash
cd /Users/xiatian/Desktop/peytchat
npm run build
```

验证：build 成功无报错。如果报错，检查：
- CSS `@import` 解析失败 → `@tailwindcss/vite` 插件是否正确加载
- `@source` 指令报错 → Tailwind v4 版本是否支持 `@source`（4.3.3 应该支持）
- solid JSX 转译失败 → `optimizeDeps.exclude` 是否包含 `@opencode-ai/ui`

- [ ] **Step 7: 验证 dev 模式 ButtonV2 渲染**

```bash
cd /Users/xiatian/Desktop/peytchat
npm run dev
```

在浏览器打开 `http://localhost:1420/app.html`。

验证：
1. 页面显示"Phase 0 验证"标题 + 3 个按钮
2. 按钮渲染为 opencode v2 风格（圆角、暗色背景、正确的字体/字号/间距）
3. 浏览器 DevTools 的 Computed 面板里能查到 `--v2-background-bg-deep` 等 CSS 变量
4. `<html>` 标签上有 `data-theme="oc-2"` 属性
5. 控制台无 "Theme context must be used within a provider" 或类似报错
6. 对比 opencode 桌面端的 ButtonV2 风格（打开 opencode-dev 的 storybook 或桌面端确认质感一致）

停掉 dev server（Ctrl+C）。

- [ ] **Step 8: Commit**

```bash
cd /Users/xiatian/Desktop/peytchat
git add src/app/index.css src/app/entry.tsx src/app/App.tsx src/app.html
git commit -m "feat(app): add Solid app entry with ThemeProvider + ButtonV2 verification

- src/app/index.css: global CSS entry (@import ui tailwind + v2 styles + @source)
- src/app/entry.tsx: Solid render entry
- src/app/App.tsx: ThemeProvider + DialogProvider + Font + ButtonV2
- src/app.html: standalone HTML entry (does not modify src/index.html)
- Phase 0 verification: ButtonV2 renders with oc-2 theme, CSS variables applied"
```

---

## Phase 0 验收清单

完成全部 3 个 Task 后，执行以下验收：

- [ ] `npx tsc --noEmit` → 0 errors
- [ ] `npm run build` → 成功无报错
- [ ] `npm run dev` → `http://localhost:1420/app.html` 正常渲染 ButtonV2
- [ ] ButtonV2 视觉质感与 opencode 桌面端一致（圆角/字体/色值/间距）
- [ ] DevTools Computed 面板能查到 `--v2-background-bg-deep` 等 v2 CSS 变量
- [ ] `<html>` 标签有 `data-theme="oc-2"` 属性
- [ ] 浏览器控制台无报错
- [ ] 旧 shell（`http://localhost:1420/` 或 `http://localhost:1420/index.html`）仍可正常访问
- [ ] `packages/ui` 已裁剪（无 v1 组件冗余、无 AI v2 组件、仅 2 个主题 JSON）
- [ ] `tailwind.config.ts` 已删除
- [ ] 3 个 commit 已提交

验收通过后，开始制定 Phase 1（app 壳）的实现计划。

---

## 风险与故障排查

### 风险 1：@tailwindcss/vite 4.3.3 不兼容 Vite 5.4

**症状**：`npm run dev` 或 `npm run build` 报 `@tailwindcss/vite` 相关错误。

**排查**：检查 `@tailwindcss/vite` 的 peerDependencies 是否要求 Vite 6+。如果是，升级 Vite 到 7.1.4（与 opencode-dev 一致），同时升级 `vite-plugin-solid` 到 2.11.10。

**修复**：
```bash
npm install vite@7.1.4 vite-plugin-solid@2.11.10 --save-dev
```

### 风险 2：solid 插件不转译 @opencode-ai/ui 的 .tsx

**症状**：浏览器报 JSX 语法错误或 `Unexpected token '<'`。

**排查**：vite-plugin-solid 默认排除 node_modules 里的文件。虽然 `optimizeDeps.exclude` 阻止了预构建，但 solid 插件可能仍不处理 node_modules 里的 .tsx。

**修复**：在 vite.config.ts 的 solid 插件配置里显式包含 `@opencode-ai/ui`：

```ts
solid({
  babel: {
    plugins: [],
  },
})
```

或者把 `@opencode-ai/ui` 从 node_modules symlink 改为 vite alias：

```ts
resolve: {
  alias: {
    "@opencode-ai/ui": path.resolve(projectRoot, "packages/ui"),
  },
},
```

但 alias 不支持 exports 子路径映射。如果需要 alias，要用 RegExp：

```ts
resolve: {
  alias: [
    {
      find: /^@opencode-ai\/ui$/,
      replacement: path.resolve(projectRoot, "packages/ui"),
    },
    {
      find: /^@opencode-ai\/ui\/v2\/(.+)$/,
      replacement: path.resolve(projectRoot, "packages/ui/src/v2/components/$1"),
    },
    // ... 需要为每种 exports 模式写规则
  ],
},
```

这很脆弱，仅在 optimizeDeps.exclude 方案失败时使用。

### 风险 3：CSS @import 解析失败

**症状**：`@import "@opencode-ai/ui/styles/tailwind"` 报 "Cannot resolve" 错误。

**排查**：vite 对 CSS @import 的 node_modules 解析可能需要特殊配置。

**修复**：在 vite.config.ts 添加 `css.preprocessorOptions` 或确认 `@opencode-ai/ui` symlink 正确：

```bash
ls -la node_modules/@opencode-ai/ui/src/styles/tailwind/index.css
# 应该存在
```

### 风险 4：tsc 报 @opencode-ai/ui 内部类型错误

**症状**：`npx tsc --noEmit` 报 `packages/ui/src/` 下的类型错误（因为裁剪了 v1 组件导致某些 import 断链）。

**排查**：ui 包有自己的 `tsconfig.build.json`，不依赖根 tsc。根 tsconfig 可能扫描了 `packages/ui`。

**修复**：在根 `tsconfig.json` 的 `exclude` 里添加 `"packages/ui"`：

```json
{
  "exclude": ["node_modules", "dist", "packages/ui"]
}
```

ui 包的类型检查由它自己的 tsconfig 管理，不影响根项目的类型安全。

### 风险 5：npm install 版本冲突

**症状**：`npm install` 报版本冲突（solid-js 根 1.9.14 vs ui 包 devDep 1.9.10）。

**修复**：ui 包的 `solid-js` 在 `devDependencies` 里（1.9.10），`peerDependencies` 是 `^1.9.0`。npm 会用根的 1.9.14 满足 peerDep。如果仍有冲突，把 ui 包 devDep 的 solid-js 改为 `1.9.14`。
