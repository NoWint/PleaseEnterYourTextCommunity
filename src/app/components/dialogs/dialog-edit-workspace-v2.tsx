// src/app/components/dialogs/dialog-edit-workspace-v2.tsx
// 工作区编辑对话框（照抄 opencode dialog-edit-project-v2.tsx 的结构，
// 去掉头像/图标上传/颜色选择等 desktop 专属交互）：
// IM 版 = 名称 + 启动命令 的表单占位。
// mode="create"：新建工作区（home 左列"添加工作区"入口）。
// TODO(Task 5): 接入真实工作区配置持久化（layout.projects.rename 等）。

import { createSignal } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { dialogsT } from "./i18n"
import type { LocalProject } from "../../context/layout"

export function DialogEditWorkspaceV2(props: { project: LocalProject; mode?: "create" | "edit" }) {
  const dialog = useDialog()
  const isCreate = () => props.mode === "create"
  const [name, setName] = createSignal(props.project.name ?? "")
  const [startup, setStartup] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const folderName = () => props.project.name ?? props.project.worktree

  const submit = (event: Event) => {
    event.preventDefault()
    if (saving()) return
    setSaving(true)
    // TODO(Task 5): 持久化工作区配置（当前为占位，直接关闭）。
    setTimeout(() => {
      setSaving(false)
      dialog.close()
    }, 300)
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader>
          <DialogTitle>
            {isCreate() ? dialogsT("dialog.project.create.title") : dialogsT("dialog.project.edit.title")}
          </DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex max-h-[min(560px,calc(100vh-160px))] w-full flex-col gap-6 overflow-y-auto px-4 pt-4 pb-1">
          <Field>
            <Field.Label>{dialogsT("dialog.project.edit.name")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              value={name()}
              placeholder={folderName()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </Field>

          <Field>
            <Field.Label>{dialogsT("dialog.project.edit.worktree.startup")}</Field.Label>
            <Field.Prefix>{dialogsT("dialog.project.edit.worktree.startup.description")}</Field.Prefix>
            <TextareaV2
              class="!w-full [&_[data-slot=textarea-v2-textarea]]:font-mono"
              rows={3}
              value={startup()}
              placeholder={dialogsT("dialog.project.edit.worktree.startup.placeholder")}
              spellcheck={false}
              onInput={(event) => setStartup(event.currentTarget.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={saving()} onClick={() => dialog.close()}>
            {dialogsT("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={saving()}>
            {saving() ? dialogsT("common.saving") : dialogsT("common.save")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
