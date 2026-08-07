import { type JSX } from "solid-js";
import { ContextMenu as KobalteContextMenu } from "@kobalte/core/context-menu";

export interface ContextMenuProps {
  /** 渲染在 Trigger 内的内容(Kobalte Trigger 自带 onContextMenu, 右键触发) */
  trigger: JSX.Element;
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
  return (
    <KobalteContextMenu.Item
      class="peyt-context-menu-item"
      onSelect={props.onSelect}
      data-action={props["data-action"]}
    >
      {props.children}
    </KobalteContextMenu.Item>
  );
}

export function ContextMenuSeparator(): JSX.Element {
  return <KobalteContextMenu.Separator class="peyt-context-menu-separator" />;
}
