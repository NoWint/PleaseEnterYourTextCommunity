// 深链处理(复刻 Delta Chat deeplink.rs):
// 注册 OPENPGP4FPR/dcaccount/dclogin scheme,浏览器点链接 → OS 唤起 PEYT →
// 本模块把 URL 存 PENDING 并通过 dc-event 事件桥发给前端处理。
//
// Windows 插件只在新进程读 argv;已运行实例靠 single-instance 转发 argv。
// 冷启动 URL 用 deep_link().get_current() 取;macOS 用 on_open_url(RunEvent::Opened)。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use crate::dto::DeepLinkPayload;

/// 待前端消费的深链 URL(单槽,覆盖去重)。
/// 冷启动(get_current)+ 热启动(single-instance argv)可能同 URL 多路进来,
/// 用单槽 Option 覆盖,避免重复处理。
static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// 注册的自定义 scheme(与 tauri.conf.json plugins.deep-link.desktop.schemes 一致)。
const KNOWN_SCHEMES: &[&str] = &["openpgp4fpr", "dcaccount", "dclogin"];

/// 聚焦主窗口 + 存入 PENDING + 发 dc-event 给前端。
pub fn handle_url(app: &AppHandle, url: &str) {
    // 聚焦主窗
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    // 存 PENDING(前端 take_pending_deeplink 消费,冷启动补收)
    if let Ok(mut p) = PENDING.lock() {
        *p = Some(url.to_string());
    }
    // 事件桥:复用 dc-event → 前端 onEvent('DeepLink')
    if let Err(e) = app.emit(
        "dc-event",
        DeepLinkPayload {
            typ: "DeepLink",
            url: url.to_string(),
        },
    ) {
        log::warn!("deeplink: emit failed: {e}");
    }
}

/// 从命令行参数提取深链 URL(single-instance / Windows argv)。
/// 参数里非可执行名的单个字符串,且 scheme ∈ 注册列表。
pub fn extract_url_from_args(args: Vec<String>) -> Option<String> {
    for arg in args {
        let lower = arg.to_lowercase();
        if KNOWN_SCHEMES.iter().any(|s| lower.starts_with(&format!("{s}:"))) {
            return Some(arg);
        }
        // https://i.delta.chat 或 https://peyt.yzjtiantian.cn 也收
        if lower.starts_with("https://i.delta.chat")
            || lower.starts_with("https://peyt.yzjtiantian.cn")
        {
            return Some(arg);
        }
    }
    None
}

/// 读取并清空 PENDING(前端冷启动补收,避免重复)。
pub fn take_pending() -> Option<String> {
    let mut p = PENDING.lock().unwrap();
    p.take()
}

/// 深链已运行时,前端主动轮询补收。
#[tauri::command]
pub fn take_pending_deeplink() -> Option<String> {
    take_pending()
}
