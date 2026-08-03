mod bot_llm;
mod bots;
mod commands;
mod db;
mod dto;
mod envelope;
mod error;
mod events;
mod llm;
mod plugins;
mod state;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("debug"))
        .format_timestamp_secs()
        .init();
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            let state = tauri::async_runtime::block_on(async move {
                AppState::new(dir).await
            })?;
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
            // 挂载 LLM 自动回复后台运行时(内部 spawn，单次调用)
            state.bots.spawn_runtime();
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
            commands::get_message_read_receipt_count,
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
            commands::bot_get_chatlist,
            commands::bot_get_chat_msgs,
            commands::bot_send_text,
            commands::bot_mark_chat_noticed,
            commands::bot_mark_chat_seen,
            commands::test_llm_config,
            commands::list_accounts,
            commands::switch_account,
            commands::add_bot_to_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
