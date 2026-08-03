import { call } from '../api.js';
import { state } from '../state.js';
import { showToast } from '../toast.js';
import { iconSvg } from '../components/icon.js';
import { escapeHtml as esc } from '../components/escape.js';
import { showPluginConfirm } from './confirm.js';
import { loadPlugin, unloadPlugin } from './manager.js';
import type { PluginStatus, RegistryPlugin } from './types.js';

/**
 * Plugin page (rail entry). Nav panel shows 市场 / 已安装 toggles,
 * main panel renders the selected view.
 */
export async function renderPluginsNav(panel: HTMLElement): Promise<void> {
  const tabs: Array<{ id: 'market' | 'installed'; label: string }> = [
    { id: 'market', label: '插件市场' },
    { id: 'installed', label: '已安装' },
  ];
  panel.innerHTML = `
    <div class="nav-header"><div class="nav-title">插件</div></div>
    <div class="nav-list">
      ${tabs
        .map(
          (t) => `<div class="nav-chat-item ${state.pluginsTab === t.id ? 'active' : ''}" data-tab="${t.id}">
            ${t.label}
          </div>`,
        )
        .join('')}
    </div>
    <div id="plugin-tree" class="nav-list"></div>
  `;
  panel.querySelectorAll<HTMLElement>('.nav-chat-item[data-tab]').forEach((el) => {
    el.addEventListener('click', async () => {
      state.pluginsTab = el.dataset.tab as 'market' | 'installed';
      panel.querySelectorAll('.nav-chat-item').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      const { renderMain } = await import('../shell/navPanel.js');
      await renderMain();
      await refreshPluginTree();
    });
  });
  // 已安装 tab 激活时，在导航栏下方渲染所有插件的树（Steam 库风格）
  if (state.pluginsTab === 'installed') {
    await refreshPluginTree();
  }
}

/** 树状列出所有已安装插件，按类型分组，类似 Steam 库。 */
export async function refreshPluginTree(): Promise<void> {
  const treeEl = document.getElementById('plugin-tree');
  if (!treeEl) return;
  const installed = await call<PluginStatus[]>('list_plugins').catch(() => []);
  if (installed.length === 0) {
    treeEl.innerHTML = `<div class="nav-empty">无已安装插件</div>`;
    return;
  }
  const typeLabels: Record<string, string> = {
    theme: '主题',
    chatbot: '机器人',
    llm: 'LLM',
    general: '工具',
  };
  const groups: Record<string, PluginStatus[]> = {};
  for (const p of installed) {
    const label = typeLabels[p.plugin_type] || '其他';
    (groups[label] ||= []).push(p);
  }
  treeEl.innerHTML = Object.entries(groups)
    .map(
      ([cat, plugins]) => `
        <div class="nav-category">${cat}</div>
        ${plugins
          .map(
            (p) => `
          <div class="nav-channel" data-plugin="${p.name}">
            <span class="plugin-tree-dot ${p.enabled ? 'on' : ''}"></span>
            <span class="nav-channel-name">${esc(p.title)}</span>
          </div>`,
          )
          .join('')}`,
    )
    .join('');
}

export async function renderPluginsMain(main: HTMLElement): Promise<void> {
  if (state.pluginsTab === 'installed') {
    await renderInstalled(main);
  } else {
    await renderMarket(main);
  }
}

