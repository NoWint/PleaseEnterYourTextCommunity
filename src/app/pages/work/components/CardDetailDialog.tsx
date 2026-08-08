// src/app/pages/work/components/CardDetailDialog.tsx
// 卡片详情对话框（Solid 版，从 src/work/cardDetail.ts 迁移）：
// 标题/描述可编辑、状态切换、截止日期、指派信息，保存/删除走 workspace context 的
// update_card / delete_card invoke（删除为两步确认，替代 legacy 内联确认）。

import { createSignal, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For } from "solid-js"
import { useWorkspace, type UpdateCardPatch } from "../../../context/workspace"
import { showToast } from "../../../utils/toast"
import type { CardDto, CardStatus } from "../../../../types"
import { STATUS_LABEL, STATUS_ORDER, tsFromYmd, typeLabel, ymdFromTs } from "../work-types"

export interface CardDetailDialogProps {
  directory: string
  card: CardDto
}

export const CardDetailDialog: Component<CardDetailDialogProps> = (props) => {
  const workspace = useWorkspace()
  const dialog = useDialog()
  const [title, setTitle] = createSignal(props.card.title)
  const [status, setStatus] = createSignal<CardStatus>(props.card.status)
  const [due, setDue] = createSignal(props.card.due_date ? ymdFromTs(props.card.due_date) : "")
  const [desc, setDesc] = createSignal(props.card.description ?? "")
  const [saving, setSaving] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)

  const save = async () => {
    if (saving()) return
    setSaving(true)
    try {
      const patch: UpdateCardPatch = {}
      if (title().trim() !== props.card.title) patch.title = title().trim()
      if (status() !== props.card.status) patch.status = status()
      if (desc().trim() !== (props.card.description ?? "")) patch.description = desc().trim() || null
      const nextDue = tsFromYmd(due())
      if (nextDue !== props.card.due_date) patch.dueDate = nextDue
      if (Object.keys(patch).length > 0) {
        await workspace.updateCard(props.directory, props.card.id, patch)
      }
      showToast({ title: "已保存" })
      dialog.close()
    } catch (e) {
      showToast({ title: "保存失败", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (confirmingDelete()) {
      setDeleting(true)
      try {
        await workspace.deleteCard(props.directory, props.card.id)
        showToast({ title: "已删除卡片" })
        dialog.close()
      } catch (e) {
        showToast({ title: "删除失败", description: e instanceof Error ? e.message : String(e) })
      } finally {
        setDeleting(false)
      }
      return
    }
    setConfirmingDelete(true)
    setTimeout(() => setConfirmingDelete(false), 3000)
  }

  return (
    <Dialog size="normal">
      <DialogHeader>
        <DialogTitle>卡片详情</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full flex-col gap-5 px-4 py-4">
        <Field>
          <Field.Label>标题</Field.Label>
          <TextInputV2
            autofocus
            class="!w-full"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </Field>

        <div class="flex items-center gap-8">
          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] text-v2-text-text-faint">类型</span>
            <span
              class="self-start rounded px-1.5 py-0.5 text-[12px]"
              classList={{
                "bg-v2-background-bg-raised text-v2-text-text-muted": props.card.type !== "task",
              }}
            >
              {typeLabel(props.card.type)}
            </span>
          </div>
          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] text-v2-text-text-faint">状态</span>
            <SegmentedControlV2
              value={status()}
              onChange={(next) => next && setStatus(next as CardStatus)}
            >
              <For each={STATUS_ORDER}>
                {(s) => <SegmentedControlItemV2 value={s}>{STATUS_LABEL[s]}</SegmentedControlItemV2>}
              </For>
            </SegmentedControlV2>
          </div>
        </div>

        <div class="flex items-center gap-8">
          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] text-v2-text-text-faint">指派</span>
            <span class="text-[13px] text-v2-text-text-base">{props.card.assignee_name || "未指派"}</span>
          </div>
          <Field>
            <Field.Label>截止日期</Field.Label>
            <input
              type="date"
              value={due()}
              onInput={(e) => setDue(e.currentTarget.value)}
              class="rounded-md border border-v2-border-border-strong-base bg-v2-background-bg-base px-2 py-1.5 text-[13px] text-v2-text-text-base outline-none focus:border-v2-text-text-muted"
            />
          </Field>
        </div>

        <Field>
          <Field.Label>描述</Field.Label>
          <TextareaV2
            class="!w-full [&_[data-slot=textarea-v2-textarea]]:min-h-[96px]"
            value={desc()}
            placeholder="卡片描述…"
            onInput={(e) => setDesc(e.currentTarget.value)}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Show when={props.card.id > 0}>
          <ButtonV2 type="button" variant="danger" disabled={deleting()} onClick={() => void remove()}>
            {confirmingDelete() ? (deleting() ? "删除中…" : "确认删除?") : "删除"}
          </ButtonV2>
        </Show>
        <div class="flex-1" />
        <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
          取消
        </ButtonV2>
        <ButtonV2 type="button" variant="contrast" disabled={saving()} onClick={() => void save()}>
          {saving() ? "保存中…" : "保存"}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export default CardDetailDialog
