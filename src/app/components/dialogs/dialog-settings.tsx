// src/app/components/dialogs/dialog-settings.tsx
// 设置对话框 v1（照抄 opencode dialog-settings.tsx）：
// 页签映射：General（主题选择器全量）/ Keybinds（IM 命令）/
//           Servers → 账号管理占位 / Providers+Models → 机器人管理占位。
// 实际入口走 settings-v2（settings-dialog.tsx 动态加载），本文件保留 v1 形态。

import { Component, createSignal, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { dialogsT } from "./i18n"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsAccountPlaceholder, SettingsBotPlaceholder } from "./settings-placeholder"

const APP_VERSION = "0.1.0"

export const DialogSettings: Component<{ defaultValue?: string }> = (props) => {
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")

  return (
    <Dialog size="x-large" transition>
      <Tabs
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full gap-4">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{dialogsT("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {dialogsT("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {dialogsT("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="servers">
                      <Icon name="server" />
                      {dialogsT("status.popover.tab.servers")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{dialogsT("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {dialogsT("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {dialogsT("settings.models.title")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{dialogsT("app.name.desktop")}</span>
              <span class="text-11-regular">v{APP_VERSION}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="servers" class="no-scrollbar">
          <SettingsAccountPlaceholder />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsBotPlaceholder />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsBotPlaceholder />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
