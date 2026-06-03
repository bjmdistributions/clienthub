#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod commands;
mod csv_import;
mod db;
mod email;
mod geocode;
mod google_contacts;
mod invoice;
mod manifest;
mod oauth_flow;
mod signup_rules;
mod sync;
mod sync_crypto;
mod template;

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

            // Auto-backup: check on startup if last backup was > 23 hours ago.
            // Clone BEFORE the first spawn consumes app_handle.
            {
                let ah = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    if let Ok(status) = commands::get_backup_status().await {
                        let last = status.get("last_backup").and_then(|v| v.as_str());
                        let should_backup = match last {
                            None => true,
                            Some(ts) => {
                                let parsed = chrono::DateTime::parse_from_rfc3339(ts).ok();
                                parsed.map_or(true, |t| (chrono::Utc::now() - t.to_utc()).num_hours() >= 23)
                            }
                        };
                        if should_backup {
                            match commands::backup_database(None).await {
                                Ok(p) => tracing::info!("auto-backup: {}", p),
                                Err(e) => tracing::warn!("auto-backup failed: {}", e),
                            }
                        }
                    }
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(86400));
                    loop {
                        interval.tick().await;
                        match commands::backup_database(None).await {
                            Ok(p) => tracing::info!("periodic backup: {}", p),
                            Err(e) => tracing::warn!("periodic backup failed: {}", e),
                        }
                    }
                });
            }

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
                    Ok(summary) => tracing::info!("{}", summary.message),
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

            // Follow-up rules: check on startup (30s delay, skip if ran <6h ago) + every 6h
            {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    if let Ok(conn) = crate::db::pool().get() {
                        let last: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='last_rules_run'", [], |r| r.get(0)).ok();
                        let should_skip = last.map_or(false, |ts| {
                            chrono::DateTime::parse_from_rfc3339(&ts).ok()
                                .map_or(false, |t| (chrono::Utc::now() - t.to_utc()).num_hours() < 6)
                        });
                        if should_skip {
                            tracing::info!("followup rules: skipped (last run <6h ago)");
                        } else {
                            match commands::process_followup_rules().await {
                                Ok(entries) => tracing::info!("followup rules: {} actions", entries.len()),
                                Err(e) => tracing::warn!("followup rules failed: {}", e),
                            }
                        }
                    }
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(21600));
                    loop {
                        interval.tick().await;
                        match commands::process_followup_rules().await {
                            Ok(entries) => tracing::info!("followup rules: {} actions", entries.len()),
                            Err(e) => tracing::warn!("followup rules failed: {}", e),
                        }
                    }
                });
            }

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
            bulk_delete_clients,
            bulk_update_category,
            bulk_update_lead_status,
            export_clients_csv,
            export_invoices_csv,
            export_deals_csv,
            export_deal_flows_csv,
            export_inventory_csv,
            export_analytics_xlsx,
            search_clients,
            global_search,
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
            list_recurring_invoices,
            create_recurring_invoice,
            update_recurring_invoice,
            pause_recurring_invoice,
            resume_recurring_invoice,
            delete_recurring_invoice,
            generate_invoice_pdf,
            preview_invoice_pdf,
            send_invoice,
            mark_invoice_paid,
            list_quotes,
            list_quotes_for_client,
            get_quote,
            create_quote,
            update_quote,
            delete_quote,
            set_quote_status,
            generate_quote_pdf,
            send_quote,
            mark_quote_converted,
            get_quote_numbering_config,
            save_quote_numbering_config,
            save_invoice_costs,
            save_invoice_shipping,
            set_invoice_sent_date,
            // Invoice numbering
            get_invoice_numbering_config,
            save_invoice_numbering_config,
            // Payments
            list_payments,
            get_payment,
            create_payment_request,
            update_payment_status,
            mark_payment_failed,
            refund_payment,
            save_stripe_keys,
            get_stripe_config,
            delete_stripe_keys,
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
            google_contacts_oauth_start,
            google_contacts_list,
            google_contacts_import,
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
            // Backup
            backup_database,
            restore_database,
            list_backups,
            get_backup_status,
            // Users
            list_users,
            create_owner_user,
            invite_user,
            claim_invite,
            remove_user,
            update_user_role,
            get_current_user,
            set_current_user,
            // Inventory
            list_inventory,
            create_lot,
            update_lot,
            archive_lot,
            link_lot_to_deal,
            set_lot_status,
            import_lot_photos,
            media_base_dir,
            // Follow-up rules
            list_followup_rules,
            create_followup_rule,
            update_followup_rule,
            delete_followup_rule,
            toggle_followup_rule,
            process_followup_rules,
            get_followup_log,
            // Portal
            generate_portal_link,
            revoke_portal_link,
            list_portal_links,
            get_portal_base_url,
            save_portal_base_url,
            // Manifest
            analyze_manifest,
            // Forecast
            get_profit_forecast,
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
            push_desktop_smtp_to_pi,
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
            list_custom_fields,
            save_custom_field,
            delete_custom_field,
            get_sheet_headers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
