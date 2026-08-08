// src/app/components/server/server-row-menu.tsx
// 照抄 opencode components/server/server-row-menu.tsx 裁剪：
// - 去掉 ServerRowMenu 包装（依赖 useServerManagementController，IM 版无此控制器）
// - 保留 ServerRowMenuView + serverMenuLabels，label 文案改中文（SHELL_DICT）
// - ServerConnection 用本地类型（key/displayName/label），builtin = 本地回落账号

import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { type Component, Show } from "solid-js"
import { useLanguage } from "../../context/language"
import { LOCAL_SERVER, ServerConnection } from "../../context/server"

export function serverMenuLabels(language: ReturnType<typeof useLanguage>) {
  return {
    more: language.t("common.moreOptions"),
    server: language.t("settings.section.account"),
    edit: language.t("dialog.server.menu.edit"),
    default: language.t("dialog.server.menu.default"),
    defaultRemove: language.t("dialog.server.menu.defaultRemove"),
    delete: language.t("dialog.server.menu.delete"),
  }
}

export const ServerRowMenuView: Component<{
  server: ServerConnection.Any
  labels: ReturnType<typeof serverMenuLabels>
  canDefault: boolean
  isDefault: boolean
  onEdit: (server: ServerConnection.Any) => void
  onSetDefault: () => void
  onRemoveDefault: () => void
  onRemove: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}> = (props) => {
  const builtin = () => ServerConnection.key(props.server) === ServerConnection.key(LOCAL_SERVER)
  return (
    <MenuV2 gutter={6} modal={false} placement="bottom-end" open={props.open} onOpenChange={props.onOpenChange}>
      <MenuV2.Trigger
        as={IconButtonV2}
        variant="ghost-muted"
        size="small"
        icon={<IconV2 name="outline-dots" />}
        aria-label={props.labels.more}
      />
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Group>
            <MenuV2.GroupLabel>{props.labels.server}</MenuV2.GroupLabel>
            <MenuV2.Item
              disabled={builtin()}
              onSelect={() => {
                if (!builtin()) props.onEdit(props.server)
              }}
            >
              {props.labels.edit}
            </MenuV2.Item>
            <Show when={props.canDefault && !props.isDefault}>
              <MenuV2.Item onSelect={props.onSetDefault}>{props.labels.default}</MenuV2.Item>
            </Show>
            <Show when={props.canDefault && props.isDefault}>
              <MenuV2.Item onSelect={props.onRemoveDefault}>{props.labels.defaultRemove}</MenuV2.Item>
            </Show>
            <MenuV2.Separator />
            <MenuV2.Item disabled={builtin()} onSelect={props.onRemove}>
              {props.labels.delete}
            </MenuV2.Item>
          </MenuV2.Group>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
