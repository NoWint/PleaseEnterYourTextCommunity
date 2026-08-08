// src/app/pages/chat/session-panel-layout.ts
// 照抄 opencode pages/session/session-panel-layout.ts。

export function sessionPanelLayout(input: { review: boolean; terminal: boolean; files: boolean }) {
  return {
    visible: input.review || input.terminal || input.files,
    stacked: input.review && input.terminal,
  }
}
