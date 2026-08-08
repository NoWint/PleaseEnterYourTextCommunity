// src/app/pages/login/index.tsx
// 登录页（账号选择 + 新建账号 + 邀请加入），全部使用 v2 组件。
// 遵循 2026-08-07 account-picker-login 设计：
// - 有已存账号 → 显示账号卡（avatar/username/mail），点击 switch_account 进入；
//   「新建账号」按钮展开表单（可收起）。
// - 无已存账号 → 直接显示新建账号表单。
// - 登出 = 进账号选择（账号保留），与后端 logout 语义一致。
// 登录/切换成功后 navigate("/home")；已登录访问 /login 时重定向回 /home。

import type { Component } from "solid-js"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Navigate, useNavigate } from "@solidjs/router"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Avatar } from "@opencode-ai/ui/v2/avatar-v2"
import { useAccount, type AccountInfo } from "../../context/account"
import { onEvent, transformBlobURL } from "../../../api"
import { showToast } from "../../utils/toast"
import { SecureJoinSection } from "./secure-join"
import "./login.css"

const LoginPage: Component = () => {
  const account = useAccount()
  const navigate = useNavigate()

  const [busyId, setBusyId] = createSignal<number | null>(null)

  const accounts = createMemo(() => account.accounts())

  const enter = () => navigate("/home")

  const pickAccount = async (a: AccountInfo) => {
    if (busyId() !== null) return
    if (a.is_current) {
      enter()
      return
    }
    setBusyId(a.id)
    try {
      await account.switchTo(a.id)
      enter()
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
      setBusyId(null)
    }
  }

  return (
    <div class="login-page">
      <Show when={account.authenticated()} fallback={null}>
        <Navigate href="/home" />
      </Show>

      <div class="login-hero">
        <img class="login-hero-logo" src="/logo.jpg" alt="PEYT Studio" />
        <h1 class="login-hero-title">PEYT Studio</h1>
        <p class="login-hero-slogan">Type Everything</p>
      </div>

      <div class="login-panel">
        <Show when={accounts().length > 0} fallback={<NewAccountForm />}>
          <AccountPicker
            accounts={accounts()}
            busyId={busyId()}
            onPick={(a) => void pickAccount(a)}
          />
          <NewAccountToggle />
        </Show>

        <div class="login-divider" role="separator" />

        <SecureJoinSection />
      </div>
    </div>
  )
}

/** 账号展示名回退：name → addr → 账号 id。 */
export function accountLabel(a: AccountInfo): string {
  return a.name || a.addr || `账号 ${a.id}`
}

/** 账号卡网格（presentational，便于测试）：点击回调由外部处理。 */
export const AccountPicker: Component<{
  accounts: AccountInfo[]
  busyId: number | null
  onPick: (a: AccountInfo) => void
}> = (props) => {
  return (
    <div class="login-card">
      <h2 class="login-section-title">选择账号</h2>
      <div class="login-accounts">
        <For each={props.accounts}>
          {(a) => (
            <button
              type="button"
              class="login-account-card"
              disabled={props.busyId !== null}
              onClick={() => props.onPick(a)}
            >
              <AccountAvatar account={a} />
              <span class="login-account-name">{accountLabel(a)}</span>
              <span class="login-account-mail">{a.addr}</span>
              <Show when={a.is_current}>
                <span class="login-account-current">当前</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <Show when={props.busyId !== null}>
        <p class="login-status">切换中…</p>
      </Show>
    </div>
  )
}

/** 账号头像：有 avatar 用图片（blobdir → transformBlobURL），无则首字母占位。 */
const AccountAvatar: Component<{ account: AccountInfo }> = (props) => {
  const [url, setUrl] = createSignal<string>("")
  onMount(() => {
    if (!props.account.avatar) return
    void transformBlobURL(props.account.avatar).then((u) => setUrl(u))
  })
  return (
    <Avatar
      fallback={(props.account.name || props.account.addr || "?").charAt(0).toUpperCase()}
      src={url() || undefined}
      size="large"
    />
  )
}

/** 有账号时的「新建账号」折叠入口：展开/收起表单。 */
const NewAccountToggle: Component = () => {
  const [open, setOpen] = createSignal(false)
  return (
    <Show
      when={open()}
      fallback={
        <ButtonV2 variant="outline" onClick={() => setOpen(true)}>
          新建账号
        </ButtonV2>
      }
    >
      <div class="login-card">
        <h2 class="login-section-title">新建账号</h2>
        <NewAccountForm />
        <ButtonV2 variant="ghost" onClick={() => setOpen(false)}>
          收起
        </ButtonV2>
      </div>
    </Show>
  )
}

/** 新建账号表单：显示名 → create_chatmail_account（附 ConfigureProgress 进度）。 */
const NewAccountForm: Component = () => {
  const account = useAccount()
  const navigate = useNavigate()
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [progress, setProgress] = createSignal<string>("")

  const submit = async () => {
    const displayName = name().trim()
    if (!displayName || busy()) return
    setBusy(true)
    setProgress("创建中…")
    let unlisten: (() => void) | null = null
    try {
      unlisten = await onEvent("ConfigureProgress", (p) => {
        const value = p.progress as number
        if (value === 0) setProgress("失败…")
        else if (value >= 1000) setProgress("成功，正在进入…")
        else if (value > 0) setProgress(`${Math.floor(value / 10)}%`)
      })
    } catch {
      // 事件桥不可用时忽略，仅以 invoke 结果为准
    }
    try {
      await account.create(displayName)
      setProgress("成功，正在进入…")
      navigate("/home")
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
      setBusy(false)
      setProgress("")
    } finally {
      unlisten?.()
    }
  }

  return (
    <div class="login-new-form">
      <p class="login-hint">输入显示名，即可创建 yzjtiantian.cn 账号</p>
      <TextInputV2
        appearance="large"
        placeholder="你的显示名"
        maxLength={60}
        value={name()}
        disabled={busy()}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit()
        }}
      />
      <ButtonV2
        variant="contrast"
        size="large"
        disabled={busy() || !name().trim()}
        onClick={() => void submit()}
      >
        创建账号
      </ButtonV2>
      <Show when={progress()}>
        <p class="login-status">{progress()}</p>
      </Show>
    </div>
  )
}

export default LoginPage
