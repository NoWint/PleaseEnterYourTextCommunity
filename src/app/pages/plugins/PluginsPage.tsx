// src/app/pages/plugins/PluginsPage.tsx
// 插件页 v2（/plugins；Task 4 平移自 src/plugins/view.ts + src/plugins/settings.ts）：
// - 市场 / 已安装 两个 tab（本地信号，不再写 legacy state.pluginsTab）
// - 市场：fetch_registry + list_plugins → 安装（install_plugin + loadPlugin）/
//   卸载（uninstall_plugin + unloadPlugin）
// - 已安装：list_plugins → 启停 switch（toggle_plugin + loadPlugin/unloadPlugin）、
//   从磁盘安装 .zip（install_plugin_from_zip）、展开「设置」编辑权限 +
//   插件声明的自定义配置（permissions.ts / storage.ts 保留为运行时工具）
// - 卸载确认改用 v2 Dialog（替换 legacy showPluginConfirm 浮动卡）
// - 运行时模块 api/manager/types/permissions/storage/confirm 均保留，仅视图迁移

import { createMemo, createSignal, For, onMount, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitle, DialogFooter } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { call } from "@/api"
import { loadPlugin, unloadPlugin } from "@/plugins/manager"
import { PERMISSION_LABELS, getPluginPermissions, setPluginPermissions } from "@/plugins/permissions"
import { getPluginSetting, setPluginSetting } from "@/plugins/storage"
import type { PluginStatus, RegistryPlugin } from "@/plugins/types"
import type { PluginPermission } from "@/types"
import { showToast } from "../../utils/toast"

const TYPE_LABELS: Record<string, string> = {
  theme: "主题",
  chatbot: "机器人",
  llm: "LLM",
  general: "工具",
}

function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? "其他"
}

