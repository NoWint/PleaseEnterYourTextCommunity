import { call, onEvent } from '../api.js';
import { hasPermission } from './permissions.js';
import { getPluginSetting, setPluginSetting, deletePluginSetting } from './storage.js';
import type { PluginApi, PluginSettingConfig, PluginThemeConfig } from './types.js';

function deny(pluginName: string, perm: string): never {
  throw new Error(`[${pluginName}] 缺少权限: ${perm}（可在 设置 → 插件 中开启）`);
}

// name -> handler,分发给注册了该工具名的插件
const pluginToolHandlers = new Map<string, (args: unknown) => Promise<string>>();

let toolBridgeStarted = false;

// 模块级桥:一次 listen('bot-tool-request'),按 payload.name 匹配 handler,并把结果回写后端。
async function startToolBridge(): Promise<void> {
  if (toolBridgeStarted) return;
  toolBridgeStarted = true;
  const { listen } = await import('@tauri-apps/api/event');
  await listen('bot-tool-request', async (ev) => {
    const p = ev.payload as { id: string; name: string; args?: unknown };
    const handler = pluginToolHandlers.get(p.name);
    let result: string;
    if (!handler) {
      result = `工具未注册: ${p.name}`;
    } else {
      try {
        result = await handler(p.args);
      } catch (e) {
        result = `工具执行失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    try {
      await call('bot_tool_result', { id: p.id, result });
    } catch {
      /* ignore */
    }
  });
}

/**
 * Build the API object handed to a plugin when it loads.
 * Each API surface is gated by the plugin's granted permissions and
 * cleaned up via the unload callbacks.
 */
export function createPluginApi(pluginName: string, unloadCallbacks: Array<() => void>): PluginApi {

  return {
    sendText(chatId, text) {
      if (!hasPermission(pluginName, 'messages:send')) return deny(pluginName, 'messages:send');
      return call('send_text', { chatId, text });
    },

    async onMessage(cb) {
      if (!hasPermission(pluginName, 'messages:read')) return deny(pluginName, 'messages:read');
      return onEvent('IncomingMsg', (payload) => {
        if (payload.chat_id != null) cb(payload as Record<string, unknown>);
      });
    },

    addCSS(css) {
      if (!hasPermission(pluginName, 'ui:css')) return deny(pluginName, 'ui:css');
      const tag = document.createElement('style');
      tag.textContent = css;
      tag.setAttribute('data-plugin', pluginName);
      document.head.appendChild(tag);
      unloadCallbacks.push(() => tag.remove());
      return () => tag.remove();
    },

    registerTheme(config: PluginThemeConfig) {
      if (!hasPermission(pluginName, 'ui:theme')) return deny(pluginName, 'ui:theme');
      const themeId = `plugin-${pluginName}-${config.id}`;
      // Inject the [data-theme="<id>"] block, matching the built-in themes.
      let css = `[data-theme="${themeId}"] {\n`;
      for (const [k, v] of Object.entries(config.vars)) css += `  ${k}: ${v};\n`;
      if (config.gradient) css += `  --theme-gradient: ${config.gradient};\n`;
      if (config.mask) css += `  --theme-mask: ${config.mask};\n`;
      css += '}';
      const tag = document.createElement('style');
      tag.textContent = css;
      tag.setAttribute('data-plugin-theme', themeId);
      document.head.appendChild(tag);

      // Register in the picker registry.
      if (!window.__peytchat_themes) window.__peytchat_themes = [];
      window.__peytchat_themes.push({
        id: themeId,
        name: config.name || config.id,
        swatch: config.swatch || config.vars['--text'] || '#888',
      });

      unloadCallbacks.push(() => {
        tag.remove();
        window.__peytchat_themes = (window.__peytchat_themes || []).filter((t) => t.id !== themeId);
      });
    },

    async registerTool(name, description, parameters, handler) {
      if (!hasPermission(pluginName, 'tools')) return deny(pluginName, 'tools');
      await startToolBridge();
      await call('register_bot_tool', { name, description, parameters });
      pluginToolHandlers.set(name, handler);
      unloadCallbacks.push(() => {
        pluginToolHandlers.delete(name);
        void call('unregister_bot_tool', { name }).catch(() => {});
      });
      return;
    },

    async unregisterTool(name) {
      if (!hasPermission(pluginName, 'tools')) return deny(pluginName, 'tools');
      pluginToolHandlers.delete(name);
      await call('unregister_bot_tool', { name });
    },

    onCommand(name, cb) {
      if (!hasPermission(pluginName, 'commands')) return deny(pluginName, 'commands');
      if (!window.__peytchat_commands) window.__peytchat_commands = {};
      if (!window.__peytchat_commands_meta) window.__peytchat_commands_meta = {};
      window.__peytchat_commands[name] = cb;
      window.__peytchat_commands_meta[name] = ''; // 描述占位,插件当前无描述字段
      unloadCallbacks.push(() => {
        delete window.__peytchat_commands![name];
        delete window.__peytchat_commands_meta![name];
      });
    },

    registerLLM(name, config) {
      if (!hasPermission(pluginName, 'llm')) return deny(pluginName, 'llm');
      if (!window.__peytchat_llms) window.__peytchat_llms = {};
      window.__peytchat_llms[name] = config;
      unloadCallbacks.push(() => {
        delete window.__peytchat_llms![name];
      });
    },

    http: {
      async get<T = unknown>(url: string): Promise<T> {
        if (!hasPermission(pluginName, 'network')) return deny(pluginName, 'network');
        return (await fetch(url)).json() as Promise<T>;
      },
      async post<T = unknown>(url: string, body: unknown): Promise<T> {
        if (!hasPermission(pluginName, 'network')) return deny(pluginName, 'network');
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return r.json() as Promise<T>;
      },
    },

    store: {
      get: <T = unknown>(key: string): T | null => getPluginSetting<T>(pluginName, key),
      set: (key: string, val: unknown): void => setPluginSetting(pluginName, key, val),
      delete: (key: string): void => deletePluginSetting(pluginName, key),
    },

    registerSetting(config: PluginSettingConfig) {
      if (!window.__peytchat_settings) window.__peytchat_settings = [];
      window.__peytchat_settings.push({ plugin: pluginName, config });
      unloadCallbacks.push(() => {
        window.__peytchat_settings = (window.__peytchat_settings || []).filter(
          (s) => !(s.plugin === pluginName && s.config.key === config.key),
        );
      });
    },

    log: {
      info: (msg) => console.log(`[${pluginName}]`, msg),
      warn: (msg) => console.warn(`[${pluginName}]`, msg),
      error: (msg) => console.error(`[${pluginName}]`, msg),
    },
  };
}
