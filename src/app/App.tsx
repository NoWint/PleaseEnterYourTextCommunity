// src/app/App.tsx
// 完整 Provider 树 + Router + AppLayout
// Phase 1 Task 4：组装壳，4 页路由可切换。

import type { Component } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { Font } from "@opencode-ai/ui/font"
import { PlatformProvider } from "./platform"
import { LayoutProvider } from "./context/layout"
import { SettingsProvider } from "./context/settings"
import { WorkspaceProvider } from "./context/workspace"
import { ChatProvider } from "./context/chat"
import AppLayout from "./layout/AppLayout"
import MessagesPage from "./pages/MessagesPage"
import GroupsPage from "./pages/GroupsPage"
import WorkPage from "./pages/WorkPage"
import SettingsPage from "./pages/SettingsPage"

const App: Component = () => {
  // Font 是兼容性 no-op 组件(返回 null,不接受 children),作为 ThemeProvider 子节点保留"已挂载"语义。
  return (
    <ThemeProvider defaultTheme="oc-2">
      <Font />
      <DialogProvider>
        <PlatformProvider>
          <SettingsProvider>
            <LayoutProvider>
              <WorkspaceProvider>
                <ChatProvider>
                  <Router root={(props) => <AppLayout>{props.children}</AppLayout>}>
                    <Route path="/" component={() => <Navigate href="/messages" />} />
                    <Route path="/messages" component={MessagesPage} />
                    <Route path="/groups" component={GroupsPage} />
                    <Route path="/work" component={WorkPage} />
                    <Route path="/settings" component={SettingsPage} />
                  </Router>
                </ChatProvider>
              </WorkspaceProvider>
            </LayoutProvider>
          </SettingsProvider>
        </PlatformProvider>
      </DialogProvider>
    </ThemeProvider>
  )
}

export default App
