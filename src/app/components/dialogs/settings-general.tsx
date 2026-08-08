// src/app/components/dialogs/settings-general.tsx
// 设置对话框「常规」页（照抄 opencode settings-general.tsx 的外观/语言/通知部分）：
// - 主题选择器全量 37 主题（useTheme，实时切换）
// - 配色方案（system/light/dark）
// - 字号（settings.fontScale，沿用 peyt.fontScale 持久化）
// - 语言（IM 版仅简体中文，禁用选择）
// - 通知开关（本地持久化 "peyt.notifications"）
// 去掉：shell/权限/推理摘要/声音/更新/显示/高级等 AI/desktop 专属项。

import { Component, createSignal, type JSX } from "solid-js"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useSettings } from "../../context/settings"
import { dialogsT } from "./i18n"
import { SettingsList } from "./settings-list"

type ThemeOption = {
  id: string
  name: string
}

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

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const settings = useSettings()

  const themeOptions = (): ThemeOption[] => theme.ids().map((id) => ({ id, name: theme.name(id) }))

  const colorSchemeOptions = (): { value: ColorScheme; label: string }[] => [
    { value: "system", label: dialogsT("theme.scheme.system") },
    { value: "light", label: dialogsT("theme.scheme.light") },
    { value: "dark", label: dialogsT("theme.scheme.dark") },
  ]

  const [notifications, setNotifications] = createSignal(loadNotifications())
  const setNotification = (key: keyof typeof DEFAULT_NOTIFICATIONS, value: boolean) => {
    setNotifications((current) => {
      const next = { ...current, [key]: value }
      localStorage.setItem(NOTIFICATIONS_STORAGE, JSON.stringify(next))
      return next
    })
  }

  const GeneralSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={dialogsT("settings.general.row.language.title")}
          description={dialogsT("settings.general.row.language.description")}
        >
          <Select
            data-action="settings-language"
            options={[{ value: "zh", label: "简体中文" }]}
            current={{ value: "zh", label: "简体中文" }}
            value={(option) => option.value}
            label={(option) => option.label}
            onSelect={() => {}}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            disabled
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AppearanceSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{dialogsT("settings.general.section.appearance")}</h3>

      <SettingsList>
        <SettingsRow
          title={dialogsT("settings.general.row.colorScheme.title")}
          description={dialogsT("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={dialogsT("settings.general.row.theme.title")}
          description={dialogsT("settings.general.row.theme.description")}
        >
          <Select
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={dialogsT("settings.general.row.fontSize.title")}
          description={dialogsT("settings.general.row.fontSize.description")}
        >
          <Select
            data-action="settings-font-size"
            options={FONT_SCALE_OPTIONS}
            current={FONT_SCALE_OPTIONS.find((o) => Math.abs(o.scale - settings.fontScale()) < 0.001)}
            value={(o) => o.value}
            label={(o) => dialogsT(o.label)}
            onSelect={(option) => option && settings.setFontScale(option.scale)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "160px" }}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{dialogsT("settings.general.section.notifications")}</h3>

      <SettingsList>
        <SettingsRow
          title={dialogsT("settings.general.notifications.agent.title")}
          description={dialogsT("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={notifications().agent}
              onChange={(checked) => setNotification("agent", checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={dialogsT("settings.general.notifications.permissions.title")}
          description={dialogsT("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={notifications().permissions}
              onChange={(checked) => setNotification("permissions", checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={dialogsT("settings.general.notifications.errors.title")}
          description={dialogsT("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={notifications().errors}
              onChange={(checked) => setNotification("errors", checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{dialogsT("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <GeneralSection />
        <AppearanceSection />
        <NotificationsSection />
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
