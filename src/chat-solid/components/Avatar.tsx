import { type JSX, Show, createMemo, createResource } from "solid-js";
import { transformBlobURL } from "../../api.js";

const AVATAR_COLORS = [
  "orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple", "gray",
] as const;

export interface AvatarProps {
  name: string;
  src?: string | null;
  color?: number | null;
  size?: "small" | "normal";
}

export function Avatar(props: AvatarProps): JSX.Element {
  const size = () => props.size === "small" ? 20 : 28;
  const initial = createMemo(() => props.name?.[0] ?? "?");
  const colorClass = createMemo(() => {
    const idx = props.color ?? 0;
    return `peyt-avatar-${AVATAR_COLORS[idx % AVATAR_COLORS.length]}`;
  });
  // transformBlobURL 是 async(可能触发 tauri convertFileSrc);
  // 用 createResource 异步解析, 解析前先用 props.src 作为初始值,
  // 保证同步渲染时 img 已在 DOM 中(blob: URL 与已就绪资源直接透传)。
  const [resolvedSrc] = createResource(
    () => props.src,
    async (s) => (s ? transformBlobURL(s) : ""),
  );
  const imgSrc = () => resolvedSrc() ?? props.src ?? "";
  return (
    <Show
      when={props.src}
      fallback={
        <span
          class={`peyt-avatar peyt-avatar-fallback ${colorClass()}`}
          style={{ width: `${size()}px`, height: `${size()}px` }}
        >
          {initial()}
        </span>
      }
    >
      <img
        class="peyt-avatar"
        src={imgSrc()}
        style={{ width: `${size()}px`, height: `${size()}px`, "border-radius": "50%" }}
        alt={props.name}
      />
    </Show>
  );
}
