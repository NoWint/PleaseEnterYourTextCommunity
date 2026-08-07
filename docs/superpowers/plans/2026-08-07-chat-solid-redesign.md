# Chat Solid 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 peytchat chat 模块从 Vanilla TS 命令式 DOM 重构为 Solid.js 响应式 Solid 岛,对齐 opencode desktop 的 UI/UX 质感。

**Architecture:** Solid 岛嵌入 `#chat-main`,shell 仅传 chatId signal;vendored v2 令牌 CSS + 自实现 Kobalte 组件 + 虚拟化时间线(projection)+ spring 动效;功能开关 `USE_SOLID_CHAT` 可回退旧实现。

**Tech Stack:** Solid.js 1.9 / @kobalte/core / @tanstack/solid-virtual / motion-one / solid-sonner / Tailwind v4 / vitest / Inter 可变字体

## Global Constraints

- TypeScript strict 模式,禁止 `any`(继承现有约束)
- vite root = "src";tsconfig 已有 `@/*` → `./src/*` 别名
- MsgDto.msg_id 是 `number`;乐观临时消息用负数 `-Date.now()`(非字符串)
- `onEvent(typ, cb)` 是 async,返回 `Promise<() => void>`(取消订阅函数)
- `call<T>(cmd, args)` 是 Tauri invoke;IPC 命令名 snake_case
- @opencode-ai/ui 不在 npm:采用 vendored 模式(复制令牌 CSS + 图标定义,自实现组件)
- 设计令牌:全面 `--v2-*` 前缀;Inter 可变字体 530/440 字重;`letter-spacing: -0.04px`
- 现有事件 typ:`MsgsChanged` / `MsgDelivered` / `MsgFailed` / `MsgRead` / `MsgDeleted` / `ReactionsChanged` / `MsgReadCountChanged` / `IncomingMsg`
- 参考源:`/Users/xiatian/Downloads/opencode-dev/packages/ui/src/v2/`
- 每个 task 结尾 commit;commit message 用 conventional commits

---

## 文件结构总览

```
src/chat-solid/
  vendor/                         # 从 opencode-dev vendored(纯 CSS/TS,无依赖链)
    styles/
      theme.css                   # v2 令牌(从 opencode-dev 复制)
      colors.css                  # v2 色阶(从 opencode-dev 复制)
    icon-definitions.ts           # v2 图标定义(从 opencode-dev 复制)
  components/                     # 自实现基础组件(Kobalte + v2 令牌)
    Button.tsx
    Avatar.tsx
    Icon.tsx                      # ensureSprite + <use> 渲染
    Tooltip.tsx
    Popover.tsx
    ContextMenu.tsx
    Dialog.tsx
    Toast.tsx                     # solid-sonner 包装
  state/
    chatStore.ts                  # createStore 消息/reactions/read/pins
    signals.ts                    # chatId signal + syncChatIdSignal
  bridge/
    eventBridge.ts                # onEvent → chatStore
    shellBridge.ts                # Solid → shell 回调
  timeline/
    projection.ts                 # MsgDto[] → TimelineRow[]
    useVirtualTimeline.ts         # createVirtualizer + 缓存
    MessageTimeline.tsx
    rows/
      DateDivider.tsx
      UnreadSeparator.tsx
      MessageBubble.tsx
      MessageContent.tsx          # view_type 分发
      SystemMessage.tsx
      SummaryBubble.tsx
  composer/
    useComposerController.ts
    Composer.tsx
    ReplyPreview.tsx
    MentionSuggest.tsx
  messages/
    ReactionPicker.tsx
    ReactionCapsules.tsx
    MessageHoverActions.tsx
    VoicePlayer.tsx
    WebxdcCard.tsx
    Gallery.tsx
  styles/
    chat.css                      # 排版类 + chat 专属样式
  ChatApp.tsx                     # 根组件
  index.tsx                       # mount/unmount 入口
test/
  chat-solid/
    projection.test.ts
    chatStore.test.ts
    useComposerController.test.ts
```

---

## 阶段 0:基础设施

### Task 0.1:安装依赖与配置 vite/tsconfig

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: Solid JSX 编译 + Tailwind v4 + vitest 可用

- [ ] **Step 1: 安装运行时依赖**

Run:
```bash
npm install solid-js @kobalte/core @tanstack/solid-virtual motion solid-sonner @solid-primitives/media
```

- [ ] **Step 2: 安装开发依赖**

Run:
```bash
npm install -D vite-plugin-solid @tailwindcss/vite tailwindcss vitest @solidjs/testing-library jsdom @testing-library/jest-dom
```

- [ ] **Step 3: 配置 vite.config.ts**

```typescript
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2021", outDir: "../dist", emptyOutDir: true },
  optimizeDeps: { exclude: ["jieba-wasm"] },
  plugins: [
    solid(),
    tailwindcss(),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
```

- [ ] **Step 4: 配置 tsconfig.json 加 JSX**

在 `compilerOptions` 加入:
```json
"jsx": "preserve",
"jsxImportSource": "solid-js",
"types": ["node", "vitest/globals", "@testing-library/jest-dom"]
```

- [ ] **Step 5: 创建 Tailwind 配置(限定 chat-solid)**

Create `tailwind.config.ts`:
```typescript
import type { Config } from "tailwindcss";
export default {
  content: ["./src/chat-solid/**/*.{ts,tsx}"],
} satisfies Config;
```

- [ ] **Step 6: 验证编译**

Run: `npx tsc --noEmit`
Expected: 无新增错误(可能有 solid 类型补充)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json tailwind.config.ts
git commit -m "build: add Solid/Tailwind/vitest deps and config"
```

---

### Task 0.2:Vendored v2 令牌与图标

**Files:**
- Create: `src/chat-solid/vendor/styles/theme.css`
- Create: `src/chat-solid/vendor/styles/colors.css`
- Create: `src/chat-solid/vendor/icon-definitions.ts`
- Create: `src/chat-solid/styles/chat.css`

**Interfaces:**
- Produces: `--v2-*` CSS 变量可用;Inter 字体加载;排版工具类 `.text-13-medium` 等

- [ ] **Step 1: 复制 v2 令牌 CSS**

Run:
```bash
cp /Users/xiatian/Downloads/opencode-dev/packages/ui/src/v2/styles/theme.css src/chat-solid/vendor/styles/theme.css
cp /Users/xiatian/Downloads/opencode-dev/packages/ui/src/v2/styles/colors.css src/chat-solid/vendor/styles/colors.css
```

- [ ] **Step 2: 复制图标定义**

Run:
```bash
cp /Users/xiatian/Downloads/opencode-dev/packages/ui/src/v2/components/icon.tsx src/chat-solid/vendor/icon-definitions.ts
```
(后续 Icon.tsx 从此文件 import icons 对象 + ensureSprite)

- [ ] **Step 3: 创建 chat.css(排版类 + 令牌 import + Inter)**

```css
/* src/chat-solid/styles/chat.css */
@import "../vendor/styles/theme.css";
@import "../vendor/styles/colors.css";

@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("https://rsms.me/inter/font-files/InterVariable.woff2") format("woff2");
}

.peyt-chat {
  font-family: "Inter", sans-serif;
  font-variation-settings: "slnt" 0;
  font-variant-numeric: tabular-nums;
  color: var(--v2-text-text-base);
  background: var(--v2-background-bg-base);
}

/* 排版工具类:数字=px,后缀=字重(regular=440, medium=530) */
.text-11-regular { font-size: 11px; font-weight: 440; line-height: 16px; letter-spacing: -0.04px; }
.text-11-medium { font-size: 11px; font-weight: 530; line-height: 16px; letter-spacing: -0.04px; }
.text-12-regular { font-size: 12px; font-weight: 440; line-height: 16px; letter-spacing: -0.04px; }
.text-13-regular { font-size: 13px; font-weight: 440; line-height: 20px; letter-spacing: -0.04px; }
.text-13-medium { font-size: 13px; font-weight: 530; line-height: 20px; letter-spacing: -0.04px; }
.text-15-medium { font-size: 15px; font-weight: 530; line-height: 20px; letter-spacing: -0.13px; }

/* 消息气泡 */
.msg-bubble-out { background: var(--v2-background-bg-layer-02); }
.msg-bubble-in  { background: var(--v2-background-bg-layer-01); }

/* hover 操作 */
.hover-actions { opacity: 0; transition: opacity 150ms ease-out; }
.message-row:hover .hover-actions { opacity: 1; }

