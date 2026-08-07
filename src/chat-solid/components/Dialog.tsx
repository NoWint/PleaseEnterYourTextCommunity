import { type JSX, Show } from "solid-js";
import { Dialog as KobalteDialog } from "@kobalte/core/dialog";

export type DialogSize = "normal" | "large" | "x-large" | "fit";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  size?: DialogSize;
  children?: JSX.Element;
  footer?: JSX.Element;
}

export function Dialog(props: DialogProps): JSX.Element {
  return (
    <KobalteDialog open={props.open} onOpenChange={props.onOpenChange}>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay class="peyt-dialog-overlay" />
        <KobalteDialog.Content class="peyt-dialog" data-size={props.size ?? "normal"}>
          <Show when={props.title || props.description}>
            <div class="peyt-dialog-header">
              <Show when={props.title}>
                <KobalteDialog.Title class="peyt-dialog-title">{props.title}</KobalteDialog.Title>
              </Show>
              <Show when={props.description}>
                <KobalteDialog.Description class="peyt-dialog-desc">{props.description}</KobalteDialog.Description>
              </Show>
            </div>
          </Show>
          <Show when={props.children}>
            <div class="peyt-dialog-body">{props.children}</div>
          </Show>
          <Show when={props.footer}>
            <div class="peyt-dialog-footer">{props.footer}</div>
          </Show>
        </KobalteDialog.Content>
      </KobalteDialog.Portal>
    </KobalteDialog>
  );
}
