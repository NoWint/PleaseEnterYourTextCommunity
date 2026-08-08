// src/app/pages/chat/session-composer-region.tsx
// 照抄 opencode pages/session/composer/session-composer-region.tsx + prompt-input-v2 视觉：
// - AI dock（question/permission/followup/revert/todo）删除
// - 保留：回复预览条 + 输入卡片（textarea 自动增高 + 工具条）
// - 工具条：bot 选择器（占位）+ 附件 + 表情 + 语音 + 发送（右侧）

import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js"
import { createSessionComposerControls, type SessionComposerControls } from "./session-composer-controls"
import { ChatIcon } from "./chat-icons"
import { reactionPanel } from "./rows/message-row"
import { showToast } from "../../utils/toast"
import { useChat } from "../../context/chat"

export function SessionComposerRegion(props: {
  chatId: () => string | null
  centered: boolean
  onSent: () => void
  controls?: SessionComposerControls
}) {
  const controls = props.controls ?? createSessionComposerControls({ chatId: props.chatId, onSent: props.onSent })
  const chat = useChat()
  const [draftTimer, setDraftTimer] = createSignal<ReturnType<typeof setTimeout> | undefined>()

  let textareaRef: HTMLTextAreaElement | undefined
  let fileInput: HTMLInputElement | undefined

  // 切换会话：清空本地状态并恢复后端草稿
  createEffect(
    on(props.chatId, async (id) => {
      if (draftTimer()) {
        clearTimeout(draftTimer())
        setDraftTimer(undefined)
      }
      controls.cancelReply()
      controls.mention.close()
      controls.setText("")
      if (!id) return
      try {
        const draft = await chat.getDraft(id)
        if (draft) {
          controls.setText(draft)
          requestAnimationFrame(() => {
            if (textareaRef) {
              textareaRef.style.height = "auto"
              textareaRef.style.height = Math.min(textareaRef.scrollHeight, 160) + "px"
            }
          })
        }
      } catch {
        /* 草稿恢复失败静默 */
      }
    }),
  )

  const onInput = () => {
    const el = textareaRef
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 160) + "px"
    controls.updateMention(el.value, el.selectionStart ?? el.value.length)
    // 草稿：防抖 500ms
    if (draftTimer()) clearTimeout(draftTimer())
    setDraftTimer(
      setTimeout(() => {
        setDraftTimer(undefined)
        const id = props.chatId()
        if (!id) return
        void chat.setDraft(id, controls.text())
      }, 500),
    )
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const composing = e.isComposing || e.keyCode === 229
    if (controls.mention.open()) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        controls.mention.move(1)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        controls.mention.move(-1)
        return
      }
      if ((e.key === "Enter" || e.key === "Tab") && !composing) {
        e.preventDefault()
        controls.mention.insert()
        // 恢复 DOM 光标到插入点之后（Solid 受控绑定会把光标重置到末尾）
        requestAnimationFrame(() => {
          if (textareaRef) {
            const pos = controls.cursorPosition()
            textareaRef.setSelectionRange(pos, pos)
          }
        })
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        controls.mention.close()
        return
      }
    }
    if (e.key === "Enter" && !composing && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      void controls.send()
    }
    if (e.key === "Escape") {
      if (controls.replyTo() != null) controls.cancelReply()
    }
  }

  const attachClick = () => {
    fileInput?.click()
  }

  const onFileChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    void controls.attach(file).catch((err) => {
      showToast({ title: "发送附件失败", description: err instanceof Error ? err.message : String(err) })
    })
  }

  const sendClick = () => {
    void controls.send()
  }

  const sendButton: JSX.Element = (
    <button
      type="button"
      class="cm-send-btn"
      title="发送"
      aria-label="发送"
      disabled={!controls.canSend()}
      onClick={sendClick}
    >
      <ChatIcon name="send" size={15} />
    </button>
  )

  return (
    <div
      data-component="session-prompt-dock"
      class="w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none bg-v2-background-bg-base"
    >
      <div class="w-full px-3 pointer-events-auto" classList={{ "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered }}>
        <div class="relative">
          {/* 回复预览条 */}
          <Show when={controls.replyMessage()}>
            {(reply) => (
              <div class="cm-reply-preview rounded-t-[12px] border border-b-0 border-v2-border-border-weaker-base bg-v2-background-bg-layer-01">
                <ChatIcon name="reply" size={13} />
                <span class="cm-reply-preview-name">回复 {reply().from_name}</span>
                <span class="cm-reply-preview-text">
                  {(reply().text || "").replace(/\s+/g, " ").slice(0, 60)}
                </span>
                <button
                  type="button"
                  class="cm-reply-cancel"
                  title="取消回复"
                  aria-label="取消回复"
                  onClick={controls.cancelReply}
                >
                  <ChatIcon name="x" size={13} />
                </button>
              </div>
            )}
          </Show>

          {/* 输入卡片 */}
          <div class="cm-composer-card">
            <textarea
              ref={textareaRef}
              class="cm-composer-textarea"
              rows={1}
              placeholder="发消息到频道… (@提及成员)"
              value={controls.text()}
              onInput={onInput}
              onKeyDown={onKeyDown}
            />
            <div class="cm-composer-toolbar">
              <div class="cm-composer-tools">
                {/* bot 选择器（占位） */}
                <button
                  type="button"
                  class="cm-bot-selector"
                  title="选择 Bot（待接入）"
                  onClick={() => showToast({ title: "Bot 选择器待接入（Task 3 占位）" })}
                >
                  <ChatIcon name="robot" size={14} />
                  <span>Bot</span>
                  <ChatIcon name="chevron-down" size={12} />
                </button>
                <button type="button" class="cm-composer-tool" title="附件" aria-label="附件" onClick={attachClick}>
                  <ChatIcon name="paperclip" size={15} />
                  <input
                    ref={fileInput}
                    type="file"
                    style={{ display: "none" }}
                    onChange={onFileChange}
                  />
                </button>
                <button
                  type="button"
                  class="cm-composer-tool"
                  title="表情"
                  aria-label="表情"
                  onClick={controls.toggleEmoji}
                >
                  <ChatIcon name="smile" size={15} />
                </button>
                <button
                  type="button"
                  class="cm-composer-tool"
                  title="语音"
                  aria-label="语音"
                  classList={{ recording: controls.voiceRecording() }}
                  onClick={() => void controls.toggleVoice()}
                >
                  <ChatIcon name="mic" size={15} />
                </button>
                <Show when={controls.voiceRecording()}>
                  <span class="cm-mic-timer">{controls.voiceElapsed()}</span>
                </Show>
              </div>
              <div class="cm-composer-actions">{sendButton}</div>
            </div>
          </div>

          {/* 表情面板 */}
          <Show when={controls.emojiOpen()}>
            <div class="cm-emoji-popover" onClick={(e) => e.stopPropagation()}>
              <For each={reactionPanel}>
                {(emoji) => (
                  <button
                    type="button"
                    class="cm-emoji-option"
                    title={emoji}
                    onClick={() => controls.insertEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                )}
              </For>
            </div>
          </Show>

          {/* @提及建议 */}
          <Show when={controls.mention.open()}>
            <div class="cm-mention-list">
              <For each={controls.mention.items()}>
                {(member, index) => (
                  <div
                    class="cm-mention-item"
                    classList={{ selected: index() === controls.mention.selectedIndex() }}
                    onMouseEnter={() => controls.mention.move(index() - controls.mention.selectedIndex())}
                    onClick={() => {
                      controls.mention.insert()
                      requestAnimationFrame(() => {
                        if (textareaRef) {
                          const pos = controls.cursorPosition()
                          textareaRef.setSelectionRange(pos, pos)
                        }
                      })
                    }}
                  >
                    <span class="cm-mention-prefix">@</span>
                    <span>{member.name}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
