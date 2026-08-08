// src/app/components/dialogs/settings-v2/providers.tsx
// 设置对话框「机器人」页签（照抄 opencode settings-v2/providers.tsx 的骨架，
// 去掉 provider 管理）：IM 版为机器人管理入口 → 关闭设置对话框并跳转 /bots
// （b5 bot-center 页面已迁移为独立路由，见 pages/bots）。

import type { Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { dialogsT } from "../i18n"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const SettingsProvidersV2: Component = () => {
  const navigate = useNavigate()
  const dialog = useDialog()
  const openBots = () => {
    dialog.close()
    navigate("/bots")
  }
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
              <ButtonV2 type="button" variant="outline" size="small" onClick={openBots}>
                {dialogsT("settings.bots.manage")}
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
