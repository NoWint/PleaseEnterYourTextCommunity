// src/app/context/server.tsx
// IM 单"服务器"（本地 peer）抽象，对齐 opencode context/server 的接口形状，
// 供照抄组件使用。Task 3 接入多端连接时扩展。

import { createSimpleContext } from "@opencode-ai/ui/context"

export namespace ServerConnection {
  export type Key = string
  export interface Any {
    key: Key
    displayName?: string
    label?: string
  }
  export const key = (conn: Any): Key => conn.key
}

export const LOCAL_SERVER: ServerConnection.Any = {
  key: "local",
  displayName: "本地",
}

interface ServerStore {
  key: ServerConnection.Key
  current: ServerConnection.Any
  list: ServerConnection.Any[]
  health: Record<string, { healthy: boolean } | undefined>
}

function createServerStore(): ServerStore {
  return {
    key: LOCAL_SERVER.key,
    current: LOCAL_SERVER,
    list: [LOCAL_SERVER],
    health: { [LOCAL_SERVER.key]: { healthy: true } },
  }
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext<ServerStore, Record<string, any>>({
  name: "Server",
  gate: false,
  init: () => createServerStore(),
})
