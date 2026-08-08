// src/app/pages/legacy/legacy-style.ts
// legacy 样式按需注入（?url 资源 + ?raw 补丁），由 LegacyPageHost 挂载时挂
// <link>/<style>、卸载时移除 —— styles.css 不再随应用启动全局加载，避免污染 v2 壳层
// （html/body font-size、全站滚动条隐藏、#app 布局等全局规则仅在 legacy 页停留期间生效）。
// legacy-global-fix.css 负责把 styles.css 里覆盖 v2 壳层的全局规则还原。
import legacyStylesUrl from "@/styles.css?url"
import legacyGlobalFixCssRaw from "./legacy-global-fix.css?raw"

export const legacyStylesheetUrl = legacyStylesUrl
export const legacyGlobalFixCss = legacyGlobalFixCssRaw
