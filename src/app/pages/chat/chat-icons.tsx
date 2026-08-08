// src/app/pages/chat/chat-icons.tsx
// 聊天页图标：复用 legacy TDesign 图标路径（src/components/tdesignIcons.ts，纯数据模块），
// 输出 Solid SVG 组件（与 @opencode-ai/ui/icon 形状一致，但覆盖 IM 专属图标名）。

import { TDESIGN_PATHS } from "@/components/tdesignIcons"
import type { JSX } from "solid-js"

export type ChatIconName = keyof typeof TDESIGN_PATHS & string

export function ChatIcon(props: { name: string; size?: number; class?: string }): JSX.Element {
  const paths = TDESIGN_PATHS[props.name]
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={1.8}
      stroke-linecap="square"
      stroke-linejoin="miter"
      class={props.class}
      aria-hidden="true"
    >
      {(paths ?? TDESIGN_PATHS.plus).map((p) => (
        <path d={p.d} fill-rule={p.fillRule as "evenodd" | undefined} />
      ))}
    </svg>
  )
}
