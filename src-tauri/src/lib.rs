//! Native shell: wires the reusable core to the window, the tray, and the
//! platform services. Commands live in the modules below.
//!
//! The WebView is treated as untrusted, because it renders imported note
//! content. It is granted no file-system, dialog, or opener capability and
//! never names a path: files are picked in native dialogs opened from Rust.
#[cfg(target_os = "android")]
mod android_oauth;
mod commands;
mod credentials;
mod erase;
mod evernote;
mod files;
mod ocr_worker;
mod pcloud_auth;
mod protocol;
mod sync_controller;
mod sync_platform;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::atomic::Ordering;
use std::sync::{atomic::AtomicBool, Arc};

use bever_core::{
    error::Result as BeverResult,
    models::{SyncProgress, SyncReport},
    sync::sync_with_pcloud_progress,
    Library,
};
use files::ImportState;
use ocr_worker::OcrWorker;
use sync_controller::{SyncController, SyncStatus};
use sync_platform::SyncPlatform;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) struct AppState {
    pub(crate) library: Arc<Library>,
    pub(crate) sync: Arc<SyncController>,
    pub(crate) platform: Arc<SyncPlatform>,
    pub(crate) imports: ImportState,
    pub(crate) ocr: Arc<OcrWorker>,
    /// Set to abandon a pCloud browser connection that is still waiting.
    /// Android signs in through a deep link and has nothing waiting.
    #[cfg_attr(target_os = "android", allow(dead_code))]
    pub(crate) oauth_cancelled: Arc<AtomicBool>,
    /// Set only when a desktop close/quit request should happen after the
    /// existing worker finishes. Opening the window clears it.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    pub(crate) exit_after_sync: AtomicBool,
}

/// Runs blocking work (database, files, network) off the UI thread and turns
/// its error into the message shown in the interface.
pub(crate) async fn blocking<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle, &AppState) -> BeverResult<T> + Send + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        work(&app, state.inner())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

fn publish_sync_status(app: &AppHandle, status: &SyncStatus) {
    let _ = app.emit("bever:sync-status", status);
}

fn finish_sync_run(app: &AppHandle, run_id: u64, result: Result<SyncReport, String>) {
    let state = app.state::<AppState>();
    let Some(status) = state.sync.finish(run_id, result) else {
        return;
    };
    publish_sync_status(app, &status);
    let message = match &status.error {
        Some(error) => format!("Sync failed: {error}"),
        None => "Synchronization complete".to_owned(),
    };
    state.platform.finish(&message);
    // Notes pulled from other devices may carry images to recognise.
    state.ocr.wake(app);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if state.exit_after_sync.load(Ordering::Acquire) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            // Recheck on the UI thread: Open Bever may have cancelled exit
            // after the worker completed but before this callback ran.
            if app
                .state::<AppState>()
                .exit_after_sync
                .load(Ordering::Acquire)
            {
                app.exit(0);
            }
        });
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn restore_main_window(app: &AppHandle) {
    app.state::<AppState>()
        .exit_after_sync
        .store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn sync_status(state: State<'_, AppState>) -> SyncStatus {
    state.sync.status()
}

#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<SyncStatus, String> {
    // Check the sign-in before reserving a run, so that a missing token is
    // reported at once. A run that is already going needs no check.
    if !app.state::<AppState>().sync.is_running() {
        blocking(&app, |_, state| {
            pcloud_auth::load_credentials(&state.library).map(|_| ())
        })
        .await?;
    }
    let state = app.state::<AppState>();
    let Some(run_id) = state.sync.begin() else {
        // Another caller won the race; report the run that is in progress.
        return Ok(state.sync.status());
    };
    publish_sync_status(&app, &state.sync.status());

    let platform = Arc::clone(&state.platform);
    let started = tauri::async_runtime::spawn_blocking(move || platform.start())
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| error.to_string()));
    if let Err(error) = started {
        finish_sync_run(&app, run_id, Err(error));
        return Ok(state.sync.status());
    }

    let library = Arc::clone(&state.library);
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = pcloud_auth::load_credentials(&library)
            .and_then(|credentials| {
                sync_with_pcloud_progress(&library, credentials, |progress: SyncProgress| {
                    let state = worker_app.state::<AppState>();
                    state.platform.progress(&progress);
                    if let Some(status) = state.sync.update(run_id, progress) {
                        publish_sync_status(&worker_app, &status);
                    }
                })
            })
            .map_err(|error| error.to_string());
        finish_sync_run(&worker_app, run_id, result);
    });
    Ok(state.sync.status())
}

