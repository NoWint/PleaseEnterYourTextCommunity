// src/app/utils/server-health.ts
// 照抄 opencode utils/server-health.ts 裁剪：三态健康类型保留，
// 健康探测机制移除（原实现依赖 @opencode-ai/client SDK 探测 /health，
// 本项目无 opencode server；健康状态由 server context（账户 is_configured）
// 提供，见 src/app/context/server.tsx）。

export type ServerHealth = { healthy: boolean; version?: string }
