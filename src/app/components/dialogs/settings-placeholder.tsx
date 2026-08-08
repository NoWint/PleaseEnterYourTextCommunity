// src/app/components/dialogs/settings-placeholder.tsx
// 设置对话框占位页签（v1 风格）：
// - 机器人管理（b5 bot-center 占位）
// - 账号管理（Servers → 账户管理占位）
// TODO(Task 5): 接入 b5 bot-center / 真实账号管理。

import type { Component } from "solid-js"
import { dialogsT } from "./i18n"
import { SettingsList } from "./settings-list"

export const SettingsBotPlaceholder: Component = () => {
  return (
    <SettingsPlaceholder
      title={dialogsT("settings.placeholder.bot.title")}
      description={dialogsT("settings.placeholder.bot.description")}
    />
  )
}

export const SettingsAccountPlaceholder: Component = () => {
  return (
    <SettingsPlaceholder
      title={dialogsT("settings.placeholder.account.title")}
      description={dialogsT("settings.placeholder.account.description")}
    />
  )
}

export const SettingsPlaceholder: Component<{ title: string; description: string }> = (props) => {
  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{props.title}</h2>
        </div>
      </div>
      <SettingsList>
        <div class="flex flex-col items-center justify-center gap-2 py-16 text-center">
          <span class="text-14-medium text-text-strong">{props.title}</span>
          <span class="text-12-regular text-text-weak max-w-[420px]">{props.description}</span>
        </div>
      </SettingsList>
    </div>
  )
}
