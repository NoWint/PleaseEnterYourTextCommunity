import type { PluginPermission } from '../types.js';

const PERMS_KEY = 'peyt.plugin.perms'; // JSON { [pluginName]: PluginPermission[] }
const DEFAULT_PERMS: PluginPermission[] = [
  'messages:read',
  'messages:send',
  'ui:css',
  'ui:theme',
  'commands',
  'llm',
  'network',
];

export const PERMISSION_LABELS: Array<{ id: PluginPermission; label: string; desc: string }> = [
  { id: 'messages:read', label: '读取消息', desc: '监听接收到的消息' },
  { id: 'messages:send', label: '发送消息', desc: '代表你发送消息' },
  { id: 'ui:css', label: '注入样式', desc: '修改界面外观（CSS）' },
  { id: 'ui:theme', label: '注册主题', desc: '添加主题到外观选择器' },
  { id: 'commands', label: '注册命令', desc: '添加 /命令 到输入框' },
  { id: 'llm', label: '注册 LLM', desc: '接入 AI 模型提供方' },
  { id: 'network', label: '网络请求', desc: '访问外部网络接口' },
  { id: 'tools', label: '注册 Bot 工具', desc: '让 Bot 能调用插件提供的工具' },
];

function loadAll(): Record<string, PluginPermission[]> {
  try {
    return JSON.parse(localStorage.getItem(PERMS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, PluginPermission[]>): void {
  localStorage.setItem(PERMS_KEY, JSON.stringify(all));
}

/** Permissions granted to a plugin. Defaults to all. */
export function getPluginPermissions(name: string): PluginPermission[] {
  return loadAll()[name] ?? [...DEFAULT_PERMS];
}

export function hasPermission(name: string, perm: PluginPermission): boolean {
  return getPluginPermissions(name).includes(perm);
}

export function setPluginPermissions(name: string, perms: PluginPermission[]): void {
  const all = loadAll();
  all[name] = perms;
  saveAll(all);
}