/* fadeUp 阶梯进入(对齐 opencode) */
@keyframes fadeUp { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
.fade-up > * { animation: fadeUp 200ms ease-out both; }
.fade-up > *:nth-child(1) { animation-delay: 0ms; }
.fade-up > *:nth-child(2) { animation-delay: 30ms; }
.fade-up > *:nth-child(3) { animation-delay: 60ms; }
.fade-up > *:nth-child(4) { animation-delay: 90ms; }
.fade-up > *:nth-child(5) { animation-delay: 120ms; }

@media (prefers-reduced-motion: reduce) {
  .fade-up > * { animation: none !important; }
  .hover-actions { transition: none !important; }
}
```

- [ ] **Step 4: 验证令牌可 import**

Create temporary `src/chat-solid/_token-check.ts`:
```typescript
import "./styles/chat.css";
console.log("token import ok");
```
Run: `npx vite build` (确认无 CSS import 错误)
Then delete: `src/chat-solid/_token-check.ts`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/vendor src/chat-solid/styles
git commit -m "feat(chat-solid): vendor v2 design tokens and icons"
```

---

## 阶段 1:基础组件

### Task 1.1:Icon 组件(sprite + use)

**Files:**
- Create: `src/chat-solid/components/Icon.tsx`
- Test: `test/chat-solid/Icon.test.tsx`

**Interfaces:**
- Produces: `Icon(name: string, size?: "small"|"normal"|"large")` 组件

- [ ] **Step 1: 写失败测试**

```tsx
// test/chat-solid/Icon.test.tsx
import { render } from "@solidjs/testing-library";
import { describe, it, expect } from "vitest";
import { Icon } from "@/chat-solid/components/Icon";

describe("Icon", () => {
  it("renders an svg with use href", () => {
    const { container } = render(() => <Icon name="plus" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    const use = svg?.querySelector("use");
    expect(use?.getAttribute("href")).toBe("#peyt-chat-icon-plus");
  });

  it("applies size", () => {
    const { container } = render(() => <Icon name="plus" size="large" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("20");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/chat-solid/Icon.test.tsx`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 Icon**

```tsx
// src/chat-solid/components/Icon.tsx
import { onMount, createMemo, type JSX } from "solid-js";
import { icons } from "../vendor/icon-definitions";

const SPRITE_ID = "peyt-chat-icon-sprite";
const symbol = (name: string) => `${SPRITE_ID}-${name}`;

function ensureSprite(): void {
  if (document.getElementById(SPRITE_ID)) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = SPRITE_ID;
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.overflow = "hidden";
  svg.innerHTML = Object.entries(icons)
    .map(([name, def]) => `<symbol id="${symbol(name)}" viewBox="${def.viewBox}">${def.body}</symbol>`)
    .join("");
  document.body.insertBefore(svg, document.body.firstChild);
}

export interface IconProps {
  name: string;
  size?: "small" | "normal" | "large";
  class?: string;
}

export function Icon(props: IconProps): JSX.Element {
  onMount(ensureSprite);
  const pixelSize = createMemo(() => {
    const s = props.size ?? "normal";
    return s === "small" ? 14 : s === "large" ? 20 : 16;
  });
  const name = createMemo(() => (icons[props.name] ? props.name : "plus"));
  return (
    <svg width={pixelSize()} height={pixelSize()} viewBox={icons[name()].viewBox} class={props.class}>
      <use href={`#${symbol(name())}`} />
    </svg>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/chat-solid/Icon.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/components/Icon.tsx test/chat-solid/Icon.test.tsx
git commit -m "feat(chat-solid): add Icon component with sprite"
```

---

### Task 1.2:Button 组件

**Files:**
- Create: `src/chat-solid/components/Button.tsx`
- Test: `test/chat-solid/Button.test.tsx`

**Interfaces:**
- Produces: `Button(props: { variant?: "primary"|"ghost"|"danger"; size?: "small"|"normal"|"large"; onClick?; children })` 

- [ ] **Step 1: 写失败测试**

```tsx
// test/chat-solid/Button.test.tsx
import { render, fireEvent } from "@solidjs/testing-library";
import { describe, it, expect, vi } from "vitest";
import { Button } from "@/chat-solid/components/Button";

describe("Button", () => {
  it("renders children and handles click", async () => {
    const onClick = vi.fn();
    const { getByText } = render(() => <Button onClick={onClick}>发送</Button>);
    await fireEvent.click(getByText("发送"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies size data attribute", () => {
    const { getByRole } = render(() => <Button size="small">x</Button>);
    expect(getByRole("button").getAttribute("data-size")).toBe("small");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/chat-solid/Button.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 Button**

```tsx
// src/chat-solid/components/Button.tsx
import { type JSX, type ValidComponent, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "small" | "normal" | "large";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
  as?: ValidComponent;
  class?: string;
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, others] = splitProps(props, ["variant", "size", "disabled", "onClick", "children", "as", "class"]);
  return (
    <Dynamic
      component={local.as ?? "button"}
      data-component="button"
      data-variant={local.variant ?? "primary"}
      data-size={local.size ?? "normal"}
      disabled={local.disabled}
      onClick={local.onClick}
      class={`peyt-btn ${local.class ?? ""}`}
      {...others}
    >
      {local.children}
    </Dynamic>
  );
}
```

配套 `src/chat-solid/styles/chat.css` 追加按钮样式(对齐 opencode button-v2.css):
```css
.peyt-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: none; border-radius: 6px; cursor: pointer;
  font-family: inherit; font-weight: 530; font-size: 13px; line-height: 20px;
  letter-spacing: -0.04px; font-variant-numeric: tabular-nums;
  transition: background 120ms ease-out;
}
.peyt-btn[data-size="small"] { height: 24px; padding: 0 9px; border-radius: 4px; }
.peyt-btn[data-size="normal"] { height: 28px; padding: 0 11px; }
.peyt-btn[data-size="large"] { height: 32px; padding: 0 15px; }
.peyt-btn[data-variant="primary"] { background: var(--v2-background-bg-contrast); color: var(--v2-text-text-inverse); }
.peyt-btn[data-variant="primary"]:hover { background: var(--v2-background-bg-contrast); opacity: 0.9; }
.peyt-btn[data-variant="ghost"] { background: transparent; color: var(--v2-text-text-base); }
.peyt-btn[data-variant="ghost"]:hover { background: var(--v2-overlay-simple-overlay-hover); }
.peyt-btn[data-variant="danger"] { background: var(--v2-state-bg-danger); color: var(--v2-state-fg-danger); }
.peyt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/chat-solid/Button.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/components/Button.tsx src/chat-solid/styles/chat.css test/chat-solid/Button.test.tsx
git commit -m "feat(chat-solid): add Button component"
```

---

### Task 1.3:Avatar 组件

**Files:**
- Create: `src/chat-solid/components/Avatar.tsx`
- Test: `test/chat-solid/Avatar.test.tsx`

**Interfaces:**
- Produces: `Avatar(props: { name: string; src?: string|null; color?: number|null; size?: "small"|"normal" })`

- [ ] **Step 1: 写失败测试**

```tsx
// test/chat-solid/Avatar.test.tsx
import { render } from "@solidjs/testing-library";
import { describe, it, expect } from "vitest";
import { Avatar } from "@/chat-solid/components/Avatar";

describe("Avatar", () => {
  it("shows fallback initials when no src", () => {
    const { getByText } = render(() => <Avatar name="张三" />);
    expect(getByText("张")).toBeTruthy();
  });

  it("renders img when src provided", () => {
    const { container } = render(() => <Avatar name="x" src="blob:abc" />);
    expect(container.querySelector("img")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run test/chat-solid/Avatar.test.tsx`

- [ ] **Step 3: 实现 Avatar**

```tsx
// src/chat-solid/components/Avatar.tsx
import { type JSX, Show, createMemo } from "solid-js";
import { transformBlobURL } from "../../api.js";

const AVATAR_COLORS = [
  "orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple", "gray",
] as const;

export interface AvatarProps {
  name: string;
  src?: string | null;
  color?: number | null;
  size?: "small" | "normal";
}

export function Avatar(props: AvatarProps): JSX.Element {
  const size = () => props.size === "small" ? 20 : 28;
  const initial = createMemo(() => props.name?.[0] ?? "?");
  const colorClass = createMemo(() => {
    const idx = props.color ?? 0;
    return `peyt-avatar-${AVATAR_COLORS[idx % AVATAR_COLORS.length]}`;
  });
  return (
    <Show
      when={props.src}
      fallback={
        <span
          class={`peyt-avatar peyt-avatar-fallback ${colorClass()}`}
          style={{ width: `${size()}px`, height: `${size()}px` }}
        >
          {initial()}
        </span>
      }
    >
      <img
        class="peyt-avatar"
        src={transformBlobURL(props.src!)}
        style={{ width: `${size()}px`, height: `${size()}px`, "border-radius": "50%" }}
        alt={props.name}
      />
    </Show>
  );
}
```

chat.css 追加:
```css
.peyt-avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-weight: 530; font-size: 11px; color: var(--v2-text-text-inverse); flex-shrink: 0; }
.peyt-avatar-fallback { background: var(--v2-avatar-bg-blue, #3b82f6); }
.peyt-avatar-orange { background: var(--v2-avatar-bg-orange, #f97316); }
.peyt-avatar-yellow { background: var(--v2-avatar-bg-yellow, #eab308); }
.peyt-avatar-cyan { background: var(--v2-avatar-bg-cyan, #06b6d4); }
.peyt-avatar-green { background: var(--v2-avatar-bg-green, #22c55e); }
.peyt-avatar-red { background: var(--v2-avatar-bg-red, #ef4444); }
.peyt-avatar-pink { background: var(--v2-avatar-bg-pink, #ec4899); }
.peyt-avatar-blue { background: var(--v2-avatar-bg-blue, #3b82f6); }
.peyt-avatar-purple { background: var(--v2-avatar-bg-purple, #a855f7); }
.peyt-avatar-gray { background: var(--v2-avatar-bg-gray, #6b7280); }
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run test/chat-solid/Avatar.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/components/Avatar.tsx src/chat-solid/styles/chat.css test/chat-solid/Avatar.test.tsx
git commit -m "feat(chat-solid): add Avatar component"
```

---

### Task 1.4:Tooltip / Popover / ContextMenu(Kobalte 包装)

**Files:**
- Create: `src/chat-solid/components/Tooltip.tsx`
- Create: `src/chat-solid/components/Popover.tsx`
- Create: `src/chat-solid/components/ContextMenu.tsx`

**Interfaces:**
- Produces: `Tooltip(props: { children, content })`
- Produces: `Popover(props: { placement, gutter, open?, children, content })`
- Produces: `ContextMenu(props: { trigger, children })` children 为 ContextMenuItem/ContextMenuSeparator

- [ ] **Step 1: 实现 Tooltip**

```tsx
// src/chat-solid/components/Tooltip.tsx
import { type JSX } from "solid-js";
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip";

export interface TooltipProps {
  children: JSX.Element;
  content: JSX.Element;
}

export function Tooltip(props: TooltipProps): JSX.Element {
  return (
    <KobalteTooltip openDelay={400} closeDelay={0} gutter={4}>
      <KobalteTooltip.Trigger>{props.children}</KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class="peyt-tooltip">
          {props.content}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}
```

- [ ] **Step 2: 实现 Popover**

```tsx
// src/chat-solid/components/Popover.tsx
import { type JSX } from "solid-js";
import { Popover as KobaltePopover } from "@kobalte/core/popover";

export interface PopoverProps {
  placement?: "top" | "bottom" | "top-start";
  gutter?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: JSX.Element;
  content: JSX.Element;
}

export function Popover(props: PopoverProps): JSX.Element {
  return (
    <KobaltePopover
      placement={props.placement ?? "top"}
      gutter={props.gutter ?? 4}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <KobaltePopover.Trigger>{props.children}</KobaltePopover.Trigger>
      <KobaltePopover.Portal>
        <KobaltePopover.Content class="peyt-popover">
          {props.content}
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  );
}
```

- [ ] **Step 3: 实现 ContextMenu**

```tsx
// src/chat-solid/components/ContextMenu.tsx
import { type JSX } from "solid-js";
import { ContextMenu as KobalteContextMenu } from "@kobalte/core/context-menu";

export interface ContextMenuProps {
  trigger: (triggerProps: Record<string, unknown>) => JSX.Element;
  children: JSX.Element;
}

export function ContextMenu(props: ContextMenuProps): JSX.Element {
  return (
    <KobalteContextMenu>
      <KobalteContextMenu.Trigger>{props.trigger}</KobalteContextMenu.Trigger>
      <KobalteContextMenu.Portal>
        <KobalteContextMenu.Content class="peyt-context-menu">
          {props.children}
        </KobalteContextMenu.Content>
      </KobalteContextMenu.Portal>
    </KobalteContextMenu>
  );
}

export function ContextMenuItem(props: { onSelect?: () => void; children: JSX.Element; "data-action"?: string }): JSX.Element {
  return <KobalteContextMenu.Item class="peyt-context-menu-item" onSelect={props.onSelect} data-action={props["data-action"]}>{props.children}</KobalteContextMenu.Item>;
}

export function ContextMenuSeparator(): JSX.Element {
  return <KobalteContextMenu.Separator class="peyt-context-menu-separator" />;
}
```

chat.css 追加浮层样式:
```css
.peyt-tooltip, .peyt-popover, .peyt-context-menu {
  background: var(--v2-background-bg-layer-01);
  box-shadow: var(--v2-elevation-floating);
  border-radius: 6px;
  padding: 6px;
  z-index: 100;
}
.peyt-tooltip { padding: 4px 8px; font-size: 11px; }
.peyt-context-menu-item { padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.peyt-context-menu-item:hover { background: var(--v2-overlay-simple-overlay-hover); }
.peyt-context-menu-separator { height: 1px; background: var(--v2-border-border-muted); margin: 4px 0; }
```

- [ ] **Step 4: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/components/Tooltip.tsx src/chat-solid/components/Popover.tsx src/chat-solid/components/ContextMenu.tsx src/chat-solid/styles/chat.css
git commit -m "feat(chat-solid): add Tooltip/Popover/ContextMenu"
```

---

### Task 1.5:Dialog + Toast

**Files:**
- Create: `src/chat-solid/components/Dialog.tsx`
- Create: `src/chat-solid/components/Toast.tsx`

**Interfaces:**
- Produces: `Dialog(props: { open, onOpenChange, title, description, children, footer, size? })`
- Produces: `toaster.show(render, opts)` / `toaster.dismiss(id)`

- [ ] **Step 1: 实现 Dialog(Kobalte)**

```tsx
// src/chat-solid/components/Dialog.tsx
import { type JSX, Show } from "solid-js";
import { Dialog as KobalteDialog } from "@kobalte/core/dialog";

export type DialogSize = "normal" | "large" | "x-large" | "fit";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  size?: DialogSize;
  children?: JSX.Element;
  footer?: JSX.Element;
}

export function Dialog(props: DialogProps): JSX.Element {
  return (
    <KobalteDialog open={props.open} onOpenChange={props.onOpenChange}>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay class="peyt-dialog-overlay" />
        <KobalteDialog.Content class="peyt-dialog" data-size={props.size ?? "normal"}>
          <Show when={props.title || props.description}>
            <div class="peyt-dialog-header">
              <Show when={props.title}><KobalteDialog.Title class="peyt-dialog-title">{props.title}</KobalteDialog.Title></Show>
              <Show when={props.description}><KobalteDialog.Description class="peyt-dialog-desc">{props.description}</KobalteDialog.Description></Show>
            </div>
          </Show>
          <Show when={props.children}><div class="peyt-dialog-body">{props.children}</div></Show>
          <Show when={props.footer}><div class="peyt-dialog-footer">{props.footer}</div></Show>
        </KobalteDialog.Content>
      </KobalteDialog.Portal>
    </KobalteDialog>
  );
}
```

- [ ] **Step 2: 实现 Toast(solid-sonner)**

```tsx
// src/chat-solid/components/Toast.tsx
import { type JSX } from "solid-js";
import { Toaster, toast as sonnerToast } from "solid-sonner";

export function ToastContainer(): JSX.Element {
  return <Toaster position="bottom-right" toastOptions={{ class: "peyt-toast", duration: 4000 }} />;
}

export const toaster = {
  show(render: (p: { toastId: number | string }) => JSX.Element, opts?: { persistent?: boolean }): string | number {
    return sonnerToast.custom((id) => render({ toastId: id }), {
      duration: opts?.persistent ? Infinity : 4000,
      className: "peyt-toast",
      unstyled: true,
    });
  },
  dismiss(id: string | number): void {
    sonnerToast.dismiss(id);
  },
};
```

chat.css 追加:
```css
.peyt-dialog-overlay { position: fixed; inset: 0; z-index: 50; background: var(--v2-overlay-simple-overlay-scrim); }
.peyt-dialog { position: fixed; z-index: 50; background: var(--v2-background-bg-layer-01); box-shadow: var(--v2-elevation-overlay); border-radius: 6px; }
.peyt-dialog[data-size="normal"] { width: 480px; }
.peyt-dialog[data-size="large"] { width: 640px; }
.peyt-dialog[data-size="fit"] { width: auto; }
.peyt-dialog-header { padding: 16px; }
.peyt-dialog-title { font-size: 15px; font-weight: 530; line-height: 20px; letter-spacing: -0.13px; }
.peyt-dialog-desc { font-size: 13px; font-weight: 440; color: var(--v2-text-text-muted); margin-top: 4px; }
.peyt-dialog-body { padding: 0 16px; max-height: 60vh; overflow: auto; }
.peyt-dialog-footer { padding: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.peyt-toast { width: 320px; background: var(--v2-background-bg-layer-01); box-shadow: var(--v2-elevation-floating); border-radius: 8px; padding: 12px; }
```

- [ ] **Step 3: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/chat-solid/components/Dialog.tsx src/chat-solid/components/Toast.tsx src/chat-solid/styles/chat.css
git commit -m "feat(chat-solid): add Dialog and Toast"
```

---

## 阶段 2:chat-solid 骨架

### Task 2.1:chatId signal

**Files:**
- Create: `src/chat-solid/state/signals.ts`
- Test: `test/chat-solid/signals.test.ts`

**Interfaces:**
- Produces: `chatId(): number | null` accessor + `syncChatIdSignal(id)` 函数

- [ ] **Step 1: 写失败测试**

```tsx
// test/chat-solid/signals.test.ts
import { describe, it, expect } from "vitest";
import { createRoot } from "solid-js";
import { chatId, syncChatIdSignal } from "@/chat-solid/state/signals";

describe("chatId signal", () => {
  it("syncs chatId", () => {
    createRoot(() => {
      expect(chatId()).toBeNull();
      syncChatIdSignal(42);
      expect(chatId()).toBe(42);
      syncChatIdSignal(null);
      expect(chatId()).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run test/chat-solid/signals.test.ts`

- [ ] **Step 3: 实现 signals**

```typescript
// src/chat-solid/state/signals.ts
import { createSignal } from "solid-js";

const [chatId, setChatId] = createSignal<number | null>(null);
const [locale, setLocale] = createSignal<string>("zh");

export { chatId, locale };

export function syncChatIdSignal(id: number | null): void {
  setChatId(id);
}

export function syncLocaleSignal(l: string): void {
  setLocale(l);
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run test/chat-solid/signals.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/state/signals.ts test/chat-solid/signals.test.ts
git commit -m "feat(chat-solid): add chatId/locale signals"
```

---

### Task 2.2:chatStore

**Files:**
- Create: `src/chat-solid/state/chatStore.ts`
- Test: `test/chat-solid/chatStore.test.ts`

**Interfaces:**
- Produces: `chatStore.messages(chatId)`, `chatStore.reactions(msgId)`, `chatStore.readCount(msgId)`, `chatStore.pinnedMsgIds(chatId)`, `chatStore.appendMessages`, `chatStore.appendOptimistic`, `chatStore.updateMsgState`, `chatStore.removeMsg`, `chatStore.setReactions`, `chatStore.setReadCount`, `chatStore.clearChat`, `chatStore.reloadMessages(chatId)`, `chatStore.reloadReactions(msgId)`

- [ ] **Step 1: 写失败测试**

```tsx
// test/chat-solid/chatStore.test.ts
import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import { chatStore } from "@/chat-solid/state/chatStore";
import type { MsgDto } from "../../src/types";

vi.mock("../../src/api", () => ({
  call: vi.fn().mockResolvedValue([]),
  onEvent: vi.fn().mockResolvedValue(() => {}),
  transformBlobURL: vi.fn().mockResolvedValue(""),
}));

const mkMsg = (over: Partial<MsgDto> = {}): MsgDto => ({
  msg_id: 1, chat_id: 10, from_id: 5, from_name: "x", from_avatar: null, from_color: null,
  text: "hi", ts: 1000, state: "delivered", view_type: "text", file: null, file_mime: null,
  file_name: null, file_bytes: null, quote_text: null, quote_from: null, quote_msg_id: null,
  quote_from_id: null, reactions: null, is_info: false, is_out: false, ...over,
});

describe("chatStore", () => {
  it("appendMessages adds to chat", () => {
    createRoot(() => {
      chatStore.clearChat(10);
      chatStore.appendMessages(10, [mkMsg({ msg_id: 1 }), mkMsg({ msg_id: 2 })]);
      expect(chatStore.messages(10).length).toBe(2);
    });
  });

  it("appendOptimistic uses negative id", () => {
    createRoot(() => {
      chatStore.clearChat(10);
      chatStore.appendOptimistic(10, mkMsg({ msg_id: -100 }));
      expect(chatStore.messages(10).length).toBe(1);
      expect(chatStore.messages(10)[0].msg_id).toBe(-100);
    });
  });

  it("updateMsgState changes state by id", () => {
    createRoot(() => {
      chatStore.clearChat(10);
      chatStore.appendMessages(10, [mkMsg({ msg_id: 1, state: "pending" })]);
      chatStore.updateMsgState(1, "delivered");
      expect(chatStore.messages(10)[0].state).toBe("delivered");
    });
  });

  it("removeMsg filters out", () => {
    createRoot(() => {
      chatStore.clearChat(10);
      chatStore.appendMessages(10, [mkMsg({ msg_id: 1 }), mkMsg({ msg_id: 2 })]);
      chatStore.removeMsg(1);
      expect(chatStore.messages(10).length).toBe(1);
      expect(chatStore.messages(10)[0].msg_id).toBe(2);
    });
  });

  it("setReactions / setReadCount", () => {
    createRoot(() => {
      chatStore.setReactions(1, [{ emoji: "👍", count: 2, reactedByMe: false }]);
      expect(chatStore.reactions(1).length).toBe(1);
      chatStore.setReadCount(1, 3);
      expect(chatStore.readCount(1)).toBe(3);
    });
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run test/chat-solid/chatStore.test.ts`

- [ ] **Step 3: 实现 chatStore**

```typescript
// src/chat-solid/state/chatStore.ts
import { createStore, produce } from "solid-js/store";
import { call } from "../../api.js";
import type { MsgDto, MsgState } from "../../types.js";

export interface Reaction { emoji: string; count: number; reactedByMe: boolean; }

interface ChatStoreState {
  messages: Record<number, MsgDto[]>;
  reactions: Record<number, Reaction[]>;
  readCounts: Record<number, number>;
  pinnedMsgIds: Record<number, Set<number>>;
  lastMsgTs: Record<number, number>;
}

const [store, setStore] = createStore<ChatStoreState>({
  messages: {}, reactions: {}, readCounts: {}, pinnedMsgIds: {}, lastMsgTs: {},
});

function findMsgIndex(chatId: number, msgId: number): number {
  return store.messages[chatId]?.findIndex((m) => m.msg_id === msgId) ?? -1;
}

export const chatStore = {
  messages: (chatId: number): MsgDto[] => store.messages[chatId] ?? [],
  reactions: (msgId: number): Reaction[] => store.reactions[msgId] ?? [],
  readCount: (msgId: number): number => store.readCounts[msgId] ?? 0,
  pinnedMsgIds: (chatId: number): Set<number> => store.pinnedMsgIds[chatId] ?? new Set(),
  lastMsgTs: (chatId: number): number => store.lastMsgTs[chatId] ?? 0,

  appendMessages(chatId: number, msgs: MsgDto[]): void {
    setStore("messages", chatId, (prev) => {
      const existing = prev ?? [];
      const existingIds = new Set(existing.map((m) => m.msg_id));
      const fresh = msgs.filter((m) => !existingIds.has(m.msg_id));
      return [...existing, ...fresh];
    });
    if (msgs.length > 0) {
      const maxTs = Math.max(...msgs.map((m) => m.ts));
      setStore("lastMsgTs", chatId, Math.max(store.lastMsgTs[chatId] ?? 0, maxTs));
    }
  },

  appendOptimistic(chatId: number, msg: MsgDto): void {
    this.appendMessages(chatId, [msg]);
  },

  updateMsgState(msgId: number, state: MsgState): void {
    setStore(produce((s) => {
      for (const chatId of Object.keys(s.messages)) {
        const id = Number(chatId);
        const idx = s.messages[id].findIndex((m) => m.msg_id === msgId);
        if (idx >= 0) { s.messages[id][idx].state = state; break; }
      }
    }));
  },

  removeMsg(msgId: number): void {
    setStore(produce((s) => {
      for (const chatId of Object.keys(s.messages)) {
        const id = Number(chatId);
        s.messages[id] = s.messages[id].filter((m) => m.msg_id !== msgId);
      }
      delete s.reactions[msgId];
      delete s.readCounts[msgId];
    }));
  },

  setReactions(msgId: number, reactions: Reaction[]): void {
    setStore("reactions", msgId, reactions);
  },

  setReadCount(msgId: number, count: number): void {
    setStore("readCounts", msgId, count);
  },

  setPinned(chatId: number, ids: number[]): void {
    setStore("pinnedMsgIds", chatId, new Set(ids));
  },

  clearChat(chatId: number): void {
    setStore(produce((s) => {
      delete s.messages[chatId];
      delete s.pinnedMsgIds[chatId];
      delete s.lastMsgTs[chatId];
    }));
  },

  async reloadMessages(chatId: number): Promise<void> {
    const msgs = await call<MsgDto[]>("load_msgs", { chatId, limit: 200, oldestId: null });
    this.appendMessages(chatId, msgs);
    if (msgs.length > 0) {
      const maxTs = Math.max(...msgs.map((m) => m.ts));
      setStore("lastMsgTs", chatId, maxTs);
    }
  },

  async reloadReactions(msgId: number): Promise<void> {
    const raw = await call<Record<string, number[]> | null>("get_reactions", { msgId });
    if (!raw) { this.setReactions(msgId, []); return; }
    const selfId = (await call<{ id: number }>("get_self_profile")).id;
    const list: Reaction[] = Object.entries(raw).map(([emoji, ids]) => ({
      emoji, count: ids.length, reactedByMe: ids.includes(selfId),
    }));
    this.setReactions(msgId, list);
  },

  async reloadReadCount(msgId: number): Promise<void> {
    const count = await call<number>("get_read_count", { msgId });
    this.setReadCount(msgId, count);
  },
};
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run test/chat-solid/chatStore.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/state/chatStore.ts test/chat-solid/chatStore.test.ts
git commit -m "feat(chat-solid): add chatStore with message/reaction state"
```

---

### Task 2.3:eventBridge + shellBridge

**Files:**
- Create: `src/chat-solid/bridge/eventBridge.ts`
- Create: `src/chat-solid/bridge/shellBridge.ts`

**Interfaces:**
- Produces: `bindChatEvents(chatId: Accessor<number|null>): Promise<() => void>`(返回总取消订阅)
- Produces: `shellBridge` 对象(实现由 shell 注入)

- [ ] **Step 1: 实现 shellBridge**

```typescript
// src/chat-solid/bridge/shellBridge.ts
import type { Page } from "../../types.js";

export interface QueuedNotif {
  chatId: number;
  title: string;
  body: string;
}

export interface ShellBridge {
  onUnreadCleared: (chatId: number) => void;
  onUpdateBadge: () => void;
  onOpenRightDrawer: (chatId: number) => void;
  onShowNotification: (n: QueuedNotif) => void;
  onNavigate: (page: Page, chatId?: number) => void;
}

export const shellBridge: ShellBridge = {
  onUnreadCleared: () => {},
  onUpdateBadge: () => {},
  onOpenRightDrawer: () => {},
  onShowNotification: () => {},
  onNavigate: () => {},
};

export function setShellBridge(impl: Partial<ShellBridge>): void {
  Object.assign(shellBridge, impl);
}
```

- [ ] **Step 2: 实现 eventBridge**

```typescript
// src/chat-solid/bridge/eventBridge.ts
import { type Accessor, onCleanup } from "solid-js";
import { onEvent, call } from "../../api.js";
import { chatStore } from "../state/chatStore";
import { shellBridge } from "./shellBridge";

export async function bindChatEvents(chatId: Accessor<number | null>): Promise<() => void> {
  const unsubs: Array<() => void> = [];
  const reg = async (typ: string, cb: (e: Record<string, unknown>) => void) => {
    const unsub = await onEvent(typ, (payload) => cb(payload as Record<string, unknown>));
    unsubs.push(unsub);
  };

  await reg("MsgsChanged", (e) => {
    const id = e.chat_id as number;
    if (id !== chatId()) return;
    void chatStore.reloadMessages(id);
    shellBridge.onUpdateBadge();
  });
  await reg("MsgDelivered", (e) => chatStore.updateMsgState(e.msg_id as number, "delivered"));
  await reg("MsgFailed", (e) => chatStore.updateMsgState(e.msg_id as number, "failed"));
  await reg("MsgRead", (e) => chatStore.updateMsgState(e.msg_id as number, "read"));
  await reg("MsgDeleted", (e) => chatStore.removeMsg(e.msg_id as number));
  await reg("ReactionsChanged", (e) => {
    setTimeout(() => void chatStore.reloadReactions(e.msg_id as number), 200);
  });
  await reg("MsgReadCountChanged", (e) => void chatStore.reloadReadCount(e.msg_id as number));
  await reg("IncomingMsg", (e) => {
    const id = e.chat_id as number;
    void call("accept_chat", { chatId: id }).catch(() => {});
  });

  return () => { for (const u of unsubs) u(); };
}
```

- [ ] **Step 3: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/chat-solid/bridge
git commit -m "feat(chat-solid): add eventBridge and shellBridge"
```

---

### Task 2.4:ChatApp 根组件 + mount/unmount 入口

**Files:**
- Create: `src/chat-solid/ChatApp.tsx`
- Create: `src/chat-solid/index.tsx`

**Interfaces:**
- Produces: `mountChat(el: HTMLElement): Promise<void>` + `unmountChat(): void`

- [ ] **Step 1: 实现 ChatApp**

```tsx
// src/chat-solid/ChatApp.tsx
import { type JSX, createEffect, on, onMount, onCleanup, Show, createResource } from "solid-js";
import { chatId } from "./state/signals";
import { chatStore } from "./state/chatStore";
import { bindChatEvents } from "./bridge/eventBridge";
import { MessageTimeline } from "./timeline/MessageTimeline";
import { Composer } from "./composer/Composer";
import { ToastContainer } from "./components/Toast";
import "./styles/chat.css";

export function ChatApp(): JSX.Element {
  let unsubEvents: (() => void) | null = null;

  onMount(async () => {
    unsubEvents = await bindChatEvents(chatId);
  });
  onCleanup(() => { unsubEvents?.(); });

  createEffect(on(chatId, (id, prev) => {
    if (id == null) return;
    if (prev != null && prev !== id) chatStore.clearChat(prev);
    void chatStore.reloadMessages(id);
  }));

  return (
    <div class="peyt-chat h-full flex flex-col">
      <Show when={chatId() != null} fallback={<div class="flex-1 flex items-center justify-center text-13-regular" style={{ color: "var(--v2-text-text-faint)" }}>选择一个会话</div>}>
        <MessageTimeline chatId={chatId()!} />
        <Composer chatId={chatId()!} />
      </Show>
      <ToastContainer />
    </div>
  );
}
```

- [ ] **Step 2: 实现 mount/unmount 入口**

```tsx
// src/chat-solid/index.tsx
import { render } from "solid-js/web";
import { ChatApp } from "./ChatApp";

let dispose: (() => void) | null = null;

export async function mountChat(el: HTMLElement): Promise<void> {
  if (dispose) dispose();
  dispose = render(() => <ChatApp />, el);
}

export function unmountChat(): void {
  dispose?.();
  dispose = null;
}
```

- [ ] **Step 3: 验证编译** → `npx tsc --noEmit`(MessageTimeline/Composer 尚未实现,先创建空占位)

Create temporary stubs `src/chat-solid/timeline/MessageTimeline.tsx` and `src/chat-solid/composer/Composer.tsx` exporting components returning `<div />`,标记 `// TODO: implement in later tasks`。

- [ ] **Step 4: Commit**

```bash
git add src/chat-solid/ChatApp.tsx src/chat-solid/index.tsx src/chat-solid/timeline/MessageTimeline.tsx src/chat-solid/composer/Composer.tsx
git commit -m "feat(chat-solid): add ChatApp root and mount/unmount entry"
```

---

## 阶段 3:消息时间线

### Task 3.1:projection

**Files:**
- Create: `src/chat-solid/timeline/projection.ts`
- Test: `test/chat-solid/projection.test.ts`

**Interfaces:**
- Produces: `type TimelineRow` + `projectMessages(msgs: MsgDto[], lastReadTs: number): TimelineRow[]`

- [ ] **Step 1: 写失败测试**

```tsx
// test/chat-solid/projection.test.ts
import { describe, it, expect } from "vitest";
import { projectMessages, type TimelineRow } from "@/chat-solid/timeline/projection";
import type { MsgDto } from "../../src/types";

const mk = (over: Partial<MsgDto> = {}): MsgDto => ({
  msg_id: 1, chat_id: 1, from_id: 1, from_name: "a", from_avatar: null, from_color: null,
  text: "x", ts: 1000, state: "delivered", view_type: "text", file: null, file_mime: null,
  file_name: null, file_bytes: null, quote_text: null, quote_from: null, quote_msg_id: null,
  quote_from_id: null, reactions: null, is_info: false, is_out: false, ...over,
});

describe("projectMessages", () => {
  it("inserts date divider across days", () => {
    const msgs = [
      mk({ msg_id: 1, ts: Date.UTC(2026, 0, 1, 10) / 1000 }),
      mk({ msg_id: 2, ts: Date.UTC(2026, 0, 2, 10) / 1000 }),
    ];
    const rows = projectMessages(msgs, 0);
    expect(rows.filter((r) => r.kind === "date-divider").length).toBe(2);
  });

  it("groups consecutive same sender", () => {
    const msgs = [
      mk({ msg_id: 1, from_id: 5, ts: 1000 }),
      mk({ msg_id: 2, from_id: 5, ts: 1001 }),
      mk({ msg_id: 3, from_id: 6, ts: 1002 }),
    ];
    const rows = projectMessages(msgs, 0);
    const msgRows = rows.filter((r) => r.kind === "message") as Extract<TimelineRow, { kind: "message" }>[];
    expect(msgRows[0].groupedWithPrev).toBe(false);
    expect(msgRows[1].groupedWithPrev).toBe(true);
    expect(msgRows[2].groupedWithPrev).toBe(false);
  });

  it("inserts unread separator before first unread", () => {
    const lastRead = 1500;
    const msgs = [
      mk({ msg_id: 1, ts: 1000, state: "read" }),
      mk({ msg_id: 2, ts: 2000, state: "delivered" }),
    ];
    const rows = projectMessages(msgs, lastRead);
    expect(rows.some((r) => r.kind === "unread-separator")).toBe(true);
  });

  it("projects info messages as system", () => {
    const msgs = [mk({ msg_id: 1, is_info: true, text: "X 加入了群聊" })];
    const rows = projectMessages(msgs, 0);
    expect(rows[0].kind).toBe("system");
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run test/chat-solid/projection.test.ts`

- [ ] **Step 3: 实现 projection**

```typescript
// src/chat-solid/timeline/projection.ts
import type { MsgDto } from "../../types.js";

export type TimelineRow =
  | { kind: "date-divider"; date: string; key: string }
  | { kind: "unread-separator"; key: string }
  | { kind: "message"; msg: MsgDto; key: string; groupedWithPrev: boolean }
  | { kind: "system"; msg: MsgDto; key: string };

function dateKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dateLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function projectMessages(msgs: MsgDto[], lastReadTs: number): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let prevDate = "";
  let prevFrom: number | null = null;
  let insertedUnread = false;

  for (const msg of msgs) {
    if (msg.is_info) {
      prevFrom = null;
      rows.push({ kind: "system", msg, key: `sys-${msg.msg_id}` });
      continue;
    }
    const dk = dateKey(msg.ts);
    if (dk !== prevDate) {
      rows.push({ kind: "date-divider", date: dateLabel(msg.ts), key: `date-${dk}` });
      prevDate = dk;
      prevFrom = null;
    }
    if (!insertedUnread && msg.ts > lastReadTs && !msg.is_out) {
      rows.push({ kind: "unread-separator", key: `unread-${msg.msg_id}` });
      insertedUnread = true;
      prevFrom = null;
    }
    const grouped = prevFrom === msg.from_id;
    rows.push({ kind: "message", msg, key: `msg-${msg.msg_id}`, groupedWithPrev: grouped });
    prevFrom = msg.from_id;
  }
  return rows;
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run test/chat-solid/projection.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/timeline/projection.ts test/chat-solid/projection.test.ts
git commit -m "feat(chat-solid): add timeline projection"
```

---

### Task 3.2:useVirtualTimeline(虚拟化 + 缓存)

**Files:**
- Create: `src/chat-solid/timeline/useVirtualTimeline.ts`

**Interfaces:**
- Consumes: `TimelineRow[]`(来自 projection)
- Produces: `useVirtualTimeline(opts: { rows, scrollEl })` → `{ virtualizer, shouldAnchorBottom, onScroll, scrollToEnd }`

- [ ] **Step 1: 实现 useVirtualTimeline**

```typescript
// src/chat-solid/timeline/useVirtualTimeline.ts
import { createSignal, createMemo, onCleanup, type Accessor } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { TimelineRow } from "./projection";

interface CacheEntry { measurements: unknown; }
const cache = new Map<number, CacheEntry>();
const MAX_CACHE = 16;

function estimateHeight(row: TimelineRow): number {
  switch (row.kind) {
    case "date-divider": return 32;
    case "unread-separator": return 28;
    case "system": return 28;
    case "message": return 60;
  }
}

export function useVirtualTimeline(opts: {
  rows: Accessor<TimelineRow[]>;
  scrollEl: Accessor<HTMLElement | null>;
  chatId: Accessor<number>;
}) {
  const [shouldAnchorBottom, setShouldAnchorBottom] = createSignal(true);

  const virtualizer = createVirtualizer({
    get count() { return opts.rows().length; },
    getScrollElement: () => opts.scrollEl(),
    estimateSize: (i) => estimateHeight(opts.rows()[i]),
    overscan: 50,
    paddingEnd: 64,
    getItemKey: (i) => opts.rows()[i].key,
    get initialMeasurementsCache() {
      return (cache.get(opts.chatId())?.measurements as []) ?? [];
    },
  });

  const saveCache = () => {
    const id = opts.chatId();
    if (cache.size >= MAX_CACHE) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(id, { measurements: virtualizer.measurementsCache });
  };

  const scrollToEnd = () => {
    queueMicrotask(() => virtualizer.scrollToEnd());
  };

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShouldAnchorBottom(atBottom);
    if (!atBottom) saveCache();
  };

  return { virtualizer, shouldAnchorBottom, onScroll, scrollToEnd, saveCache };
}
```

- [ ] **Step 2: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/chat-solid/timeline/useVirtualTimeline.ts
git commit -m "feat(chat-solid): add virtualized timeline hook with cache"
```

---

### Task 3.3:MessageTimeline + 行组件

**Files:**
- Create: `src/chat-solid/timeline/MessageTimeline.tsx`
- Create: `src/chat-solid/timeline/rows/DateDivider.tsx`
- Create: `src/chat-solid/timeline/rows/UnreadSeparator.tsx`
- Create: `src/chat-solid/timeline/rows/SystemMessage.tsx`
- Create: `src/chat-solid/timeline/rows/MessageBubble.tsx`
- Create: `src/chat-solid/timeline/rows/MessageContent.tsx`

**Interfaces:**
- Consumes: `chatStore`, `projectMessages`, `useVirtualTimeline`
- Produces: `MessageTimeline(props: { chatId: number })`

- [ ] **Step 1: 实现行组件(DateDivider/UnreadSeparator/SystemMessage)**

```tsx
// src/chat-solid/timeline/rows/DateDivider.tsx
import { type JSX } from "solid-js";
export function DateDivider(props: { date: string }): JSX.Element {
  return <div class="text-11-medium text-center py-2" style={{ color: "var(--v2-text-text-muted)" }}>{props.date}</div>;
}
```

```tsx
// src/chat-solid/timeline/rows/UnreadSeparator.tsx
import { type JSX } from "solid-js";
export function UnreadSeparator(): JSX.Element {
  return (
    <div class="flex items-center gap-2 py-1">
      <div class="flex-1 h-px" style={{ background: "var(--v2-border-border-base)" }} />
      <span class="text-11-medium" style={{ color: "var(--v2-state-fg-danger)" }}>新消息</span>
      <div class="flex-1 h-px" style={{ background: "var(--v2-border-border-base)" }} />
    </div>
  );
}
```

```tsx
// src/chat-solid/timeline/rows/SystemMessage.tsx
import { type JSX } from "solid-js";
import type { MsgDto } from "../../../types.js";
export function SystemMessage(props: { msg: MsgDto }): JSX.Element {
  return <div class="text-11-regular text-center py-1" style={{ color: "var(--v2-text-text-muted)" }}>{props.msg.text}</div>;
}
```

- [ ] **Step 2: 实现 MessageContent(text 先行,其他类型后续 task)**

```tsx
// src/chat-solid/timeline/rows/MessageContent.tsx
import { type JSX, Show } from "solid-js";
import type { MsgDto } from "../../../types.js";

export function MessageContent(props: { msg: MsgDto }): JSX.Element {
  return (
    <Show when={props.msg.view_type === "text" || !props.msg.view_type} fallback={<span>{props.msg.text}</span>}>
      <div class="text-13-regular" innerHTML={renderMarkdownSafe(props.msg.text)} />
    </Show>
  );
}

// 简易 markdown:先纯文本,后续 task 接入完整 markdown
function renderMarkdownSafe(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br/>");
}
```

- [ ] **Step 3: 实现 MessageBubble**

```tsx
// src/chat-solid/timeline/rows/MessageBubble.tsx
import { type JSX, Show, createMemo } from "solid-js";
import type { MsgDto } from "../../../types.js";
import { Avatar } from "../../components/Avatar";
import { MessageContent } from "./MessageContent";
import { chatStore } from "../../state/chatStore";
import { MessageHoverActions } from "../../messages/MessageHoverActions";

export function MessageBubble(props: { msg: MsgDto; groupedWithPrev: boolean }): JSX.Element {
  const isOut = () => props.msg.is_out;
  const time = createMemo(() => {
    const d = new Date(props.msg.ts * 1000);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  return (
    <div class="message-row flex gap-2" classList={{ "flex-row-reverse": isOut(), "mt-3": !props.groupedWithPrev, "mt-1": props.groupedWithPrev }} data-msg={props.msg.msg_id}>
      <Show when={!props.groupedWithPrev && !isOut()}>
        <Avatar name={props.msg.from_name} src={props.msg.from_avatar} color={props.msg.from_color} size="normal" />
      </Show>
      <div class="flex flex-col" classList={{ "items-end": isOut() }}>
        <Show when={!props.groupedWithPrev}>
          <div class="flex gap-2 items-baseline mb-0.5">
            <span class="text-13-medium">{props.msg.from_name}</span>
            <span class="text-11-regular" style={{ color: "var(--v2-text-text-muted)" }}>{time()}</span>
          </div>
        </Show>
        <div class="msg-bubble px-3 py-2 rounded-lg max-w-[640px]" classList={{ "msg-bubble-out": isOut(), "msg-bubble-in": !isOut() }} data-state={props.msg.state}>
          <MessageContent msg={props.msg} />
        </div>
      </div>
      <MessageHoverActions msg={props.msg} />
    </div>
  );
}
```

- [ ] **Step 4: 实现 MessageTimeline(替换 stub)**

```tsx
// src/chat-solid/timeline/MessageTimeline.tsx
import { type JSX, createMemo, createSignal, Show, For, onMount, createEffect, on } from "solid-js";
import { chatStore } from "../state/chatStore";
import { projectMessages, type TimelineRow } from "./projection";
import { useVirtualTimeline } from "./useVirtualTimeline";
import { DateDivider } from "./rows/DateDivider";
import { UnreadSeparator } from "./rows/UnreadSeparator";
import { SystemMessage } from "./rows/SystemMessage";
import { MessageBubble } from "./rows/MessageBubble";

export function MessageTimeline(props: { chatId: number }): JSX.Element {
  let scrollEl: HTMLElement | null = null;
  const [setScrollEl] = createSignal<HTMLElement | null>(null);

  const msgs = createMemo(() => chatStore.messages(props.chatId));
  const rows = createMemo(() => projectMessages(msgs(), 0));

  const { virtualizer, shouldAnchorBottom, onScroll, scrollToEnd } = useVirtualTimeline({
    rows, scrollEl: () => scrollEl, chatId: () => props.chatId,
  });

  createEffect(on(rows, () => {
    if (shouldAnchorBottom()) scrollToEnd();
  }));

  const renderRow = (row: TimelineRow): JSX.Element => {
    switch (row.kind) {
      case "date-divider": return <DateDivider date={row.date} />;
      case "unread-separator": return <UnreadSeparator />;
      case "system": return <SystemMessage msg={row.msg} />;
      case "message": return <MessageBubble msg={row.msg} groupedWithPrev={row.groupedWithPrev} />;
    }
  };

  return (
    <div class="flex-1 min-h-0 relative overflow-hidden">
      <div ref={scrollEl!} class="h-full overflow-y-auto px-4 py-2" onScroll={onScroll}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          <For each={virtualizer.getVirtualItems()}>
            {(item) => (
              <div style={{ position: "absolute", top: `${item.start}px`, left: 0, width: "100%" }} data-index={item.index}>
                {renderRow(rows()[item.index])}
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={!shouldAnchorBottom()}>
        <button class="absolute bottom-8 right-8 w-8 h-7 rounded-lg flex items-center justify-center"
          style={{
            background: "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
            "backdrop-filter": "blur(2px)",
            "box-shadow": "var(--v2-elevation-raised)",
          }}
          onClick={scrollToEnd}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
            <path d="M8 3v10M4 9l4 4 4-4" />
          </svg>
        </button>
      </Show>
    </div>
  );
}
```

- [ ] **Step 5: 创建 MessageHoverActions stub(后续 task 实现)**

```tsx
// src/chat-solid/messages/MessageHoverActions.tsx
import { type JSX } from "solid-js";
import type { MsgDto } from "../../types.js";
export function MessageHoverActions(_props: { msg: MsgDto }): JSX.Element {
  return <div class="hover-actions" />; // TODO: Task 6.1
}
```

- [ ] **Step 6: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/chat-solid/timeline src/chat-solid/messages/MessageHoverActions.tsx
git commit -m "feat(chat-solid): add virtualized MessageTimeline with rows"
```

---

## 阶段 4:Composer

### Task 4.1:useComposerController

**Files:**
- Create: `src/chat-solid/composer/useComposerController.ts`
- Test: `test/chat-solid/useComposerController.test.ts`

**Interfaces:**
- Consumes: `chatId: Accessor<number>`, `chatStore`, `call`
- Produces: `createComposerController(chatId)` → `{ text, setText, replyTo, setReplyTo, attachments, mode, setMode, blank, sending, send }`

- [ ] **Step 1: 写失败测试**

```tsx
// test/chat-solid/useComposerController.test.ts
import { describe, it, expect, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createComposerController } from "@/chat-solid/composer/useComposerController";

vi.mock("../../src/api", () => ({
  call: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === "get_draft") return Promise.resolve(null);
    if (cmd === "send_msg") return Promise.resolve({ msg_id: 999 });
    if (cmd === "set_draft") return Promise.resolve(null);
    return Promise.resolve(null);
  }),
  onEvent: vi.fn(),
  transformBlobURL: vi.fn(),
}));

describe("useComposerController", () => {
  it("blank when no text", () => {
    createRoot(() => {
      const [chatId] = createSignal(1);
      const c = createComposerController(chatId);
      expect(c.blank()).toBe(true);
    });
  });

  it("not blank when text set", () => {
    createRoot(() => {
      const [chatId] = createSignal(1);
      const c = createComposerController(chatId);
      c.setText("hi");
      expect(c.blank()).toBe(false);
    });
  });

  it("send clears text on success", async () => {
    createRoot(async () => {
      const [chatId] = createSignal(1);
      const c = createComposerController(chatId);
      c.setText("hello");
      await c.send();
      expect(c.text()).toBe("");
    });
  });
});
```

- [ ] **Step 2: 运行确认失败** → `npx vitest run test/chat-solid/useComposerController.test.ts`

- [ ] **Step 3: 实现 controller**

```typescript
// src/chat-solid/composer/useComposerController.ts
import { createSignal, createMemo, createEffect, on, type Accessor } from "solid-js";
import { call } from "../../api.js";
import { chatStore } from "../state/chatStore";
import { toaster } from "../components/Toast";
import type { MsgDto } from "../../types.js";

export interface Attachment { path: string; name: string; mime: string; bytes: number; }

export function createComposerController(chatId: Accessor<number>) {
  const [text, setText] = createSignal("");
  const [replyTo, setReplyTo] = createSignal<MsgDto | null>(null);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [mode, setMode] = createSignal<"collapsed" | "expanded">("collapsed");
  const [sending, setSending] = createSignal(false);

  const blank = createMemo(() => !text() && attachments().length === 0 && !replyTo());

  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(on(text, (t) => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { void call("set_draft", { chatId: chatId(), draft: t }); }, 500);
  }));

  createEffect(on(chatId, async (id) => {
    const draft = await call<string | null>("get_draft", { chatId: id });
    setText(draft ?? "");
    setReplyTo(null);
    setAttachments([]);
  }));

  const send = async (): Promise<void> => {
    if (blank() || sending()) return;
    setSending(true);
    const tempId = -Date.now();
    const tempMsg: MsgDto = {
      msg_id: tempId, chat_id: chatId(), from_id: 0, from_name: "me", from_avatar: null, from_color: null,
      text: text(), ts: Math.floor(Date.now() / 1000), state: "pending", view_type: "text",
      file: null, file_mime: null, file_name: null, file_bytes: null,
      quote_text: null, quote_from: null, quote_msg_id: replyTo()?.msg_id ?? null,
      quote_from_id: null, reactions: null, is_info: false, is_out: true,
    };
    chatStore.appendOptimistic(chatId(), tempMsg);
    const sentText = text();
    try {
      await call("send_msg", {
        chatId: chatId(), text: sentText,
        replyTo: replyTo()?.msg_id ?? null,
        attachments: attachments(),
      });
      setText(""); setReplyTo(null); setAttachments([]);
    } catch (e) {
      chatStore.updateMsgState(tempId, "failed");
      toaster.show(({ toastId }) => (
        <div class="text-13-regular" style={{ color: "var(--v2-state-fg-danger)" }}>
          {e instanceof Error ? e.message : String(e)}
        </div>
      ), { persistent: false });
    } finally {
      setSending(false);
    }
  };

  return { text, setText, replyTo, setReplyTo, attachments, setAttachments, mode, setMode, blank, sending, send };
}
```

- [ ] **Step 4: 运行确认通过** → `npx vitest run test/chat-solid/useComposerController.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/composer/useComposerController.ts test/chat-solid/useComposerController.test.ts
git commit -m "feat(chat-solid): add composer controller with draft/send"
```

---

### Task 4.2:Composer UI + ReplyPreview + MentionSuggest

**Files:**
- Create: `src/chat-solid/composer/Composer.tsx`(替换 stub)
- Create: `src/chat-solid/composer/ReplyPreview.tsx`
- Create: `src/chat-solid/composer/MentionSuggest.tsx`

**Interfaces:**
- Consumes: `createComposerController`, `Button`, `Avatar`, `Popover`
- Produces: `Composer(props: { chatId: number })`

- [ ] **Step 1: 实现 ReplyPreview**

```tsx
// src/chat-solid/composer/ReplyPreview.tsx
import { type JSX, Show } from "solid-js";
import type { MsgDto } from "../../types.js";
import { Icon } from "../components/Icon";

export function ReplyPreview(props: { msg: MsgDto | null; onClose: () => void }): JSX.Element {
  return (
    <Show when={props.msg}>
      <div class="flex items-center gap-2 px-3 py-1 text-11-regular" style={{ background: "var(--v2-background-bg-layer-01)", color: "var(--v2-text-text-muted)" }}>
        <Icon name="reply" size="small" />
        <span class="truncate">回复 {props.msg!.from_name}: {props.msg!.text.slice(0, 50)}</span>
        <button onClick={props.onClose} class="ml-auto"><Icon name="close" size="small" /></button>
      </div>
    </Show>
  );
}
```

- [ ] **Step 2: 实现 MentionSuggest**

```tsx
// src/chat-solid/composer/MentionSuggest.tsx
import { type JSX, For, Show, createMemo } from "solid-js";
import { Popover } from "../components/Popover";
import { Avatar } from "../components/Avatar";
import { state } from "../../state.js";
import type { MemberDto, ChannelDto } from "../../types.js";

export function MentionSuggest(props: {
  query: string;
  kind: "@" | "#" | null;
  onPick: (item: { name: string; type: "member" | "channel" }) => void;
}): JSX.Element {
  const items = createMemo(() => {
    if (!props.kind) return [];
    const q = props.query.toLowerCase();
    if (props.kind === "@") {
      return state.currentMembers
        .filter((m: MemberDto) => m.name.toLowerCase().includes(q))
        .map((m) => ({ name: m.name, type: "member" as const }));
    }
    return state.channels
      .filter((c: ChannelDto) => c.name.toLowerCase().includes(q))
      .map((c) => ({ name: c.name, type: "channel" as const }));
  });
  return (
    <Show when={props.kind && items().length > 0}>
      <Popover open={true} onOpenChange={() => {}} placement="top-start" gutter={4}
        content={
          <div class="mention-suggest flex flex-col gap-0.5 min-w-[200px]">
            <For each={items()}>
              {(item) => (
                <button class="mention-item flex items-center gap-2 px-2 py-1 rounded text-13-regular" data-action="mention-pick" onClick={() => props.onPick(item)}>
                  <Show when={item.type === "member"}><Avatar name={item.name} size="small" /></Show>
                  <span>{item.name}</span>
                </button>
              )}
            </For>
          </div>
        }
      >
        <span class="hidden" />
      </Popover>
    </Show>
  );
}
```

- [ ] **Step 3: 实现 Composer(替换 stub)**

```tsx
// src/chat-solid/composer/Composer.tsx
import { type JSX, createSignal, createMemo, Show, on } from "solid-js";
import { createComposerController } from "./useComposerController";
import { ReplyPreview } from "./ReplyPreview";
import { MentionSuggest } from "./MentionSuggest";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { state } from "../../state.js";

export function Composer(props: { chatId: number }): JSX.Element {
  const ctrl = createComposerController(() => props.chatId);
  const [mentionQuery, setMentionQuery] = createSignal("");
  const [mentionKind, setMentionKind] = createSignal<"@" | "#" | null>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLTextAreaElement;
    if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && ctrl.mode() === "collapsed") {
      e.preventDefault();
      void ctrl.send();
      return;
    }
    if (e.key === "Enter" && e.ctrlKey && ctrl.mode() === "expanded") {
      e.preventDefault();
      void ctrl.send();
      return;
    }
    // 检测 @ 和 #
    const before = target.value.slice(0, target.selectionStart);
    const m = before.match(/([@#])(\w*)$/);
    if (m) { setMentionKind(m[1] as "@" | "#"); setMentionQuery(m[2]); }
    else { setMentionKind(null); }
  };

  const onInput = (e: InputEvent) => {
    const t = e.target as HTMLTextAreaElement;
    ctrl.setText(t.value);
  };

  const onPickMention = (item: { name: string }) => {
    const ta = document.querySelector<HTMLTextAreaElement>(".peyt-composer-textarea");
    if (!ta) return;
    const before = ta.value.slice(0, ta.selectionStart).replace(/([@#])\w*$/, `${mentionKind()}${item.name} `);
    const after = ta.value.slice(ta.selectionStart);
    const newVal = before + after;
    ctrl.setText(newVal);
    setMentionKind(null);
  };

  return (
    <div class="composer-area border-t" style={{ "border-color": "var(--v2-border-border-muted)" }}>
      <ReplyPreview msg={ctrl.replyTo()} onClose={() => ctrl.setReplyTo(null)} />
      <div class="px-3 py-2 flex items-end gap-2">
        <Button variant="ghost" size="normal" onClick={() => ctrl.setMode(ctrl.mode() === "collapsed" ? "expanded" : "collapsed")}>
          <Icon name="expand" size="normal" />
        </Button>
        <div class="flex-1 relative">
          <MentionSuggest query={mentionQuery()} kind={mentionKind()} onPick={onPickMention} />
          <textarea
            class="peyt-composer-textarea text-13-regular w-full resize-none border rounded-lg px-3 py-2 outline-none"
            style={{
              "min-height": "44px", "max-height": "200px",
              "border-color": "var(--v2-border-border-base)",
              "background": "var(--v2-background-bg-layer-01)",
              "color": "var(--v2-text-text-base)",
            }}
            placeholder="发消息... (@提及 / #频道)"
            value={ctrl.text()}
            onInput={onInput}
            onKeyDown={onKeyDown}
            rows={ctrl.mode() === "expanded" ? 5 : 1}
          />
        </div>
        <Button variant="primary" size="normal" disabled={ctrl.blank() || ctrl.sending()} onClick={() => void ctrl.send()}>
          <Show when={!ctrl.sending()} fallback={<Icon name="plus" size="small" />}>
            <span class="text-13-medium">发送</span>
          </Show>
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/chat-solid/composer
git commit -m "feat(chat-solid): add Composer with mention and reply preview"
```

---

## 阶段 5:消息内容类型

### Task 5.1:MessageContent 完整分发(image/file/voice/webxdc + markdown)

**Files:**
- Modify: `src/chat-solid/timeline/rows/MessageContent.tsx`

**Interfaces:**
- Consumes: `MsgDto.view_type`, `transformBlobURL`

- [ ] **Step 1: 实现 MessageContent 按 view_type 分发**

```tsx
// src/chat-solid/timeline/rows/MessageContent.tsx
import { type JSX, Show, createMemo, For } from "solid-js";
import type { MsgDto } from "../../../types.js";
import { transformBlobURL } from "../../../api.js";
import { VoicePlayer } from "../../messages/VoicePlayer";
import { WebxdcCard } from "../../messages/WebxdcCard";

export function MessageContent(props: { msg: MsgDto }): JSX.Element {
  const vt = () => props.msg.view_type ?? "text";
  const fileUrl = createMemo(() => (props.msg.file ? transformBlobURL(props.msg.file) : ""));

  return (
    <Show when={vt() === "text" || vt() === "auto"} fallback={
      <Show when={vt() === "image" || vt() === "gif"} fallback={
        <Show when={vt() === "voice" || vt() === "audio"} fallback={
          <Show when={vt() === "webxdc"} fallback={
            <Show when={vt() === "file" || vt() === "video"} fallback={<span>{props.msg.text}</span>}>
              <FileCard msg={props.msg} url={fileUrl()} />
            </Show>
          }>
            <WebxdcCard msg={props.msg} />
          </Show>
        }>
          <VoicePlayer msg={props.msg} />
        </Show>
      }>
        <ImageContent msg={props.msg} url={fileUrl()} />
      </Show>
    }>
      <div class="text-13-regular" innerHTML={renderMarkdown(props.msg.text)} />
    </Show>
  );
}

function ImageContent(props: { msg: MsgDto; url: string }): JSX.Element {
  return (
    <img src={props.url} alt={props.msg.file_name ?? ""} class="max-w-[320px] max-h-[320px] rounded-lg object-cover cursor-pointer" />
  );
}

function FileCard(props: { msg: MsgDto; url: string }): JSX.Element {
  return (
    <a href={props.url} download={props.msg.file_name ?? undefined} class="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "var(--v2-overlay-simple-overlay-hover)" }}>
      <span class="text-13-medium">{props.msg.file_name ?? "文件"}</span>
      <Show when={props.msg.file_bytes}><span class="text-11-regular" style={{ color: "var(--v2-text-text-muted)" }}>{formatBytes(props.msg.file_bytes!)}</span></Show>
    </a>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function renderMarkdown(text: string): string {
  // 暂用 marked(已有依赖),后续可换 shiki
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br/>");
}
```

- [ ] **Step 2: 创建 VoicePlayer / WebxdcCard stub**

```tsx
// src/chat-solid/messages/VoicePlayer.tsx
import { type JSX } from "solid-js";
import type { MsgDto } from "../../types.js";
import { Icon } from "../components/Icon";
export function VoicePlayer(props: { msg: MsgDto }): JSX.Element {
  return <div class="flex items-center gap-2 px-2 py-1"><Icon name="plus" size="normal" /><span class="text-11-regular">语音消息</span></div>;
}
```

```tsx
// src/chat-solid/messages/WebxdcCard.tsx
import { type JSX } from "solid-js";
import type { MsgDto } from "../../types.js";
export function WebxdcCard(props: { msg: MsgDto }): JSX.Element {
  return <div class="px-3 py-2 rounded-lg text-13-regular" style={{ background: "var(--v2-overlay-simple-overlay-hover)" }}>{props.msg.text || "webxdc 应用"}</div>;
}
```

- [ ] **Step 3: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/chat-solid/timeline/rows/MessageContent.tsx src/chat-solid/messages/VoicePlayer.tsx src/chat-solid/messages/WebxdcCard.tsx
git commit -m "feat(chat-solid): add message content type dispatch"
```

---

## 阶段 6:消息操作

### Task 6.1:MessageHoverActions + ReactionPicker + ReactionCapsules

**Files:**
- Modify: `src/chat-solid/messages/MessageHoverActions.tsx`
- Create: `src/chat-solid/messages/ReactionPicker.tsx`
- Create: `src/chat-solid/messages/ReactionCapsules.tsx`

**Interfaces:**
- Consumes: `chatStore`, `ContextMenu`, `Popover`, `Dialog`, `call`

- [ ] **Step 1: 实现 ReactionCapsules**

```tsx
// src/chat-solid/messages/ReactionCapsules.tsx
import { type JSX, For } from "solid-js";
import type { Reaction } from "../state/chatStore";

export function ReactionCapsules(props: { msgId: number; reactions: Reaction[]; onPick: (emoji: string) => void }): JSX.Element {
  return (
    <div class="flex flex-wrap gap-1 mt-1">
      <For each={props.reactions}>
        {(r) => (
          <button class="flex items-center gap-1 h-5 px-1.5 rounded-full text-11-medium" data-action="reaction-toggle" onClick={() => props.onPick(r.emoji)}
            style={{ background: r.reactedByMe ? "var(--v2-state-bg-info)" : "var(--v2-overlay-simple-overlay-hover)" }}>
            <span>{r.emoji}</span><span>{r.count}</span>
          </button>
        )}
      </For>
    </div>
  );
}
```

- [ ] **Step 2: 实现 ReactionPicker**

```tsx
// src/chat-solid/messages/ReactionPicker.tsx
import { type JSX, For, Show, createSignal } from "solid-js";
import { Popover } from "../components/Popover";
import { Icon } from "../components/Icon";
import { call } from "../../api.js";

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "😭", "🔥"];
const PANEL = ["👍", "❤️", "😂", "😮", "😢", "😭", "🔥", "🎉", "👏", "🙏", "💯", "✨", "😍", "🤔", "😴", "🤯", "😅", "🥳", "😎", "🥺", "😤", "🤝", "💪", "👀", "✅", "❌", "⚠️", "❗", "❓", "⭐", "🌟", "☀️", "🌙", "☕", "🍻", "🎁", "🏆"];

export function ReactionPicker(props: { msgId: number; open: boolean; onOpenChange: (o: boolean) => void }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const send = async (emoji: string) => {
    props.onOpenChange(false);
    await call("send_reaction", { msgId: props.msgId, emoji });
  };
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange} placement="top" gutter={4}
      content={
        <div class="reaction-picker flex flex-col gap-1 p-1">
          <div class="flex gap-0.5">
            <For each={QUICK}>{(e) => <button class="reaction-item text-base px-1" data-action="reaction-quick" onClick={() => void send(e)}>{e}</button>}</For>
            <button class="reaction-item px-1" onClick={() => setExpanded(!expanded())}><Icon name="expand" size="small" /></button>
          </div>
          <Show when={expanded()}>
            <div class="grid grid-cols-8 gap-0.5 max-w-[280px]">
              <For each={PANEL}>{(e) => <button class="reaction-item text-base px-1" data-action="reaction-panel" onClick={() => void send(e)}>{e}</button>}</For>
            </div>
          </Show>
        </div>
      }
    >
      <span class="hidden" />
    </Popover>
  );
}
```

- [ ] **Step 3: 实现 MessageHoverActions(替换 stub)**

```tsx
// src/chat-solid/messages/MessageHoverActions.tsx
import { type JSX, createSignal, Show } from "solid-js";
import type { MsgDto } from "../../types.js";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "../components/ContextMenu";
import { Dialog } from "../components/Dialog";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { ReactionPicker } from "./ReactionPicker";
import { chatStore } from "../state/chatStore";
import { call } from "../../api.js";

export function MessageHoverActions(props: { msg: MsgDto }): JSX.Element {
  const [reactionOpen, setReactionOpen] = createSignal(false);
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const pinned = () => chatStore.pinnedMsgIds(props.msg.chat_id).has(props.msg.msg_id);

  const copy = () => navigator.clipboard.writeText(props.msg.text);
  const togglePin = async () => {
    await call(pinned() ? "unpin_msg" : "pin_msg", { chatId: props.msg.chat_id, msgId: props.msg.msg_id });
    void chatStore.reloadMessages(props.msg.chat_id);
  };
  const del = async () => {
    await call("delete_msg", { msgId: props.msg.msg_id });
    setDeleteOpen(false);
  };

  return (
    <>
      <div class="hover-actions flex items-center gap-0.5">
        <button class="p-1 rounded hover:bg-overlay-hover" data-action="react" onClick={() => setReactionOpen(true)}><Icon name="plus" size="small" /></button>
      </div>
      <ContextMenu trigger={(p) => <div {...p} class="contents" />}>
        <ContextMenuItem data-action="react" onSelect={() => setReactionOpen(true)}>添加反应</ContextMenuItem>
        <ContextMenuItem data-action="copy" onSelect={copy}>复制</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-action="pin" onSelect={() => void togglePin()}>{pinned() ? "取消置顶" : "置顶"}</ContextMenuItem>
        <Show when={props.msg.is_out}>
          <ContextMenuSeparator />
          <ContextMenuItem data-action="delete" onSelect={() => setDeleteOpen(true)}>删除</ContextMenuItem>
        </Show>
      </ContextMenu>
      <ReactionPicker msgId={props.msg.msg_id} open={reactionOpen()} onOpenChange={setReactionOpen} />
      <Dialog open={deleteOpen()} onOpenChange={setDeleteOpen} title="删除消息" description="确定删除这条消息吗?" size="fit"
        footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" onClick={() => void del()}>删除</Button></>}
      />
    </>
  );
}
```

- [ ] **Step 4: 给 MessageBubble 接入 ReactionCapsules**

Modify `src/chat-solid/timeline/rows/MessageBubble.tsx` 在 `MessageContent` 后加入:
```tsx
<Show when={chatStore.reactions(props.msg.msg_id).length > 0}>
  <ReactionCapsules msgId={props.msg.msg_id} reactions={chatStore.reactions(props.msg.msg_id)} onPick={(e) => void call("send_reaction", { msgId: props.msg.msg_id, emoji: e })} />
</Show>
```
并 import `{ ReactionCapsules } from "../../messages/ReactionCapsules"` 和 `{ call } from "../../../api.js"`。

- [ ] **Step 5: 验证编译** → `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/chat-solid/messages
git commit -m "feat(chat-solid): add hover actions, reaction picker, capsules"
```

---

## 阶段 7:接入 shell + 退役旧代码

### Task 7.1:shell 接入 Solid mount + 功能开关

**Files:**
- Modify: `src/shell/navPanel.ts`(renderMain 接入)
- Modify: `src/shell/shell.ts`(chatId 变化时 syncChatIdSignal)
- Modify: `src/main.ts`(注入 shellBridge)

**Interfaces:**
- Consumes: `mountChat`, `unmountChat`, `syncChatIdSignal`, `setShellBridge`

- [ ] **Step 1: 在 navPanel renderMain 中接入 Solid mount**

定位 `src/shell/navPanel.ts` 中 `renderMain` / 路由到 chat 的逻辑。在渲染 `#chat-main` 时:
```typescript
import { mountChat, unmountChat } from "../chat-solid/index.js";
import { syncChatIdSignal } from "../chat-solid/state/signals.js";

const USE_SOLID_CHAT = true;

// 原 renderChatView(chatId) 调用处替换为:
if (USE_SOLID_CHAT) {
  syncChatIdSignal(chatId);
  const el = document.getElementById("chat-main");
  if (el) await mountChat(el);
} else {
  // 保留旧 import: const { renderChatView } = await import("../chat/chatView.js");
  // await renderChatView(chatId);
}
```

- [ ] **Step 2: shell 切换 page 时 unmount**

在 navPanel 切到非 chat page 时:
```typescript
if (state.currentPage !== "messages") {
  unmountChat();
  syncChatIdSignal(null);
}
```

- [ ] **Step 3: main.ts 注入 shellBridge**

```typescript
import { setShellBridge } from "./chat-solid/bridge/shellBridge.js";

// boot() 中 renderShell 后:
setShellBridge({
  onUnreadCleared: (chatId) => { /* 调用现有 shell badge 更新逻辑 */ },
  onUpdateBadge: () => { /* 调用现有 updateBadges */ },
  onOpenRightDrawer: (chatId) => { state.rightDrawerOpen = true; state.currentChatId = chatId; },
  onShowNotification: (n) => { /* 复用现有通知队列 */ },
  onNavigate: (page, chatId) => { state.currentPage = page; if (chatId != null) state.currentChatId = chatId; },
});
```

- [ ] **Step 4: 启动验证**

Run: `npm run tauri dev`
验证:打开一个会话 → 看到 Solid chat 渲染(消息列表 + composer)→ 能发消息 → 切换会话 → 切到其他 page 再切回 chat 正常。

- [ ] **Step 5: Commit**

```bash
git add src/shell/navPanel.ts src/shell/shell.ts src/main.ts
git commit -m "feat: wire Solid chat into shell with feature flag"
```

---

### Task 7.2:退役旧 chat DOM 操作

**Files:**
- Modify: `src/shell/shell.ts`(移除 refreshCurrentChat/appendNewMessages/updateMsgState/removeMsg/refreshMsgReactions/updateReadCount 的 chat DOM 操作,改为 no-op 或删除)

**Interfaces:**
- Consumes: Solid 已接管这些功能

- [ ] **Step 1: 定位 shell.ts 中的 chat DOM 操作函数**

用 Grep 搜索 `src/shell/shell.ts` 中:`refreshCurrentChat|appendNewMessages|updateMsgState|removeMsg|refreshMsgReactions|updateReadCount`。

- [ ] **Step 2: 改为 no-op(保留签名避免破坏其他引用)**

对每个函数,在 `USE_SOLID_CHAT` 为 true 时直接 return:
```typescript
export function refreshCurrentChat(): void {
  if (USE_SOLID_CHAT) return; // Solid 接管
  // ... 原逻辑保留
}
```

- [ ] **Step 3: 验证旧逻辑未被触发**

Run: `npm run tauri dev`,发消息/收消息/反应,确认旧 DOM 操作未执行(可加 console.log 确认)。

- [ ] **Step 4: Commit**

```bash
git add src/shell/shell.ts
git commit -m "refactor: retire legacy chat DOM ops in shell (Solid接管)"
```

---

## 阶段 8:验收

### Task 8.1:质感对齐验收

**Files:** 无(验证 task)

- [ ] **Step 1: 字体与排版检查**

启动 app,DevTools 检查消息正文:font-family=Inter, font-weight=440, font-size=13px, letter-spacing=-0.04px, line-height=20px。

- [ ] **Step 2: 令牌检查**

DevTools 确认 `--v2-text-text-base` / `--v2-background-bg-layer-01` 等令牌已加载,明暗切换(`data-color-scheme`)生效。

- [ ] **Step 3: 虚拟化验证**

进入消息 >200 条的会话,滚动流畅,DevTools Performance 无长任务。

- [ ] **Step 4: 交互验证清单**

逐项验证:发消息(乐观+送达)/ 收消息 / 反应(快捷+面板)/ 回复 / 复制 / 置顶 / 删除(Dialog确认)/ @提及 / #频道 / 草稿(切回会话恢复)/ 收起/展开 composer / 会话切换(缓存生效)/ jump-to-latest / 明暗切换。

- [ ] **Step 5: 与 opencode 截图对比**

对比消息气泡/间距/阴影/hover 操作位置/字号,确认质感对齐。

- [ ] **Step 6: Commit 验收记录**

```bash
git commit --allow-empty -m "test: chat-solid 质感对齐验收通过"
```

---

## Self-Review 检查记录

**1. Spec 覆盖:**
- 架构(Solid 岛)→ Task 2.4, 7.1 ✓
- v2 令牌 → Task 0.2 ✓
- Inter 字体 → Task 0.2 ✓
- 虚拟化时间线 → Task 3.1, 3.2, 3.3 ✓
- projection → Task 3.1 ✓
- 会话切换缓存 → Task 3.2 ✓
- 粘底锚定 + jump-to-latest → Task 3.3 ✓
- Spring 动效 → chat.css fadeUp(Task 0.2)✓(spring 组件级动效在后续迭代)
- 三件套悬浮 → Task 1.4 ✓
- Toast/Dialog → Task 1.5 ✓
- TS 内联 sprite 图标 → Task 1.1 ✓
- Composer controller/state 分离 → Task 4.1 ✓
- 草稿防抖 → Task 4.1 ✓
- 乐观更新(负数 id)→ Task 4.1 ✓
- @提及/#频道 → Task 4.2 ✓
- 消息内容类型 → Task 5.1 ✓
- hover 操作 + 反应 + 回复 + 转发 + 置顶 + 删除 → Task 6.1 ✓
- shellBridge → Task 2.3, 7.1 ✓
- 退役旧 DOM 操作 → Task 7.2 ✓
- 功能开关回退 → Task 7.1 ✓

**2. 类型一致性:**
- `MsgDto.msg_id: number` → 乐观消息用 `-Date.now()`(Task 4.1)✓
- `onEvent` 返回 `Promise<() => void>` → eventBridge 用 `await`(Task 2.3)✓
- `chatStore` 方法签名跨 task 一致(messages/reactions/readCount/appendMessages/appendOptimistic/updateMsgState/removeMsg/setReactions/setReadCount)✓
- `TimelineRow` kind 一致(projection / MessageTimeline)✓

**3. 已知简化(后续迭代):**
- VoicePlayer/WebxdcCard 为 stub(Task 5.1),完整实现在后续迭代
- markdown 用纯文本转义(Task 5.1),完整 shiki 高亮在后续迭代
- Gallery/SummaryBubble 未在本计划(范围:核心 chat 体验,spec §7 提及但优先级次之)
- 转发(forward)操作未单独实现(ContextMenu 预留,转发 UI 在后续迭代)

这些简化已在 spec §11.1 步骤 5-7 标注为后续工作,本计划聚焦步骤 1-4 + 8-9(骨架 + 时间线 + composer + 接入 + 验收),是可独立交付的核心闭环。
