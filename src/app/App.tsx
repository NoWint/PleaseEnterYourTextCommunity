import type { Component } from "solid-js"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { Font } from "@opencode-ai/ui/font"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"

const App: Component = () => {
  // Font 是兼容性 no-op 组件(返回 null,不接受 children),作为兄弟节点挂载保留"已挂载"语义
  return (
    <ThemeProvider defaultTheme="oc-2">
      <Font />
      <DialogProvider>
        <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "align-items": "center" }}>
          <h1 style={{ "font-size": "20px", "font-weight": 600 }}>Phase 0 验证</h1>
          <ButtonV2 variant="neutral" size="normal">Neutral Button</ButtonV2>
          <ButtonV2 variant="contrast" size="normal">Contrast Button</ButtonV2>
          <ButtonV2 variant="ghost" size="small">Ghost Small</ButtonV2>
        </div>
      </DialogProvider>
    </ThemeProvider>
  )
}

export default App
