// src/app/context/tabs.tsx
// 照抄 opencode context/tabs.tsx 结构改造：标签页 = IM 聊天会话。
// tabHref: session → /chat/:id，draft → /chat/new?draftId=:draftId
// 持久化到 localStorage（peyt.tabs*）；会话数据经 chat context 实时解析。

import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AppSession } from "../types"
import { nextTabAfterClose } from "./closed-tabs"

export type SessionTab = {
  type: "session"
  chatId: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  /** 新建会话所属工作区（可空）。 */
  directory?: string
}

export type Tab = SessionTab | DraftTab

export type TabInfo = {
  title?: string
  directory?: string
}

export const draftHref = (draftID: string) => `/chat/new?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) => (tab.type === "draft" ? draftHref(tab.draftID) : `/chat/${tab.chatId}`)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `chat:${tab.chatId}`)

export function sessionHasOpenTab(tabs: Tab[], session: AppSession) {
  return tabs.some((tab) => tab.type === "session" && tab.chatId === session.id)
}

let draftCounter = 0

// 刚被关闭的 tab key（本 tick 内生效）。titlebar 的 auto-add effect 会在 store
// 变化时同步重跑（@solidjs/router 0.15.3 的 navigate 是异步更新 location），
// 若不拦截，关闭标签页时 effect 会把刚关闭的 tab 又加回来。
const recentlyRemoved = new Set<string>()

export function isTabRecentlyRemoved(key: string) {
  return recentlyRemoved.has(key)
}

function markTabRemoved(key: string) {
  recentlyRemoved.add(key)
  setTimeout(() => recentlyRemoved.delete(key), 0)
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function persist(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

interface TabsStore {
  store: Tab[]
  info: Record<string, TabInfo>
  ready: () => boolean
  addSessionTab: (tab: Omit<SessionTab, "type">) => SessionTab
  reorder: (keys: string[]) => void
  newDraft: (draft: Omit<DraftTab, "type" | "draftID">) => Promise<DraftTab>
  removeTab: (index: number) => void
  closeTab: (index: number) => void
  reopenClosedTab: () => void
  removeSessionTab: (input: Omit<SessionTab, "type">) => void
  removeSessions: (chatIds: string[]) => void
  /** 新建会话成功后用 session tab 替换对应的 draft tab（/chat/new 流程，避免残留「新会话」标签）。 */
  replaceDraft: (draftID: string, chatId: string) => void
  rememberSessionInfo: (tab: SessionTab, session: Pick<AppSession, "title" | "directory">) => void
  select: (tab: Tab) => void
  remember: (tab: Tab) => void
  toggleHome: (input: { home: boolean; current?: Tab }) => void
}

function createTabsStore(): TabsStore {
  const navigate = useNavigate()
  const location = useLocation()

  const [store, setStore] = createStore<Tab[]>(loadJson<Tab[]>("peyt.tabs", []))
  const [info, setInfo] = createStore<Record<string, TabInfo>>(loadJson("peyt.tabs.info", {}))
  const [recentKey, setRecentKeyState] = createStore<{ key?: string }>(
    loadJson("peyt.tabs.recent", {}),
  )
  const [closed, setClosed] = createStore<{ tab: Tab; index: number }[]>(loadJson("peyt.tabs.closed", []))

  const persistTabs = () => persist("peyt.tabs", store)
  const persistInfo = () => persist("peyt.tabs.info", info)
  const persistRecent = () => persist("peyt.tabs.recent", recentKey)
  const persistClosed = () => persist("peyt.tabs.closed", closed)

  const setRecentKey = (key: string | undefined) => {
    setRecentKeyState("key", key)
    persistRecent()
  }

  const navigateTab = (tab: Tab) => {
    const href = tabHref(tab)
    setRecentKey(tabKey(tab))
    navigate(href)
  }

  const removeTab = (index: number) => {
    const tab = store[index]
    if (!tab) return
    const key = tabKey(tab)
    // 仅当关闭的是当前激活标签时才导航（对齐 opencode nextTabAfterClose）；
    // 后台标签关闭不改变路由。已回到 /home 时也跳过导航。
    const active = recentKey.key === key && location.pathname !== "/home"
    const nextTab = nextTabAfterClose(store, index, active)
    // 先导航再改 store：titlebar 的 auto-add effect 会在 store 变化时同步重跑，
    // 若 route 仍指向该 session，会把刚关闭的 tab 又加回来。
    if (nextTab === null) {
      navigate("/home")
    } else if (nextTab) {
      navigateTab(nextTab)
    }
    // 用纯函数 setter（返回新数组），不要用 produce 就地变异：
    // produce 的 in-place splice 在本环境（solid 1.9.14 + vite 预构建）不触发 store 更新。
    setStore((tabs) => tabs.filter((_, i) => i !== index))
    persistTabs()
    setInfo((draft) => {
      const next = { ...draft }
      delete next[key]
      return next
    })
    persistInfo()
    if (recentKey.key === key) setRecentKey(undefined)
  }

  const addSessionTab = (tab: Omit<SessionTab, "type">): SessionTab => {
    const next: SessionTab = { type: "session", ...tab }
    const existing = store.find((item) => tabKey(item) === tabKey(next))
    if (existing) return existing as SessionTab
    setStore((tabs) =>
      tabs.some((item) => tabKey(item) === tabKey(next)) ? tabs : [...tabs, next],
    )
    persistTabs()
    return next
  }

  const actions: TabsStore = {
    store,
    info,
    ready: () => true,
    addSessionTab,
    reorder(keys: string[]) {
      setStore((tabs) => {
        const byKey = new Map(tabs.map((tab) => [tabKey(tab), tab]))
        const next = keys.map((key) => byKey.get(key)).filter((tab): tab is Tab => !!tab)
        if (next.length !== tabs.length) return tabs
        return next
      })
      persistTabs()
    },
    async newDraft(draft) {
      const draftID = `draft-${Date.now().toString(36)}-${(draftCounter++).toString(36)}`
      const tab: DraftTab = { type: "draft", draftID, ...draft }
      setStore((tabs) => [...tabs, tab])
      persistTabs()
      navigate(draftHref(draftID))
      return tab
    },
    removeTab,
    closeTab(index: number) {
      const tab = store[index]
      if (!tab) return
      if (tab.type === "session") {
        setClosed((stack) => [...stack, { tab, index }].slice(-20))
        persistClosed()
      }
      markTabRemoved(tabKey(tab))
      removeTab(index)
    },
    reopenClosedTab() {
      const entry = closed[closed.length - 1]
      if (!entry) return
      markTabRemoved(tabKey(entry.tab))
      setClosed((stack) => stack.slice(0, -1))
      persistClosed()
      const index = Math.min(entry.index, store.length)
      setStore((tabs) => {
        if (tabs.some((item) => tabKey(item) === tabKey(entry.tab))) return tabs
        return [...tabs.slice(0, index), entry.tab, ...tabs.slice(index)]
      })
      persistTabs()
      navigateTab(entry.tab)
    },
    removeSessionTab(input) {
      const index = store.findIndex(
        (tab) => tab.type === "session" && tab.chatId === input.chatId,
      )
      if (index !== -1) {
        markTabRemoved(tabKey(store[index]))
        removeTab(index)
      }
    },
    replaceDraft(draftID, chatId) {
      const draftKey = tabKey({ type: "draft", draftID })
      const index = store.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
      // 先补 session tab（幂等：titlebar 的 auto-add effect 也会补，此处保证替换后仍在）
      const session = addSessionTab({ chatId })
      if (index === -1) return
      markTabRemoved(draftKey)
      setStore((tabs) => tabs.filter((_, i) => i !== index))
      persistTabs()
      setInfo((draft) => {
        const next = { ...draft }
        delete next[draftKey]
        return next
      })
      persistInfo()
      if (recentKey.key === draftKey) setRecentKey(tabKey(session))
    },
    removeSessions(chatIds: string[]) {
      const removed = store
        .filter((tab) => tab.type === "session" && chatIds.includes(tab.chatId))
        .map(tabKey)
      if (removed.length === 0) return
      for (const key of removed) markTabRemoved(key)
      const ids = new Set(chatIds)
      const removedCurrent = removed.some((key) => key === recentKey.key)
      setStore((tabs) => tabs.filter((tab) => tab.type !== "session" || !ids.has(tab.chatId)))
      persistTabs()
      for (const key of removed) {
        setInfo((draft) => {
          const next = { ...draft }
          delete next[key]
          return next
        })
      }
      persistInfo()
      if (recentKey.key && removed.includes(recentKey.key)) setRecentKey(undefined)
      if (removedCurrent) navigate("/home")
    },
    rememberSessionInfo(tab, session) {
      const key = tabKey(tab)
      const next = { title: session.title, directory: session.directory }
      const current = info[key]
      if (current?.title === next.title && current.directory === next.directory) return
      setInfo(key, next)
      persistInfo()
    },
    select: navigateTab,
    remember(tab) {
      const key = tabKey(tab)
      if (recentKey.key !== key) setRecentKey(key)
    },
    toggleHome(input) {
      if (input.home) {
        const tab = store.find((tab) => tabKey(tab) === recentKey.key)
        if (tab) navigateTab(tab)
        return
      }
      if (input.current) {
        setRecentKey(tabKey(input.current))
        navigate("/home")
        return
      }
      navigate("/home")
    },
  }

  return actions
}

export const { use: useTabs, provider: TabsProvider } = createSimpleContext<TabsStore, Record<string, any>>({
  name: "Tabs",
  gate: false,
  init: () => createTabsStore(),
})
