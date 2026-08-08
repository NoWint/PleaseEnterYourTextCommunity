/**
 * 插件设置视图（legacy settingsPage 的「插件」区块）占位。
 *
 * 插件管理 UI 已随 Task 4 迁移至 v2 原生页（src/app/pages/plugins/PluginsPage.tsx，
 * 含启停开关 / 权限 / 自定义配置 / 卸载）。本文件仅保留 renderPluginSettings
 * 的兼容导出，供仍未迁移的 legacy settingsPage.ts（Phase 6 移除）编译与运行；
 * 运行时渲染为占位提示。插件的运行时模块（api/manager/types/permissions/
 * storage/confirm）均不受影响。
 */
export async function renderPluginSettings(main: HTMLElement): Promise<void> {
  main.innerHTML = `
    <div class="settings-section plugin-settings-page">
      <h2>插件</h2>
      <div class="plugin-empty">插件设置已迁移至新版「插件」页</div>
    </div>
  `;
}
