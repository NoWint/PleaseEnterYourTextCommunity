// src/app/context/language.tsx
// 最小语言 context：t(key, params?) 查 src/i18n（zh 优先，en 兜底），
// 未命中回落到 key 本身。壳层新增文案集中在 SHELL_DICT（中文为主）。

import { createSimpleContext } from "@opencode-ai/ui/context"
import { zh as appZh } from "../../i18n/zh"
import { en as appEn } from "../../i18n/en"

// 壳层（titlebar/sidebar/home）新增文案。TODO(Task 3): 迁移到 src/i18n 统一管理。
const SHELL_DICT: Record<string, string> = {
  "home.title": "首页",
  "command.session.new": "新建会话",
  "command.project.open": "添加工作区",
  "command.sidebar.toggle": "切换侧栏",
  "command.tab.close": "关闭标签页",
  "command.tab.reopenClosed": "重新打开已关闭的标签页",
  "command.category.view": "视图",
  "command.category.file": "文件",
  "common.goBack": "后退",
  "common.goForward": "前进",
  "common.closeTab": "关闭标签页",
  "common.moreOptions": "更多选项",
  "common.rename": "重命名",
  "common.reset": "重置",
  "common.delete": "删除",
  "common.edit": "编辑",
  "common.close": "关闭",
  "common.archive": "归档",
  "common.loadMore": "加载更多",
  "common.loading": "加载中…",
  "common.requestFailed": "请求失败",
  "sidebar.settings": "设置",
  "sidebar.help": "帮助",
  "sidebar.empty.title": "暂无工作区",
  "sidebar.empty.description": "添加工作区后，最近的会话会显示在这里",
  "sidebar.project.recentSessions": "最近会话",
  "sidebar.project.clearNotifications": "清除未读",
  "sidebar.project.reveal": "在文件夹中显示",
  "sidebar.workspaces.enable": "启用工作区列表",
  "sidebar.workspaces.disable": "禁用工作区列表",
  "workspace.type.local": "工作区",
  "workspace.type.sandbox": "子空间",
  "workspace.new": "新建工作区",
  "session.tab.unknown": "未知会话",
  "home.projects": "工作区",
  "home.project.add": "添加工作区",
  "home.recentlyClosed": "最近关闭",
  "home.server.collapse": "折叠",
  "home.server.expand": "展开",
  "home.sessions.group.today": "今天",
  "home.sessions.group.yesterday": "昨天",
  "home.sessions.group.older": "更早",
  "home.sessions.privateChat": "私聊",
  "home.sessions.search.placeholder": "搜索会话…",
  "home.sessions.search.placeholder.scoped": "在 {scope} 中搜索…",
  "home.sessions.search.sessions": "会话",
  "home.sessions.search.noResults": "没有匹配 “{query}” 的会话",
  "home.sessions.empty": "暂无会话",
  "home.sessions.empty.description": "发起新会话后，它们会出现在这里",
  "dialog.project.edit.title": "编辑工作区",
  "settings.section.server": "账号",
  "dialog.server.menu.edit": "编辑",
  "dialog.server.menu.default": "设为默认账号",
  "dialog.server.menu.defaultRemove": "取消默认账号",
  "dialog.server.menu.delete": "删除账号",
}

function resolve(dict: Record<string, string>, key: string): string | undefined {
  if (key in dict) return dict[key]
  const parts = key.split(".")
  // 尝试逐级回退（如 command.session.new → command.session → command）
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join(".")
    if (prefix in dict) return dict[prefix]
  }
  return undefined
}

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

interface LanguageStore {
  t: (key: string, params?: Record<string, string | number>) => string
  direction: () => "ltr"
}

function createLanguageStore(): LanguageStore {
  const t = (key: string, params?: Record<string, string | number>) => {
    const value =
      resolve(appZh, key) ?? resolve(SHELL_DICT, key) ?? resolve(appEn, key) ?? key
    return interpolate(value, params)
  }
  return { t, direction: () => "ltr" }
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext<LanguageStore, Record<string, any>>({
  name: "Language",
  gate: false,
  init: () => createLanguageStore(),
})
