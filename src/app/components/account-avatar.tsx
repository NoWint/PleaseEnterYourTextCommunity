// src/app/components/account-avatar.tsx
// 账号头像（登录页账号卡 / 账号管理对话框共用）：
// 有 avatar 用图片（blobdir → transformBlobURL），无则首字母占位。

import { createSignal, onMount, type Component } from "solid-js"
import { Avatar } from "@opencode-ai/ui/v2/avatar-v2"
import { transformBlobURL } from "../../api"
import type { AccountInfo } from "../context/account"

export const AccountAvatar: Component<{ account: AccountInfo; size?: "small" | "normal" | "large" }> = (
  props,
) => {
  const [url, setUrl] = createSignal<string>("")
  onMount(() => {
    if (!props.account.avatar) return
    void transformBlobURL(props.account.avatar).then((u) => setUrl(u))
  })
  return (
    <Avatar
      fallback={(props.account.name || props.account.addr || "?").charAt(0).toUpperCase()}
      src={url() || undefined}
      size={props.size ?? "normal"}
    />
  )
}
