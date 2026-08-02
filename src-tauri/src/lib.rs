mod commands;
mod db;
mod dto;
mod envelope;
mod error;
mod events;
mod plugins;
mod state;
mod terminal;

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
            events::spawn_event_forwarder(handle, state.accounts.clone());
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
            commands::create_group_chat,
            commands::create_chat_by_contact,
            commands::get_asset_url,
            commands::search_msgs,
            commands::get_all_messages,
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
            // Terminal
            terminal::open_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::close_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
