#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod commands;
mod csv_import;
mod db;
mod email;
mod invoice;
mod oauth_flow;
mod signup_rules;
mod sync;
mod sync_crypto;

use commands::*;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            db::init(app)?;
            signup_rules::ensure_table()?;

            // Sync folder lives next to the DB. Syncthing/Dropbox can target this.
            let sync_dir = db::app_data_dir().join("sync");
            sync::init(sync_dir)?;

            // Replay any events that arrived while we were offline.
            tauri::async_runtime::spawn(async move {
                match sync::replay_all().await {
                    Ok(n) => tracing::info!("sync replay: applied {} events", n),
                    Err(e) => tracing::warn!("sync replay failed: {}", e),
                }
            });

            // File watcher: react to incoming events from peers.
            if let Err(e) = sync::start_watcher() {
                tracing::warn!("sync watcher failed to start: {}", e);
            }

            // Periodic IMAP scan every 5 minutes.
            email::spawn_periodic_scan(300);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Clients
            list_clients,
            get_client,
            create_client,
            update_client,
            delete_client,
            search_clients,
            // Interactions
            list_interactions,
            add_interaction,
            // Invoices
            list_invoices,
            create_invoice,
            generate_invoice_pdf,
            send_invoice,
            mark_invoice_paid,
            // Email
            send_email,
            scan_inbox,
            oauth_start_consent,
            // AI
            ai_draft_reply,
            ai_extract_data,
            ai_suggest_invoice,
            ai_summarize_history,
            ai_health_check,
            ai_list_models,
            ai_set_model,
            // Settings & creds
            save_credential,
            delete_credential,
            save_email_settings,
            get_email_settings,
            save_company_info,
            get_company_info,
            // Sync
            sync_replay,
            sync_status,
            sync_set_passphrase,
            sync_is_encrypted,
            // Dashboard
            dashboard_stats,
            // CSV import
            csv_preview,
            csv_import,
            // Signup rules
            list_signup_rules,
            create_signup_rule,
            delete_signup_rule,
            toggle_signup_rule,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
