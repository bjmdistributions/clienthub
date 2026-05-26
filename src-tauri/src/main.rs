#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod commands;
mod csv_import;
mod db;
mod email;
mod geocode;
mod invoice;
mod oauth_flow;
mod signup_rules;
mod sync;
mod sync_crypto;

use commands::*;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            db::init(app)?;
            signup_rules::ensure_table()?;

            {
                if let Err(e) = geocode::init() {
                    tracing::warn!("geocode init failed: {}", e);
                }
            }

            // Sync folder lives next to the DB. Syncthing/Dropbox can target this.
            let sync_dir = db::app_data_dir().join("sync");
            sync::init(sync_dir)?;

            // AppHandle is Send + Clone — safe to move into async spawns.
            // tauri::App is NOT Send and must never be captured in a spawn.
            let app_handle = app.handle().clone();

            // Replay sync events, mark overdue invoices, fire follow-up notification.
            // All three run sequentially in one spawn so they share the same task context.
            tauri::async_runtime::spawn(async move {
                // 1. Replay peer sync events that arrived while offline.
                match sync::replay_all().await {
                    Ok(n) => tracing::info!("sync replay: applied {} events", n),
                    Err(e) => tracing::warn!("sync replay failed: {}", e),
                }

                // 2. Mark any sent invoices past their due date as overdue.
                match mark_overdue_invoices().await {
                    Ok(n) if n > 0 => tracing::info!("marked {} invoices overdue", n),
                    Err(e) => tracing::warn!("mark_overdue failed: {}", e),
                    _ => {}
                }

                // 2b. Generate recurring invoices that are due.
                match generate_recurring_invoices().await {
                    Ok(n) if n > 0 => tracing::info!("generated {} recurring invoices", n),
                    Err(e) => tracing::warn!("recurring failed: {}", e),
                    _ => {}
                }

                // 3. Fire a system notification if follow-ups are due today.
                match due_followups().await {
                    Ok(clients) if !clients.is_empty() => {
                        let _ = app_handle
                            .notification()
                            .builder()
                            .title("Follow-ups Due")
                            .body(format!(
                                "You have {} follow-up(s) due today",
                                clients.len()
                            ))
                            .show();
                    }
                    Err(e) => tracing::warn!("due_followups failed: {}", e),
                    _ => {}
                }
            });

            tauri::async_runtime::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                match commands::geocode_all_clients().await {
                    Ok(msg) => tracing::info!("{}", msg),
                    Err(e) => tracing::warn!("geocode_all failed: {}", e),
                }
            });

            // File watcher: react to incoming sync events from peers.
            if let Err(e) = sync::start_watcher() {
                tracing::warn!("sync watcher failed to start: {}", e);
            }

            // Periodic IMAP scan every 5 minutes.
            email::spawn_periodic_scan(300);

            // Periodic Google Sheets sync every 10 minutes
            commands::spawn_periodic_sheet_sync(600);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Clients
            list_clients,
            get_client,
            create_client,
            update_client,
            update_client_status,
            delete_client,
            search_clients,
            list_stale_clients,
            due_followups,
            list_clients_filtered,
            clients_missing_info,
            // Interactions
            list_interactions,
            add_interaction,
            // Invoices
            list_invoices,
            get_invoice,
            list_invoices_for_client,
            create_invoice,
            update_invoice,
            delete_invoice,
            mark_overdue_invoices,
            generate_recurring_invoices,
            generate_invoice_pdf,
            preview_invoice_pdf,
            send_invoice,
            mark_invoice_paid,
            save_invoice_costs,
            save_invoice_shipping,
            set_invoice_sent_date,
            detect_duplicate_clients,
            cleanup_clients,
            // Deals
            list_deals,
            list_deals_by_stage,
            get_deal,
            create_deal,
            update_deal,
            update_deal_stage,
            delete_deal,
            convert_deal_to_invoice,
            supplier_name_suggestions,
            // Deal Flows
            create_deal_flow,
            get_deal_flow_by_invoice,
            get_deal_flow,
            list_deal_flows,
            list_deal_flows_by_stage,
            mark_payment_received,
            unmark_payment_received,
            add_supplier_payment,
            update_supplier_payment,
            remove_supplier_payment,
            mark_supplier_payment_paid,
            unmark_supplier_payment_paid,
            complete_deal_flow,
            uncomplete_deal_flow,
            update_deal_completed_at,
            update_deal_flow_notes,
            update_deal_flow_name,
            delete_deal_flow,
            // Profit Split
            get_profit_split,
            save_profit_split,
            // Suppliers
            list_suppliers,
            get_supplier,
            create_supplier,
            update_supplier,
            archive_supplier,
            delete_supplier,
            search_suppliers,
            get_supplier_price_history,
            record_supplier_price,
            check_price_changes,
            revert_supplier_price_change,
            get_deal_flow_node_map,
            // Customer Health
            buyer_tiers,
            get_buyer_tier,
            generate_weekly_brief,
            pipeline_analytics,
            // Geocoding
            geocode_client,
            geocode_all_clients,
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
            get_onboarding_status,
            complete_onboarding,
            // Sync
            sync_replay,
            sync_status,
            sync_set_passphrase,
            sync_is_encrypted,
            // Dashboard
            dashboard_stats,
            get_monthly_profit,
            get_analytics_range,
            list_deals_for_supplier,
            // CSV import
            csv_preview,
            csv_import,
            // Signup rules
            list_signup_rules,
            create_signup_rule,
            delete_signup_rule,
            toggle_signup_rule,
            // Payment methods
            list_payment_methods,
            create_payment_method,
            update_payment_method,
            delete_payment_method,
            reorder_payment_methods,
            // Line item templates
            list_line_item_templates,
            create_line_item_template,
            delete_line_item_template,
            reorder_line_item_templates,
            // Email drafts
            list_drafts,
            update_draft,
            send_draft,
            discard_draft,
            // Newsletters
            list_newsletters,
            save_newsletter,
            delete_newsletter,
            send_newsletter,
            ai_draft_newsletter,
            // Scheduled Sends
            schedule_newsletter_send,
            cancel_scheduled_send,
            list_scheduled_sends,
            get_scheduled_send_progress,
            save_smtp_settings_for_pi,
            get_smtp_settings_for_pi,
            // Categories
            list_categories,
            create_category,
            update_category,
            delete_category,
            reorder_categories,
            // Sheet Sync
            get_sheet_sync_config,
            save_sheet_sync_config,
            sync_from_sheet,
            get_sheet_sync_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
