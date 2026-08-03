import { call } from '../api.js';
import { ui } from './ui.js';

// 多设备绑定:导出本机密钥供第二台设备导入(对齐 Delta SetupMultiDevice)。
// 导出:把本机账号密钥写入 peyt-selfkeys.tar,拷贝到第二台设备;
// 导入:在第二台设备上选择该文件,同步登录同一账号(重启生效)。
// 后端命令 get_appdata_dir / export_self_keys / import_self_keys 由主 Agent 在 commands.rs 实现。
// 说明:ui.dialog 的 body 是 HTML 字符串,输入值在点击时通过 querySelector 读取,不做双向绑定。
export async function openMultiDeviceSetup(): Promise<void> {
  // 先取应用数据目录,作为默认导出路径
  let appDataDir = '';
  try {
    appDataDir = await call<string>('get_appdata_dir');
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
  const defaultPath = appDataDir ? joinDefaultKeysPath(appDataDir) : '';

  const dlg = ui.dialog({
    title: '多设备绑定',
    body: `
      <div style="font-size:13px;color:var(--text);margin-bottom:16px">
        导出本机密钥文件,在第二台设备上导入即可登录同一账号并同步数据。
      </div>
      <div style="margin-bottom:16px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:10px">导出密钥</div>
        <div class="ui-field">
          <span class="ui-field-label">导出路径</span>
          <input id="md-export-path" class="ui-input" type="text" value="${escapeHtml(defaultPath)}" placeholder="密钥文件保存路径" />
        </div>
        <button id="md-export-btn" class="ui-button ui-button-primary">导出密钥</button>
      </div>
      <div class="ui-divider"></div>
      <div style="margin-top:16px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:10px">导入密钥</div>
        <div class="ui-field">
          <span class="ui-field-label">密钥文件路径</span>
          <input id="md-import-path" class="ui-input" type="text" placeholder="选择导出的密钥文件" />
        </div>
        <button id="md-import-btn" class="ui-button ui-button-primary">导入密钥</button>
      </div>
    `,
    actions: [ui.button({ label: '关闭', variant: 'ghost', onClick: () => dlg.close() })],
  });

  // 绑定导出按钮
  const exportBtn = dlg.overlay.querySelector<HTMLButtonElement>('#md-export-btn');
  const exportPath = dlg.overlay.querySelector<HTMLInputElement>('#md-export-path');
  exportBtn?.addEventListener('click', async () => {
    const path = (exportPath?.value || '').trim();
    if (!path) { ui.toast('请填写导出路径'); return; }
    exportBtn.disabled = true;
    try {
      await call('export_self_keys', { path });
      ui.toast('密钥已导出,可在第二台设备导入');
      dlg.close();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    } finally {
      exportBtn.disabled = false;
    }
  });

  // 绑定导入按钮
  const importBtn = dlg.overlay.querySelector<HTMLButtonElement>('#md-import-btn');
  const importPath = dlg.overlay.querySelector<HTMLInputElement>('#md-import-path');
  importBtn?.addEventListener('click', async () => {
    const path = (importPath?.value || '').trim();
    if (!path) { ui.toast('请填写密钥文件路径'); return; }
    importBtn.disabled = true;
    try {
      await call('import_self_keys', { path });
      ui.toast('密钥已导入,重启应用后生效');
      dlg.close();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    } finally {
      importBtn.disabled = false;
    }
  });

  exportPath?.focus();
}

function joinDefaultKeysPath(dir: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const base = dir.replace(/[\\/]+$/, '');
  return `${base}${sep}peyt-selfkeys.tar`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
