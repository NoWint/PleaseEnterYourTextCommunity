# 账号选择登录页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把登录页从「快速开始/邮箱登录」双 tab 改造为「账号选择 + 新建账号」,移除邮箱/密码/高级设置/深链登录预填,登出进入账号选择。

**Architecture:** 后端 `AccountInfoDto` 加 `avatar` 字段,`list_accounts`/`switch_account` 各自取 self 头像(与 `get_self_profile` 同法)。前端 `login.ts` 重写:`renderLogin` → `list_accounts` → 有账号显示账号卡(点击 `switch_account` 进主界面)+「新建账号」按钮(展开表单),无账号直接显示表单。`deepLink.ts` 对 dclogin/dcaccount 静默忽略。`login` 命令保留不改。

**Tech Stack:** Tauri v2, Vanilla TS, deltachat core(不改),Vite。无前端测试框架,验证 = `npx tsc --noEmit` + `npm run build` + 手动 `tauri dev`。

---

### Task 1: 后端 AccountInfoDto 加 avatar

**Files:**
- Modify: `src-tauri/src/dto.rs:984-991`
- Modify: `src-tauri/src/commands.rs:3924-3963`

背景:`AccountInfoDto` 仅两处构造(commands.rs:3934、3960),加字段必须同步。头像取值方法与 `get_self_profile`(commands.rs:227-231)一致:`Contact::get_by_id(&ctx, ContactId::SELF)` → `get_profile_image`。`Contact`/`ContactId`/`Context` 均已 import(commands.rs:5,7,9)。

**注意:本任务修改 src-tauri,按用户偏好默认不跑 cargo check(连带编译 core 5-7 分钟)。改动是「加一个字段 + 一处 self 头像获取」,仔细对照下述代码,保证语义与 `get_self_profile` 完全一致即可。**

- [ ] **Step 1: dto.rs 加 avatar 字段**

把 `AccountInfoDto` 改为:

```rust
/// 账号信息(切换账号列表用)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfoDto {
    pub id: u32,
    pub name: String,
    pub addr: String,
    pub is_current: bool,
    /// self 头像 blobdir 绝对路径;无头像/读取失败为 None。
    pub avatar: Option<String>,
}
```

- [ ] **Step 2: commands.rs 加 self_avatar 辅助函数**

