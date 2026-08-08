// src/app/pages/NewChatPage.tsx
// 新会话页（/chat/new）：新建私聊输入 + 快速入口（新建群聊 / 扫码加群 / 邀请链接）。
// 提交后创建会话（create_chat_by_email / create_group / secure_join）并导航 /chat/:id
// （titlebar 的 auto-add effect 会自动补 session tab）。文案统一走 dialogsT（src/i18n）。

import { createSignal, Show, type Component } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { call } from "../../api"
import { useAccount } from "../context/account"
import { useTabs } from "../context/tabs"
import { normalizeUrlForQr } from "../../utils/deepLink"
import { isEmail } from "../../utils/inviteLink"
import { dialogsT } from "../components/dialogs/i18n"
import { showToast } from "../utils/toast"
import { PanelCard } from "./panel-card"

// @ts-expect-error qrcode 无类型声明（与 login/secure-join 用法一致）
import QRCode from "qrcode"

const NewChatPage: Component = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const account = useAccount()
  const tabs = useTabs()
  const dialog = useDialog()
  const [input, setInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  // 创建成功后用 session tab 替换当前 URL 里 draftId 对应的 draft tab（否则残留「新会话」标签）
  const openChat = (chatId: number) => {
    const draftId = new URLSearchParams(location.search).get("draftId")
    if (draftId) tabs.replaceDraft(draftId, String(chatId))
    navigate(`/chat/${chatId}`)
  }

  // 私聊 / 邀请链接（邮箱 → create_chat_by_email；securejoin 链接 → secure_join）
  const startChat = async () => {
    const raw = input().trim()
    if (!raw || busy()) return
    setBusy(true)
    try {
      if (isEmail(raw)) {
        const chatId = await call<number>("create_chat_by_email", { email: raw })
        openChat(chatId)
        return
      }
      const chatId = await account.joinSecure(normalizeUrlForQr(raw))
      showToast({ title: dialogsT("newchat.joined") })
      if (chatId) openChat(chatId)
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  // 新建群聊（create_group）
  const createGroup = () => {
    void dialog.show(() => <CreateGroupDialog onCreated={openChat} />)
  }

  // 扫码加群：展示个人邀请二维码 + 粘贴链接加入
  const scanJoin = () => {
    void dialog.show(() => <ScanJoinDialog />)
  }

  return (
    <div class="flex flex-1 min-h-0 min-w-0 self-stretch p-2">
      <PanelCard raised>
        <div class="flex-1 min-h-0 flex flex-col items-center justify-center gap-10 px-6">
          <div class="flex max-w-[560px] w-full flex-col items-center gap-8">
            <h1 class="text-[22px] font-[640] leading-7 tracking-[-0.02em] text-v2-text-text-strong">
              {dialogsT("newchat.title")}
            </h1>
            <form
              class="flex w-full items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void startChat()
              }}
            >
              <TextInputV2
                autofocus
                appearance="large"
                class="!w-full"
                placeholder={dialogsT("newchat.placeholder")}
                value={input()}
                onInput={(event) => setInput(event.currentTarget.value)}
                aria-label={dialogsT("newchat.title")}
              />
              <ButtonV2 type="submit" variant="contrast" size="large" disabled={busy() || !input().trim()}>
                {busy() ? dialogsT("newchat.joining") : dialogsT("newchat.start")}
              </ButtonV2>
            </form>
            <div class="flex items-center justify-center gap-3">
              <QuickEntry icon="grid-plus" label={dialogsT("newchat.group.title")} onClick={createGroup} />
              <QuickEntry icon="outline-share" label={dialogsT("newchat.scan.title")} onClick={scanJoin} />
            </div>
          </div>
        </div>
      </PanelCard>
    </div>
  )
}

function QuickEntry(props: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="flex h-20 w-32 flex-col items-center justify-center gap-2 rounded-lg border border-border-weak-base bg-v2-background-bg-base text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
      onClick={props.onClick}
    >
      <IconV2 name={props.icon} size="large" />
      <span class="text-[13px]">{props.label}</span>
    </button>
  )
}

function CreateGroupDialog(props: { onCreated: (chatId: number) => void }) {
  const dialog = useDialog()
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: Event) => {
    event.preventDefault()
    const trimmed = name().trim()
    if (!trimmed || busy()) return
    setBusy(true)
    try {
      const chatId = await call<number>("create_group", { name: trimmed })
      dialog.close()
      props.onCreated(chatId)
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <form onSubmit={submit} class="contents">
        <DialogHeader>
          <DialogTitle>{dialogsT("newchat.group.title")}</DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex flex-col gap-4 px-4 pt-4 pb-1">
          <TextInputV2
            autofocus
            appearance="large"
            class="!w-full"
            placeholder={dialogsT("newchat.group.placeholder")}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
            aria-label={dialogsT("newchat.group.placeholder")}
          />
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
            {dialogsT("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={busy() || !name().trim()}>
            {busy() ? dialogsT("newchat.group.creating") : dialogsT("newchat.group.create")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function ScanJoinDialog() {
  const dialog = useDialog()
  const navigate = useNavigate()
  const location = useLocation()
  const account = useAccount()
  const tabs = useTabs()
  const [qrUrl, setQrUrl] = createSignal("")
  const [link, setLink] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const loadQr = async () => {
    try {
      const qr = await call<string>("get_securejoin_qr", { chatId: null })
      const dataUrl = await QRCode.toDataURL(normalizeUrlForQr(qr), { margin: 1, width: 220 })
      setQrUrl(dataUrl)
    } catch {
      setQrUrl("")
    }
  }
  void loadQr()

  const join = async () => {
    const raw = link().trim()
    if (!raw || busy()) return
    setBusy(true)
    try {
      const chatId = await account.joinSecure(normalizeUrlForQr(raw))
      showToast({ title: dialogsT("newchat.joined") })
      // 与 startChat 路径一致：加入成功后直达新会话（secure_join 返回 chatId），
      // 并替换掉 URL 中 draftId 对应的 draft tab。
      if (chatId) {
        const draftId = new URLSearchParams(location.search).get("draftId")
        if (draftId) tabs.replaceDraft(draftId, String(chatId))
        navigate(`/chat/${chatId}`)
      }
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{dialogsT("newchat.scan.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex flex-col items-center gap-4 px-4 pt-4 pb-1">
        <Show
          when={qrUrl()}
          fallback={<div class="text-[13px] text-v2-text-text-faint">{dialogsT("newchat.scan.unavailable")}</div>}
        >
          <img src={qrUrl()} width={220} height={220} alt={dialogsT("newchat.scan.title")} class="rounded-md" />
        </Show>
        <div class="flex w-full items-center gap-2">
          <TextInputV2
            class="!w-full"
            placeholder={dialogsT("newchat.scan.linkPlaceholder")}
            value={link()}
            onInput={(event) => setLink(event.currentTarget.value)}
            aria-label={dialogsT("newchat.scan.linkPlaceholder")}
          />
          <ButtonV2 type="button" variant="contrast" disabled={busy() || !link().trim()} onClick={() => void join()}>
            {dialogsT("newchat.scan.join")}
          </ButtonV2>
        </div>
        <p class="text-[12px] text-v2-text-text-faint">{dialogsT("newchat.scan.hint")}</p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" onClick={() => dialog.close()}>
          {dialogsT("newchat.scan.close")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export default NewChatPage
