// src/app/pages/chat/session-side-panel.tsx
// 照抄 opencode pages/session/session-side-panel.tsx 骨架改造：
// - AI 文件/review/context tab 删除 → IM tab：成员 / 置顶 / 会话信息
// - 数据来自 chat context（members/pinned/info，经 invoke + Tauri 事件刷新）

import { createMemo, For, Show, type Accessor, type Component } from "solid-js"
import { createSignal } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useChat } from "../../context/chat"
import { colorHex } from "./chat-text"
import { ChatIcon } from "./chat-icons"

const SIDE_PANEL_WIDTH = 300

interface SessionSidePanelProps {
  chatId: Accessor<string | null>
  onClose: () => void
  onJumpToMessage: (msgId: number) => void
}

const MemberRow: Component<{ name: string; addr: string; avatar: string | null; color: number | null; isSelf: boolean; lastSeen: number }> = (props) => {
  const online = () => {
    if (props.isSelf) return true
    if (!props.lastSeen) return false
    return Date.now() / 1000 - props.lastSeen < 600
  }
  const letter = () => (props.name || "?").charAt(0).toUpperCase() || "?"

  return (
    <div class="cm-panel-member" onClick={() => { /* TODO(Task 3): 打开成员资料卡 */ }}>
      <Show
        when={props.avatar}
        fallback={
          <div class="cm-member-avatar" style={{ background: colorHex(props.color) }}>
            {letter()}
          </div>
        }
      >
        <img class="cm-member-avatar" src={props.avatar!} alt="" />
      </Show>
      <div class="cm-member-info">
        <div class="cm-member-name">
          {props.name}
          <Show when={props.isSelf}>
            <span style={{ "margin-left": "4px", "font-size": "11px", color: "var(--v2-text-text-faint)" }}>（我）</span>
          </Show>
        </div>
        <div class="cm-member-addr">{props.addr}</div>
      </div>
      <Show when={!props.isSelf}>
        <span class="cm-online-dot" classList={{ on: online() }} title={online() ? "在线" : "离线"} />
      </Show>
    </div>
  )
}

export function SessionSidePanel(props: SessionSidePanelProps) {
  const chat = useChat()
  const isDesktop = createMediaQuery("(min-width: 768px)")
  const [activeTab, setActiveTab] = createSignal("members")

  const chatId = () => props.chatId() ?? ""
  const info = createMemo(() => chat.chatInfo(chatId()))
  const members = createMemo(() => chat.members(chatId()))
  const pinnedIds = createMemo(() => chat.pinnedIds(chatId()))
  const pinnedMessages = createMemo(() =>
    pinnedIds()
      .map((id) => chat.messages(chatId()).find((m) => m.msg_id === id))
      .filter((m): m is NonNullable<typeof m> => !!m),
  )

  return (
    <Show when={isDesktop()}>
      <aside
        id="session-side-panel"
        aria-label="会话侧栏"
        class="relative min-w-0 h-full shrink-0 flex overflow-hidden border-l border-v2-border-border-weaker-base bg-v2-background-bg-base"
        style={{ width: `${SIDE_PANEL_WIDTH}px` }}
      >
        <Tabs value={activeTab()} onChange={setActiveTab} class="flex flex-col w-full h-full min-h-0">
          <div class="sticky top-0 shrink-0 flex items-center pl-2 pr-1 py-1 gap-1">
            <Tabs.List class="flex-1">
              <Tabs.Trigger value="members">
                <span>成员</span>
                <Show when={members().length > 0}>
                  <span style={{ "margin-left": "4px", "font-size": "11px", color: "var(--v2-text-text-faint)" }}>
                    {members().length}
                  </span>
                </Show>
              </Tabs.Trigger>
              <Tabs.Trigger value="pinned">
                <span>置顶</span>
                <Show when={pinnedIds().length > 0}>
                  <span style={{ "margin-left": "4px", "font-size": "11px", color: "var(--v2-text-text-faint)" }}>
                    {pinnedIds().length}
                  </span>
                </Show>
              </Tabs.Trigger>
              <Tabs.Trigger value="info">
                <span>会话信息</span>
              </Tabs.Trigger>
            </Tabs.List>
            <IconButtonV2
              type="button"
              size="small"
              variant="ghost-muted"
              icon={<IconV2 name="outline-xmark" />}
              aria-label="关闭侧栏"
              onClick={props.onClose}
            />
          </div>

          <Show when={activeTab() === "members"}>
            <Tabs.Content value="members" class="flex-1 min-h-0 overflow-y-auto px-1.5 py-1">
              <For each={members()}>
                {(member) => (
                  <MemberRow
                    name={member.name}
                    addr={member.addr}
                    avatar={member.avatar}
                    color={member.color}
                    isSelf={member.is_self}
                    lastSeen={member.last_seen}
                  />
                )}
              </For>
            </Tabs.Content>
          </Show>

          <Show when={activeTab() === "pinned"}>
            <Tabs.Content value="pinned" class="flex-1 min-h-0 overflow-y-auto px-1.5 py-1">
              <Show
                when={pinnedMessages().length > 0}
                fallback={
                  <div class="flex items-center justify-center h-full text-[12px] text-v2-text-text-faint">
                    暂无置顶消息
                  </div>
                }
              >
                <For each={pinnedMessages()}>
                  {(msg) => (
                    <div class="cm-panel-pin" onClick={() => props.onJumpToMessage(Number(msg.msg_id))}>
                      <ChatIcon name="pin" size={13} />
                      <span class="cm-panel-pin-text">
                        {msg.from_name}：{(msg.text || "").replace(/\s+/g, " ").slice(0, 40)}
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </Tabs.Content>
          </Show>

          <Show when={activeTab() === "info"}>
            <Tabs.Content value="info" class="flex-1 min-h-0 overflow-y-auto px-1.5 py-2">
              <Show when={info()}>
                {(i) => (
                  <>
                    <div class="cm-panel-info-row">
                      <span class="cm-panel-info-key">名称</span>
                      <span class="cm-panel-info-value">{i().name || `#${chatId()}`}</span>
                    </div>
                    <div class="cm-panel-info-row">
                      <span class="cm-panel-info-key">类型</span>
                      <span class="cm-panel-info-value">{i().is_group ? "群聊" : "单聊"}</span>
                    </div>
                    <div class="cm-panel-info-row">
                      <span class="cm-panel-info-key">成员数</span>
                      <span class="cm-panel-info-value">{i().members?.length ?? 0}</span>
                    </div>
                    <div class="cm-panel-info-row">
                      <span class="cm-panel-info-key">加密</span>
                      <span class="cm-panel-info-value">{i().is_encrypted ? "已加密" : "未加密"}</span>
                    </div>
                    <div class="cm-panel-info-row">
                      <span class="cm-panel-info-key">我在群内</span>
                      <span class="cm-panel-info-value">{i().self_in_group ? "是" : "否"}</span>
                    </div>
                    <div class="cm-panel-info-row">
                      <span class="cm-panel-info-key">可发送</span>
                      <span class="cm-panel-info-value">{i().can_send ? "是" : "否"}</span>
                    </div>
                  </>
                )}
              </Show>
            </Tabs.Content>
          </Show>
        </Tabs>
      </aside>
    </Show>
  )
}

export { SIDE_PANEL_WIDTH }
