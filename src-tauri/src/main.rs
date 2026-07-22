#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod bank_import;
mod checkups;
mod commands;
mod csv_import;
mod db;
mod email;
mod employees;
mod facebook;
mod form_parser;
mod geocode;
mod google_contacts;
mod invoice;
mod manifest;
mod oauth_flow;
mod plaid;
mod release_letter;
mod sheet_clone;
mod sheet_writeback;
mod signup_rules;
mod netsync;
mod sync;
mod sync_crypto;
mod secret_store;
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

const LOG_PREFIX: &str = "ecliptr-";
const LOG_KEEP_DAYS: i64 = 7;

/// Daily-rolling `tracing` log kept next to the DB. Release builds are
/// `windows_subsystem = "windows"`, so the subscriber's default stdout writer
/// goes nowhere and every tracing site in the app is invisible — including sync
/// failures. Old day-files are pruned so this can't grow without bound.
struct DailyLog {
    dir: std::path::PathBuf,
    /// (day, open file) — replaced as a pair when the date rolls over.
    current: std::sync::Mutex<Option<(String, std::fs::File)>>,
}

fn log_day_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn open_log_day(dir: &std::path::Path, day: &str) -> Option<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{LOG_PREFIX}{day}.log")))
        .ok()
}

/// Delete day-files older than `LOG_KEEP_DAYS`. The `%Y-%m-%d` stamp sorts
/// lexically, so a string compare against the cutoff is enough.
fn prune_logs(dir: &std::path::Path) {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(LOG_KEEP_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(day) = name.strip_prefix(LOG_PREFIX).and_then(|s| s.strip_suffix(".log")) {
            if day < cutoff.as_str() {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

impl DailyLog {
    /// `None` when the dir can't be written — the caller then keeps the previous
    /// stdout-only behaviour rather than failing startup.
    fn open(dir: &std::path::Path) -> Option<Self> {
        let day = log_day_stamp();
        let f = open_log_day(dir, &day)?;
        prune_logs(dir);
        Some(DailyLog {
            dir: dir.to_path_buf(),
            current: std::sync::Mutex::new(Some((day, f))),
        })
    }
}

impl std::io::Write for &DailyLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let day = log_day_stamp();
        // A poisoned lock or a failed write must never take the app down over a
        // log line, so both degrade to dropping the line.
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if cur.as_ref().map_or(true, |(d, _)| *d != day) {
            prune_logs(&self.dir);
            *cur = open_log_day(&self.dir, &day).map(|f| (day, f));
        }
        match cur.as_mut() {
            Some((_, f)) => f.write(buf).or(Ok(buf.len())),
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        match cur.as_mut() {
            Some((_, f)) => f.flush().or(Ok(())),
            None => Ok(()),
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for DailyLog {
    type Writer = &'a DailyLog;
    fn make_writer(&'a self) -> Self::Writer {
        self
    }
}

fn init_logging(dir: &std::path::Path) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let Some(file) = DailyLog::open(dir) else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
        return;
    };
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false);
    #[cfg(debug_assertions)]
    {
        use tracing_subscriber::fmt::writer::MakeWriterExt;
        builder.with_writer(file.and(std::io::stdout)).init();
    }
    #[cfg(not(debug_assertions))]
    builder.with_writer(file).init();
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

/// Show a native error dialog via a subprocess. Deliberately avoids the app's
/// event loop and the Objective-C runtime: the setup hook runs on the main
/// thread before the loop starts, and an in-process dialog would route through
/// objc2 (the same runtime implicated in the macOS 26 startup abort). A separate
/// process shows the message even when our own process can't. Best-effort — the
/// text is passed via an env var so neither AppleScript nor PowerShell needs
/// escaping. The message is always written to startup-error.log regardless.
fn show_startup_error_dialog(body: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("osascript")
            .env("ECLIPTR_STARTUP_ERR", body)
            .args([
                "-e",
                "display dialog (system attribute \"ECLIPTR_STARTUP_ERR\") with title \"Ecliptr - startup error\" buttons {\"OK\"} default button \"OK\" with icon stop",
            ])
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("powershell")
            .env("ECLIPTR_STARTUP_ERR", body)
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:ECLIPTR_STARTUP_ERR, 'Ecliptr - startup error', 'OK', 'Error')",
            ])
            .status();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = body; }
}

