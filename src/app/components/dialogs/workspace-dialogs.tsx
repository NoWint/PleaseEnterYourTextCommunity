// src/app/components/dialogs/workspace-dialogs.tsx
// 工作区相关小对话框（AppLayout/sidebar 复用）：
// - ConfirmWorkspaceDialog：重置/删除工作区前的确认（本地清空 + toast 在调用方）。
// - WorkspaceSelectDialog：选择工作区（chooseProject 入口），选中后导航 /home/<wsId>。

import { For, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { dialogsT } from "./i18n"

export const ConfirmWorkspaceDialog: Component<{
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
}> = (props) => {
  const dialog = useDialog()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="px-4 pt-4 pb-1">
        <p class="text-[13px] leading-5 text-v2-text-text-muted">{props.description}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
          {dialogsT("common.cancel")}
        </ButtonV2>
        <ButtonV2
          type="button"
          variant="contrast"
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          {props.confirmLabel}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export const WorkspaceSelectDialog: Component<{
  workspaces: { worktree: string; name: string }[]
  onSelect: (worktree: string) => void
}> = (props) => {
  const dialog = useDialog()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{dialogsT("dialog.workspace.select.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex flex-col gap-1 px-4 pt-4 pb-1">
        <For each={props.workspaces}>
          {(ws) => (
            <button
              type="button"
              class="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-start text-[13px] text-v2-text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => {
                dialog.close()
                props.onSelect(ws.worktree)
              }}
            >
              <span class="min-w-0 truncate">{ws.name}</span>
              <span class="shrink-0 text-[12px] text-v2-text-text-faint truncate">{ws.worktree}</span>
            </button>
          )}
        </For>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
          {dialogsT("common.cancel")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
