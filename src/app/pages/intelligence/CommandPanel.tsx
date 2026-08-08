// src/app/pages/intelligence/CommandPanel.tsx
// 统一命令系统可视化。后端无 list_commands 界面命令（调查 0 MISS 清单无此命令），
// 按 smart-center spec §4 展示文档化静态注册表：Bot 与用户双路径共用 CommandRegistry，
// 聊天流输入斜杠命令触发；未定义命令提示 /help。

import { For, type Component } from "solid-js"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { CommandSpec } from "./types"

// 静态注册表（与后端 commands/registry.rs 注册内容一致；spec §4.4）
const COMMANDS: CommandSpec[] = [
  {
    name: "/summarize [N] [save]",
    scope: "双方",
    description: "总结最近 N 条消息（默认 30，上限 200）；带 save 后缀同时存入知识库。无 LLM 时提示「LLM 未配置」。",
    example: "/summarize 50 save",
  },
  {
    name: "/ask <问题>",
    scope: "双方",
    description: "知识库检索（关键词/标签 Top-N）+ LLM 回答；无条目时提示可用 /summarize 入库。",
    example: "/ask 这个项目用了哪些依赖？",
  },
  {
    name: "/whoami",
    scope: "Bot",
    description: "Bot 身份 + 工作区信息（自 rule.rs 迁入注册表）。",
    example: "/whoami",
  },
  {
    name: "/roll <N>",
    scope: "Bot",
    description: "生成 1-N 随机数（自 rule.rs 迁入注册表）。",
    example: "/roll 6",
  },
]

// 双路径规则（spec §4.3）
const SCOPE_RULES: Array<{ title: string; detail: string }> = [
  {
    title: "Bot 路径",
    detail: "会话有已配置 LLM 的 Bot 且命令 scope 含 Bot → Bot 优先处理，系统处理器跳过（不双回复）。",
  },
  {
    title: "用户路径",
    detail: "会话无 Bot 或 Bot 未配置 LLM，且命令 scope 含用户 → 系统命令处理器接管，以「系统」身份回复进聊天流。",
  },
  {
    title: "未知命令",
    detail: "发送 /help 查看可用命令。",
  },
]

export const CommandPanel: Component = () => {
  return (
    <div class="flex h-full min-h-0 flex-col overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[820px] flex-col gap-4 p-4">
        <div class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
          <div class="text-[13px] font-medium text-v2-text-text-base">斜杠命令注册表</div>
          <div class="text-[12px] leading-relaxed text-v2-text-text-muted">
            统一命令注册表（CommandRegistry）为全局单例，Bot 驱动与用户侧共用同一套解析与处理；
            命令在聊天流中触发，与 Bot 消息同通道。命令清单来自 smart-center 设计 spec §4.4（后端注册表内容，界面命令无查询接口，此处为文档化展示）。
          </div>
        </div>

        <div class="flex flex-col divide-y divide-v2-border-border-muted overflow-hidden rounded-[10px] bg-v2-background-bg-layer-01">
          <For each={COMMANDS}>
            {(cmd) => (
              <div class="flex flex-col gap-1.5 p-4">
                <div class="flex flex-wrap items-center gap-2">
                  <code class="rounded bg-v2-background-bg-base px-1.5 py-0.5 text-[12px] text-v2-text-text-base">
                    {cmd.name}
                  </code>
                  <Tag variant={cmd.scope === "Bot" ? "neutral" : "accent"}>{cmd.scope}</Tag>
                </div>
                <div class="text-[12px] leading-relaxed text-v2-text-text-muted">{cmd.description}</div>
                <div class="text-[11px] text-v2-text-text-faint">示例：{cmd.example}</div>
              </div>
            )}
          </For>
        </div>

        <div class="flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
          <div class="text-[13px] font-medium text-v2-text-text-base">双调用路径</div>
          <For each={SCOPE_RULES}>
            {(rule) => (
              <div class="flex flex-col gap-0.5">
                <span class="text-[12px] text-v2-text-text-base">{rule.title}</span>
                <span class="text-[11px] leading-relaxed text-v2-text-text-faint">{rule.detail}</span>
              </div>
            )}
          </For>
        </div>

        <div class="flex flex-col gap-1.5 rounded-[10px] bg-v2-background-bg-layer-01 p-4">
          <span class="text-[12px] text-v2-text-text-base">本页相关界面命令</span>
          <span class="text-[11px] leading-relaxed text-v2-text-text-faint">
            知识库：list_knowledge / get_knowledge / update_knowledge / delete_knowledge / summarize_store_now /
            list_knowledge_config / set_knowledge_config；主题总结：enqueue_summary（事件 summary-event /
            download-progress）；智能设置：get_intelligence_settings / set_intelligence_settings /
            get_llm_model_status / start_engine_download / test_llm_config。
          </span>
        </div>
      </div>
    </div>
  )
}
