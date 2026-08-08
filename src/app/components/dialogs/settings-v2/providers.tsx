// src/app/components/dialogs/settings-v2/providers.tsx
// 设置对话框「机器人」页签（照抄 opencode settings-v2/providers.tsx 的骨架，
// 去掉 provider 管理）：IM 版为机器人管理占位（b5 bot-center）。
// TODO(Task 5): 接入 b5 bot-center。

import type { Component } from "solid-js"
import { dialogsT } from "../i18n"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsProvidersV2: Component = () => {
  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{dialogsT("settings.providers.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{dialogsT("settings.placeholder.bot.title")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={dialogsT("settings.placeholder.bot.title")}
              description={dialogsT("settings.placeholder.bot.description")}
            >
              <span class="text-v2-text-text-faint text-13-regular">—</span>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
