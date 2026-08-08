// src/app/components/dialogs/settings-v2/servers.tsx
// 设置对话框「服务器」页签（照抄 opencode settings-v2/servers.tsx 的骨架，
// 去掉 AI server 管理）：IM 版 = 本地服务状态 + 账号管理（当前账号 + 切换账号对话框）。
// 健康状态统一处理：true=运行中、false=连接异常、undefined=未知（与 status-popover 一致）。
// 账号管理：当前账号行 + 「切换账号…」打开 dialog-account（列出账号/切换/登出/新建）。

import type { Component } from "solid-js"
import { useServer } from "../../../context/server"
import { useAccount } from "../../../context/account"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { dialogsT } from "../i18n"
import { serverHealthLabel, serverStatusDotClass, type ServerHealth } from "../status-popover"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsServersV2: Component = () => {
  const server = useServer()
  const account = useAccount()
  const dialog = useDialog()
  const healthy = (): ServerHealth => server.health[server.key]?.healthy

  const openAccountDialog = () => {
    void import("../dialog-account").then((module) => {
      void dialog.show(() => <module.DialogAccount />)
    })
  }

  const currentName = () =>
    account.current()?.name || account.current()?.addr || dialogsT("settings.placeholder.account.local")
  const currentAddr = () => account.current()?.addr || "未登录"

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{dialogsT("status.popover.tab.servers")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{dialogsT("settings.placeholder.account.local")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={server.current.displayName ?? dialogsT("settings.placeholder.account.local")}
              description={serverHealthLabel(healthy())}
            >
              <span
                class={`inline-block size-2 rounded-full ${serverStatusDotClass(healthy())}`}
                aria-hidden="true"
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{dialogsT("settings.placeholder.account.title")}</h3>
          <SettingsListV2>
            <SettingsRowV2 title={currentName()} description={currentAddr()}>
              <ButtonV2 variant="outline" onClick={openAccountDialog}>
                切换账号…
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
          <p class="settings-v2-section-title settings-v2-placeholder-note">
            点击「切换账号」可列出已存账号、切换或登出
          </p>
        </div>
      </div>
    </>
  )
}
