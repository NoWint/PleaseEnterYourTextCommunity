import { type JSX, type ValidComponent, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "small" | "normal" | "large";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
  as?: ValidComponent;
  class?: string;
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, others] = splitProps(props, ["variant", "size", "disabled", "onClick", "children", "as", "class"]);
  return (
    <Dynamic
      component={local.as ?? "button"}
      data-component="button"
      data-variant={local.variant ?? "primary"}
      data-size={local.size ?? "normal"}
      disabled={local.disabled}
      onClick={local.onClick}
      class={`peyt-btn ${local.class ?? ""}`}
      {...others}
    >
      {local.children}
    </Dynamic>
  );
}
