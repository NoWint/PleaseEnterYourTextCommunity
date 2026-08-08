// src/app/context/server.tsx
// IM 多"服务器"（= 账号）抽象，对齐 opencode context/server 的接口形状，
// 供照抄的 home 组件使用：
// - list/current = 账号列表映射为 ServerConnection.Any（key=账号 id，displayName=账号名）
// - health = 账号在线态（{ healthy: is_configured }）
// - collapsed = 账号行折叠态（localStorage peyt.serverCollapsed）
// - defaultKey/canDefault = 默认账号（peyt.defaultServer localStorage，缺省第一个账号）
// - focus(key) = 切换账号（account.switchTo）
//
// ServerProvider 挂在 Router 外、AccountProvider 在 Router 内，账号数据经
// ServerAccountBridge（App.tsx 中置于 AccountProvider 下）绑定。

import { createMemo, createSignal } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useAccount, type AccountInfo, type AccountStore } from "./account"

export namespace ServerConnection {
  export type Key = string
  export interface Any {
    key: Key
    displayName?: string
    label?: string
  }
  export const key = (conn: Any): Key => conn.key
}

export const LOCAL_SERVER: ServerConnection.Any = {
  key: "local",
  displayName: "本地",
}

export type ServerHealth = { healthy: boolean } | undefined

const SERVER_COLLAPSED_KEY = "peyt.serverCollapsed"
const DEFAULT_SERVER_KEY = "peyt.defaultServer"

/** 账号 store（ServerAccountBridge 绑定时写入；绑定前回落单本地 server 行为） */
const [accountStore, setAccountStore] = createSignal<AccountStore>()

/** 账号 → server 连接映射 */
function toConnection(account: AccountInfo): ServerConnection.Any {
  return {
    key: String(account.id),
    displayName: account.name,
    label: account.addr,
  }
}

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SERVER_COLLAPSED_KEY) ?? "{}") as Record<string, boolean>
  } catch {
    return {}
  }
}

interface ServerStore {
  key: ServerConnection.Key
  current: ServerConnection.Any
  list: ServerConnection.Any[]
  health: Record<string, ServerHealth | undefined>
  collapsed: Record<string, boolean>
  defaultKey: ServerConnection.Key | null | undefined
  canDefault: () => boolean
  setCollapsed: (key: ServerConnection.Key, collapsed: boolean) => void
  setDefault: (key?: ServerConnection.Key) => void
  focus: (key: ServerConnection.Key) => Promise<void>
}

function createServerStore(): ServerStore {
  const accounts = createMemo(() => accountStore()?.accounts() ?? [])
  const configured = () => accountStore()?.authenticated() ?? true

  const list = createMemo((): ServerConnection.Any[] => {
    const items = accounts()
    return items.length === 0 ? [LOCAL_SERVER] : items.map(toConnection)
  })

  const current = createMemo((): ServerConnection.Any => {
    const active = accountStore()?.current()
    if (active) return toConnection(active)
    const items = accounts()
    return items.length === 0 ? LOCAL_SERVER : toConnection(items[0])
  })

  const health = createMemo<Record<string, ServerHealth | undefined>>(() => {
    const items = accounts()
    if (items.length === 0) return { [LOCAL_SERVER.key]: { healthy: true } }
    const healthy = configured()
    const result: Record<string, ServerHealth | undefined> = {}
    for (const item of items) result[String(item.id)] = { healthy }
    return result
  })

  const [collapsed, setCollapsedState] = createSignal<Record<string, boolean>>(readCollapsed())
  const [storedDefault, setStoredDefault] = createSignal<string | null>(
    localStorage.getItem(DEFAULT_SERVER_KEY),
  )

  const defaultKey = createMemo((): ServerConnection.Key | null | undefined => {
    const items = list()
    if (items.length === 0) return undefined
    const stored = storedDefault()
    if (stored && items.some((item) => item.key === stored)) return stored
    return items[0]?.key ?? null
  })

  function setCollapsed(key: ServerConnection.Key, next: boolean) {
    const updated = { ...collapsed(), [key]: next }
    setCollapsedState(updated)
    try {
      localStorage.setItem(SERVER_COLLAPSED_KEY, JSON.stringify(updated))
    } catch {
      // 忽略存储异常（如隐私模式）
    }
  }

  function setDefault(key?: ServerConnection.Key) {
    if (key) localStorage.setItem(DEFAULT_SERVER_KEY, key)
    else localStorage.removeItem(DEFAULT_SERVER_KEY)
    setStoredDefault(key ?? null)
  }

  async function focus(key: ServerConnection.Key) {
    const store = accountStore()
    if (!store) return
    const target = accounts().find((account) => String(account.id) === key)
    if (target && !target.is_current) await store.switchTo(target.id)
  }

  return {
    get key() {
      return current().key
    },
    get current() {
      return current()
    },
    get list() {
      return list()
    },
    get health() {
      return health()
    },
    get collapsed() {
      return collapsed()
    },
    get defaultKey() {
      return defaultKey()
    },
    canDefault: () => accounts().length > 1,
    setCollapsed,
    setDefault,
    focus,
  }
}

/** 账号桥：挂在 AccountProvider 内，把账号 store 绑定给 server store（provider 顺序不允许 init 期读取）。 */
export function ServerAccountBridge() {
  const account = useAccount()
  setAccountStore(account)
  return null
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext<ServerStore, Record<string, any>>({
  name: "Server",
  gate: false,
  init: () => createServerStore(),
})
