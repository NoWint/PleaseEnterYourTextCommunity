// src/app/components/dialogs/settings-v2/general.tsx
// 设置对话框「常规」页 v2（照抄 opencode settings-v2/general.tsx 的外观/语言/
// 通知部分）：主题选择器全量 37 主题、配色方案、字号、语言（仅中文，禁用）、
// 通知开关（本地持久化 "peyt.notifications"）。
// 去掉：shell/权限/推理摘要/声音/更新/显示/高级/布局过渡等 AI 专属项。

import { Component, createSignal, type JSX } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useSettings } from "../../../context/settings"
import { dialogsT } from "../i18n"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const schemeOptions: ColorScheme[] = ["system", "light", "dark"]

const FONT_SCALE_OPTIONS = [
  { value: "0.85", scale: 0.85, label: "settings.general.fontScale.compact" },
  { value: "1", scale: 1, label: "settings.general.fontScale.default" },
  { value: "1.15", scale: 1.15, label: "settings.general.fontScale.large" },
  { value: "1.3", scale: 1.3, label: "settings.general.fontScale.xl" },
]

const NOTIFICATIONS_STORAGE = "peyt.notifications"
const DEFAULT_NOTIFICATIONS = { agent: true, permissions: true, errors: true }

function loadNotifications(): typeof DEFAULT_NOTIFICATIONS {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE)
    if (!raw) return { ...DEFAULT_NOTIFICATIONS }
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object"
      ? { ...DEFAULT_NOTIFICATIONS, ...(parsed as Partial<typeof DEFAULT_NOTIFICATIONS>) }
      : { ...DEFAULT_NOTIFICATIONS }
  } catch {
    return { ...DEFAULT_NOTIFICATIONS }
  }
}

const LanguageSetting = () => {
  return (
    <SettingsRowV2
      title={dialogsT("settings.general.row.language.title")}
      description={dialogsT("settings.general.row.language.description")}
    >
      <SelectV2
        appearance="inline"
        data-action="settings-language"
        options={[{ value: "zh", label: "简体中文" }]}
        placement="bottom-end"
        gutter={6}
        current={{ value: "zh", label: "简体中文" }}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={() => {}}
        disabled
      />
    </SettingsRowV2>
  )
}

const AppearanceSection = () => {
  const theme = useTheme()
  const settings = useSettings()
  const themeOptions = () => theme.ids().map((id) => ({ id, name: theme.name(id) }))

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{dialogsT("settings.general.section.appearance")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={dialogsT("settings.general.row.colorScheme.title")}
          description={dialogsT("settings.general.row.colorScheme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            options={schemeOptions}
            current={schemeOptions.find((option) => option === theme.colorScheme())}
            placement="bottom-end"
            gutter={6}
            label={(option) => {
              if (option === "system") return dialogsT("theme.scheme.system")
              if (option === "light") return dialogsT("theme.scheme.light")
              return dialogsT("theme.scheme.dark")
            }}
            onSelect={(option) => option && theme.setColorScheme(option)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={dialogsT("settings.general.row.theme.title")}
          description={dialogsT("settings.general.row.theme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((option) => option.id === theme.themeId())}
            placement="bottom-end"
            gutter={6}
            value={(option) => option.id}
            label={(option) => option.name}
            onSelect={(option) => option && theme.setTheme(option.id)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={dialogsT("settings.general.row.fontSize.title")}
          description={dialogsT("settings.general.row.fontSize.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-font-size"
            options={FONT_SCALE_OPTIONS}
            current={FONT_SCALE_OPTIONS.find((option) => Math.abs(option.scale - settings.fontScale()) < 0.001)}
            placement="bottom-end"
            gutter={6}
            value={(option) => option.value}
            label={(option) => dialogsT(option.label)}
            onSelect={(option) => option && settings.setFontScale(option.scale)}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )
}

const NotificationsSection = () => {
  const [notifications, setNotifications] = createSignal(loadNotifications())
  const setNotification = (key: keyof typeof DEFAULT_NOTIFICATIONS, value: boolean) => {
    setNotifications((current) => {
      const next = { ...current, [key]: value }
      localStorage.setItem(NOTIFICATIONS_STORAGE, JSON.stringify(next))
      return next
    })
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{dialogsT("settings.general.section.notifications")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={dialogsT("settings.general.notifications.agent.title")}
          description={dialogsT("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={notifications().agent}
              onChange={(checked) => setNotification("agent", checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={dialogsT("settings.general.notifications.permissions.title")}
          description={dialogsT("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={notifications().permissions}
              onChange={(checked) => setNotification("permissions", checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={dialogsT("settings.general.notifications.errors.title")}
          description={dialogsT("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={notifications().errors}
              onChange={(checked) => setNotification("errors", checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )
}

export const SettingsGeneralV2: Component = () => {
  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{dialogsT("settings.tab.general")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <LanguageSetting />
          </SettingsListV2>
        </div>

        <AppearanceSection />

        <NotificationsSection />
      </div>
    </>
  )
}