/// Run a critical startup step. On failure, record it to startup-error.log and
/// show a native error dialog, then exit — instead of returning `Err` from
/// `setup`, which unwinds into tao's `did_finish_launching` (an `extern "C"`
/// callback that cannot unwind) and aborts with a silent SIGABRT. On success,
/// returns the step's value unchanged.
fn expect_startup<T, E: std::fmt::Display>(step: &str, result: Result<T, E>) -> T {
    match result {
        Ok(v) => v,
        Err(e) => {
            let base = dirs_next_data_dir().unwrap_or_else(std::env::temp_dir);
            let log_path = base
                .join("com.bjmdistributions.clienthub")
                .join("startup-error.log");
            write_startup_log(&format!("SETUP FAILED [{step}]: {e}"));
            show_startup_error_dialog(&format!(
                "Ecliptr could not finish starting up.\n\n{step} failed: {e}\n\nDetails were saved to:\n{}",
                log_path.display()
            ));
            std::process::exit(1);
        }
    }
}

/// macOS only: when the app is launched from a read-only / translocated location
/// (Gatekeeper App Translocation, or straight from the DMG / Downloads), the
/// auto-updater can't replace the bundle in place — the user sees "Ecliptr is
/// running from a read-only location and can't update itself". Detect that at
/// startup and offer to move the app into /Applications and relaunch from there,
/// which stops translocation and lets updates work. Best-effort and fully guarded:
/// acts only when clearly needed, never touches user data (which lives in
/// Application Support, not the bundle), and falls back to manual instructions if
/// the move fails. Uses osascript via a subprocess (same approach as
/// show_startup_error_dialog) to stay off the objc2 runtime.
#[cfg(target_os = "macos")]
fn ensure_app_in_applications() {
    // exe = <App>.app/Contents/MacOS/<bin>; the bundle is three parents up.
    let exe = match std::env::current_exe() { Ok(p) => p, Err(_) => return };
    let bundle = match exe.ancestors().nth(3) {
        Some(p) if p.extension().and_then(|e| e.to_str()) == Some("app") => p.to_path_buf(),
        _ => return, // not a .app layout (e.g. `cargo run`) — nothing to do
    };
    let bundle_str = bundle.to_string_lossy().to_string();
    let translocated = bundle_str.contains("/AppTranslocation/");
    let in_applications = bundle_str.starts_with("/Applications/");
    if in_applications && !translocated { return; } // already in the right place

    let name = bundle.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !name.ends_with(".app") { return; } // safety: never build a bare /Applications/ target
    let target = format!("/Applications/{name}");

    let prompt = "Ecliptr is running from a location where it can't update itself.\n\n\
                  Move it to your Applications folder now? Ecliptr will reopen from there, \
                  and updates will work from then on.";
    let choice = std::process::Command::new("osascript")
        .env("ECLIPTR_MOVE_MSG", prompt)
        .args(["-e",
            "button returned of (display dialog (system attribute \"ECLIPTR_MOVE_MSG\") \
             with title \"Move Ecliptr to Applications\" \
             buttons {\"Not now\", \"Move to Applications\"} default button \"Move to Applications\")"])
        .output();
    let approved = matches!(&choice, Ok(o) if String::from_utf8_lossy(&o.stdout).contains("Move to Applications"));
    if !approved { return; }

    // Replace any stale copy, then ditto in (preserves signature + xattrs).
    let _ = std::process::Command::new("rm").args(["-rf", target.as_str()]).status();
    let moved = matches!(
        std::process::Command::new("ditto").arg(&bundle_str).arg(&target).status(),
        Ok(s) if s.success()
    );

    if moved {
        let _ = std::process::Command::new("open").args(["-n", target.as_str()]).spawn();
        std::process::exit(0);
    }
    // Move failed (usually /Applications permissions) — guide the user to do it by hand.
    let _ = std::process::Command::new("osascript")
        .env("ECLIPTR_MOVE_ERR",
            "Couldn't move Ecliptr automatically.\n\nPlease quit Ecliptr, drag it into your \
             Applications folder, then reopen it from there so it can update itself.")
        .args(["-e",
            "display dialog (system attribute \"ECLIPTR_MOVE_ERR\") \
             with title \"Move Ecliptr to Applications\" buttons {\"OK\"} default button \"OK\""])
        .status();
}

