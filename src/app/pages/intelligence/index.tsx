// src/app/pages/intelligence/index.tsx
// 智能中心页（/intelligence）：玻璃工具条 + Tab 条 + 内容区（同 legacy 结构）。
// 五 Tab：知识库 / 主题总结 / 自动总结配置 / 智能设置 / 命令系统。
// 页内 Tab 状态本地 signal + localStorage 持久化（替代 legacy state.intelligenceTab + saveState）。

import { createSignal, For, type Component } from "solid-js"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KnowledgePanel } from "./KnowledgePanel"
import { SummaryPanel } from "./SummaryPanel"
import { CommandPanel } from "./CommandPanel"
import type { IntelligenceTab } from "./types"

const TAB_KEY = "peyt.intelligenceTab"

const TABS: Array<{ id: IntelligenceTab; label: string }> = [
  { id: "knowledge", label: "知识库" },
  { id: "summary", label: "主题总结" },
  { id: "config", label: "自动总结配置" },
  { id: "settings", label: "智能设置" },
  { id: "commands", label: "命令系统" },
]

function loadTab(): IntelligenceTab {
  const saved = localStorage.getItem(TAB_KEY)
  return TABS.some((t) => t.id === saved) ? (saved as IntelligenceTab) : "knowledge"
}

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
    <path d="M21.448 13C20.9483 17.7767 16.909 21.5 12 21.5C8.18227 21.5 4.89052 19.248 3.38065 16M2.5 20.5V15.5H5.5M2.55176 11C3.05145 6.22334 7.09079 2.5 11.9998 2.5C15.8175 2.5 19.1092 4.75197 20.6191 8M21.4998 3.5V8.5H18.4998" />
  </svg>
)

const IntelligencePage: Component = () => {
  const [tab, setTab] = createSignal<IntelligenceTab>(loadTab())
  const [refresh, setRefresh] = createSignal(0)

  const switchTab = (next: string | null) => {
    if (!next || !TABS.some((t) => t.id === next)) return
    setTab(next as IntelligenceTab)
    localStorage.setItem(TAB_KEY, next)
  }

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      {/* 玻璃工具条 */}
      <header class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-v2-border-border-muted px-4 py-3">
        <div class="min-w-0">
          <div class="text-[14px] font-semibold tracking-[-0.02em] text-v2-text-text-base">智能中心</div>
          <div class="mt-0.5 text-[11px] text-v2-text-text-faint">知识库 · 主题总结 · 自动总结配置 · 智能设置</div>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <IconButtonV2
            size="small"
            variant="ghost-muted"
            title="刷新"
            onClick={() => setRefresh((n) => n + 1)}
            icon={<RefreshIcon />}
          />
        </div>
      </header>

      {/* Tab 条 + 内容区 */}
      <TabsV2 value={tab()} onChange={switchTab} class="flex min-h-0 flex-1 flex-col">
        <TabsV2.List class="shrink-0 border-b border-v2-border-border-muted px-2 pt-1">
          <For each={TABS}>
            {(t) => (
              <TabsV2.Trigger value={t.id} class="px-3 py-2 text-[12px]">
                {t.label}
              </TabsV2.Trigger>
            )}
          </For>
        </TabsV2.List>

        <div class="min-h-0 flex-1">
          <TabsV2.Content value="knowledge" class="h-full">
            <KnowledgePanel mode="library" refresh={refresh()} />
          </TabsV2.Content>
          <TabsV2.Content value="summary" class="h-full">
            <SummaryPanel mode="summary" refresh={refresh()} />
          </TabsV2.Content>
          <TabsV2.Content value="config" class="h-full">
            <KnowledgePanel mode="config" refresh={refresh()} />
          </TabsV2.Content>
          <TabsV2.Content value="settings" class="h-full">
            <SummaryPanel mode="settings" refresh={refresh()} />
          </TabsV2.Content>
          <TabsV2.Content value="commands" class="h-full">
            <CommandPanel />
          </TabsV2.Content>
        </div>
      </TabsV2>
    </div>
  )
}

export default IntelligencePage
