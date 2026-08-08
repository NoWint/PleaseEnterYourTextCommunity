/** A plugin entry from the GitHub registry. */
export interface RegistryPlugin {
  name: string;
  version: string;
  title: string;
  description: string;
  author: string;
  /** "theme" | "chatbot" | "llm" | "general" */
  type: string;
  entry: string;
}

/** Status of an installed plugin. */
export interface PluginStatus {
  name: string;
  title: string;
  description: string;
  plugin_type: string;
  version: string;
  author: string;
  enabled: boolean;
}

/** Theme registration config for theme plugins. */
export interface PluginThemeConfig {
  id: string;
  name: string;
  vars: Record<string, string>;
  gradient?: string;
  mask?: string;
  swatch?: string;
}

/** A theme registered by a plugin, listed in the appearance picker. */
export interface RegisteredPluginTheme {
  id: string;
  name: string;
  swatch: string;
}

/** A custom setting field a plugin declares, rendered in 设置 → 插件. */
export interface PluginSettingConfig {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'select';
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
}

/** A registered setting, keyed by plugin name. */
export interface RegisteredPluginSetting {
  plugin: string;
  config: PluginSettingConfig;
}

/** The API object passed to each plugin. */
export interface PluginApi {
  sendText(chatId: number, text: string): Promise<unknown>;
  onMessage(cb: (payload: Record<string, unknown>) => void): Promise<() => void>;
  addCSS(css: string): () => void;
  registerTheme(config: PluginThemeConfig): void;
  onCommand(name: string, cb: (args: string, chatId: number) => unknown): void;
  registerTool(name: string, description: string, parameters: unknown, handler: (args: unknown) => Promise<string>): Promise<void>;
  unregisterTool(name: string): Promise<void>;
  registerLLM(name: string, config: Record<string, unknown>): void;
  registerSetting(config: PluginSettingConfig): void;
  http: {
    get<T = unknown>(url: string): Promise<T>;
    post<T = unknown>(url: string, body: unknown): Promise<T>;
  };
  store: {
    get<T = unknown>(key: string): T | null;
    set(key: string, val: unknown): void;
    delete(key: string): void;
  };
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

declare global {
  interface Window {
    __peytchat_themes?: Array<{ id: string; name: string; swatch: string }>;
    __peytchat_commands?: Record<string, (args: string, chatId: number) => unknown>;
    __peytchat_commands_meta?: Record<string, string>; // 命令名 → 描述(空字符串=无描述)
    __peytchat_llms?: Record<string, Record<string, unknown>>;
    __peytchat_settings?: RegisteredPluginSetting[];
  }
}