const PluginsPage: Component = () => {
  const dialog = useDialog()

  const [tab, setTab] = createSignal<"market" | "installed">("market")
  const [plugins, setPlugins] = createSignal<PluginStatus[]>([])
  const [registry, setRegistry] = createSignal<RegistryPlugin[] | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [installing, setInstalling] = createSignal<string | null>(null)
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [cfgValues, setCfgValues] = createSignal<Record<string, string>>({})

  let fileInput: HTMLInputElement | undefined

  const load = async () => {
    setLoading(true)
    try {
      const [p, r] = await Promise.all([
        call<PluginStatus[]>("list_plugins").catch(() => []),
        call<RegistryPlugin[]>("fetch_registry").catch(() => null),
      ])
      setPlugins(p)
      setRegistry(r)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const installedMap = createMemo(() => {
    const map = new Map<string, PluginStatus>()
    for (const p of plugins()) map.set(p.name, p)
    return map
  })

  const install = async (name: string) => {
    setInstalling(name)
    try {
      const plugin = await call<RegistryPlugin>("install_plugin", { name })
      await loadPlugin(plugin.name, plugin.title)
      showToast({ title: `已安装 ${plugin.title}` })
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    } finally {
      setInstalling(null)
      await load()
    }
  }

  const uninstall = async (name: string) => {
    try {
      unloadPlugin(name)
      await call("uninstall_plugin", { name })
      showToast({ title: "已卸载" })
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    }
    await load()
  }

  const toggle = async (name: string, enabled: boolean) => {
    const prev = plugins()
    setPlugins((list) => list.map((p) => (p.name === name ? { ...p, enabled } : p)))
    try {
      await call("toggle_plugin", { name, enabled })
      if (enabled) await loadPlugin(name)
      else unloadPlugin(name)
    } catch (e) {
      // 失败回滚（与 legacy checkbox 回滚等价）
      setPlugins(prev)
      showToast({ title: e instanceof Error ? e.message : String(e) })
    }
  }

  const installFromZip = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ""
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      const plugin = await call<RegistryPlugin>("install_plugin_from_zip", {
        dataBase64: btoa(binary),
      })
      await loadPlugin(plugin.name, plugin.title)
      showToast({ title: `已安装 ${plugin.title}` })
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : String(e) })
    }
    await load()
  }

  const confirmUninstall = (name: string, title: string) => {
    dialog.show(() => (
      <Dialog size="normal">
        <DialogHeader>
          <DialogTitle>卸载插件</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p class="text-[13px] text-v2-text-text-muted">
            确定卸载插件 "{title}" 吗？其注册的命令与主题将一并移除。
          </p>
        </DialogBody>
        <DialogFooter>
          <div class="flex justify-end gap-2">
            <ButtonV2 size="small" variant="ghost" onClick={() => dialog.close()}>
              取消
            </ButtonV2>
            <ButtonV2
              size="small"
              variant="danger"
              onClick={() => {
                dialog.close()
                void uninstall(name)
              }}
            >
              卸载
            </ButtonV2>
          </div>
        </DialogFooter>
      </Dialog>
    ))
  }

  // ── 插件设置（权限 + 自定义配置，平移自 settings.ts） ──────────────
  const registeredSettings = (plugin: string) =>
    (window.__peytchat_settings ?? []).filter((s) => s.plugin === plugin)

  const cfgKey = (plugin: string, key: string) => `${plugin}:${key}`
  const cfgValue = (plugin: string, key: string) =>
    cfgValues()[cfgKey(plugin, key)] ?? getPluginSetting<string>(plugin, key) ?? ""
  const setCfgValue = (plugin: string, key: string, val: string) =>
    setCfgValues((m) => ({ ...m, [cfgKey(plugin, key)]: val }))

  const saveConfig = (plugin: string) => {
    for (const s of registeredSettings(plugin)) {
      setPluginSetting(plugin, s.config.key, cfgValue(plugin, s.config.key))
    }
    showToast({ title: "配置已保存" })
  }

  const togglePerm = (name: string, permId: PluginPermission, checked: boolean) => {
    const current = getPluginPermissions(name)
    const next = checked
      ? [...current, permId]
      : current.filter((p) => p !== permId)
    setPluginPermissions(name, next)
    showToast({ title: checked ? `已授权 ${permId}` : `已撤销 ${permId}` })
  }

  const toggleExpanded = (name: string) =>
    setExpanded((m) => ({ ...m, [name]: !m[name] }))

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <header class="flex shrink-0 items-center gap-x-3 border-b border-v2-border-border-weak-base px-4 py-3">
        <div class="min-w-0">
          <div class="text-[14px] font-semibold tracking-[-0.02em] text-v2-text-text-base">插件</div>
          <div class="mt-0.5 text-[11px] text-v2-text-text-faint">已安装 {plugins().length} 个插件</div>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <SegmentedControlV2 value={tab()} onChange={(v) => v && setTab(v as "market" | "installed")}>
            <SegmentedControlItemV2 value="market">插件市场</SegmentedControlItemV2>
            <SegmentedControlItemV2 value="installed">已安装</SegmentedControlItemV2>
          </SegmentedControlV2>
          <Show when={tab() === "installed"}>
            <ButtonV2 size="small" variant="ghost" title="从磁盘安装 .zip 插件" onClick={() => fileInput?.click()}>
              从 zip 安装
            </ButtonV2>
          </Show>
          <IconButtonV2
            size="small"
            variant="ghost-muted"
            title="刷新"
            onClick={() => void load()}
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">
                <path d="M21.448 13C20.9483 17.7767 16.909 21.5 12 21.5C8.18227 21.5 4.89052 19.248 3.38065 16M2.5 20.5V15.5H5.5M2.55176 11C3.05145 6.22334 7.09079 2.5 11.9998 2.5C15.8175 2.5 19.1092 4.75197 20.6191 8M21.4998 3.5V8.5H18.4998" />
              </svg>
            }
          />
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".zip"
        class="hidden"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ""
          if (file) void installFromZip(file)
        }}
      />

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Show when={tab() === "market"} fallback={
          <Show when={!loading()} fallback={<div class="px-2 py-8 text-center text-[12px] text-v2-text-text-faint">加载中…</div>}>
            <Show when={plugins().length > 0} fallback={<div class="px-2 py-8 text-center text-[12px] text-v2-text-text-faint">还没有安装插件</div>}>
              <div class="flex flex-col gap-2">
                <For each={plugins()}>
                  {(p) => (
                    <div class="rounded-lg border border-v2-border-border-weak-base px-3 py-2.5">
                      <div class="flex items-center gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="truncate text-[13px] font-medium text-v2-text-text-base">{p.title}</span>
                            <span class="shrink-0 rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[10px] text-v2-text-text-faint">{typeLabel(p.plugin_type)}</span>
                          </div>
                          <div class="mt-0.5 truncate text-[12px] text-v2-text-text-muted">{p.description}</div>
                        </div>
                        <ButtonV2
                          size="small"
                          variant="ghost"
                          title="展开设置"
                          onClick={() => toggleExpanded(p.name)}
                        >
                          设置
                        </ButtonV2>
                        <Switch
                          checked={p.enabled}
                          onChange={(c) => void toggle(p.name, c)}
                          hideLabel
                        >
                          启用
                        </Switch>
                        <IconButtonV2
                          size="small"
                          variant="ghost-muted"
                          title="卸载"
                          onClick={() => confirmUninstall(p.name, p.title)}
                          icon={
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true">
                              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                            </svg>
                          }
                        />
                      </div>
                      <Show when={expanded()[p.name]}>
                        <div class="mt-2.5 border-t border-v2-border-border-weak-base pt-2.5">
                          <div class="flex flex-col gap-1.5">
                            <For each={PERMISSION_LABELS}>
                              {(perm) => (
                                <CheckboxV2
                                  label={perm.label}
                                  description={perm.desc}
                                  checked={getPluginPermissions(p.name).includes(perm.id)}
                                  onChange={(c) => togglePerm(p.name, perm.id, c)}
                                />
                              )}
                            </For>
                          </div>
                          <Show when={registeredSettings(p.name).length > 0}>
                            <div class="mt-2.5 grid grid-cols-2 gap-2">
                              <For each={registeredSettings(p.name)}>
                                {(s) => (
                                  <label class="flex flex-col gap-1">
                                    <span class="text-[11px] text-v2-text-text-faint">{s.config.label}</span>
                                    <input
                                      class="rounded-md border border-v2-border-border-weak-base bg-v2-background-bg-base px-2 py-1 text-[12px] text-v2-text-text-base outline-none"
                                      type={s.config.type === "password" ? "password" : "text"}
                                      placeholder={s.config.placeholder ?? ""}
                                      value={cfgValue(p.name, s.config.key)}
                                      onInput={(e) => setCfgValue(p.name, s.config.key, e.currentTarget.value)}
                                    />
                                  </label>
                                )}
                              </For>
                            </div>
                            <div class="mt-2 flex justify-end">
                              <ButtonV2 size="small" variant="neutral" onClick={() => saveConfig(p.name)}>
                                保存
                              </ButtonV2>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        }>
          <Show when={!loading()} fallback={<div class="px-2 py-8 text-center text-[12px] text-v2-text-text-faint">加载中…</div>}>
            <Show when={registry() && registry()!.length > 0} fallback={<div class="px-2 py-8 text-center text-[12px] text-v2-text-text-faint">暂无可用插件</div>}>
              <div class="flex flex-col gap-2">
                <For each={registry()!}>
                  {(plugin) => {
                    const installed = installedMap().get(plugin.name)
                    return (
                      <div class="flex items-center gap-3 rounded-lg border border-v2-border-border-weak-base px-3 py-2.5">
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="truncate text-[13px] font-medium text-v2-text-text-base">{plugin.title}</span>
                            <span class="shrink-0 rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[10px] text-v2-text-text-faint">{typeLabel(plugin.type)}</span>
                          </div>
                          <div class="mt-0.5 truncate text-[12px] text-v2-text-text-muted">{plugin.description}</div>
                        </div>
                        <Show when={!installed} fallback={
                          <div class="flex items-center gap-1.5">
                            <span class="text-[11px] text-v2-text-text-faint">已安装</span>
                            <ButtonV2 size="small" variant="ghost" onClick={() => confirmUninstall(plugin.name, plugin.title)}>
                              卸载
                            </ButtonV2>
                          </div>
                        }>
                          <ButtonV2
                            size="small"
                            variant="neutral"
                            disabled={installing() === plugin.name}
                            onClick={() => void install(plugin.name)}
                          >
                            {installing() === plugin.name ? "安装中…" : "安装"}
                          </ButtonV2>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default PluginsPage
