#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod checkups;
mod commands;
mod csv_import;
mod db;
mod email;
mod employees;
mod form_parser;
mod geocode;
mod google_contacts;
mod invoice;
mod manifest;
mod oauth_flow;
mod sheet_clone;
mod sheet_writeback;
mod signup_rules;
mod netsync;
mod sync;
mod sync_crypto;
mod template;

use commands::*;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

/// Append a startup/diagnostic message to a log file the user can send us when
/// the app fails to launch. Best-effort: tries the OS app-data dir, falls back
/// to the home dir, and never panics itself.
fn write_startup_log(msg: &str) {
    let base = dirs_next_data_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("com.bjmdistributions.clienthub");
    let _ = std::fs::create_dir_all(&dir);
    let line = format!("[{}] {}\n", chrono::Utc::now().to_rfc3339(), msg);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("startup-error.log")) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Resolve the platform app-data dir without pulling in extra deps.
fn dirs_next_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    { std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support")) }
    #[cfg(target_os = "windows")]
    { std::env::var_os("APPDATA").map(std::path::PathBuf::from) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")) }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Capture any panic to a log file so a launch crash is diagnosable instead of
    // a silent SIGABRT. Chains to the default hook so console output is preserved.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_startup_log(&format!("PANIC: {}", info));
        default_hook(info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            db::init(app)?;
            signup_rules::ensure_table()?;
            // Unified RBAC tables + system roles (synced with the server).
            if let Err(e) = employees::ensure_rbac() {
                tracing::warn!("rbac init failed: {}", e);
            }

            {
                if let Err(e) = geocode::init() {
                    tracing::warn!("geocode init failed: {}", e);
                }
            }

            // Sync folder lives next to the DB. Syncthing/Dropbox can target this.
            let sync_dir = db::app_data_dir().join("sync");
            sync::init(sync_dir)?;
            // Phase 2 network sync: outbound queue + background push/pull loop.
            // Inert until a server connection is configured (BJM folder-sync unaffected).
            if let Err(e) = netsync::ensure_tables() {
                tracing::warn!("netsync init failed: {}", e);
            }
            netsync::spawn_loop(app.handle().clone());

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

            // One-time background cleanup of email_in interactions that the pre-fix
            // scanner re-logged every scan (IMAP N:* bug). Guarded to run once.
            std::thread::spawn(|| email::dedup_email_interactions_once());
            // One-time migration: promote any existing device-local email config to
            // the org-shared default so every admin inherits it. Guarded to run once.
            std::thread::spawn(|| email::migrate_email_config_to_org_once());
            // Near-real-time inbox monitoring via IMAP IDLE (one watcher per inbox,
            // OS notification on each new lead) + a long safety-net sweep. Replaces
            // the old fixed 5-minute poll.
            email::spawn_realtime_watchers(app.handle().clone());

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
            // Network sync (Phase 2)
            netsync::netsync_connect,
            netsync::netsync_status,
            netsync::netsync_disconnect,
            netsync::netsync_sync_now,
            netsync::netsync_repair,
            netsync::netsync_repair_hard,
            netsync::netsync_restore_snapshot,
            netsync::netsync_diagnostics,
            netsync::get_my_plan,
            netsync::get_platform_signups,
            netsync::upload_company_logo,
            // Google Sheet clone (read-and-rebuild view-only supplier load sheets)
            sheet_clone::clone_google_sheet,
            // Sticky notes
            list_notes,
            create_note,
            update_note,
            delete_note,
            // Clients
            list_clients,
            client_last_activity,
            list_client_reps,
            get_client,
            create_client,
            update_client,
            update_client_status,
            toggle_client_blacklist,
            toggle_client_exclusive,
            toggle_client_high_value,
            set_client_credit_limit,
            get_client_credit_status,
            get_newsletter_include_ranked,
            set_newsletter_include_ranked,
            approve_client,
            reject_client,
            archive_client_source_email,
            get_pending_approvals,
            list_approval_requests,
            approval_requests_count,
            resolve_approval_request,
            get_approval_policy,
            set_approval_policy,
            set_checkup_visibility,
            submit_feedback,
            open_external,
            list_forms,
            save_form,
            delete_form,
            checkups::create_checkup,
            checkups::list_checkups,
            checkups::get_checkup,
            checkups::set_checkup_item_stage,
            checkups::delete_checkup,
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
            get_invoice_template,
            save_invoice_template,
            render_sample_invoice_pdf,
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
            set_invoice_void,
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
            set_deal_flow_fell_through,
            // Archive (soft-delete + fell-through) + restore
            list_archive,
            restore_archived,
            // Profit Split
            get_profit_split,
            save_profit_split,
            get_brief_frequency,
            set_brief_frequency,
            get_organization_name,
            set_organization_name,
            // Unified accounts + team management (RBAC)
            employees::employee_status,
            employees::employee_me,
            employees::update_my_account,
            employees::employee_logout,
            employees::employee_bootstrap,
            employees::employee_login,
            employees::login,
            employees::switch_workspace_restart,
            employees::active_workspace,
            employees::list_staff,
            employees::update_staff,
            employees::delete_staff,
            commands::create_refund,
            commands::list_refunds,
            commands::set_refund_owed,
            commands::delete_refund,
            commands::deal_flow_payout,
            commands::list_deal_reps,
            commands::set_deal_lead_rep,
            commands::add_client_credit,
            commands::get_client_credit,
            commands::list_rep_payouts,
            commands::mark_rep_payout_paid,
            commands::get_rep_payout_settings,
            commands::set_rep_payout_settings,
            commands::get_payout_split,
            commands::save_payout_split,
            commands::get_shopify_config,
            commands::set_shopify_secret,
            commands::create_intake_source,
            commands::list_intake_sources,
            commands::save_intake_mapping,
            commands::delete_intake_source,
            commands::get_intake_fields,
            commands::automations_summary,
            employees::list_roles,
            employees::create_role,
            employees::update_role,
            employees::list_invites,
            employees::create_invite,
            employees::revoke_invite,
            employees::reopen_invite,
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
            get_email_inboxes,
            save_email_inbox,
            delete_email_inbox,
            get_email_use_org_default,
            set_email_use_org_default,
            transfer_org_inbox,
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
            send_test_email,
            test_smtp_connection,
            test_inbox_connection,
            google_email_status,
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
            delete_lot,
            delete_lots,
            resync_inventory,
            import_lot_photos,
            remove_lot_photo,
            attach_lot_manifest,
            remove_lot_manifest,
            media_base_dir,
            generate_whatsapp_message,
            get_lot_media_files,
            save_whatsapp_footer,
            get_whatsapp_footer,
            get_whatsapp_settings,
            save_whatsapp_settings,
            open_lot_folder,
            whatsapp_web_reachable,
            open_whatsapp_window,
            close_whatsapp_window,
            whatsapp_embed_show,
            whatsapp_embed_close,
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
            get_receivables_aging,
            get_payables_aging,
            get_analytics_range,
            list_deals_for_supplier,
            // CSV import
            csv_preview,
            csv_import,
            // Signup rules
            list_signup_rules,
            create_signup_rule,
            update_signup_rule,
            delete_signup_rule,
            toggle_signup_rule,
            preview_form_capture,
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
            list_newsletter_schedules,
            create_newsletter_schedule,
            update_newsletter_schedule,
            delete_newsletter_schedule,
            save_smtp_settings_for_pi,
            push_desktop_smtp_to_pi,
            get_smtp_settings_for_pi,
            // Categories
            list_categories,
            create_category,
            update_category,
            delete_category,
            reorder_categories,
            sort_categories,
            dedupe_categories,
            import_categories,
            csv_distinct_column,
            // Sheet Sync
            get_sheet_sync_config,
            save_sheet_sync_config,
            sheet_writeback_status,
            sheet_writeback::sync_all_clients_to_sheet,
            sync_from_sheet,
            get_sheet_sync_log,
            list_custom_fields,
            save_custom_field,
            delete_custom_field,
            get_sheet_headers,
            sheet_category_column_values,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Don't blind-abort: record what actually failed so a launch crash is
            // diagnosable (startup-error.log), then surface a clear message.
            write_startup_log(&format!("FATAL: tauri run failed: {}", e));
            panic!("error while running tauri application: {}", e);
        });
}
