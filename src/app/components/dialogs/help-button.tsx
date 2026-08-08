// src/app/components/dialogs/help-button.tsx
// 帮助按钮（照抄 opencode help-button.tsx 的骨架，去掉产品宣传 toast/视频/图片）：
// IM 版 = 标题栏问号按钮，弹出帮助对话框（使用指南/反馈/关于占位）。
// TODO(Task 5): 接入真实帮助文档链接与版本信息。

import { createSignal } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { dialogsT } from "./i18n"

export function HelpButton() {
  const dialog = useDialog()
  const [shown, setShown] = createSignal(false)

  const open = () => {
    setShown(true)
    void dialog.show(
      () => (
        <Dialog size="normal" class="help-dialog">
          <DialogHeader>
            <DialogTitle>{dialogsT("help.title")}</DialogTitle>
          </DialogHeader>
          <DialogBody class="flex flex-col gap-6 px-6 pb-6">
            <p class="text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
              {dialogsT("help.drawer.introduction")}
            </p>
            <div class="flex flex-col gap-4">
              <HelpItem
                title={dialogsT("help.drawer.guide")}
                description={dialogsT("help.drawer.guide.description")}
              />
              <HelpItem
                title={dialogsT("help.drawer.feedback")}
                description={dialogsT("help.drawer.feedback.description")}
              />
              <HelpItem
                title={dialogsT("help.drawer.about")}
                description={dialogsT("help.drawer.about.description")}
              />
            </div>
          </DialogBody>
        </Dialog>
      ),
      () => setShown(false),
    )
  }

  return (
    <IconButtonV2
      type="button"
      variant="ghost-muted"
      size="large"
      class="!w-9 shrink-0"
      state={shown() ? "pressed" : undefined}
      icon={<IconV2 name="help" />}
      onClick={open}
      aria-label={dialogsT("help.button.ariaLabel")}
      aria-pressed={shown()}
    />
  )
}

function HelpItem(props: { title: string; description: string }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base">
        {props.title}
      </span>
      <span class="text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted">
        {props.description}
      </span>
    </div>
  )
}
