// src/app/components/dialogs/settings-v2/servers.tsx
// 设置对话框「服务器」页签（照抄 opencode settings-v2/servers.tsx 的骨架，
// 去掉 AI server 管理）：IM 版为账号管理占位。
// TODO(Task 5): 接入真实账号/服务器管理。

import type { Component } from "solid-js"
import { useServer } from "../../../context/server"
import { dialogsT } from "../i18n"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsServersV2: Component = () => {
  const server = useServer()
  const healthy = () => server.health[server.key]?.healthy ?? false

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{dialogsT("status.popover.tab.servers")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{dialogsT("settings.placeholder.account.title")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={server.current.displayName ?? dialogsT("settings.placeholder.account.local")}
              description={
                healthy() ? dialogsT("settings.placeholder.account.healthy") : dialogsT("settings.placeholder.account.unhealthy")
              }
            >
              <span
                class="inline-block size-2 rounded-full"
                classList={{
                  "bg-[var(--v2-state-fg-success)]": healthy(),
                  "bg-[var(--v2-state-fg-danger)]": !healthy(),
                }}
                aria-hidden="true"
              />
            </SettingsRowV2>
          </SettingsListV2>
          <p class="settings-v2-section-title settings-v2-placeholder-note">
            {dialogsT("settings.placeholder.account.description")}
          </p>
        </div>
      </div>
    </>
  )
}
