// src/app/components/dialogs/dialog-account.tsx
// 账号管理对话框：列出账号（avatar/name/addr + 当前标记）、点击切换（switch_account）、
// 新建账号（→ /login 的账号选择）、登出（→ /login，账号保留）。
// 由设置对话框「服务器」页签的账号管理区打开（见 settings-v2/servers.tsx）。

import { For, Show, createSignal, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Avatar } from "@opencode-ai/ui/v2/avatar-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useAccount, type AccountInfo } from "../../context/account"
import { transformBlobURL } from "../../../api"
import { showToast } from "../../utils/toast"
import "./dialog-account.css"

export function DialogAccount() {
  const account = useAccount()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [busyId, setBusyId] = createSignal<number | null>(null)

  const switchTo = async (a: AccountInfo) => {
    if (busyId() !== null) return
    if (a.is_current) {
      dialog.close()
      return
    }
    setBusyId(a.id)
    try {
      await account.switchTo(a.id)
      dialog.close()
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
      setBusyId(null)
    }
  }

  const createAccount = () => {
    dialog.close()
    navigate("/login")
  }

  const logout = async () => {
    if (busyId() !== null) return
    setBusyId(-1)
    try {
      await account.logout()
      dialog.close()
      navigate("/login")
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
      setBusyId(null)
    }
  }

  return (
    <Dialog class="dialog-account">
      <DialogHeader>
        <DialogTitle>账号管理</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-col gap-2 px-4 pt-4 pb-1">
        <p class="dialog-account-hint">点击账号即可切换；登出后回到账号选择</p>
        <For each={account.accounts()}>
          {(a) => (
            <button
              type="button"
              class="dialog-account-row"
              disabled={busyId() !== null}
              onClick={() => void switchTo(a)}
            >
              <AccountAvatar account={a} />
              <span class="dialog-account-copy">
                <span class="dialog-account-name">{a.name || a.addr || `账号 ${a.id}`}</span>
                <span class="dialog-account-mail">{a.addr}</span>
              </span>
              <Show when={a.is_current}>
                <span class="dialog-account-current">当前</span>
              </Show>
            </button>
          )}
        </For>
        <Show when={busyId() === -1}>
          <p class="dialog-account-status">登出中…</p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="outline" disabled={busyId() !== null} onClick={createAccount}>
          新建账号
        </ButtonV2>
        <ButtonV2 variant="danger" disabled={busyId() !== null} onClick={() => void logout()}>
          登出
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

/** 账号头像：有 avatar 用图片（blobdir → transformBlobURL），无则首字母占位。 */
function AccountAvatar(props: { account: AccountInfo }) {
  const [url, setUrl] = createSignal<string>("")
  onMount(() => {
    if (!props.account.avatar) return
    void transformBlobURL(props.account.avatar).then((u) => setUrl(u))
  })
  return (
    <Avatar
      fallback={(props.account.name || props.account.addr || "?").charAt(0).toUpperCase()}
      src={url() || undefined}
      size="normal"
    />
  )
}
