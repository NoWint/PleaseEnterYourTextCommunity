// src/app/pages/chat/session-composer-controls.ts
// 照抄 opencode pages/session/composer/session-composer-controls.ts 改造：
// - AI 能力（模型选择/agents/providers/文件引用）删除
// - 替换为 IM 能力：发送（文本/回复/附件/语音）、@提及建议、草稿、表情、bot 占位选择器
// 状态全部本地（chat context 负责 IPC 与消息列表）。

import { createMemo, createSignal, type Accessor } from "solid-js"
import { useChat } from "../../context/chat"
import { showToast } from "../../utils/toast"
import type { MemberDto } from "@/types"

export interface SessionComposerControls {
  text: Accessor<string>
  setText: (text: string) => void
  canSend: Accessor<boolean>
  send: () => Promise<void>
  replyTo: Accessor<number | null>
  replyMessage: Accessor<{ from_name: string; text: string } | null>
  setReply: (msgId: number) => void
  cancelReply: () => void
  emojiOpen: Accessor<boolean>
  toggleEmoji: () => void
  insertEmoji: (emoji: string) => void
  attach: (file: File) => Promise<void>
  voiceRecording: Accessor<boolean>
  voiceElapsed: Accessor<string>
  toggleVoice: () => Promise<void>
  mention: {
    open: Accessor<boolean>
    items: Accessor<MemberDto[]>
    selectedIndex: Accessor<number>
    move: (delta: number) => void
    insert: () => void
    close: () => void
  }
  updateMention: (value: string, selectionStart: number) => void
  insertMention: (name: string) => void
  cursorPosition: Accessor<number>
}

export function createSessionComposerControls(input: {
  chatId: Accessor<string | null>
  onSent: () => void
}) {
  const chat = useChat()
  const [text, setText] = createSignal("")
  const [replyTo, setReplyTo] = createSignal<number | null>(null)
  const [emojiOpen, setEmojiOpen] = createSignal(false)
  const [voiceRecording, setVoiceRecording] = createSignal(false)
  const [voiceElapsed, setVoiceElapsed] = createSignal("")
  const [mentionQueryStart, setMentionQueryStart] = createSignal(-1)
  const [mentionItems, setMentionItems] = createSignal<MemberDto[]>([])
  const [mentionSelected, setMentionSelected] = createSignal(0)
  // 输入框真实光标位置（onInput 时更新；@提及插入用它，避免丢光标后的文本）
  const [cursor, setCursor] = createSignal(0)

  const chatId = input.chatId
  const canSend = createMemo(() => text().trim().length > 0)
  const members = createMemo(() => {
    const id = chatId()
    if (!id) return []
    return chat.members(id)
  })

  const replyMessage = createMemo(() => {
    const id = chatId()
    const msgId = replyTo()
    if (!id || msgId == null) return null
    const msg = chat.messages(id).find((m) => m.msg_id === msgId)
    if (!msg) return null
    return { from_name: msg.from_name || "未知", text: msg.text || "" }
  })

  // @提及检测：光标前 @xxx
  const updateMention = (value: string, selectionStart: number) => {
    setCursor(selectionStart)
    const beforeCursor = value.slice(0, selectionStart)
    const atMatch = beforeCursor.match(/@(\w*)$/)
    if (atMatch) {
      const query = atMatch[1].toLowerCase()
      const hits = members().filter((m) => m.name.toLowerCase().includes(query))
      if (hits.length > 0) {
        setMentionQueryStart(selectionStart - atMatch[0].length)
        setMentionItems(hits)
        setMentionSelected(0)
        return
      }
    }
    setMentionQueryStart(-1)
    setMentionItems([])
  }

  const insertMention = (name: string) => {
    const start = mentionQueryStart()
    if (start < 0) return
    const current = text()
    const end = Math.max(start, cursor())
    const next = current.slice(0, start) + `@${name} ` + current.slice(end)
    setText(next)
    setCursor((start + name.length + 2))
    setMentionQueryStart(-1)
    setMentionItems([])
  }

  let recorder: MediaRecorder | null = null
  let recorderChunks: Blob[] = []
  let recorderTimer: ReturnType<typeof setInterval> | undefined
  let recorderStart = 0

  const formatRecordTime = (ms: number) => {
    const totalSec = Math.floor(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}:${String(s).padStart(2, "0")}`
  }

  return {
    text,
    setText: (value: string) => {
      setText(value)
      setCursor(value.length)
      // TODO(Task 3): 草稿防抖（set_draft），见 session-composer-region 的 onInput 处理
    },
    canSend,
    send: async () => {
      const id = chatId()
      const value = text().trim()
      if (!id || !value) return
      const mdOn = localStorage.getItem("peyt.md.enabled") !== "0"
      setText("")
      setCursor(0)
      setMentionQueryStart(-1)
      setMentionItems([])
      const quote = replyTo()
      try {
        await chat.sendText(id, value, { markdown: mdOn, quoteMsgId: quote ?? undefined })
      } catch (e) {
        showToast({ title: "发送失败", description: e instanceof Error ? e.message : String(e) })
      } finally {
        if (quote != null) setReplyTo(null)
      }
      input.onSent()
    },
    replyTo,
    replyMessage,
    setReply: (msgId: number) => setReplyTo(msgId),
    cancelReply: () => setReplyTo(null),
    emojiOpen,
    toggleEmoji: () => setEmojiOpen((v) => !v),
    insertEmoji: (emoji: string) => {
      setText((v) => {
        const next = v + emoji
        setCursor(next.length)
        return next
      })
      setEmojiOpen(false)
    },
    attach: async (file: File) => {
      const id = chatId()
      if (!id) return
      try {
        await chat.sendAttachment(id, file)
      } finally {
        input.onSent()
      }
    },
    voiceRecording,
    voiceElapsed,
    toggleVoice: async () => {
      const id = chatId()
      if (!id) return
      if (recorder) {
        recorder.onstop = () => {
          const blob = new Blob(recorderChunks, { type: recorder?.mimeType || "audio/webm" })
          void chat
            .sendVoice(id, blob)
            .then(input.onSent)
            .catch((e) => {
              showToast({ title: "发送语音失败", description: e instanceof Error ? e.message : String(e) })
            })
        }
        recorder.stop()
        return
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (e) {
        // TODO(Task 3): toast 提示
        console.warn("无法访问麦克风", e)
        return
      }
      let mediaRecorder: MediaRecorder
      try {
        mediaRecorder = new MediaRecorder(stream)
      } catch {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      recorderChunks = []
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recorderChunks.push(e.data)
      }
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        recorder = null
        setVoiceRecording(false)
        if (recorderTimer !== undefined) clearInterval(recorderTimer)
        setVoiceElapsed("")
      }
      mediaRecorder.start()
      recorder = mediaRecorder
      recorderStart = Date.now()
      setVoiceRecording(true)
      recorderTimer = setInterval(() => setVoiceElapsed(formatRecordTime(Date.now() - recorderStart)), 1000)
    },
    mention: {
      open: createMemo(() => mentionItems().length > 0),
      items: mentionItems,
      selectedIndex: mentionSelected,
      move: (delta: number) => {
        const items = mentionItems()
        if (items.length === 0) return
        setMentionSelected((i) => (i + delta + items.length) % items.length)
      },
      insert: () => {
        const item = mentionItems()[mentionSelected()]
        if (item) insertMention(item.name)
      },
      close: () => {
        setMentionQueryStart(-1)
        setMentionItems([])
      },
    },
    cursorPosition: cursor,
    updateMention,
    insertMention,
  }
}

export type SessionComposerControlsStore = ReturnType<typeof createSessionComposerControls>
