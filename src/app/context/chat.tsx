// src/app/context/chat.tsx
// ChatStore：IM 聊天会话数据源（Task 3 接入真实数据）。
// - 会话列表/未读：get_chatlist invoke + Tauri 事件（ChatlistItemChanged/ChatModified/MsgsChanged…）
// - 消息：get_chat_msgs（分页 beforeMsgId）+ 发送（send_text/send_reply/send_attachment/send_voice）
// - 反应/置顶/已读：send_reaction/toggle_pin/get_msg_read_counts
// - 拉取失败时保留 Task 1 假数据兜底

import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AppSession } from "../types"
import { makeFakeChats, makeFakeInfo, makeFakeMessages, makeFakeMembers } from "../data/fake"
import { call, onEvent } from "../../api"
import type {
  ChannelDto,
  ChatInfoDto,
  ChatListItem,
  MemberDto,
  MsgDto,
  RoleDto,
  SelfProfile,
  WorkspaceDto,
} from "@/types"

/** 乐观临时消息扩展（legacy composer 同款：msg_id 可为字符串 tmp_ 前缀）。 */
export type RenderableMsg = Omit<MsgDto, "msg_id"> & {
  msg_id: number | string
  is_out?: boolean
  _state?: "sending" | "failed"
}

export interface ReactionDto {
  emoji: string
  count: number
  senders: number[]
}

interface ChatStore {
  currentChatId: () => string | null
  setCurrentChat: (id: string | null) => void
  session: (id: string) => AppSession | undefined
  chatList: () => AppSession[]
  unreadFor: (id: string) => number
  rename: (id: string, title: string) => void
  archive: (id: string) => void
  markRead: (id: string) => void
  touch: (id: string) => void

  // 会话级数据（invoke + 事件）
  ensureLoaded: (chatId: string) => Promise<void>
  reloadMessages: (chatId: string) => Promise<void>
  loadOlder: (chatId: string) => Promise<boolean>
  hasMore: (chatId: string) => boolean
  messages: (chatId: string) => RenderableMsg[]
  unreadSnapshot: (chatId: string) => number
  members: (chatId: string) => MemberDto[]
  isGroup: (chatId: string) => boolean
  chatInfo: (chatId: string) => ChatInfoDto | undefined
  pinnedIds: (chatId: string) => number[]
  roles: () => RoleDto[]
  self: () => SelfProfile | null
  readCountFor: (msgId: string) => number
  reactionsFor: (chatId: string, msgId: string) => ReactionDto[]
  workspaceIdFor: (chatId: string) => number | null

  // 动作
  sendText: (chatId: string, text: string, opts?: { markdown?: boolean; quoteMsgId?: number }) => Promise<void>
  sendAttachment: (chatId: string, file: File) => Promise<void>
  sendVoice: (chatId: string, blob: Blob) => Promise<void>
  sendReaction: (chatId: string, msgId: number, emoji: string) => Promise<void>
  togglePin: (chatId: string, msgId: number) => Promise<void>
  getDraft: (chatId: string) => Promise<string | null>
  setDraft: (chatId: string, text: string) => Promise<void>
}

function blobToBase64(blob: Blob): Promise<string> {  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf)
    let binary = ""
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
  })
}

