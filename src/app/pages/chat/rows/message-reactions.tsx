// src/app/pages/chat/rows/message-reactions.tsx
// 反应条 + 反应选择器（从 legacy message.ts renderReactions/反应选择器迁移）。
// 反应数据来自 chat store 的 reactionCache（get_reactions invoke + 事件刷新）。

import { For, Show, type Component } from "solid-js"
import { useChat } from "../../../context/chat"
import { reactionQuick, reactionPanel } from "./message-row"

interface MessageReactionsProps {
  msgId: number | string
  chatId: string | null
  open: boolean
  onToggle: (emoji: string) => void
  onClose: () => void
}

export const MessageReactions: Component<MessageReactionsProps> = (props) => {
  const chat = useChat()
  const reactions = () => {
    const id = props.chatId
    if (!id) return []
    return chat.reactionsFor(id, String(props.msgId))
  }

  return (
    <>
      <Show when={reactions().length > 0}>
        <div class="cm-reactions">
          <For each={reactions()}>
            {(r) => (
              <span
                class="cm-reaction"
                data-msg={String(props.msgId)}
                data-emoji={r.emoji}
                onClick={() => props.onToggle(r.emoji)}
              >
                {r.emoji.trim()}
                <Show when={r.count > 1}>
                  <span class="cm-reaction-count">{r.count}</span>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.open}>
        <div
          class="cm-reaction-picker show"
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={props.onClose}
        >
          <For each={reactionQuick}>
            {(emoji) => (
              <span class="cm-reaction-pick" data-emoji={emoji} title={emoji} onClick={() => props.onToggle(emoji)}>
                {emoji}
              </span>
            )}
          </For>
          <Show when={props.open}>
            {/* 完整面板在打开时展示（简单起见直接铺开常用面板前 16 个 + 更多提示） */}
            <For each={reactionPanel.slice(0, 16)}>
              {(emoji) => (
                <span class="cm-reaction-pick" data-emoji={emoji} title={emoji} onClick={() => props.onToggle(emoji)}>
                  {emoji}
                </span>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </>
  )
}
