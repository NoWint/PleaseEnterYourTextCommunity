// src/app/App.tsx
// 完整 Provider 树 + Router + AppLayout
// Task 1：路由重排 / → /home、/home、/home/:wsId、/chat/:id、/chat/new、/work、/settings
//
// 注意：Layout/Tabs/Command 依赖 @solidjs/router hooks（useLocation/useNavigate），
// 因此必须挂在 Router root 内部（Router 会把 children 当作 Route 分支，不能直接包）。

import type { Component } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { Font } from "@opencode-ai/ui/font"
import { PlatformProvider } from "./platform"
import { LanguageProvider } from "./context/language"
import { ServerProvider } from "./context/server"
import { SettingsProvider } from "./context/settings"
import { LayoutProvider } from "./context/layout"
import { TabsProvider } from "./context/tabs"
import { CommandProvider } from "./context/command"
import { WorkspaceProvider } from "./context/workspace"
import { ChatProvider } from "./context/chat"
import BodyDesignClass from "./layout/BodyDesignClass"
import AppLayout from "./layout/AppLayout"
import { NewHome } from "./pages/home/home"
import MessagesPage from "./pages/MessagesPage"
import NewChatPage from "./pages/NewChatPage"
import WorkPage from "./pages/WorkPage"
import SettingsPage from "./pages/SettingsPage"

const App: Component = () => {
  // Font 是兼容性 no-op 组件(返回 null,不接受 children),作为 ThemeProvider 子节点保留"已挂载"语义。
  return (
    <ThemeProvider defaultTheme="oc-2">
      <Font />
      <BodyDesignClass />
      <DialogProvider>
        <PlatformProvider>
          <LanguageProvider>
            <ServerProvider>
              <SettingsProvider>
                <Router
                  root={(props) => (
                    <LayoutProvider>
                      <TabsProvider>
                        <CommandProvider>
                          <WorkspaceProvider>
                            <ChatProvider>
                              <AppLayout>{props.children}</AppLayout>
                            </ChatProvider>
                          </WorkspaceProvider>
                        </CommandProvider>
                      </TabsProvider>
                    </LayoutProvider>
                  )}
                >
                  <Route path="/" component={() => <Navigate href="/home" />} />
                  <Route path="/home" component={NewHome} />
                  <Route path="/home/:wsId" component={WorkPage} />
                  <Route path="/chat/new" component={NewChatPage} />
                  <Route path="/chat/:id" component={MessagesPage} />
                  <Route path="/work" component={WorkPage} />
                  <Route path="/settings" component={SettingsPage} />
                </Router>
              </SettingsProvider>
            </ServerProvider>
          </LanguageProvider>
        </PlatformProvider>
      </DialogProvider>
    </ThemeProvider>
  )
}

export default App
