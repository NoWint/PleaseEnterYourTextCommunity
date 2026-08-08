// src/app/components/dialogs/i18n.ts
// 对话框/命令面板的本地文案字典（中文）。
// 设计：设置对话框、命令面板、帮助/状态等由 Task 2 引入的组件所需的全部
// 用户可见文案集中于此，经 useDialogsT() 查询，未命中回落到 key 本身。
// 后续若统一 i18n 管理（Task 5+），可把这份字典并入 src/i18n。

const DICT: Record<string, string> = {
  // ── 通用 ──
  "common.cancel": "取消",
  "common.save": "保存",
  "common.saving": "保存中…",
  "common.loading": "加载中…",
  "app.name.desktop": "PeytChat",

  // ── 命令 ──
  "command.palette": "命令面板",
  // 设置入口统一为对话框（settings.dialog.open）；无 /settings 页面路由。
  "command.settings.open": "打开设置对话框",
  "command.session.new": "新建会话",
  "command.session.switch": "切换会话",
  "command.session.markRead": "标记已读",
  "command.workspace.switch": "切换工作区",
  "command.theme.switch": "切换主题",
  "command.category.settings": "设置",
  "command.category.session": "会话",
  "command.category.workspace": "工作区",
  "command.category.theme": "主题",

  // ── 命令面板 ──
  "palette.group.commands": "命令",
  "palette.search.placeholder.home": "搜索命令…",
  "palette.empty": "没有匹配的命令",

  // ── 设置对话框 ──
  "settings.section.desktop": "桌面端",
  "settings.section.server": "服务器",
  "settings.tab.general": "常规",
  "settings.tab.shortcuts": "快捷键",
  "status.popover.tab.servers": "服务器",
  "settings.providers.title": "机器人",
  "settings.models.title": "模型",

  // 常规页
  "settings.general.section.appearance": "外观",
  "settings.general.section.notifications": "通知",
  "settings.general.row.language.title": "语言",
  "settings.general.row.language.description": "界面显示语言",
  "settings.general.row.colorScheme.title": "配色方案",
  "settings.general.row.colorScheme.description": "选择界面使用浅色或深色外观",
  "settings.general.row.theme.title": "主题",
  "settings.general.row.theme.description": "选择界面主题，支持实时切换",
  "settings.general.row.fontSize.title": "字号",
  "settings.general.row.fontSize.description": "调整界面文字大小",
  "settings.general.fontScale.compact": "紧凑",
  "settings.general.fontScale.default": "默认",
  "settings.general.fontScale.large": "大",
  "settings.general.fontScale.xl": "特大",
  "settings.general.notifications.agent.title": "消息通知",
  "settings.general.notifications.agent.description": "新消息到达时在桌面显示通知",
  "settings.general.notifications.permissions.title": "会话提醒",
  "settings.general.notifications.permissions.description": "有人@我或提到我时提醒",
  "settings.general.notifications.errors.title": "错误通知",
  "settings.general.notifications.errors.description": "连接或同步异常时通知我",
  "theme.scheme.system": "跟随系统",
  "theme.scheme.light": "浅色",
  "theme.scheme.dark": "深色",

  // 快捷键页
  "settings.shortcuts.title": "快捷键",
  "settings.shortcuts.search.placeholder": "搜索快捷键…",
  "settings.shortcuts.search.empty": "没有匹配的快捷键",
  "settings.shortcuts.reset.button": "重置",
  "settings.shortcuts.unassigned": "未分配",
  "settings.shortcuts.pressKeys": "按下按键…",
  "settings.shortcuts.conflict.title": "快捷键冲突",
  "settings.shortcuts.conflict.description": "“{keybind}” 已被 “{titles}” 使用",
  "settings.shortcuts.reset.toast.title": "已重置快捷键",
  "settings.shortcuts.reset.toast.description": "所有快捷键已恢复默认",
  "settings.shortcuts.group.general": "常规",
  "settings.shortcuts.group.session": "会话",
  "settings.shortcuts.group.navigation": "导航",
  "settings.shortcuts.group.workspace": "工作区",

  // 占位页签
  "settings.placeholder.bot.title": "机器人管理",
  "settings.placeholder.bot.description": "机器人（Bot）的接入与管理将在后续版本开放。",
  "settings.placeholder.account.title": "账号管理",
  "settings.placeholder.account.local": "本地服务",

  // ── 工作区编辑对话框（占位） ──
  "dialog.project.edit.title": "编辑工作区",
  "dialog.project.edit.name": "名称",
  "dialog.project.edit.worktree.startup": "启动命令",
  "dialog.project.edit.worktree.startup.description": "进入该工作区时自动执行的命令",
  "dialog.project.edit.worktree.startup.placeholder": "例如：npm run dev",

  // ── 状态弹层 ──
  "status.popover.trigger": "服务器状态",
  "status.popover.title": "服务器",
  "status.popover.server.healthy": "运行中",
  "status.popover.server.unhealthy": "连接异常",
  "status.popover.server.unknown": "状态未知",

  // ── 帮助 ──
  "help.title": "帮助",
  "help.button.ariaLabel": "帮助",
  "help.drawer.introduction": "PeytChat 是一款基于 Tauri 的即时通讯应用。",
  "help.drawer.guide": "使用指南",
  "help.drawer.guide.description": "快捷键、命令面板与设置说明",
  "help.drawer.feedback": "反馈问题",
  "help.drawer.feedback.description": "告诉我们哪里需要改进",
  "help.drawer.about": "关于",
  "help.drawer.about.description": "版本信息与更新日志",
}

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

export type DialogsT = (key: string, params?: Record<string, string | number>) => string

/** 命令面板/设置对话框等 Task 2 组件的文案查询函数。 */
export function dialogsT(key: string, params?: Record<string, string | number>): string {
  return interpolate(DICT[key] ?? key, params)
}