function createChatStore(): ChatStore {
  const [state, setState] = createStore({
    currentChatId: null as string | null,
    sessions: makeFakeChats() as AppSession[],
    // chatId(数字串) → 工作区 key（由 list_workspaces + list_channels 反查）
    directoryByChat: {} as Record<string, string>,
    isGroupMap: {} as Record<string, boolean>,
    membersMap: {} as Record<string, MemberDto[]>,
    infoMap: {} as Record<string, ChatInfoDto>,
    pinnedMap: {} as Record<string, number[]>,
    messagesByChat: {} as Record<string, RenderableMsg[]>,
    loadedChats: {} as Record<string, boolean>,
    oldestByChat: {} as Record<string, number | null>,
    noMoreByChat: {} as Record<string, boolean>,
    unreadAtOpen: {} as Record<string, number>,
    roles: [] as RoleDto[],
    self: null as SelfProfile | null,
    readCounts: {} as Record<string, number>,
    reactions: {} as Record<string, ReactionDto[]>,
    chatlistFresh: false,
  })

  const byId = createMemo(() => {
    const map = new Map<string, AppSession>()
    for (const s of state.sessions) map.set(s.id, s)
    return map
  })

  const unreadFor = (id: string) => byId().get(id)?.unread ?? 0

  // ── 会话列表 ──────────────────────────────────────────

  async function refreshChatlist(): Promise<void> {
    try {
      const list = await call<ChatListItem[]>("get_chatlist")
      const sessions = list
        .filter((c) => !c.is_archived)
        .map((c) => {
          const id = String(c.chat_id)
          return {
            id,
            title: c.name || `#${c.chat_id}`,
            directory: state.directoryByChat[id] ?? "",
            time: {
              created: (c.last_ts ?? 0) * 1000,
              updated: (c.last_ts ?? 0) * 1000,
            },
            unread: c.unread,
            working: false,
          } as AppSession
        })
      setState("sessions", sessions)
      // 会话列表加载成功 → 已接入真实数据，未读计数同步
      setState("chatlistFresh", true)
    } catch {
      // invoke 不可用（纯浏览器 dev）→ 保留假数据
    }
  }

  // 会话 → 工作区映射：list_workspaces + 每个工作区 list_channels
  async function refreshDirectories(): Promise<void> {
    try {
      const workspaces = await call<WorkspaceDto[]>("list_workspaces")
      const dirByChat: Record<string, string> = {}
      for (const ws of workspaces) {
        const key = `ws-${ws.id}`
        try {
          const channels = await call<ChannelDto[]>("list_channels", { workspaceId: ws.id })
          for (const ch of channels) dirByChat[String(ch.chat_id)] = key
        } catch {
          /* 单个工作区失败不影响其余 */
        }
      }
      setState("directoryByChat", dirByChat)
      // 映射就绪后重映射已有会话
      setState("sessions", (sessions) =>
        sessions.map((s) => ({ ...s, directory: dirByChat[s.id] ?? s.directory })),
      )
    } catch {
      /* 浏览器 dev 无 invoke → 保留假数据 */
    }
  }

  // ── 消息 ──────────────────────────────────────────────

  async function ensureLoaded(chatId: string): Promise<void> {
    if (state.loadedChats[chatId]) {
      void refreshChatInfo(chatId)
      return
    }
    setState("loadedChats", chatId, true)
    setState("unreadAtOpen", chatId, unreadFor(chatId))
    await Promise.all([
      loadMessages(chatId, true),
      refreshChatInfo(chatId),
      refreshPins(chatId),
      refreshRoles(chatId),
    ])
    // 打开即已读：清本地未读 + 通知后端（mark_chat_seen 会向对方发已读回执）
    try {
      await call("mark_chat_seen", { chatId: Number(chatId) })
      setState("sessions", (sessions) =>
        sessions.map((s) => (s.id === chatId ? { ...s, unread: 0 } : s)),
      )
    } catch {
      /* 静默 */
    }
  }

  async function loadMessages(chatId: string, fresh: boolean): Promise<void> {
    try {
      const msgs = await call<MsgDto[]>("get_chat_msgs", { chatId: Number(chatId), beforeMsgId: null })
      const next = msgs as RenderableMsg[]
      if (fresh) {
        setState("messagesByChat", chatId, next)
      } else {
        // 增量合并：保留已加载的（含更早分页），追加新消息，去重，清除乐观 tmp
        const existing = state.messagesByChat[chatId] ?? []
        const existingIds = new Set(existing.map((m) => String(m.msg_id)))
        const newMsgs = next.filter((m) => !existingIds.has(String(m.msg_id)))
        if (newMsgs.length > 0) {
          const deduped = [
            ...existing.filter((m) => typeof m.msg_id !== "string" || !String(m.msg_id).startsWith("tmp_")),
            ...newMsgs,
          ]
          setState("messagesByChat", chatId, deduped)
        }
      }
      const oldest = (state.messagesByChat[chatId] ?? []).find(
        (m) => typeof m.msg_id === "number",
      )
      setState("oldestByChat", chatId, oldest ? Number(oldest.msg_id) : null)
      setState("noMoreByChat", chatId, next.length < 50)
      await loadReadCounts(chatId)
      await loadReactions(chatId)
    } catch {
      // invoke 不可用（浏览器 dev）→ 假会话用假消息兜底，保证 timeline 可预览
      if (!state.chatlistFresh) {
        const session = byId().get(chatId)
        if (session) {
          setState("messagesByChat", chatId, makeFakeMessages(chatId) as RenderableMsg[])
          setState("oldestByChat", chatId, Number(chatId) * 1000)
          setState("noMoreByChat", chatId, true)
          if (!state.infoMap[chatId]) {
            setState("infoMap", chatId, makeFakeInfo(chatId, session.title))
            setState("membersMap", chatId, makeFakeMembers())
            setState("isGroupMap", chatId, true)
          }
        }
      }
    }
  }

  async function reloadMessages(chatId: string): Promise<void> {
    if (!state.loadedChats[chatId]) return
    await loadMessages(chatId, false)
  }

  async function loadOlder(chatId: string): Promise<boolean> {
    const before = state.oldestByChat[chatId]
    if (before == null || state.noMoreByChat[chatId]) return false
    try {
      const older = await call<MsgDto[]>("get_chat_msgs", { chatId: Number(chatId), beforeMsgId: before })
      if (older.length === 0) {
        setState("noMoreByChat", chatId, true)
        return false
      }
      const existing = state.messagesByChat[chatId] ?? []
      const existingIds = new Set(existing.map((m) => String(m.msg_id)))
      const added = older.filter((m) => !existingIds.has(String(m.msg_id)))
      setState("messagesByChat", chatId, [...added, ...existing])
      setState("oldestByChat", chatId, Number(older[0].msg_id))
      setState("noMoreByChat", chatId, older.length < 50)
      await loadReadCounts(chatId)
      return added.length > 0
    } catch {
      return false
    }
  }

  async function refreshChatInfo(chatId: string): Promise<void> {
    try {
      const info = await call<ChatInfoDto>("get_chat_info", { chatId: Number(chatId) })
      setState("infoMap", chatId, info)
      setState("membersMap", chatId, info.members ?? [])
      setState("isGroupMap", chatId, info.is_group)
    } catch {
      /* 静默 */
    }
  }

  async function refreshPins(chatId: string): Promise<void> {
    try {
      const pins = await call<Array<{ msg_id: number }>>("get_channel_pins", { chatId: Number(chatId) })
      setState("pinnedMap", chatId, pins.map((p) => Number(p.msg_id)))
    } catch {
      setState("pinnedMap", chatId, [])
    }
  }

  async function refreshRoles(chatId: string): Promise<void> {
    const wsId = workspaceIdFor(chatId)
    if (wsId == null) return
    try {
      const roles = await call<RoleDto[]>("list_roles", { workspaceId: wsId })
      setState("roles", roles)
    } catch {
      /* 静默 */
    }
  }

  async function loadReadCounts(chatId: string): Promise<void> {
    const msgs = state.messagesByChat[chatId] ?? []
    const ids = msgs.filter((m) => m.is_out && typeof m.msg_id === "number").map((m) => Number(m.msg_id))
    if (ids.length === 0) return
    try {
      const counts = await call<number[]>("get_msg_read_counts", { msgIds: ids })
      setState("readCounts", (draft) => {
        const next = { ...draft }
        ids.forEach((id, i) => {
          next[String(id)] = counts[i] ?? 0
        })
        return next
      })
    } catch {
      /* 静默 */
    }
  }

  async function loadReactions(chatId: string): Promise<void> {
    const msgs = state.messagesByChat[chatId] ?? []
    const ids = msgs
      .filter((m) => typeof m.msg_id === "number")
      .map((m) => Number(m.msg_id))
    for (const id of ids) {
      try {
        const reactions = await call<ReactionDto[]>("get_reactions", { msgId: id })
        setState("reactions", `${chatId}:${id}`, reactions)
      } catch {
        /* 静默 */
      }
    }
  }

  // ── 发送 ──────────────────────────────────────────────

  async function sendText(
    chatId: string,
    text: string,
    opts?: { markdown?: boolean; quoteMsgId?: number },
  ): Promise<void> {
    const mdOn = opts?.markdown ?? localStorage.getItem("peyt.md.enabled") !== "0"
    const self = state.self
    const quoteMsgId = opts?.quoteMsgId
    let quoteFrom: string | null = null
    let quoteText: string | null = null
    if (quoteMsgId != null) {
      const quoted = state.messagesByChat[chatId]?.find((m) => m.msg_id === quoteMsgId)
      if (quoted) {
        quoteFrom = quoted.from_name
        quoteText = quoted.text
      }
    }
    const tmp: RenderableMsg = {
      msg_id: `tmp_${Date.now()}`,
      chat_id: Number(chatId),
      from_id: self?.id ?? 0,
      from_name: self?.name ?? "我",
      from_avatar: self?.avatar ?? null,
      from_color: self?.color ?? null,
      text: mdOn ? JSON.stringify({ type: "text", id: `tmp_${Date.now()}`, payload: { text, markdown: true } }) : text,
      ts: Math.floor(Date.now() / 1000),
      state: "pending",
      view_type: "Text",
      file: null,
      file_mime: null,
      file_name: null,
      file_bytes: null,
      quote_text: quoteText,
      quote_from: quoteFrom,
      quote_msg_id: quoteMsgId ?? null,
      quote_from_id: null,
      reactions: null,
      is_info: false,
      is_out: true,
      _state: "sending",
    }
    pushTmpMessage(chatId, tmp)
    try {
      if (quoteMsgId != null) {
        await call("send_reply", { chatId: Number(chatId), text, quoteMsgId, markdown: mdOn })
      } else {
        await call("send_text", { chatId: Number(chatId), text, markdown: mdOn })
      }
    } catch (e) {
      markTmpFailed(chatId, String(tmp.msg_id))
      throw e
    }
  }

  async function sendAttachment(chatId: string, file: File): Promise<void> {
    const self = state.self
    const blobUrl = URL.createObjectURL(file)
    const viewType = file.type.startsWith("image/")
      ? "Image"
      : file.type.startsWith("audio/")
        ? "Audio"
        : file.type.startsWith("video/")
          ? "Video"
          : "File"
    const tmp: RenderableMsg = {
      msg_id: `tmp_att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      chat_id: Number(chatId),
      from_id: self?.id ?? 0,
      from_name: self?.name ?? "我",
      from_avatar: self?.avatar ?? null,
      from_color: self?.color ?? null,
      text: file.name,
      ts: Math.floor(Date.now() / 1000),
      state: "pending",
      view_type: viewType,
      file: blobUrl,
      file_mime: file.type,
      file_name: file.name,
      file_bytes: file.size,
      quote_text: null,
      quote_from: null,
      quote_msg_id: null,
      quote_from_id: null,
      reactions: null,
      is_info: false,
      is_out: true,
      _state: "sending",
    }
    pushTmpMessage(chatId, tmp)
    try {
      const base64 = await blobToBase64(file)
      await call("send_attachment", { chatId: Number(chatId), base64, filename: file.name, mime: file.type })
    } catch (e) {
      markTmpFailed(chatId, String(tmp.msg_id))
      URL.revokeObjectURL(blobUrl)
      throw e
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }

  async function sendVoice(chatId: string, blob: Blob): Promise<void> {
    const self = state.self
    const blobUrl = URL.createObjectURL(blob)
    const tmp: RenderableMsg = {
      msg_id: `tmp_voice_${Date.now()}`,
      chat_id: Number(chatId),
      from_id: self?.id ?? 0,
      from_name: self?.name ?? "我",
      from_avatar: self?.avatar ?? null,
      from_color: self?.color ?? null,
      text: "语音消息",
      ts: Math.floor(Date.now() / 1000),
      state: "pending",
      view_type: "Voice",
      file: blobUrl,
      file_mime: "audio/webm",
      file_name: "voice.webm",
      file_bytes: blob.size,
      quote_text: null,
      quote_from: null,
      quote_msg_id: null,
      quote_from_id: null,
      reactions: null,
      is_info: false,
      is_out: true,
      _state: "sending",
    }
    pushTmpMessage(chatId, tmp)
    try {
      const base64 = await blobToBase64(blob)
      await call("send_voice", { chatId: Number(chatId), base64 })
    } catch (e) {
      markTmpFailed(chatId, String(tmp.msg_id))
      URL.revokeObjectURL(blobUrl)
      throw e
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }

  function pushTmpMessage(chatId: string, tmp: RenderableMsg): void {
    setState("messagesByChat", chatId, (msgs) => [...(msgs ?? []), tmp])
  }

  function markTmpFailed(chatId: string, tmpId: string): void {
    setState("messagesByChat", chatId, (msgs) =>
      (msgs ?? []).map((m) => (String(m.msg_id) === tmpId ? { ...m, state: "failed", _state: "failed" } : m)),
    )
  }

  // ── 反应 / 置顶 ───────────────────────────────────────

  async function sendReaction(chatId: string, msgId: number, emoji: string): Promise<void> {
    try {
      await call("send_reaction", { chatId: Number(chatId), msgId, emoji })
      // 乐观更新本地缓存（get_reactions 返回数组）
      const key = `${chatId}:${msgId}`
      const current = state.reactions[key] ?? []
      const existing = current.find((r) => r.emoji === emoji)
      const selfId = state.self?.id ?? 1
      let next: ReactionDto[]
      if (existing && existing.senders.includes(selfId)) {
        next = current
          .map((r) =>
            r.emoji === emoji
              ? { ...r, count: r.count - 1, senders: r.senders.filter((s) => s !== selfId) }
              : r,
          )
          .filter((r) => r.count > 0)
      } else if (existing) {
        next = current.map((r) =>
          r.emoji === emoji ? { ...r, count: r.count + 1, senders: [...r.senders, selfId] } : r,
        )
      } else {
        next = [...current, { emoji, count: 1, senders: [selfId] }]
      }
      setState("reactions", key, next)
    } catch (e) {
      throw e
    }
  }

  async function togglePin(chatId: string, msgId: number): Promise<void> {
    const wsId = workspaceIdFor(chatId)
    if (wsId == null) return
    try {
      await call<boolean>("toggle_pin", {
        workspaceId: wsId,
        chatId: Number(chatId),
        msgId,
      })
      // toggle_pin 返回 bool 表示置顶状态；本地切换与后端保持一致
      const current = state.pinnedMap[chatId] ?? []
      const next = current.includes(msgId)
        ? current.filter((id) => id !== msgId)
        : [...current, msgId]
      setState("pinnedMap", chatId, next)
    } catch {
      /* 置顶失败静默 */
    }
  }

  // ── 草稿 ──────────────────────────────────────────────

  async function getDraft(chatId: string): Promise<string | null> {
    try {
      return await call<string | null>("get_draft", { chatId: Number(chatId) })
    } catch {
      return null
    }
  }

  async function setDraft(chatId: string, text: string): Promise<void> {
    try {
      await call("set_draft", { chatId: Number(chatId), text })
    } catch {
      /* 静默 */
    }
  }

  // ── Tauri 事件订阅 ────────────────────────────────────

  function workspaceIdFor(chatId: string): number | null {
    const dir = state.directoryByChat[chatId] ?? byId().get(chatId)?.directory ?? ""
    const match = /^ws-(\d+)$/.exec(dir)
    return match ? Number(match[1]) : null
  }

  function updateMsgState(msgId: unknown, nextState: string): void {
    const id = String(msgId)
    const chatId = state.currentChatId
    if (!chatId) return
    setState("messagesByChat", chatId, (msgs) =>
      (msgs ?? []).map((m) =>
        String(m.msg_id) === id ? { ...m, state: nextState as RenderableMsg["state"], _state: undefined } : m,
      ),
    )
  }

  function removeMsg(msgId: unknown): void {
    const id = String(msgId)
    const chatId = state.currentChatId
    if (!chatId) return
    setState("messagesByChat", chatId, (msgs) => (msgs ?? []).filter((m) => String(m.msg_id) !== id))
  }

  function subscribeEvents(): void {
    const onMsgEvent = () => {
      const id = state.currentChatId
      if (!id) return
      void reloadMessages(id)
    }
    void onEvent("MsgsChanged", onMsgEvent)
    void onEvent("IncomingMsg", onMsgEvent)
    void onEvent("ChatlistItemChanged", () => {
      void refreshChatlist()
    })
    void onEvent("ChatModified", () => {
      void refreshChatlist()
    })
    void onEvent("MsgDelivered", (e) => updateMsgState(e.msg_id, "delivered"))
    void onEvent("MsgFailed", (e) => updateMsgState(e.msg_id, "failed"))
    void onEvent("MsgDeleted", (e) => removeMsg(e.msg_id))
    void onEvent("MsgRead", (e) => updateMsgState(e.msg_id, "read"))
    void onEvent("ReactionsChanged", (e) => {
      const chatId = state.currentChatId
      if (!chatId || e.msg_id == null) return
      const key = `${chatId}:${e.msg_id}`
      void call<ReactionDto[]>("get_reactions", { msgId: e.msg_id }).then((reactions) =>
        setState("reactions", key, reactions),
      )
    })
    void onEvent("IncomingReaction", (e) => {
      const chatId = state.currentChatId
      if (!chatId || e.msg_id == null) return
      const key = `${chatId}:${e.msg_id}`
      void call<ReactionDto[]>("get_reactions", { msgId: e.msg_id }).then((reactions) =>
        setState("reactions", key, reactions),
      )
    })
    void onEvent("ChatDeleted", () => {
      void refreshChatlist()
    })
  }

  // 初始化：self + 会话列表 + 工作区映射 + 事件订阅
  void (async () => {
    try {
      const self = await call<SelfProfile>("get_self_profile")
      setState("self", self)
    } catch {
      /* 静默 */
    }
    await Promise.all([refreshChatlist(), refreshDirectories()])
    subscribeEvents()
  })()

  return {
    currentChatId: () => state.currentChatId,
    setCurrentChat: (id) => setState("currentChatId", id),
    session: (id: string) => byId().get(id),
    chatList: createMemo(() =>
      [...state.sessions]
        .filter((chat) => !chat.archived)
        .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
    ),
    unreadFor,
    rename(id: string, title: string) {
      setState("sessions", (s) => s.map((item) => (item.id === id ? { ...item, title } : item)))
    },
    archive(id: string) {
      setState("sessions", (s) => s.map((item) => (item.id === id ? { ...item, archived: true } : item)))
      // TODO(Task 3): 后端归档命令（get_chatlist archived_only 存在，写命令待接入）
    },
    markRead(id: string) {
      setState("sessions", (s) => s.map((item) => (item.id === id ? { ...item, unread: 0 } : item)))
    },
    touch(id: string) {
      setState("sessions", (s) =>
        s.map((item) =>
          item.id === id ? { ...item, time: { ...item.time, updated: Date.now() } } : item,
        ),
      )
    },

    ensureLoaded,
    reloadMessages,
    loadOlder,
    hasMore: (chatId: string) => !state.noMoreByChat[chatId] && state.oldestByChat[chatId] != null,
    messages: (chatId: string) => state.messagesByChat[chatId] ?? [],
    unreadSnapshot: (chatId: string) => state.unreadAtOpen[chatId] ?? 0,
    members: (chatId: string) => state.membersMap[chatId] ?? [],
    isGroup: (chatId: string) => state.isGroupMap[chatId] ?? false,
    chatInfo: (chatId: string) => state.infoMap[chatId],
    pinnedIds: (chatId: string) => state.pinnedMap[chatId] ?? [],
    roles: () => state.roles,
    self: () => state.self,
    readCountFor: (msgId: string) => state.readCounts[msgId] ?? 0,
    reactionsFor: (chatId: string, msgId: string) => state.reactions[`${chatId}:${msgId}`] ?? [],
    workspaceIdFor,

    sendText,
    sendAttachment,
    sendVoice,
    sendReaction,
    togglePin,
    getDraft,
    setDraft,
  }
}

export const { use: useChat, provider: ChatProvider } = createSimpleContext<ChatStore, Record<string, any>>({
  name: "Chat",
  gate: false,
  init: () => createChatStore(),
})