async function renderMarket(main: HTMLElement): Promise<void> {
  main.innerHTML = `
    <div class="plugin-installed-view">
      <div class="plugin-installed-head">
        <h2>插件市场</h2>
        <button class="plugin-icon-btn" id="plugin-market-refresh" title="刷新列表">${iconSvg('refresh-cw', { width: 14, height: 14 })}</button>
      </div>
      <div class="plugin-list" id="plugin-market-list"><div class="plugin-empty">加载插件列表…</div></div>
    </div>
  `;
  const pane = document.getElementById('plugin-market-list')!;
  document.getElementById('plugin-market-refresh')!.addEventListener('click', () => {
    void renderMarket(main);
  });

  const [available, installed] = await Promise.all([
    call<RegistryPlugin[]>('fetch_registry').catch(() => null),
    call<PluginStatus[]>('list_plugins').catch(() => []),
  ]);

  if (!available || available.length === 0) {
    pane.innerHTML = `<div class="plugin-empty">暂无可用插件</div>`;
    return;
  }

  const installedMap = new Map(installed.map((p) => [p.name, p]));

  pane.innerHTML = `${available
    .map((plugin) => {
      const inst = installedMap.get(plugin.name);
      const isInstalled = !!inst;
      return `
        <div class="plugin-row" data-name="${plugin.name}">
          <span class="p-name">${esc(plugin.title)}</span>
          <span class="plugin-desc">${esc(plugin.description)}</span>
          ${isInstalled
            ? `<button class="plugin-icon-btn plugin-install" disabled title="已安装">${iconSvg('check', { width: 14, height: 14 })}</button><button class="plugin-icon-btn danger plugin-uninstall" data-name="${plugin.name}" title="删除">${iconSvg('trash', { width: 14, height: 14 })}</button>`
            : `<button class="plugin-icon-btn plugin-install" data-name="${plugin.name}" title="安装">${iconSvg('download', { width: 14, height: 14 })}</button>`}
        </div>`;
    })
    .join('')}`;

  pane.querySelectorAll<HTMLButtonElement>('.plugin-install').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name!;
      btn.disabled = true;
      // 进度条插到按钮左边，按钮保留
      const bar = document.createElement('div');
      bar.className = 'plugin-progress';
      btn.parentElement!.insertBefore(bar, btn);
      try {
        const plugin = await call<RegistryPlugin>('install_plugin', { name });
        await loadPlugin(plugin.name, plugin.title);
        showToast(`已安装 ${plugin.title}`);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
      await renderMarket(main);
    });
  });

  pane.querySelectorAll<HTMLButtonElement>('.plugin-uninstall').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name!;
      showPluginConfirm(btn, `删除插件 "${name}"？`, async () => {
        unloadPlugin(name);
        await call('uninstall_plugin', { name });
        await renderMarket(main);
      });
    });
  });
}

async function renderInstalled(main: HTMLElement): Promise<void> {
  main.innerHTML = `
    <div class="plugin-installed-view">
      <div class="plugin-installed-head">
        <h2>已安装插件</h2>
        <button class="plugin-zip-btn" id="plugin-zip-btn" title="从磁盘安装 .zip 插件">+</button>
      </div>
      <input id="plugin-zip-input" type="file" accept=".zip" style="display:none" />
      <div class="plugin-list" id="plugin-installed-list"><div class="plugin-empty">加载中…</div></div>
    </div>
  `;

  document.getElementById('plugin-zip-btn')!.addEventListener('click', () => {
    document.getElementById('plugin-zip-input')!.click();
  });
  document.getElementById('plugin-zip-input')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const plugin = await call<RegistryPlugin>('install_plugin_from_zip', {
        dataBase64: btoa(binary),
      });
      await loadPlugin(plugin.name, plugin.title);
      showToast(`已安装 ${plugin.title}`);
      await renderInstalled(main);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
    (e.target as HTMLInputElement).value = '';
  });

  const listEl = document.getElementById('plugin-installed-list')!;
  const installed = await call<PluginStatus[]>('list_plugins').catch(() => []);

  if (installed.length === 0) {
    listEl.innerHTML = `<div class="plugin-empty">还没有安装插件</div>`;
    return;
  }

  listEl.innerHTML = installed
    .map(
      (p) => `
        <div class="plugin-row" data-name="${p.name}">
          <span class="p-name">${esc(p.title)}</span>
          <span class="plugin-enable-wrap">
            <label class="toggle-switch">
              <input type="checkbox" class="lm-toggle" data-name="${p.name}" ${p.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </span>
          <button class="plugin-icon-btn danger plugin-uninstall" data-name="${p.name}" title="删除">${iconSvg('trash', { width: 14, height: 14 })}</button>
        </div>`,
    )
    .join('');

  listEl.querySelectorAll<HTMLInputElement>('.lm-toggle').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const name = cb.dataset.name!;
      try {
        await call('toggle_plugin', { name, enabled: cb.checked });
        if (cb.checked) await loadPlugin(name);
        else unloadPlugin(name);
      } catch {
        cb.checked = !cb.checked;
      }
      await refreshPluginTree();
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.plugin-uninstall').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name!;
      showPluginConfirm(btn, `删除插件 "${name}"？`, async () => {
        unloadPlugin(name);
        await call('uninstall_plugin', { name });
        await renderInstalled(main);
        await refreshPluginTree();
      });
    });
  });
}
