// src/app/App.tsx
// 完整 Provider 树 + Router + AppLayout
// Task 1：路由重排 / → /home、/home、/home/:wsId、/chat/:id、/chat/new、/work
// Task 5：新增 /login 路由 + 未登录重定向（RequireAuth）；登录后进 /home。
// 设置入口统一走对话框（settings.dialog.open，见 components/dialogs/settings-dialog.tsx），
// 无 /settings 页面路由；壳层（AppLayout）只包已登录分支。
//
// 注意：Layout/Tabs/Command 依赖 @solidjs/router hooks（useLocation/useNavigate），
// 因此必须挂在 Router root 内部（Router 会把 children 当作 Route 分支，不能直接包）。

import type { Component, ParentProps } from "solid-js"
import { lazy, Show } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { Font } from "@opencode-ai/ui/font"
import { PlatformProvider } from "./platform"
import { LanguageProvider } from "./context/language"
import { ServerProvider, ServerAccountBridge } from "./context/server"
import { SettingsProvider } from "./context/settings"
import { LayoutProvider } from "./context/layout"
import { TabsProvider } from "./context/tabs"
import { CommandProvider } from "./context/command"
import { WorkspaceProvider } from "./context/workspace"
import { ChatProvider } from "./context/chat"
import { AccountProvider, useAccount } from "./context/account"
import BodyDesignClass from "./layout/BodyDesignClass"
import AppLayout from "./layout/AppLayout"
import { NewHome } from "./pages/home/home"
import MessagesPage from "./pages/MessagesPage"
import NewChatPage from "./pages/NewChatPage"
import WorkPage from "./pages/WorkPage"
import LoginPage from "./pages/login"
// legacy 页按需加载（code-split，避免 legacy vanilla 页面进首屏 bundle）
const BotsPage = lazy(() => import("./pages/bots"))
const PluginsPage = lazy(() => import("./pages/plugins/PluginsPage"))
const InboxPage = lazy(() => import("./pages/inbox/InboxPage"))
const GithubPage = lazy(() => import("./pages/github"))
const IntelligencePage = lazy(() => import("./pages/intelligence"))
const DebugPage = lazy(() => import("./pages/debug/DebugPage"))

// 路由守卫：未登录（is_configured=false）→ 重定向 /login；探测完成前显示加载占位。
const RequireAuth: Component<ParentProps> = (props) => {
  const account = useAccount()
  return (
    <Show when={account.ready()} fallback={<BootLoading />}>
      <Show when={account.authenticated()} fallback={<Navigate href="/login" />}>
        {props.children}
      </Show>
    </Show>
  )
}

// 已登录分支统一包 AppLayout（titlebar+sidebar 只出现在已登录页面；
// /login 与启动占位走裸 main 区，不渲染壳层）。
const AuthedLayout: Component<ParentProps> = (props) => (
  <RequireAuth>
    <AppLayout>{props.children}</AppLayout>
  </RequireAuth>
)

// 登录态探测中的最小占位（避免壳层加载前白屏）。
const BootLoading: Component = () => (
  <div class="flex h-full w-full items-center justify-center text-v2-text-text-faint text-13-regular">
    加载中…
  </div>
)

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
                    <AccountProvider>
                      <ServerAccountBridge />
                      <LayoutProvider>
                        <TabsProvider>
                          <CommandProvider>
                            <WorkspaceProvider>
                              <ChatProvider>{props.children}</ChatProvider>
                            </WorkspaceProvider>
                          </CommandProvider>
                        </TabsProvider>
                      </LayoutProvider>
                    </AccountProvider>
                  )}
                >
                  <Route path="/" component={() => <Navigate href="/home" />} />
                  <Route path="/login" component={LoginPage} />
                  <Route path="/home" component={() => <AuthedLayout><NewHome /></AuthedLayout>} />
                  <Route path="/home/:wsId" component={() => <AuthedLayout><WorkPage /></AuthedLayout>} />
                  <Route path="/chat/new" component={() => <AuthedLayout><NewChatPage /></AuthedLayout>} />
                  <Route path="/chat/:id" component={() => <AuthedLayout><MessagesPage /></AuthedLayout>} />
                  <Route path="/work" component={() => <AuthedLayout><WorkPage /></AuthedLayout>} />
                  {/* 6 个功能页（bots/plugins/inbox/github/intelligence/debug）已全部迁移为原生 Solid 组件 */}
                  <Route path="/bots" component={() => <AuthedLayout><BotsPage /></AuthedLayout>} />
                  <Route path="/plugins" component={() => <AuthedLayout><PluginsPage /></AuthedLayout>} />
                  <Route path="/inbox" component={() => <AuthedLayout><InboxPage /></AuthedLayout>} />
                  <Route path="/github" component={() => <AuthedLayout><GithubPage /></AuthedLayout>} />
                  <Route path="/intelligence" component={() => <AuthedLayout><IntelligencePage /></AuthedLayout>} />
                  <Route path="/debug" component={() => <AuthedLayout><DebugPage /></AuthedLayout>} />
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
