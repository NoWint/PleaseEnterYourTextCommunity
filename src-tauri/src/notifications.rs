// 原生系统通知 —— 复刻 Delta Chat 桌面端(user-notify crate)架构:
// 前端只调 invoke('show_notification'),Rust 侧用 user-notify 发系统原生通知
// (Windows: WinRT Toast / macOS: UNUserNotificationCenter / Linux: DBus)。
// 彻底摆脱浏览器 `Notification.requestPermission()` / `new Notification()`
// (WebView2 通知权限不稳定,且不构成"Windows 原生通知")。
//
// 权限:Windows/Linux 桌面通知权限默认授予(no-op);macOS 首次调用
// `first_time_ask_for_notification_permission()` 由系统弹询问。
// 点击:app 运行时 register 的 Activated 回调触发 → emit "dc-event" 给前端聚焦聊天;
// app 未运行时点击由系统经启动参数唤起(未注册协议,当前不做 deeplink)。

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use user_notify::{
    get_notification_manager, NotificationBuilder, NotificationManager, NotificationResponse,
    XdgNotificationCategory,
};

/// 通知点击载荷:写入 user_info,点击回调解码出 chat_id 供前端跳转。
const PAYLOAD_CHAT_ID: &str = "chat_id";

/// 系统通知点击事件(前端通过 onEvent('NotificationClick') 监听,复用 dc-event 桥)。
#[derive(Serialize, Clone)]
struct NotificationClickPayload {
    typ: &'static str,
    chat_id: u32,
}

pub struct Notifications {
    pub(crate) manager: Arc<dyn NotificationManager>,
}

impl Notifications {
    /// `app_id` = Windows AUMID(打包后由安装器注册;未打包时 CreateToastNotifierWithId
    /// 失败,user-notify 自动回退 mock manager,不报错)。
    /// `notification_protocol` 传 None:Windows 点击唤起走 toast.Activated(app 运行时),
    /// 不注册自定义 URI scheme(需要处理 deeplink 启动,超出当前范围)。
    pub fn new(app_id: String) -> Self {
        Self {
            manager: get_notification_manager(app_id, None),
        }
    }

    /// 注册点击回调:点击通知 → 聚焦窗口 + emit NotificationClick 事件。
    /// macOS/Linux 走 register;Windows 给每个 toast 注册 Activated 事件(app 运行时)。
    pub fn initialize(&self, app: AppHandle) {
        let app_clone = app.clone();
        let _ = self.manager.register(
            Box::new(move |response: NotificationResponse| {
                let app = app_clone.clone();
                tauri::async_runtime::spawn(async move {
                    // 点击通知 → 唤起并聚焦主窗口
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    if let Some(chat_id) = response
                        .user_info
                        .get(PAYLOAD_CHAT_ID)
                        .and_then(|s| s.parse::<u32>().ok())
                    {
                        let _ = app.emit(
                            "dc-event",
                            NotificationClickPayload {
                                typ: "NotificationClick",
                                chat_id,
                            },
                        );
                    }
                });
            }),
            Vec::new(),
        );
    }
}

/// 发原生通知。前端 shell.ts 在收到新消息且当前聊天不是该会话时调用。
#[tauri::command]
pub async fn show_notification(
    state: State<'_, Notifications>,
    title: String,
    body: String,
    chat_id: Option<u32>,
    icon: Option<String>,
) -> Result<(), String> {
    let mut builder = NotificationBuilder::new()
        .title(&title)
        .body(&body)
        .set_thread_id(&format!(
            "peyt-{}",
            chat_id.map(|c| c.to_string()).unwrap_or_default()
        ))
        .set_xdg_category(XdgNotificationCategory::ImReceived);
    if let Some(chat_id) = chat_id {
        let mut user_info = HashMap::new();
        user_info.insert(PAYLOAD_CHAT_ID.to_string(), chat_id.to_string());
        builder = builder.set_user_info(user_info);
    }
    if let Some(icon) = icon.filter(|p| !p.is_empty()) {
        // Windows toast 用 set_icon(圆形头像);macOS/Linux 用 set_image 展示
        let icon_path = PathBuf::from(icon);
        #[cfg(target_os = "windows")]
        {
            builder = builder.set_icon(icon_path).set_icon_round_crop(true);
        }
        #[cfg(not(target_os = "windows"))]
        {
            builder = builder.set_image(icon_path);
        }
    }
    state
        .manager
        .send_notification(builder)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 系统通知权限状态(设置页显示;Windows/Linux 恒 true,macOS 区分授权/拒绝)。
#[tauri::command]
pub async fn get_notification_permission(
    state: State<'_, Notifications>,
) -> Result<bool, String> {
    state
        .manager
        .get_notification_permission_state()
        .await
        .map_err(|e| e.to_string())
}

/// 触发系统通知权限请求(前端在用户开启通知开关时调用)。
#[tauri::command]
pub async fn request_notification_permission(
    state: State<'_, Notifications>,
) -> Result<bool, String> {
    state
        .manager
        .first_time_ask_for_notification_permission()
        .await
        .map_err(|e| e.to_string())
}
