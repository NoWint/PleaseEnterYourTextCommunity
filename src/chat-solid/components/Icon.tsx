import { onMount, createMemo, type JSX } from "solid-js";
import { icons } from "../vendor/icon-definitions";

// sprite 容器 svg 的 id;symbol id 前缀用 ICON_PREFIX, 产生形如
// `peyt-chat-icon-plus` 的 id, 与测试预期一致。
const SPRITE_ID = "peyt-chat-icon-sprite";
const ICON_PREFIX = "peyt-chat-icon-";
const symbol = (name: string) => `${ICON_PREFIX}${name}`;

function ensureSprite(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_ID)) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = SPRITE_ID;
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.overflow = "hidden";
  svg.innerHTML = Object.entries(icons)
    .map(([name, def]) => `<symbol id="${symbol(name)}" viewBox="${def.viewBox}">${def.body}</symbol>`)
    .join("");
  document.body.insertBefore(svg, document.body.firstChild);
}

export interface IconProps {
  name: string;
  size?: "small" | "normal" | "large";
  class?: string;
}

export function Icon(props: IconProps): JSX.Element {
  onMount(ensureSprite);
  const pixelSize = createMemo(() => {
    const s = props.size ?? "normal";
    return s === "small" ? 14 : s === "large" ? 20 : 16;
  });
  const name = createMemo(() => (icons[props.name] ? props.name : "plus"));
  return (
    <svg width={pixelSize()} height={pixelSize()} viewBox={icons[name()].viewBox} class={props.class}>
      <use href={`#${symbol(name())}`} />
    </svg>
  );
}

