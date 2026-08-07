import { type JSX } from "solid-js";
import { Popover as KobaltePopover } from "@kobalte/core/popover";

export interface PopoverProps {
  placement?: "top" | "bottom" | "top-start";
  gutter?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: JSX.Element;
  content: JSX.Element;
}

export function Popover(props: PopoverProps): JSX.Element {
  return (
    <KobaltePopover
      placement={props.placement ?? "top"}
      gutter={props.gutter ?? 4}
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <KobaltePopover.Trigger>{props.children}</KobaltePopover.Trigger>
      <KobaltePopover.Portal>
        <KobaltePopover.Content class="peyt-popover">
          {props.content}
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  );
}
