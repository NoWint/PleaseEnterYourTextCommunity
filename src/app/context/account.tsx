// src/app/context/account.tsx
// AccountStore：登录态 + 账号管理（is_configured / list_accounts / switch_account /
// create_chatmail_account / logout / secure_join 命令封装）。
// - App.tsx 依据 ready/authenticated 做 /login 重定向（未登录 → 登录页，登录后 → /home）。
// - 切换账号/登出/新建后经 refresh() 同步状态，无需整页 reload。
// - 后端 switch_account 不发事件（"前端切换后 reload 重建 UI"），chat/workspace
//   context 经 version 信号监听切换，重拉当前账号的会话/工作区/自身资料。
// - 登出语义（对齐 8/7 account-picker-login 设计）：stop_io + 清 current，
//   账号保留 → 登录页重新显示账号选择。
//
// 浏览器 dev（无 Tauri invoke）降级：视为已登录（与其他 store 一致，保证壳层可浏览）；
// 设置 localStorage "peyt.forceLogin" = "1" 可强制未登录态，用于预览登录页。

import { createSignal } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { call } from "../../api"

export interface AccountInfo {
  id: number
  name: string
  addr: string
  is_current: boolean
  avatar: string | null
}

export interface AccountStore {
  /** 首次 is_configured/list_accounts 探测是否完成（完成前 App 显示启动占位） */
  ready: () => boolean
  /** 是否有已配置（当前激活）账号 */
  authenticated: () => boolean
  /** 已存账号列表（未登录时也拉取，供账号选择） */
  accounts: () => AccountInfo[]
  /** 当前激活账号（可能 undefined） */
  current: () => AccountInfo | undefined
  /** 账号切换版本号：switchTo/create/logout 后 +1，供下游按账号重拉数据。 */
  version: () => number
  refresh: () => Promise<void>
  /** switch_account(id) 本地切换 → refresh */
  switchTo: (id: number) => Promise<void>
  /** create_chatmail_account(displayName) 注册并切换 → refresh */
  create: (displayName: string) => Promise<void>
  /** logout：stop_io + 清 current，账号保留 → refresh */
  logout: () => Promise<void>
  /** secure_join(inviteLink) 加入群聊/联系人，返回 chatId → refresh */
  joinSecure: (inviteLink: string) => Promise<number>
}

const FORCE_LOGIN_KEY = "peyt.forceLogin"

function createAccountStore(): AccountStore {
  const [ready, setReady] = createSignal(false)
  const [authenticated, setAuthenticated] = createSignal(false)
  const [accounts, setAccounts] = createSignal<AccountInfo[]>([])
  const [version, setVersion] = createSignal(0)

  async function refresh(): Promise<void> {
    // dev 预览开关：强制未登录态（登录页渲染用，与真实 is_configured 无关）
    if (localStorage.getItem(FORCE_LOGIN_KEY) === "1") {
      setAuthenticated(false)
      try {
        setAccounts(await call<AccountInfo[]>("list_accounts"))
      } catch {
        setAccounts([])
      }
      setReady(true)
      return
    }

    try {
      const configured = await call<boolean>("is_configured")
      setAuthenticated(configured)
    } catch {
      // invoke 不可用（浏览器 dev）→ 降级为已登录（与其他 store 一致）
      console.warn("[account] is_configured 不可用（浏览器 dev）→ 视为已登录")
      setAuthenticated(true)
    }
    // 未登录时也要拉已存账号（登出 ≠ 删除账号，登录页展示账号选择）
    try {
      setAccounts(await call<AccountInfo[]>("list_accounts"))
    } catch {
      setAccounts([])
    }
    setReady(true)
  }

  void refresh()

  return {
    ready,
    authenticated,
    accounts,
    current: () => accounts().find((a) => a.is_current),
    version,
    refresh,
    async switchTo(id: number) {
      await call("switch_account", { id })
      await refresh()
      setVersion((v) => v + 1)
    },
    async create(displayName: string) {
      await call("create_chatmail_account", { displayName })
      await refresh()
      setVersion((v) => v + 1)
    },
    async logout() {
      await call("logout")
      await refresh()
      setVersion((v) => v + 1)
    },
    async joinSecure(inviteLink: string): Promise<number> {
      const chatId = await call<number>("secure_join", { qr: inviteLink })
      await refresh()
      return chatId
    },
  }
}

export const { use: useAccount, provider: AccountProvider } = createSimpleContext<AccountStore, Record<string, any>>({
  name: "Account",
  gate: false,
  init: () => createAccountStore(),
})
