// src/app/components/dialogs/status-popover.tsx
// 服务器状态弹层（照抄 opencode status-popover.tsx 的骨架，
// 去掉 MCP/LSP 健康检查）：IM 版展示本地服务器连接状态 + 快捷入口。

import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useServer } from "../../context/server"
import { dialogsT } from "./i18n"

function serverStatusDotClass(state: { healthy: boolean | undefined; attention?: boolean; issue?: boolean }) {
  if (state.healthy === false) return "bg-[var(--v2-state-fg-danger)]"
  if (state.issue || state.attention) return "bg-[var(--v2-state-fg-warning)]"
  return "bg-[var(--v2-state-fg-success)]"
}

function StatusPopoverBody(props: { shown: boolean; children: JSX.Element }) {
  return (
    <div
      class="w-[360px] max-w-[calc(100vw-40px)] overflow-hidden rounded-xl border border-border-weak-base bg-background-strong shadow-[var(--shadow-lg-border-base)]"
    >
      {props.children}
    </div>
  )
}

type StatusPopoverState = {
  shown: boolean
  healthy: boolean | undefined
  label: string
  onOpenChange: (value: boolean) => void
  body: () => JSX.Element
}

export function StatusPopover() {
  const language = dialogsT
  const server = useServer()
  const [shown, setShown] = createSignal(false)
  const healthy = () => server.health[server.key]?.healthy

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "titlebar-icon w-8 h-6 p-0 box-border",
        "aria-label": language("status.popover.trigger"),
        style: { scale: 1 },
      }}
      trigger={
        <div class="relative size-4">
          <div class="badge-mask-tight size-4 flex items-center justify-center">
            <Icon name={shown() ? "status-active" : "status"} size="small" />
          </div>
          <div class={`absolute -top-px -right-px size-1.5 rounded-full ${serverStatusDotClass({ healthy: healthy() })}`} />
        </div>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
      gutter={4}
      placement="bottom-end"
      shift={-168}
    >
      <Show when={shown()}>
        <StatusPopoverBody shown={shown()}>
          <Body healthy={healthy()} />
        </StatusPopoverBody>
      </Show>
    </Popover>
  )
}

export function StatusPopoverV2(props: { scope?: "server" }) {
  const server = useServer()
  const [shown, setShown] = createSignal(false)
  const healthy = () => server.health[server.key]?.healthy
  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    healthy: healthy(),
    label: dialogsT("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <Body healthy={healthy()} />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

function Body(props: { healthy: boolean | undefined }) {
  const server = useServer()
  return (
    <div class="flex flex-col">
      <div class="px-4 py-3 border-b border-border-weak-base">
        <span class="text-14-medium text-text-strong">{dialogsT("status.popover.title")}</span>
      </div>
      <div class="px-4 py-3 flex items-center gap-3">
        <span
          class={`inline-block size-2 rounded-full ${serverStatusDotClass({ healthy: props.healthy })}`}
          aria-hidden="true"
        />
        <div class="flex flex-col min-w-0">
          <span class="text-13-medium text-text-base truncate">
            {server.current.displayName ?? dialogsT("settings.placeholder.account.local")}
          </span>
          <span class="text-12-regular text-text-weak">
            {props.healthy === false
              ? dialogsT("status.popover.server.unhealthy")
              : dialogsT("status.popover.server.healthy")}
          </span>
        </div>
      </div>
    </div>
  )
}

function StatusPopoverView(props: { state: StatusPopoverState }) {
  const popoverProps = {
    class:
      "[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl",
    gutter: 4,
    placement: "bottom-end" as const,
    shift: -168,
  }

  return (
    <Popover
      open={props.state.shown}
      onOpenChange={props.state.onOpenChange}
      triggerAs={IconButtonV2}
      triggerProps={{
        variant: "ghost-muted",
        size: "large",
        class: "!w-9 shrink-0",
        state: props.state.shown ? "pressed" : undefined,
        "aria-label": props.state.label,
      }}
      trigger={
        <div class="relative size-4">
          <IconV2 name={props.state.shown ? "status-active" : "status"} />
          <div
            class={`absolute -top-1 -right-1 size-2 rounded-full border border-[var(--v2-background-bg-deep)] ${serverStatusDotClass({ healthy: props.state.healthy })}`}
          />
        </div>
      }
      {...popoverProps}
    >
      {props.state.body()}
    </Popover>
  )
}
