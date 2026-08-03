import { call } from '../api.js';
import { ui } from './ui.js';

// 备份与恢复对话框(对齐 Delta Backup.tsx)。
// 导出:设置加密密码后把完整数据(含密钥)导出为加密备份文件;
// 导入:选择备份文件路径 + 密码后恢复迁移到当前实例。
// 后端命令 get_appdata_dir / export_backup / import_backup 由主 Agent 在 commands.rs 实现。
// 说明:ui.dialog 的 body 是 HTML 字符串,输入值在点击时通过 querySelector 读取,不做双向绑定。
export async function openBackupDialog(): Promise<void> {
  // 先取应用数据目录,作为默认导出路径
  let appDataDir = '';
  try {
    appDataDir = await call<string>('get_appdata_dir');
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e));
  }
  const defaultPath = appDataDir ? joinDefaultBackupPath(appDataDir) : '';

  const dlg = ui.dialog({
    title: '备份与恢复',
    body: `
      <div style="margin-bottom:16px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:10px">导出备份</div>
        <div class="ui-field">
          <span class="ui-field-label">导出路径</span>
          <input id="bd-export-path" class="ui-input" type="text" value="${escapeHtml(defaultPath)}" placeholder="备份文件保存路径" />
        </div>
        <div class="ui-field">
          <span class="ui-field-label">加密密码</span>
          <input id="bd-export-pass" class="ui-input" type="password" placeholder="设置备份加密密码" />
        </div>
        <button id="bd-export-btn" class="ui-button ui-button-primary">导出备份</button>
      </div>
      <div class="ui-divider"></div>
      <div style="margin-top:16px">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:10px">导入备份</div>
        <div class="ui-field">
          <span class="ui-field-label">备份文件路径</span>
          <input id="bd-import-path" class="ui-input" type="text" placeholder="选择要导入的备份文件" />
        </div>
        <div class="ui-field">
          <span class="ui-field-label">加密密码</span>
          <input id="bd-import-pass" class="ui-input" type="password" placeholder="输入备份加密密码" />
        </div>
        <button id="bd-import-btn" class="ui-button ui-button-primary">导入备份</button>
      </div>
    `,
    actions: [ui.button({ label: '关闭', variant: 'ghost', onClick: () => dlg.close() })],
  });

  // 绑定导出按钮
  const exportBtn = dlg.overlay.querySelector<HTMLButtonElement>('#bd-export-btn');
  const exportPath = dlg.overlay.querySelector<HTMLInputElement>('#bd-export-path');
  const exportPass = dlg.overlay.querySelector<HTMLInputElement>('#bd-export-pass');
  exportBtn?.addEventListener('click', async () => {
    const path = (exportPath?.value || '').trim();
    const passphrase = exportPass?.value || '';
    if (!path) { ui.toast('请填写导出路径'); return; }
    if (!passphrase) { ui.toast('请设置加密密码'); return; }
    exportBtn.disabled = true;
    try {
      await call('export_backup', { path, passphrase });
      ui.toast('备份已导出');
      dlg.close();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    } finally {
      exportBtn.disabled = false;
    }
  });

  // 绑定导入按钮
  const importBtn = dlg.overlay.querySelector<HTMLButtonElement>('#bd-import-btn');
  const importPath = dlg.overlay.querySelector<HTMLInputElement>('#bd-import-path');
  const importPass = dlg.overlay.querySelector<HTMLInputElement>('#bd-import-pass');
  importBtn?.addEventListener('click', async () => {
    const path = (importPath?.value || '').trim();
    const passphrase = importPass?.value || '';
    if (!path) { ui.toast('请填写备份文件路径'); return; }
    if (!passphrase) { ui.toast('请输入加密密码'); return; }
    importBtn.disabled = true;
    try {
      await call('import_backup', { path, passphrase });
      ui.toast('备份已导入,重启应用后生效');
      dlg.close();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e));
    } finally {
      importBtn.disabled = false;
    }
  });

  exportPath?.focus();
}

function joinDefaultBackupPath(dir: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const base = dir.replace(/[\\/]+$/, '');
  return `${base}${sep}peyt-backup-${dateStamp()}.tar`;
}

function dateStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
