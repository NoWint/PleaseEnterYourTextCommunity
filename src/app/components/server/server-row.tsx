// src/app/components/server/server-row.tsx
// 照抄 opencode components/server/server-row.tsx 裁剪：仅保留
// ServerHealthIndicator（三态圆点）。ServerRow（服务器配置行）整体移除
// —— IM 版账号健康态由 server context 提供，无需 credential/version 展示。

import type { ServerHealth } from "../../utils/server-health"

export function ServerHealthIndicator(props: { health?: ServerHealth }) {
  return (
    <div
      classList={{
        "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
        // 与 status-popover 的状态点配色一致（本地 v2 token 对应 opencode 三态）
        "bg-[var(--v2-state-fg-success)]": props.health?.healthy === true,
        "bg-[var(--v2-state-fg-danger)]": props.health?.healthy === false,
        "bg-[var(--v2-text-text-faint)]": props.health === undefined,
      }}
    />
  )
}
