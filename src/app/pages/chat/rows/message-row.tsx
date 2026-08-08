// src/app/pages/chat/rows/message-row.tsx
// IM 消息气泡行（从 legacy src/chat/message.ts renderMessage 迁移为 Solid 组件）：
// 头像/名字/角色 tag/回复标记、引用块、正文（hljs 代码高亮 + @mention + 链接）、
// 附件（图片/文件/语音/音视频）、反应条、footer（时间+发送状态+重发）、
// hover 操作栏（反应/回复/置顶/更多）+ 右键菜单。

import { createMemo, createResource, For, Match, Show, Switch, type Component } from "solid-js"
import { createSignal } from "solid-js"
import { useChat } from "../../../context/chat"
import { usePlatform } from "../../../platform"
import { call, transformBlobURL } from "../../../../api"
import { showToast } from "../../../utils/toast"
import type { GroupRole } from "../rows"
import type { RenderableMsg } from "../../../context/chat"
import {
  colorHex,
  formatBytes,
  formatTs,
  msgMarkdown,
  msgThemeStyle,
  quoteHtml,
  renderMessageText,
  stateLabel,
} from "../chat-text"
import { ChatIcon } from "../chat-icons"
import { MessageReactions } from "./message-reactions"
import { MessageAttachment } from "./message-attachment"

interface MessageRowProps {
  message: RenderableMsg
  groupRole: GroupRole
  onSizeChange?: () => void
  onReply: (msgId: number) => void
  onJumpToMessage: (msgId: number) => void
}

export const reactionQuick: string[] = ["👍", "❤️", "😂", "😮", "😢", "😭", "🔥"]
export const reactionPanel: string[] = [
  "👍", "❤️", "😂", "😮", "😢", "😭", "🔥", "🎉",
  "👏", "🙏", "💯", "✨", "😍", "🤔", "😴", "🤯",
  "😅", "🥳", "😎", "🥺", "😤", "🤝", "💪", "👀",
  "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿",
  "❤️‍🔥", "💖", "💔", "✅", "❌", "⚠️", "❗", "❓",
  "⭐", "🌟", "☀️", "🌙", "☕", "🍻", "🎁", "🏆",
]

