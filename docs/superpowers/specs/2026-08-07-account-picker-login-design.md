# 账号选择登录页设计

日期:2026-08-07
状态:设计定稿
范围:登录页改造为「账号选择 + 新建账号」,移除邮箱登录表单/密码/高级设置/深链登录。登出 = 进入账号选择(非真正退出)。

## 1. 背景与动机

### 1.1 现状

- 登录页(renderLogin):tabs「快速开始 / 邮箱登录」+ 邮箱登录含高级设置(imap/smtp) + 深链登录。
- 登出(`logout` 命令):stop_io 当前账号 + 清内存 current_id,**账号保留** → reload 进登录页。
- 已存账号 `list_accounts`(id/name/addr/is_current,**无头像**)、`switch_account` 本地切换。
- 所有 yzjtiantian.cn 账号都从客户端注册,客户端有私钥 → **邮箱登录(密码)不需要**。

### 1.2 目标

1. **登录页 = 账号选择**:有已存账号 → 显示账号卡(头像/username/mail),点击 `switch_account` 进入。
2. **新建账号**:「快速开始」改名「新建账号」,注册新账号并切换(无账号直接显示表单,有账号在下方提供入口)。
3. **移除**:邮箱登录表单、密码、高级设置(imap/smtp)、深链登录。域名限制通过「前缀 + 固定 @yzjtiantian.cn 后缀」从 UI 杜绝——但无登录表单后该限制自然失效(不再需要)。
4. **登出语义**:登出 ≠ 退出账号,仅 stop_io + 清 current → 进账号选择;选完/注册完才是真正切换/注册。

### 1.3 非目标

- 不改 core/账号存储(账号永久保留,无删除)。
- 不新增「退出并删除账号」。
- login 命令保留(向后兼容),但前端不再调用密码登录。

## 2. 登录页结构

### 2.1 有已存账号

```
login-wrap
  login-hero(logo / PEYT Studio / slogan)
  login-panel
    账号选择(标题「选择账号」)
      [账号卡 1]  avatar username mail
      [账号卡 2]  avatar username mail
      ...(点击 → switch_account → onSuccess 进主界面)
    ─── 分隔线 ───
    「新建账号」按钮(展开表单)
      显示名输入 → 创建按钮
```

### 2.2 无已存账号

```
login-panel
  「新建账号」表单(直接显示)
    显示名输入 → 创建按钮
```

## 3. 账号卡

- 头像(圆形,blobdir → transformBlobURL)、username(name)、mail(addr)。
- 当前选中账号带标记(is_current)。
- 点击 → `switch_account(id)` → `onSuccess()` 进主界面。
- 多账号可横向网格(2 列)或竖排;竖排简单,2 列紧凑。

## 4. 新建账号

- 「快速开始」改名「新建账号」。
- 表单:显示名输入 + 创建按钮 → `create_chatmail_account({displayName})` → onSuccess。
- 有账号时点击「新建账号」按钮展开表单(可收起);无账号直接显示。

## 4.1 操作按钮样式

- 所有操作按钮(新建账号、创建账号、账号卡点击区)内文字**水平垂直居中**(apple-design 对齐惯例)。
- 按钮使用 flex 居中(justify-content/align-items center),不使用 text-align 残留偏移。

## 5. 移除内容

| 移除 | 位置 |
|---|---|
| 邮箱登录表单(email/password/loginBtn)| login.ts |
| 高级设置(advancedToggle/advanced/8 字段/collectAdvanced)| login.ts |
| applyPendingDclogin(登录页深链预填)| login.ts |
| AdvancedConfig 接口 | login.ts |
| login 命令的 advanced 参数(保留命令兼容) | 后端可选 |

**深链 dclogin**:移除登录页预填后,deepLink.ts 对 dclogin 静默忽略(不再调 parse_dclogin 填表单)。yzjtiantian.cn 账号均从客户端注册,dcaccount 配置外部账号场景不存在。

## 6. 后端改动

### 6.1 AccountInfoDto 加 avatar

`list_accounts` 里为每个账号取 self 头像(与 get_self_profile 同法):

```rust
let avatar = deltachat::contact::Contact::get_by_id(ctx, deltachat::contact::ContactId::SELF)
    .await?
    .get_profile_image(ctx).await?
    .map(|p| p.to_string_lossy().to_string());
```

AccountInfoDto 加 `pub avatar: Option<String>`。

### 6.2 login 命令

保留(兼容旧客户端/测试),但前端不再调用。可选:移除 `advanced` 参数使签名简化,或保留。

## 7. 数据流

```
登出 → logout(stop_io + 清 current) → reload → is_configured=false → renderLogin
renderLogin → list_accounts
  ├─ 有账号 → 显示账号卡(avatar/name/addr) → 点击 switch_account(id) → onSuccess
  └─ 无账号 → 直接显示新建账号表单 → create_chatmail_account → onSuccess
```

## 8. 错误处理

- list_accounts 失败 → 显示新建账号表单(账号选择降级)。
- switch_account 失败 → toast。
- create_chatmail_account 失败 → 按钮恢复 + toast。
- 头像加载失败 → 首字母占位。

## 9. 测试

- 有账号:登录页显示账号卡,点击进入。
- 无账号:直接显示新建账号表单。
- 新建账号成功后进入主界面。
- 登出后回到账号选择。
- 头像:有则显示,无则首字母。

## 10. 兼容性

- 登出语义不变(现状已对)。
- login 命令保留,旧调用不受影响。
- 移除高级设置/深链:旧深链(带 imap 配置)静默忽略 advanced。