紧挨 `list_accounts`(命令注释「/// 列出所有账号…」前)插入:

```rust
/// 取账号自身头像路径(blobdir 绝对路径),失败降级 None。list_accounts/switch_account 共用。
async fn self_avatar(ctx: &Context) -> Option<String> {
    match Contact::get_by_id(ctx, ContactId::SELF).await {
        Ok(c) => match c.get_profile_image(ctx).await {
            Ok(p) => p.map(|p| p.to_string_lossy().to_string()),
            Err(_) => None,
        },
        Err(_) => None,
    }
}
```

- [ ] **Step 3: list_accounts 填充 avatar**

`list_accounts` 内 push 处改为:

```rust
        out.push(crate::dto::AccountInfoDto {
            id,
            name,
            addr,
            is_current,
            avatar: self_avatar(&ctx).await,
        });
```

(`ctx` 是 `accounts.get_account(id)` 解出的 owned `Context`,与现有 `ctx.get_config` 用法一致。)

- [ ] **Step 4: switch_account 填充 avatar**

`switch_account` 的 return 处改为:

```rust
        return Ok(crate::dto::AccountInfoDto { id, name, addr, is_current: true, avatar: self_avatar(&ctx).await });
```

- [ ] **Step 5: 检查字段唯一性**

```bash
cd "E:\WechatDevelop\PEYT Community"
grep -rn "AccountInfoDto {" src-tauri/src/
```

Expected: 只有 commands.rs 两处构造,均已加 `avatar`;dto.rs 结构体含新字段。若有遗漏构造点,补上 `avatar: None`。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/dto.rs src-tauri/src/commands.rs
git commit -m "feat(login): AccountInfoDto 加 avatar, list_accounts/switch_account 返回 self 头像"
```

---

### Task 2: 重写 login.ts 为账号选择 + 新建账号

**Files:**
- Modify: `src/views/login.ts`(整体重写)

彻底替换 login.ts 全部内容。移除:AdvancedConfig、handleProgress、邮箱表单、tab、高级设置、applyPendingDclogin、collectAdvanced。保留:hero 外壳 + glass 卡片(`.login-panel`/`.login-form` 结构不变),新账号创建逻辑沿用原「快速开始」提交(create_chatmail_account + ConfigureProgress)。

完整新内容:

```ts
import { call, onEvent, transformBlobURL } from '../api.js';
import type { DcEvent } from '../api.js';
import { ui } from '../components/ui.js';

interface AccountInfo {
  id: number;
  name: string;
  addr: string;
  is_current: boolean;
  avatar: string | null;
}

export function renderLogin(onSuccess: () => void | Promise<void>): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-hero">
        <img class="login-hero-logo" src="/logo.jpg" alt="PEYT Studio" />
        <h1 class="login-hero-title">PEYT Studio</h1>
        <p class="login-hero-slogan">Type Everything</p>
      </div>
      <div class="login-panel">
        <div class="login-form" id="login-form"></div>
      </div>
    </div>
  `;
  const form = app.querySelector<HTMLElement>('#login-form')!;
  void initLogin(form, onSuccess);
}

async function initLogin(form: HTMLElement, onSuccess: () => void | Promise<void>): Promise<void> {
  let accounts: AccountInfo[] = [];
  try {
    accounts = await call<AccountInfo[]>('list_accounts');
  } catch (e) {
    console.warn('[login] list_accounts 失败,降级为新建账号表单', e);
  }
  if (accounts.length > 0) {
    renderAccountPicker(form, accounts, onSuccess);
  } else {
    renderNewAccount(form, onSuccess);
  }
}

// ── 账号选择:账号卡 + 「新建账号」入口 ─────────────────
function renderAccountPicker(form: HTMLElement, accounts: AccountInfo[], onSuccess: () => void | Promise<void>): void {
  const title = document.createElement('h2');
  title.className = 'login-accounts-title';
  title.textContent = '选择账号';
  form.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'login-accounts';
  for (const a of accounts) grid.appendChild(accountCard(a, onSuccess));
  form.appendChild(grid);

  const sep = document.createElement('div');
  sep.className = 'login-separator';
  form.appendChild(sep);

  const newBtn = ui.button({ label: '新建账号', variant: 'ghost' });
  newBtn.id = 'login-new-account-btn';
  newBtn.classList.add('login-new-account');
  form.appendChild(newBtn);

  const newForm = document.createElement('form');
  newForm.id = 'login-new-form';
  newForm.className = 'login-new-form';
  newForm.hidden = true;
  bindNewAccountForm(newForm, onSuccess);
  form.appendChild(newForm);

  newBtn.addEventListener('click', () => { newForm.hidden = !newForm.hidden; });
}

function accountCard(a: AccountInfo, onSuccess: () => void | Promise<void>): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'login-account-card';

  const avatar = document.createElement('div');
  avatar.className = 'login-account-avatar';
  const letter = (a.name || '?').charAt(0).toUpperCase();
  avatar.textContent = letter;
  if (a.avatar) {
    void transformBlobURL(a.avatar).then((url) => {
      if (url) { avatar.innerHTML = `<img src="${url}" alt="" />`; }
    });
  }

  const meta = document.createElement('div');
  meta.className = 'login-account-meta';
  const name = document.createElement('div');
  name.className = 'login-account-name';
  name.textContent = a.name || a.addr || `账号 ${a.id}`;
  const mail = document.createElement('div');
  mail.className = 'login-account-mail';
  mail.textContent = a.addr;
  meta.append(name, mail);

  btn.append(avatar, meta);

  if (a.is_current) {
    const tag = document.createElement('span');
    tag.className = 'login-account-current';
    tag.textContent = '当前';
    btn.appendChild(tag);
  }

  btn.addEventListener('click', async () => {
    if (a.is_current) { await onSuccess(); return; }
    btn.disabled = true;
    try {
      await call('switch_account', { id: a.id });
      await onSuccess();
    } catch (e) {
      btn.disabled = false;
      ui.toast(e instanceof Error ? e.message : String(e));
    }
  });
  return btn;
}

// ── 新建账号表单 ──────────────────────────────────────
function renderNewAccount(form: HTMLElement, onSuccess: () => void | Promise<void>): void {
  const formEl = document.createElement('form');
  formEl.id = 'login-new-form';
  formEl.className = 'login-new-form';
  bindNewAccountForm(formEl, onSuccess);
  form.appendChild(formEl);
}

function bindNewAccountForm(formEl: HTMLFormElement, onSuccess: () => void | Promise<void>): void {
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '输入显示名，自动创建 yzjtiantian.cn 免费账号，立即开始聊天。';
  const displayName = ui.input({ placeholder: '显示名（如：张三）' });
  displayName.id = 'display-name';
  displayName.required = true;
  displayName.maxLength = 60;
  const createBtn = ui.button({ label: '创建账号' });
  createBtn.id = 'login-create-btn';
  formEl.append(hint, displayName, createBtn);

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = displayName.value.trim() || '';
    if (!name) return;
    createBtn.disabled = true;
    createBtn.textContent = '创建中…';
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onEvent('ConfigureProgress', (p: DcEvent) => {
        const progress = p.progress as number;
        if (progress === 0) createBtn.textContent = '失败…';
        else if (progress >= 1000) createBtn.textContent = '成功，正在进入…';
        else if (progress > 0) createBtn.textContent = `${Math.floor(progress / 10)}%`;
        if (p.comment) console.log('[configure]', p.comment);
      });
    } catch {}
    try {
      await call('create_chatmail_account', { displayName: name });
      if (unlisten) unlisten();
      await onSuccess();
    } catch {
      if (unlisten) unlisten();
      createBtn.disabled = false;
      createBtn.textContent = '创建账号';
    }
  });
}
```

- [ ] **Step 1: 整体替换 login.ts**

用上述代码 `Write` 覆盖 `src/views/login.ts`。

- [ ] **Step 2: 确认无残留引用**

```bash
cd "E:\WechatDevelop\PEYT Community"
grep -rn "applyPendingDclogin\|AdvancedConfig\|collectAdvanced\|handleProgress\|邮箱登录\|高级设置" src/ --include=*.ts
```

Expected: 只剩 deepLink.ts 对 applyPendingDclogin 的 import(下一 Task 处理);login.ts 内不应再有以上标识。

- [ ] **Step 3: Commit**

```bash
git add src/views/login.ts
git commit -m "feat(login): 登录页改为账号选择 + 新建账号, 移除邮箱/密码/高级设置"
```

---

### Task 3: deepLink.ts 对 dclogin 静默忽略

**Files:**
- Modify: `src/utils/deepLink.ts:46-57`(routeDeepLink 的 dclogin 分支)
- Modify: `src/utils/deepLink.ts:91-99`(processPendingDeepLink 的 pendingDclogin 块)

所有 yzjtiantian.cn 账号均从客户端注册,客户端持私钥 → 无外部账号(dclogin/dcaccount)登录场景。移除登录页预填后,深链对 dclogin 静默忽略,不再调 parse_dclogin 填表单。

- [ ] **Step 1: routeDeepLink 的 dclogin 分支改为静默返回**

把 routeDeepLink 内第 46-57 行整段:

```ts
    const lower = url.toLowerCase();
    // 2. dclogin:/dcaccount: → 登录页预填
    if (lower.startsWith('dclogin:') || lower.startsWith('dcaccount:')) {
      const info = await call<{ email: string; advanced: unknown }>('parse_dclogin', { url });
      localStorage.setItem('peyt.pendingDclogin', JSON.stringify(info));
      // 切到登录页(若已配置账号则提示)
      const { renderMain } = await import('../shell/navPanel.js');
      state.currentPage = 'settings';
      saveState();
      await renderMain();
      showToast('已解析登录链接,请在设置账号中完成登录');
      return;
    }
```

替换为:

```ts
    const lower = url.toLowerCase();
    // 2. dclogin:/dcaccount: → 静默忽略(所有账号均从客户端注册,无外部账号登录)
    if (lower.startsWith('dclogin:') || lower.startsWith('dcaccount:')) {
      return;
    }
```

- [ ] **Step 2: 移除 processPendingDeepLink 的 pendingDclogin 块**

把 processPendingDeepLink 末尾的注释 + 整个 `try { const pending = localStorage... }` 块(第 91-99 行)删掉,函数体只保留 `take_pending_deeplink`:

```ts
/** 冷启动补收:应用启动后取 Rust PENDING 深链(启动早于事件注册时用)。 */
export async function processPendingDeepLink(): Promise<void> {
  try {
    const url = await call<string | null>('take_pending_deeplink');
    if (url) void routeDeepLink(url);
  } catch { /* 无 pending 忽略 */ }
}
```

- [ ] **Step 3: 确认无残留引用**

```bash
cd "E:\WechatDevelop\PEYT Community"
grep -rn "pendingDclogin\|applyPendingDclogin\|parse_dclogin" src/
```

Expected: `parse_dclogin` 只出现在 src-tauri(命令保留);src 下无 pendingDclogin / applyPendingDclogin 引用。若 deepLink.ts 顶部 import 的 `state`/`saveState`/`showToast` 因此变成未使用 → tsc 会报 noUnusedLocals(见 Task 5 验证),视报错删掉对应 import 行。

- [ ] **Step 4: Commit**

```bash
git add src/utils/deepLink.ts
git commit -m "feat(login): deepLink 对 dclogin/dcaccount 静默忽略, 移除登录预填逻辑"
```

---

### Task 4: styles.css 账号卡样式 + 按钮文字居中 + 移除死样式

**Files:**
- Modify: `src/styles.css:275-288`(login-form .ui-button 加 justify-content)
- Modify: `src/styles.css:290-338`(删 tabs/tab/tab-panel/advanced/link,新增账号卡样式)

- [ ] **Step 1: 操作按钮内文字居中**

`.login-form .ui-button`(第 275-285 行)规则内,在 `width: 100%;` 后加一行:

```css
  width: 100%;
  justify-content: center;   /* 操作按钮内文字水平居中(Apple §1 对齐惯例) */
  padding: 15px 16px;
```

- [ ] **Step 2: 删除 tabs/tab/tab-panel/advanced/link 死样式**

删除以下整块(第 290-338 行,含中间注释行;保留第 330 行 `.login-form .hint` 不动):

1. `/* 登录页 tab 切换... */` 注释 + `.login-form .tabs { ... }` + `.login-form .tab { ... }` + `.login-form .tab:hover { ... }` + `.login-form .tab.active { ... }`(第 290-308 行)
2. `.login-form .tab-panel { ... }` + `.login-form .tab-panel:not([hidden]) { ... }` + `.login-form .tab-panel[hidden] { ... }`(第 309-311 行)——保留 `@keyframes login-panel-in`(第 312-315 行),后续用它给 `.login-new-form` 入场动画
3. `@media (prefers-reduced-motion: reduce)` 内的 `.login-form .tab-panel:not([hidden])` 选择器改为 `.login-form .login-new-form:not([hidden])`(第 316-318 行)
4. `/* 高级设置折叠区 */` 注释 + `.login-form .advanced` 两块(第 320-328 行)
5. `/* 文本链接按钮... */` 注释 + `.login-form .link` 两块(第 332-338 行)

- [ ] **Step 3: 新增账号选择样式**

在 `.login-form .hint`(第 330 行)之后、四栏外壳注释之前插入:

```css
/* 账号选择:标题 + 2 列账号卡 */
.login-accounts-title {
  margin: 0; font-size: 15px; font-weight: 600; color: var(--text);
}
.login-accounts {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
}
.login-account-card {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--border-strong) 26%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--capsule) 55%, transparent);
  cursor: pointer; text-align: left; font-family: var(--font);
  transition: transform 140ms var(--ease-out), border-color 180ms var(--ease-out), box-shadow 180ms var(--ease-out);
}
.login-account-card:hover {
  border-color: color-mix(in srgb, var(--text) 18%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, #000 14%, transparent);
}
.login-account-card:active { transform: scale(0.97); }
.login-account-card:disabled { opacity: 0.5; cursor: default; }
.login-account-avatar {
  flex: none; width: 40px; height: 40px; border-radius: 50%; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 600; color: #fff;
  background: var(--border-strong);
}
.login-account-avatar img { width: 100%; height: 100%; object-fit: cover; }
.login-account-meta {
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.login-account-name {
  font-size: 14px; font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.login-account-mail {
  font-size: 12px; color: var(--text-mute);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.login-account-current {
  margin-left: auto; flex: none;
  padding: 2px 8px; border-radius: 999px;
  font-size: 11px; color: var(--text-weak);
  background: color-mix(in srgb, var(--capsule) 80%, transparent);
}
.login-separator { height: 1px; background: color-mix(in srgb, var(--border-strong) 30%, transparent); margin: 4px 0; }
/* 新建账号:ghost 全宽按钮 + 折叠表单 */
.login-new-account { width: 100%; }
.login-new-form { flex-direction: column; gap: 14px; }
.login-new-form:not([hidden]) { display: flex; animation: login-panel-in 240ms var(--ease-out); }
.login-new-form[hidden] { display: none; }
```

- [ ] **Step 4: 验证 CSS 无语法错**

```bash
cd "E:\WechatDevelop\PEYT Community"
npm run build
```

Expected: `vite build` 成功(此前改错花括号会导致失败)。若失败,定位 styles.css 报错行修复(最常见:花括号不成对)。

- [ ] **Step 5: Commit**

```bash
git add src/styles.css
git commit -m "feat(login): 账号卡样式 + 操作按钮文字居中, 移除 tab/高级设置死样式"
```

---

### Task 5: 类型检查 + 全量构建 + 手动验证

**Files:** 无代码改动,仅验证。

- [ ] **Step 1: TypeScript 类型检查**

```bash
cd "E:\WechatDevelop\PEYT Community"
npx tsc --noEmit
```

Expected: 0 报错。若 Task 3 后 deepLink.ts 出现未使用 import(noUnusedLocals),删除对应行;若 login.ts 有类型问题,对照 Task 2 代码修正。

- [ ] **Step 2: Vite 全量构建**

```bash
npm run build
```

Expected: `vite build` 成功,dist 生成。

- [ ] **Step 3: 手动验证(tauri dev)**

```bash
npm run tauri dev
```

(首次会编译 core,5-7 分钟;按用户偏好仅在最终验证时跑一次。)

验证清单:

| 场景 | 预期 |
|---|---|
| 已有 ≥1 账号,启动 | 登录页显示「选择账号」+ 账号卡(头像/name/mail),无邮箱登录 |
| 点击账号卡 | 进入主界面(switch_account 生效) |
| 点「当前」账号卡 | 直接进入主界面 |
| 有账号时点「新建账号」 | 展开表单,输入显示名 → 创建 → 进入主界面 |
| 无账号,启动 | 直接显示新建账号表单 |
| 设置 → 登出 | 回登录页 → 显示账号选择 |
| 有账号无头像 | 账号卡显示首字母占位 |
| 所有操作按钮 | 文字水平垂直居中 |
| 收到 dclogin:/dcaccount: 深链 | 无反应(静默忽略,不弹 toast 不跳页) |

- [ ] **Step 4: 全部提交后确认工作区干净**

```bash
git status
```

Expected: 无未提交改动(windowControls.ts 的未提交改动除外——那是既有状态,不动它)。

---

## Self-Review

**Spec coverage:**
- §2 登录页结构(有/无账号两分支)→ Task 2(renderAccountPicker/renderNewAccount)✓
- §3 账号卡(头像/name/mail/is_current/点击 switch)→ Task 2 accountCard ✓
- §4 新建账号(改名 + 表单 + 有账号时折叠)→ Task 2 ✓
- §4.1 操作按钮文字居中 → Task 4 Step 1(justify-content:center)✓
- §5 移除(邮箱表单/高级设置/applyPendingDclogin/AdvancedConfig)→ Task 2;深链 dclogin 静默 → Task 3 ✓
- §6.1 AccountInfoDto avatar → Task 1 ✓;§6.2 login 命令保留不改 ✓
- §7 数据流 → Task 1-3 实现 ✓
- §8 错误处理:list_accounts 失败降级表单 → Task 2 initLogin catch;switch 失败 toast → accountCard catch;创建失败按钮恢复 → bindNewAccountForm catch;头像失败首字母 → accountCard 先渲染字母再异步替换 ✓
- §9 测试 → Task 5 手动清单 ✓
- §10 兼容性:logout 语义不变、login 保留 ✓

**Placeholder scan:** 无 TBD/TODO;所有代码步骤给出完整代码。✓

**Type consistency:**
- `AccountInfoDto.avatar: Option<String>` ↔ TS `avatar: string | null` ✓(tauri 反序列化 null → null)
- `self_avatar(ctx: &Context) -> Option<String>` 在 list_accounts/switch_account 内均以 `&ctx` 调用(`ctx` 为 owned `Context`)✓
- 类名 `login-accounts-title/login-accounts/login-account-card/login-account-avatar/login-account-meta/login-account-name/login-account-mail/login-account-current/login-separator/login-new-account/login-new-form` 在 Task 2 TS 与 Task 4 CSS 完全一致 ✓
- `login-new-form` 的 `[hidden]`/`:not([hidden])` 规则与 renderAccountPicker 里 `newForm.hidden = true` 及 toggle 匹配 ✓