const ContextMenu: Component<{
  x: number
  y: number
  message: RenderableMsg
  isOut: boolean
  pinned: boolean
  onClose: () => void
  onReply: () => void
  onTogglePin: () => void
  onJumpToMessage: (msgId: number) => void
}> = (props) => {
  const item = (label: string, danger: boolean, onClick: () => void) => (
    <button
      type="button"
      class="w-full text-left px-2.5 py-1.5 rounded-md text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover transition-colors"
      classList={{ "text-v2-danger-danger-base": danger }}
      onClick={() => {
        props.onClose()
        onClick()
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      class="fixed z-[90] min-w-[160px] rounded-[10px] border border-v2-border-border-weaker-base bg-v2-background-bg-layer-02 p-1 shadow-[var(--v2-elevation-floating)]"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      {item("复制文本", false, () => {
        void navigator.clipboard?.writeText(props.message.text).then(
          () => showToast({ title: "已复制" }),
          () => showToast({ title: "复制失败" }),
        )
      })}
      {item("回复", false, props.onReply)}
      {item(props.pinned ? "取消置顶" : "置顶", false, props.onTogglePin)}
      <Show when={props.message.quote_msg_id}>
        {item("跳转引用原文", false, () => {
          if (props.message.quote_msg_id != null) props.onJumpToMessage(props.message.quote_msg_id)
        })}
      </Show>
      <Show when={props.isOut}>
        <div class="my-1 h-px bg-v2-border-border-weaker-base" />
        {item("删除", true, () => {
          const msgId = props.message.msg_id
          try {
            void call("delete_msg", { msgId })
            showToast({ title: "已删除" })
          } catch (e) {
            showToast({ title: "删除失败", description: e instanceof Error ? e.message : String(e) })
          }
        })}
      </Show>
    </div>
  )
}

export const MessageRow: Component<MessageRowProps> = (props) => {
  const chat = useChat()
  const platform = usePlatform()
  const message = () => props.message
  const isOut = createMemo(() => message().is_out ?? false)
  const chatId = () => chat.currentChatId()
  const isGroup = createMemo(() => chat.isGroup(chatId() ?? ""))
  const members = createMemo(() => chat.members(chatId() ?? ""))
  const selfName = createMemo(() => chat.self()?.name ?? "我")
  const roleNames = createMemo(() => chat.roles().map((r) => r.name).filter(Boolean))
  const readCount = createMemo(() => chat.readCountFor(String(message().msg_id)))
  const collapsed = () => props.groupRole === "middle" || props.groupRole === "last"

  const member = createMemo(() => members().find((mm) => mm.contact_id === message().from_id))
  const avatarPath = createMemo(() => member()?.avatar ?? message().from_avatar ?? null)
  const [avatarUrl] = createResource(avatarPath, (path) => (path ? transformBlobURL(path) : Promise.resolve("")))
  const avatarColor = createMemo(() => colorHex(message().from_color ?? member()?.color))
  const letter = createMemo(() => (message().from_name || "?").charAt(0).toUpperCase() || "?")

  const theme = createMemo(() => msgThemeStyle(message().text))
  const md = createMemo(() => msgMarkdown(message().text))
  const textHtml = createMemo(() =>
    renderMessageText(message().text, { selfName: selfName(), roleNames: roleNames(), markdown: md() }),
  )
  const quote = createMemo(() => quoteHtml(message().quote_text))

  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null)
  const pinned = () => chat.pinnedIds(chatId() ?? "").includes(Number(message().msg_id))

  const onReaction = (emoji: string) => {
    const id = chatId()
    if (!id || typeof message().msg_id !== "number") {
      showToast({ title: "消息发送中，稍后可回应" })
      return
    }
    void chat.sendReaction(id, message().msg_id as number, emoji)
  }

  const onTogglePin = () => {
    const id = chatId()
    if (!id || typeof message().msg_id !== "number") return
    void chat.togglePin(id, message().msg_id as number)
  }

  const openExternal = (url: string) => {
    if (url.startsWith("mailto:")) return
    platform.openExternal(url)
  }

  const menuOpen = () => !!menu()

  return (
    <div
      class="cm-message"
      data-out={isOut() ? "1" : undefined}
      classList={{
        "cm-collapsed": collapsed(),
        [`cm-group-${props.groupRole}`]: true,
      }}
      data-msg={String(message().msg_id)}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div class="cm-message-row">
        <Show
          when={avatarUrl()}
          fallback={
            <div
              class="cm-avatar cm-avatar-letter"
              style={{ background: avatarColor() }}
              data-contact={message().from_id}
              onClick={() => {
                // TODO(Task 3): 点击头像打开联系人资料卡（legacy contactCard）
              }}
            >
              {letter()}
            </div>
          }
        >
          <img
            class="cm-avatar"
            src={avatarUrl()}
            alt=""
            onClick={() => {
              // TODO(Task 3): 点击头像打开联系人资料卡（legacy contactCard）
            }}
          />
        </Show>
        <div class="cm-bubble" data-mt={theme()?.id} style={theme()?.style}>
          {/* hover 操作栏 */}
          <div class="cm-hover-actions">
            <button
              type="button"
              class="cm-action-btn"
              title="反应"
              aria-label="反应"
              onClick={(e) => {
                e.stopPropagation()
                setPickerOpen((v) => !v)
              }}
            >
              <ChatIcon name="smile" size={15} />
            </button>
            <button
              type="button"
              class="cm-action-btn"
              title="回复"
              aria-label="回复"
              onClick={(e) => {
                e.stopPropagation()
                if (typeof message().msg_id === "number") props.onReply(message().msg_id as number)
              }}
            >
              <ChatIcon name="reply" size={15} />
            </button>
            <button
              type="button"
              class="cm-action-btn"
              title={pinned() ? "取消置顶" : "置顶"}
              aria-label="置顶"
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin()
              }}
            >
              <ChatIcon name="pin" size={15} />
            </button>
            <button
              type="button"
              class="cm-action-btn"
              title="更多"
              aria-label="更多"
              onClick={(e) => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: isOut() ? rect.left - 160 : rect.right, y: rect.bottom + 4 })
              }}
            >
              <ChatIcon name="more-horizontal" size={15} />
            </button>
          </div>

          {/* meta：名字 + 角色 tag + 回复标记 */}
          <div class="cm-meta">
            <Show when={!collapsed() && !isOut() && isGroup()}>
              <span class="cm-name">{message().from_name}</span>
              <span class="cm-role">{message().from_id === 1 ? "core" : "member"}</span>
            </Show>
            <Show when={message().quote_from}>
              <span class="cm-reply-mark">
                回复{" "}
                <span class="cm-reply-name" onClick={() => { /* TODO(Task 3): 打开发送者资料卡 */ }}>
                  {message().quote_from}
                </span>
              </span>
            </Show>
          </div>

          {/* 引用块 */}
          <Show when={message().quote_text}>
            <div
              class="cm-quote"
              title="点击跳转原文"
              onClick={(e) => {
                e.stopPropagation()
                const quoteId = message().quote_msg_id
                if (quoteId != null) props.onJumpToMessage(quoteId)
              }}
            >
              <div class="cm-quote-name">{message().quote_from || ""}</div>
              <div class="cm-quote-text" innerHTML={quote().html} />
            </div>
          </Show>

          {/* 正文 */}
          <div class="cm-text" innerHTML={textHtml()} />

          {/* 附件 */}
          <Show when={message().view_type && message().view_type !== "Text" && message().file}>
            <MessageAttachment message={message()} />
          </Show>

          {/* 反应 */}
          <MessageReactions
            msgId={message().msg_id}
            chatId={chatId()}
            open={pickerOpen()}
            onToggle={onReaction}
            onClose={() => setPickerOpen(false)}
          />

          {/* footer：时间 + 状态 + 重发 */}
          <footer class="cm-footer">
            <span>{formatTs(message().ts)}</span>
            <Show when={isOut()}>
              <span class={`cm-state state-${message().state ?? "pending"}`}>
                {stateLabel(message().state, isGroup(), readCount())}
              </span>
              <Show when={message().state === "failed"}>
                <span
                  class="cm-resend"
                  onClick={() => {
                    // TODO(Task 3): 重发失败消息（legacy resend：再调 send_text）
                  }}
                >
                  重发
                </span>
              </Show>
            </Show>
          </footer>
        </div>
      </div>

      {/* 右键菜单 */}
      <Show when={menu()}>
        {(pos) => (
          <ContextMenu
            x={pos().x}
            y={pos().y}
            message={message()}
            isOut={isOut()}
            pinned={pinned()}
            onClose={() => setMenu(null)}
            onReply={() => {
              if (typeof message().msg_id === "number") props.onReply(message().msg_id as number)
            }}
            onTogglePin={onTogglePin}
            onJumpToMessage={props.onJumpToMessage}
          />
        )}
      </Show>
    </div>
  )
}

// 供右键菜单「复制」等使用（保持与 legacy 一致的引用导出）
export { formatBytes, formatTs }
