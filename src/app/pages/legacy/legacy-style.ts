// src/app/pages/legacy/legacy-style.ts
// 一次性引入 legacy 样式（src/styles.css）+ 全局还原补丁。
// 加载顺序：src/app/entry.tsx 先引入 v2 的 src/app/index.css；
// 任一 legacy 包装页首次挂载时再引入本模块 → legacy 样式后加载。
// legacy-global-fix.css 负责把 styles.css 里 4 条覆盖 v2 壳层的全局规则还原。
import "@/styles.css"
import "./legacy-global-fix.css"