/// Called by the interface after it has saved any unsaved note, in answer to
/// a request to close the window. While a sync is running the window only
/// hides, so the sync can finish; otherwise the application exits.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn finish_close(app: AppHandle, window: tauri::Window) {
    let state = app.state::<AppState>();
    if should_defer_close(window.label(), state.sync.is_running()) {
        state.exit_after_sync.store(true, Ordering::Release);
        let _ = window.hide();
    } else {
        app.exit(0);
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn finish_close() {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn should_defer_close(label: &str, sync_running: bool) -> bool {
    label == "main" && sync_running
}

/// Where the library lives. `BEVER_DATA_DIR` selects another directory,
/// which keeps automated tests and portable installations away from the
/// user's own library.
fn data_directory(app: &tauri::App) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    match std::env::var_os("BEVER_DATA_DIR") {
        Some(directory) if !directory.is_empty() => Ok(directory.into()),
        _ => Ok(app.path().app_data_dir()?),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_deep_link::init()).plugin(
        tauri::plugin::Builder::new("bever-sync")
            .setup(|app, api| {
                app.manage(Arc::new(SyncPlatform::register::<()>(api)?));
                Ok(())
            })
            .build(),
    );

    builder
        .register_asynchronous_uri_scheme_protocol("bever", protocol::handle)
        .setup(|app| {
            let library = Arc::new(Library::open(data_directory(app)?)?);
            // Leftovers of a run that was killed mid-transfer.
            let _ = library.remove_stale_staging();
            files::purge_opened_attachments(app.handle());
            #[cfg(target_os = "android")]
            let platform = Arc::clone(&*app.state::<Arc<SyncPlatform>>());
            #[cfg(not(target_os = "android"))]
            let platform = Arc::new(SyncPlatform);
            app.manage(AppState {
                library,
                sync: Arc::new(SyncController::default()),
                platform,
                imports: ImportState::default(),
                ocr: Arc::new(OcrWorker::default()),
                oauth_cancelled: Arc::new(AtomicBool::new(false)),
                exit_after_sync: AtomicBool::new(false),
            });
            #[cfg(target_os = "android")]
            android_oauth::register(app)?;
            // Continue recognising images queued before the last exit.
            app.state::<AppState>().ocr.wake(app.handle());

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::TrayIconBuilder,
                };
                let open = MenuItem::with_id(app, "open", "Open Bever", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;
                TrayIconBuilder::with_id("main-tray")
                    .icon(
                        app.default_window_icon()
                            .expect("Bever window icon")
                            .clone(),
                    )
                    .menu(&menu)
                    .tooltip("Bever")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => restore_main_window(app),
                        "quit" => {
                            if app.state::<AppState>().sync.is_running() {
                                app.state::<AppState>()
                                    .exit_after_sync
                                    .store(true, Ordering::Release);
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.hide();
                                }
                            } else {
                                app.exit(0);
                            }
                        }
                        _ => {}
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            // The interface normally answers a close request itself (it saves
            // first, then calls `finish_close`). This is the fallback for a
            // page that never loaded: a running sync still keeps the process.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                let app = _window.app_handle();
                if should_defer_close(_window.label(), app.state::<AppState>().sync.is_running()) {
                    api.prevent_close();
                    app.state::<AppState>()
                        .exit_after_sync
                        .store(true, Ordering::Release);
                    let _ = _window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::save_note,
            commands::set_notes_trashed,
            commands::delete_notes_permanently,
            commands::empty_trash,
            commands::create_notebook,
            commands::rename_notebook,
            commands::delete_notebook,
            commands::set_notebook_stack,
            commands::create_stack,
            commands::rename_stack,
            commands::delete_stack,
            commands::create_tag,
            commands::rename_tag,
            commands::set_tag_parent,
            commands::delete_tag,
            commands::toggle_shortcut,
            commands::organize_notes,
            commands::update_note_timestamps,
            commands::get_settings,
            commands::set_setting,
            commands::app_info,
            files::pick_enex_files,
            files::import_enex,
            files::cancel_import,
            files::attach_files,
            files::attach_bytes,
            files::export_notes,
            files::save_attachment,
            files::open_attachment,
            files::open_external_url,
            ocr_worker::ocr_status,
            sync_now,
            sync_status,
            finish_close,
            pcloud_auth::pcloud_status,
            pcloud_auth::connect_pcloud,
            pcloud_auth::cancel_pcloud_connect,
            pcloud_auth::connect_pcloud_token,
            pcloud_auth::disconnect_pcloud,
            erase::erase_local_data,
            evernote::evernote_local_overview,
            evernote::import_evernote_local,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bever");
}

#[cfg(test)]
mod tests {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_close_waits_only_for_the_active_sync_worker() {
        use super::should_defer_close;
        assert!(should_defer_close("main", true));
        assert!(!should_defer_close("main", false));
        assert!(!should_defer_close("secondary", true));
    }
}