#[cfg(not(target_os = "macos"))]
fn ensure_app_in_applications() {}

fn main() {
    // Capture any panic to a log file so a launch crash is diagnosable instead of
    // a silent SIGABRT. Chains to the default hook so console output is preserved.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_startup_log(&format!("PANIC: {}", info));
        default_hook(info);
    }));

    // Before anything else: if we're running from a read-only / translocated spot
    // (macOS), offer to move into /Applications so the updater can work. No-op on
    // Windows and when already correctly installed.
    ensure_app_in_applications();

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
            // Critical startup steps: on failure show a native dialog + log and
            // exit, rather than returning Err (which aborts inside tao's
            // did_finish_launching as a silent SIGABRT).
            expect_startup("Database", db::init(app));
            // Logging starts here, not in main(): the log sits in the ACTIVE store
            // dir, which only `db::init` can resolve (it depends on the signed-in
            // account). Everything that logs runs after this point.
            init_logging(db::app_data_dir());
            expect_startup("Signup rules table", signup_rules::ensure_table());
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
            expect_startup("Sync", sync::init(sync_dir));
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

                // 2c. Reconcile inventory media with the server every launch: download any
                // photos/manifests this device is missing and upload any the server lacks.
                // Photo/manifest files don't ride the DB sync oplog (only the path text
                // does), so this is what actually converges images across devices and the
                // hosted storefront. Runs each launch (not once-per-install) and only moves
                // missing files, so it's cheap once converged.
                match commands::reconcile_inventory_media().await {
                    Ok(r) if r.downloaded > 0 || r.uploaded > 0 => {
                        tracing::info!("inventory media reconcile: {} down, {} up", r.downloaded, r.uploaded);
                    }
                    Err(e) => tracing::warn!("inventory media reconcile deferred: {}", e),
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

            // Plaid bank feed: pull once ~30s after startup, then every 20 minutes.
            // Best-effort — plaid_sync errors when no banks are connected or keys are
            // missing, so we just log and keep looping. This also backfills Plaid's
            // progressively-extracted history without the user clicking Sync.
            tauri::async_runtime::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                match commands::plaid_sync().await {
                    Ok(v) => tracing::info!("plaid auto-sync: imported {}", v.get("imported").and_then(|n| n.as_i64()).unwrap_or(0)),
                    Err(e) => tracing::warn!("plaid auto-sync failed: {}", e),
                }
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(1200));
                loop {
                    interval.tick().await;
                    match commands::plaid_sync().await {
                        Ok(v) => tracing::info!("plaid auto-sync: imported {}", v.get("imported").and_then(|n| n.as_i64()).unwrap_or(0)),
                        Err(e) => tracing::warn!("plaid auto-sync failed: {}", e),
                    }
                }
            });

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
            netsync::admin_waitlist_all,
            netsync::admin_feedback_all,
            netsync::admin_set_org_plan,
            netsync::admin_delete_workspace,
            netsync::admin_onboarding,
            netsync::admin_platform_users,
            netsync::admin_broadcast_preview,
            netsync::admin_broadcast_send,
            netsync::admin_broadcast_test,
            netsync::netsync_whoami,
            netsync::upload_company_logo,
            // Google Sheet clone (read-and-rebuild view-only supplier load sheets)
            sheet_clone::clone_google_sheet,
            // Sticky notes
            list_notes,
            create_note,
            update_note,
            keep_note,
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
            get_newsletter_unsubscribe_enabled,
            set_newsletter_unsubscribe_enabled,
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
            open_invoice_pdf,
            get_invoice_template,
            save_invoice_template,
            render_sample_invoice_pdf,
            get_quote_template,
            save_quote_template,
            render_sample_quote_pdf,
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
            release_letter::generate_release_letter,
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
            set_deposit,
            add_supplier_payment,
            update_supplier_payment,
            remove_supplier_payment,
            mark_supplier_payment_paid,
            unmark_supplier_payment_paid,
            set_supplier_payment_kept,
            complete_deal_flow,
            recalc_deal_from_bank,
            cleanup_orphan_allocations,
            scan_data_integrity,
            converge_integrity_item,
            resync_all_completed_deals,
            set_deal_link_na,
            set_refund_done,
            uncomplete_deal_flow,
            set_deal_payout_included,
            update_deal_completed_at,
            update_deal_flow_notes,
            update_deal_flow_name,
            delete_deal_flow,
            set_deal_flow_fell_through,
            // Archive (soft-delete + fell-through) + restore
            list_archive,
            restore_archived,
            recover_deleted_from_backups,
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
            employees::local_is_superadmin,
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
            commands::add_deal_receipt,
            commands::list_deal_receipts,
            commands::delete_deal_receipt,
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
            parse_load,
            parse_loads,
            load_ai_status,
            set_anthropic_key,
            get_storefront_config,
            save_storefront_config,
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
            list_offers,
            set_offer_status,
            delete_offer,
            list_stale_server_lots,
            resync_inventory,
            import_lot_photos,
            backfill_inventory_photos,
            backfill_inventory_manifests,
            reconcile_inventory_media,
            list_media_sync_issues,
            cleanup_inventory_photos,
            remove_lot_photo,
            attach_lot_manifest,
            remove_lot_manifest,
            media_base_dir,
            generate_whatsapp_message,
            get_lot_media_files,
            save_whatsapp_footer,
            get_whatsapp_footer,
            save_whatsapp_description,
            get_whatsapp_description,
            get_whatsapp_settings,
            save_whatsapp_settings,
            get_newsletter_product_template,
            save_newsletter_product_template,
            open_lot_folder,
            whatsapp_web_reachable,
            open_whatsapp_window,
            close_whatsapp_window,
            whatsapp_embed_show,
            whatsapp_embed_close,
            // Facebook Page auto-post
            facebook::fb_status,
            facebook::fb_set_app,
            facebook::fb_connect,
            facebook::fb_select_page,
            facebook::fb_disconnect,
            facebook::fb_post_lot,
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
            // Bank statement import (financial engine)
            bank_preview,
            bank_import,
            bank_preview_ai,
            bank_import_ai,
            plaid_set_keys,
            plaid_has_keys,
            plaid_config,
            plaid_test_keys,
            plaid_link_token,
            plaid_connect_start,
            plaid_connect_poll,
            plaid_resync_all,
            plaid_refresh_sync,
            plaid_exchange,
            plaid_list_items,
            plaid_remove_item,
            plaid_sync,
            list_bank_txns,
            bank_txn_summary,
            set_bank_txn_review,
            allocate_bank_txn,
            remove_bank_allocation,
            list_bank_allocations_for_txn,
            deal_allocations,
            reattach_orphaned_deal_allocations,
            cleanup_ghost_deal_flows,
            heal_overallocated_txns,
            pull_now,
            set_note_editing,
            unallocated_bank_txns,
            add_cash_transaction,
            deal_reconciliation,
            reconciliation_status_all,
            refund_status_all,
            clear_bank_txns,
            get_money_config,
            set_money_config,
            financials_overview,
            list_loans,
            create_loan,
            update_loan,
            delete_loan,
            tag_bank_txn_to_loan,
            untag_bank_txn_loan,
            loan_ledger,
            apply_loan_repayments_to_set_aside,
            create_txn_rule,
            list_txn_rules,
            delete_txn_rule,
            apply_txn_rules,
            ai_categorize_bank_txns,
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
            push_email_login_to_server,
            share_connections_with_team,
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
