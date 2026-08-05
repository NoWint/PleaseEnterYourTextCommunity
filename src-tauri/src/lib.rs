mod activity;
mod bots;
mod commands;
mod db;
mod deeplink;
mod drivers;
mod dto;
mod envelope;
mod error;
mod events;
mod github;
mod llm;
mod notifications;
mod personas;
mod plugins;
mod runtime;
mod state;
mod summary;
#[cfg(target_os = "windows")]
mod titlebar;
mod tools;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 默认过滤:全局 info(压掉第三方 pgp:: 等 debug 刷屏),
    // 但 peytchat 自身保持 debug(事件转发/命令日志排查用)。
    // 覆盖规则:全局 info,peytchat=debug,pgp=warn(密钥解析只留警告)。
    // 用户可通过 RUST_LOG 环境变量覆盖。
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,peytchat=debug,pgp=warn"),
    )
        .format_timestamp_secs()
        .init();
    tauri::Builder::default()
        // 深链插件:注册 OPENPGP4FPR/dcaccount/dclogin scheme(tauri.conf.json 配置)。
        // single-instance:Windows 插件只在新进程读 argv,已运行实例靠它转发深链。
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 热启动:另一个实例把 argv(含深链 URL)转发到这里 → 处理并聚焦。
            if let Some(url) = deeplink::extract_url_from_args(args) {
                deeplink::handle_url(app, &url);
            }
        }))
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            let mut state = tauri::async_runtime::block_on(async move {
                AppState::new(dir).await
            })?;
            // 深链冷启动:get_current() 取当前实例启动时的 URL;macOS 用 on_open_url。
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                // Windows/Linux:冷启动 URL 从 get_current() 拿(读 argv)。
                #[cfg(not(target_os = "macos"))]
                {
                    if let Ok(Some(urls)) = handle.deep_link().get_current() {
                        if let Some(url) = urls.first() {
                            deeplink::handle_url(&handle, url.as_str());
                        }
                    }
                }
                // macOS:RunEvent::Opened → on_open_url。
                #[cfg(target_os = "macos")]
                {
                    let app_handle = app.handle().clone();
                    handle
                        .deep_link()
                        .on_open_url(move |event| {
                            if let Some(url) = event.urls().first() {
                                deeplink::handle_url(&app_handle, url.as_str());
                            }
                        });
                }
            }
            // 原生系统通知:注册点击回调(点击 → 聚焦窗口 + 事件给前端)。
            // app_id 用 bundle identifier (Windows AUMID),对齐 Delta 桌面端。
            let notif = notifications::Notifications::new(app.config().identifier.clone());
            notif.initialize(app.handle().clone());
            app.manage(notif);
            // Windows 无边框窗口:子类化窗口过程,让最大化/还原按钮区域返回 HTMAXBUTTON,
            // 从而在悬停时显示 Win11 原生 snap layout 分组弹窗(系统处理最大化/还原)。
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(hwnd) = win.hwnd() {
                    if let Err(e) = titlebar::install(hwnd) {
                        log::warn!("titlebar: failed to install wndproc: {e}");
                    }
                }
            }
            let handle = app.handle().clone();
            // 绑定 bot 账号 id 集合的 Arc，再传给事件转发器(过滤 bot 账号事件)
            let bot_ids = state.bots.bot_ids();
            events::spawn_event_forwarder(handle, state.accounts.clone(), bot_ids);
            // 自愈:若持久化选中的账号是 bot(历史 bug),切回其 owner 并同步内存 current_id
            if let Ok(Some(owner)) = tauri::async_runtime::block_on(state.bots.ensure_selected_not_bot()) {
                state.set_current(owner);
                log::warn!("healed: switched selected account to owner {owner}");
            }
            // 启动全部 bot 的 IO(bot 是应用级后台服务,不依赖当前账号);失败只记日志
            if let Err(e) = tauri::async_runtime::block_on(state.bots.start_all()) {
                log::warn!("failed to start bots: {e}");
            }
            // 活动日志:落库 + 实时 bot-activity 事件(时间线页/打字指示器通道)
            let activity = {
                let handle = app.handle().clone();
                crate::activity::ActivityLog::new(state.db.clone()).with_callback(move |a| {
                    use tauri::Emitter;
                    let _ = handle.emit("bot-activity", &a);
                })
            };
            use std::sync::Arc;
            // 工具桥:插件工具请求经 app.emit 推前端(B5 前端监听)
            let handle = app.handle().clone();
            let bridge = Arc::new(crate::tools::ToolBridge::new().with_emitter(move |v| {
                use tauri::Emitter;
                let _ = handle.emit("bot-tool-request", &v);
            }));
            let mut built = crate::tools::ToolRegistry::new(bridge);
            built.register(Arc::new(crate::tools::builtins::GetTimeTool));
            built.register(Arc::new(crate::tools::builtins::CalculateTool));
            built.register(Arc::new(crate::tools::builtins::ConvertUnitsTool));
            built.register(Arc::new(crate::tools::net::GetWeatherTool::new()));
            built.register(Arc::new(crate::tools::net::FetchUrlTool::new()));
            built.register(Arc::new(crate::tools::net::WebSearchTool::new()));
            built.register(Arc::new(crate::tools::file::ReadFileTool));
            built.register(Arc::new(crate::tools::file::WriteFileTool));
            built.register(Arc::new(crate::tools::file::ListFilesTool));
            built.register(Arc::new(crate::tools::app::SearchHistoryTool));
            built.register(Arc::new(crate::tools::app::CreateCardTool));
            built.register(Arc::new(crate::tools::app::SetReminderTool));
            // GitHub 工具集:共享 AppState.github(命令层/工具层单一数据源)
            let github_client = state.github.clone();
            built.register(Arc::new(crate::tools::github::GithubGetRepoTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubListIssuesTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubGetIssueTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubListPullsTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubGetPullTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubListCommitsTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubGetCommitTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubSearchRepoTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubSearchCodeTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubGetFileTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubGetReadmeTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubGetRepoEventsTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(crate::tools::github::GithubCreateIssueTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(
                crate::tools::github::GithubAddIssueCommentTool::new(github_client.clone()),
            ));
            built.register(Arc::new(crate::tools::github::GithubAddIssueLabelsTool::new(
                github_client.clone(),
            )));
            built.register(Arc::new(
                crate::tools::github::GithubCreatePrReviewCommentTool::new(github_client),
            ));
            // 从 db 加载插件工具(setup 闭包非 async,用 block_on)
            let rows = tauri::async_runtime::block_on(state.db.list_plugin_tools())?;
            built.reload_plugin_tools(&rows);
            let tool_registry = Arc::new(built);
            state.bot_tools = tool_registry.clone();

            // 驱动注册:规则 + LLM + 定时(cron)。顺序即优先级:
            // RuleDriver 在前 → 规则命中即短路,LLM 驱动不再被调用(spec §2.1)。
            let mut registry = crate::drivers::DriverRegistry::new();
            registry.register(Arc::new(crate::drivers::rule::RuleDriver::with_llm(
                Arc::new(crate::llm::LlmClient::new()),
            )));
            registry.register(Arc::new(crate::drivers::llm::LlmDriver::new(
                crate::llm::LlmClient::new(),
                tool_registry,
            )));
            registry.register(Arc::new(crate::drivers::schedule::ScheduleDriver));
            // 挂载事件调度器(常驻后台)
            tauri::async_runtime::spawn(crate::runtime::spawn(
                state.accounts.clone(),
                state.db.clone(),
                state.bots.bot_ids(),
                activity,
                registry,
                state.data_dir.clone(),
            ));
            // 主题总结服务:下载 + 队列 + 本地/API 推理(managed resource, 命令层共享)
            // 必须在 app.manage(state) 之前构建 —— SummaryService 需 state.db(Arc<Db> 可 clone)。
            {
                use tauri::Manager;
                // 注:dir 已 move 进 AppState::new(上方 async move),此处置用 state.data_dir(同路径)。
                let models_dir = state.data_dir.join("models");
                let engine_exe = if cfg!(target_os = "windows") { "llama-server.exe" } else { "llama-server" };
                let runner = Arc::new(crate::summary::runner::LocalRunner::new(models_dir.join(engine_exe)));
                // 默认档位 0.5b 的模型文件(切换由 summary_save_prefs 更新)
                let default_model = models_dir.join(crate::summary::downloader::ModelSize::B05.file_name());
                // setup 闭包非 async → block_on 跑 new()(内部含启动水合 await)
                let svc = tauri::async_runtime::block_on(crate::summary::commands::SummaryService::new(
                    app.handle().clone(), state.data_dir.clone(), runner, default_model, state.db.clone(),
                ));
                app.manage(svc);
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::is_configured,
            commands::login,
            commands::create_chatmail_account,
            commands::get_self_profile,
            commands::get_chatlist,
            commands::get_chat_info,
            commands::get_chat_msgs,
            commands::send_text,
            commands::get_contacts,
            commands::create_group,
            commands::add_group_member,
            commands::create_chat_by_email,
            commands::accept_chat,
            commands::block_chat,
            commands::delete_chat,
            commands::leave_group,
            commands::remove_group_member,
            commands::rename_group,
            commands::set_group_description,
            commands::set_group_avatar,
            commands::mark_chat_noticed,
            commands::mark_chat_seen,
            commands::get_securejoin_qr,
            commands::secure_join,
            commands::list_workspaces,
            commands::create_workspace,
            commands::join_workspace,
            commands::list_channels,
            commands::create_channel,
            commands::get_channel_pins,
            commands::toggle_pin,
            commands::list_roles,
            commands::create_role,
            commands::set_contact_role,
            commands::list_all_contact_roles,
            commands::send_reaction,
            commands::get_reactions,
            commands::send_reply,
            commands::get_channel_topic,
            commands::set_channel_topic,
            commands::validate_channels,
            commands::update_workspace,
            commands::delete_workspace,
            commands::leave_workspace,
            commands::update_channel,
            commands::delete_channel,
            commands::leave_channel,
            commands::update_profile,
            commands::save_avatar_from_bytes,
            commands::get_my_qr,
            commands::logout,
            commands::delete_msg,
            commands::forward_msg,
            commands::create_group_chat,
            commands::create_chat_by_contact,
            commands::get_asset_url,
            commands::search_msgs,
            commands::get_all_messages,
            commands::debug_chatlist,
            commands::create_card,
            commands::update_card,
            commands::delete_card,
            commands::list_cards,
            commands::get_card,
            commands::upsert_card_from_msg,
            commands::message_to_card,
            commands::update_channel_space_type,
            commands::get_channel_space_type,
            commands::ensure_peyt_studio,
            commands::join_peyt_studio,
            commands::join_peyt_channel,
            // SP6: Inbox + Activity
            commands::list_inbox_events,
            commands::mark_inbox_read,
            commands::mark_all_inbox_read,
            commands::get_inbox_unread_count,
            commands::list_activities,
            commands::record_inbox_event,
            // Plugin Commands
            commands::fetch_registry,
            commands::install_plugin,
            commands::install_plugin_from_zip,
            commands::uninstall_plugin,
            commands::list_plugins,
            commands::toggle_plugin,
            commands::get_plugin_js,
            // Delta 对齐批次 1
            commands::archive_chat,
            commands::set_chat_muted,
            commands::set_chat_pinned,
            commands::save_msg,
            commands::unsave_msg,
            commands::get_draft,
            commands::set_draft,
            // Delta 对齐批次 2
            commands::get_chat_media,
            commands::get_msg_file_text, // 媒体库正文搜索:提取附件文本
            commands::get_message_read_receipt_count,
            commands::get_message_read_receipts,
            commands::get_msg_read_counts,
            // 屏蔽列表 / 取消屏蔽
            commands::get_blocked_contacts,
            commands::unblock_contact,
            // Delta 对齐批次 3
            commands::send_voice,
            commands::get_webxdc_info,
            commands::get_webxdc_blob,
            commands::get_webxdc_status_updates,
            commands::send_webxdc_status_update,
            // Delta 对齐批次 4
            commands::get_appdata_dir,
            commands::export_self_keys,
            commands::import_self_keys,
            commands::export_backup,
            commands::import_backup,
            commands::get_contact_encryption_info,
            commands::get_chat_encryption_info,
            commands::get_self_encryption_info,
            // Bot 系统
            commands::create_bot,
            commands::list_bots,
            commands::delete_bot,
            commands::set_bot_io,
            commands::update_bot_llm,
            commands::get_bot_llm,
            commands::get_bot_config,
            commands::update_bot_config,
            commands::list_bot_personas,
            commands::apply_bot_persona,
            commands::get_bot_stats,
            commands::bot_get_chatlist,
            commands::bot_get_chat_msgs,
            commands::bot_send_text,
            commands::bot_mark_chat_noticed,
            commands::bot_mark_chat_seen,
            commands::test_llm_config,
            commands::list_accounts,
            commands::switch_account,
            commands::add_bot_to_chat,
            commands::bot_list_schedules,
            commands::bot_add_schedule,
            commands::bot_delete_schedule,
            commands::register_bot_tool,
            commands::unregister_bot_tool,
            commands::list_bot_tools,
            commands::bot_tool_result,
            commands::list_bot_activities,
            // D1 GitHub:界面命令层(Task 4)
            commands::get_github_settings,
            commands::set_github_token,
            commands::list_github_repos,
            commands::add_github_repo,
            commands::remove_github_repo,
            commands::github_repo,
            commands::github_list_issues,
            commands::github_get_issue,
            commands::github_list_pulls,
            commands::github_list_commits,
            commands::github_search_repo,
            commands::github_search_code,
            commands::github_list_events,
            commands::github_get_content,
            // 原生系统通知(user-notify)
            notifications::show_notification,
            notifications::get_notification_permission,
            notifications::request_notification_permission,
            notifications::request_attention,
            // 深链:前端冷启动补收 PENDING
            deeplink::take_pending_deeplink,
            commands::parse_dclogin,
            // 外链与链接预览(链接卡片)
            commands::open_external,
            commands::fetch_link_preview,
            // 联系人名片:解析 vCard 消息 + 共有会话 + 发送名片
            commands::get_msg_vcard,
            commands::list_common_chats,
            commands::send_vcard,
            // 附件发送(media 信封)
            commands::send_attachment,
            // 主题总结(LLM)
            summary::commands::summary_get_state,
            summary::commands::summary_save_prefs,
            summary::commands::summary_set_api,
            summary::commands::summary_clear_api,
            summary::commands::summary_download,
            summary::commands::summary_list_models,
            summary::commands::summary_enqueue,
            summary::commands::summary_load_cache,
            summary::commands::summary_save_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
