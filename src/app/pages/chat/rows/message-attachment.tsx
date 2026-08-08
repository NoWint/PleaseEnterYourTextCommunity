// src/app/pages/chat/rows/message-attachment.tsx
// 附件渲染（从 legacy message.ts attachment 分支迁移）：
// 图片/Gif/贴纸、文件、语音（自定义播放器）、音频、视频。

import { createMemo, createResource, createSignal, Match, onCleanup, Show, Switch, type Component } from "solid-js"
import { transformBlobURL } from "../../../../api"
import { formatBytes, formatVoiceTime } from "../chat-text"
import { ChatIcon } from "../chat-icons"
import type { RenderableMsg } from "../../../context/chat"

const VoicePlayer: Component<{ url: string }> = (props) => {
  const [playing, setPlaying] = createSignal(false)
  const [current, setCurrent] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  let audio: HTMLAudioElement | undefined

  onCleanup(() => {
    audio?.pause()
  })

  const toggle = () => {
    if (!audio) return
    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0
      void audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }

  return (
    <div class="cm-attachment voice">
      <button type="button" class="cm-voice-play" title={playing() ? "暂停" : "播放语音"} onClick={toggle}>
        <ChatIcon name={playing() ? "pause" : "play"} size={14} />
      </button>
      <div class="cm-voice-body">
        <div class="cm-voice-time">{formatVoiceTime(current())}</div>
        <div
          class="cm-voice-progress"
          onClick={(e) => {
            if (!audio || !duration()) return
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
            audio.currentTime = ratio * duration()
          }}
        >
          <div
            class="cm-voice-progress-fill"
            style={{ width: `${duration() > 0 ? (current() / duration()) * 100 : 0}%` }}
          />
        </div>
      </div>
      <span class="cm-voice-time">{formatVoiceTime(duration())}</span>
      <audio
        ref={audio}
        src={props.url}
        preload="metadata"
        hidden
        onLoadedMetadata={() => setDuration(audio?.duration ?? 0)}
        onTimeUpdate={() => setCurrent(audio?.currentTime ?? 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setCurrent(0)
        }}
      />
    </div>
  )
}

export const MessageAttachment: Component<{ message: RenderableMsg }> = (props) => {
  const m = () => props.message
  const [url] = createResource(
    () => (m().view_type !== "Text" && m().file ? m().file : null),
    (path) => transformBlobURL(path),
  )
  const [fullscreen, setFullscreen] = createSignal(false)

  const view = createMemo(() => m().view_type)

  return (
    <Show when={view() !== "Text" && url()}>
      {(assetUrl) => (
        <div class="cm-attachment">
          <Switch>
            <Match when={view() === "Image" || view() === "Gif" || view() === "Sticker"}>
              <img
                class="cm-attach-img"
                src={assetUrl()}
                alt={m().file_name || "image"}
                onClick={() => setFullscreen(true)}
              />
              <Show when={fullscreen()}>
                <div class="cm-fullscreen-overlay" onClick={() => setFullscreen(false)}>
                  <img src={assetUrl()} alt="" />
                </div>
              </Show>
            </Match>
            <Match when={view() === "Voice"}>
              <VoicePlayer url={assetUrl()} />
            </Match>
            <Match when={view() === "Audio"}>
              <audio controls src={assetUrl()} />
            </Match>
            <Match when={view() === "Video"}>
              <video controls src={assetUrl()} />
            </Match>
            <Match when={view() === "File"}>
              <div
                class="cm-file-card"
                onClick={() => {
                  const a = document.createElement("a")
                  a.href = assetUrl()
                  a.download = ""
                  a.click()
                }}
              >
                <div class="cm-file-icon">
                  <ChatIcon name="file-text" size={16} />
                </div>
                <div class="cm-file-info">
                  <div class="cm-file-name">{m().file_name || "file"}</div>
                  <div class="cm-file-meta">{formatBytes(m().file_bytes)} · 点击下载</div>
                </div>
              </div>
            </Match>
            <Match when={view() === "Webxdc" || view() === "Vcard"}>
              {/* TODO(Task 3): Webxdc 卡片 / vCard 名片（legacy renderWebxdcCard / hydrateVcardCard） */}
              <div class="cm-file-card">
                <div class="cm-file-icon">
                  <ChatIcon name="file-text" size={16} />
                </div>
                <div class="cm-file-info">
                  <div class="cm-file-name">{view() === "Vcard" ? "名片" : "Webxdc App"}</div>
                  <div class="cm-file-meta">{m().file_name || ""}</div>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  )
}
