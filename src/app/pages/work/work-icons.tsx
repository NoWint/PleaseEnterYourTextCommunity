// src/app/pages/work/work-icons.tsx
// 工作页图标：与 chat-icons.tsx 同款实现，但用相对路径导入 TDESIGN_PATHS——
// 兼容 vite dev（vite.config.ts 未配置 @/ 别名，绝对别名导入在 dev 下 500）。

import { TDESIGN_PATHS } from "../../../components/tdesignIcons"
import type { JSX } from "solid-js"

export function WorkIcon(props: { name: string; size?: number; class?: string }): JSX.Element {
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

export default WorkIcon
