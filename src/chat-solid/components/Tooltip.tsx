import { type JSX } from "solid-js";
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip";

export interface TooltipProps {
  children: JSX.Element;
  content: JSX.Element;
}

export function Tooltip(props: TooltipProps): JSX.Element {
  return (
    <KobalteTooltip openDelay={400} closeDelay={0} gutter={4}>
      <KobalteTooltip.Trigger>{props.children}</KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class="peyt-tooltip">
          {props.content}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  );
}
