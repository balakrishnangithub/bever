//! Native shell: wires the reusable core to the window, the tray, and the
//! platform services. Commands live in the modules below.
//!
//! The WebView is treated as untrusted, because it renders imported note
//! content. It is granted no file-system, dialog, or opener capability and
//! never names a path: files are picked in native dialogs opened from Rust.
#[cfg(target_os = "android")]
mod android_oauth;
mod awake;
mod commands;
mod credentials;
mod erase;
mod evernote;
mod files;
mod ocr_worker;
mod pcloud_auth;
mod protocol;
mod startup;
mod sync_controller;
mod sync_platform;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::sync::atomic::Ordering;
use std::sync::{atomic::AtomicBool, Arc};

use bever_core::{
    error::{BeverError, Result as BeverResult},
    models::SyncProgress,
    sync::{sync_with_remote, Cancel, RemoteStore, SyncOptions, SyncRun},
    Library,
};
use files::ImportState;
use ocr_worker::OcrWorker;
use startup::Startup;
use sync_controller::{RunEnd, SyncController, SyncStatus};
use sync_platform::SyncPlatform;
use tauri::{AppHandle, Emitter, Manager};

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

impl AppState {
    /// The application's state, waited for when set-up is still opening the
    /// library; see [`Startup`]. This is the one way to it.
    pub(crate) fn of(app: &AppHandle) -> &AppState {
        app.state::<Startup<AppState>>().inner().wait()
    }
}

/// How long a synchronization that was stopped in order to quit is given to
/// end before the application leaves without it. It ends within moments;
/// this is for the one that does not.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const QUIT_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// The tray's last entry, which says what choosing it will do.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct QuitItem(tauri::menu::MenuItem<tauri::Wry>);

/// Runs blocking work (database, files, network) off the UI thread and turns
/// its error into the message shown in the interface.
pub(crate) async fn blocking<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle, &AppState) -> BeverResult<T> + Send + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || work(&app, AppState::of(&app)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// What this library synchronizes with, stopped by `cancel`. pCloud is the
/// one storage service there is; another would be chosen here, and nothing
/// else about a run would differ.
fn remote_store(library: &Library, cancel: Cancel) -> BeverResult<Box<dyn RemoteStore>> {
    Ok(Box::new(pcloud_auth::client(library)?.stopped_by(cancel)))
}

fn publish_sync_status(app: &AppHandle, status: &SyncStatus) {
    let _ = app.emit("bever:sync-status", status);
}

/// Shows in the tray whether a synchronization is running, and what
/// quitting would then do.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn show_in_tray(app: &AppHandle, running: bool) {
    let (quit, tooltip) = if running {
        ("Stop synchronizing and quit", "Bever is synchronizing")
    } else {
        ("Quit", "Bever")
    };
    if let Some(item) = app.try_state::<QuitItem>() {
        let _ = item.0.set_text(quit);
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn show_in_tray(_app: &AppHandle, _running: bool) {}

fn finish_sync_run(app: &AppHandle, run_id: u64, end: RunEnd) {
    let state = AppState::of(app);
    let Some(status) = state.sync.finish(run_id, end) else {
        return;
    };
    publish_sync_status(app, &status);
    show_in_tray(app, false);
    let message = match &status.error {
        Some(error) => format!("Sync failed: {error}"),
        None if status.stopped => "Synchronization stopped".to_owned(),
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
            if AppState::of(&app).exit_after_sync.load(Ordering::Acquire) {
                app.exit(0);
            }
        });
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn restore_main_window(app: &AppHandle) {
    AppState::of(app)
        .exit_after_sync
        .store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Leaves the application. A synchronization that is running is stopped
/// first: it leaves both sides consistent, and the next run goes on from
/// where this one stopped. Quitting is never made to wait for a run to
/// finish, which may be hours away.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn quit_now(app: &AppHandle) {
    let state = AppState::of(app);
    if !state.sync.is_running() {
        app.exit(0);
        return;
    }
    state.exit_after_sync.store(true, Ordering::Release);
    if let Some(status) = state.sync.stop() {
        publish_sync_status(app, &status);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    // The run ends within moments of being stopped, and the application
    // leaves when it has (`finish_sync_run`). Should it not end, the
    // application leaves all the same.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_GRACE);
        let _ = app.clone().run_on_main_thread(move || {
            // Unless Bever was opened again meanwhile.
            if AppState::of(&app).exit_after_sync.load(Ordering::Acquire) {
                app.exit(0);
            }
        });
    });
}

#[tauri::command]
fn sync_status(app: AppHandle) -> SyncStatus {
    AppState::of(&app).sync.status()
}

/// Stops the synchronization that is running. What it has transferred
/// stays, and the next run goes on from there.
#[tauri::command]
fn stop_sync(app: AppHandle) -> SyncStatus {
    let state = AppState::of(&app);
    if let Some(status) = state.sync.stop() {
        publish_sync_status(&app, &status);
    }
    state.sync.status()
}

/// The latest runs, newest first: when each began and ended, how it ended
/// and what it moved.
#[tauri::command]
async fn sync_history(app: AppHandle) -> Result<Vec<SyncRun>, String> {
    blocking(&app, |_, state| state.library.sync_runs()).await
}

#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<SyncStatus, String> {
    // Check the sign-in before reserving a run, so that a missing token is
    // reported at once. A run that is already going needs no check.
    if !AppState::of(&app).sync.is_running() {
        blocking(&app, |_, state| {
            remote_store(&state.library, Cancel::new()).map(|_| ())
        })
        .await?;
    }
    let state = AppState::of(&app);
    let Some((run_id, cancel)) = state.sync.begin() else {
        // Another caller won the race; report the run that is in progress.
        return Ok(state.sync.status());
    };
    publish_sync_status(&app, &state.sync.status());
    show_in_tray(&app, true);

    let platform = Arc::clone(&state.platform);
    let started = tauri::async_runtime::spawn_blocking(move || platform.start())
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| error.to_string()));
    if let Err(error) = started {
        finish_sync_run(&app, run_id, RunEnd::Failed(error));
        return Ok(state.sync.status());
    }

    let library = Arc::clone(&state.library);
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // For as long as the run goes, and no longer.
        let _awake = awake::Awake::hold();
        let options = SyncOptions {
            cancel: cancel.clone(),
            ..SyncOptions::default()
        };
        let result = remote_store(&library, cancel).and_then(|remote| {
            sync_with_remote(&library, &*remote, &options, |progress: SyncProgress| {
                let state = AppState::of(&worker_app);
                state.platform.progress(&progress);
                if let Some(status) = state.sync.update(run_id, progress) {
                    publish_sync_status(&worker_app, &status);
                }
            })
        });
        let end = match result {
            Ok(report) => RunEnd::Complete(report),
            Err(BeverError::Cancelled) => RunEnd::Stopped,
            Err(error) => RunEnd::Failed(error.to_string()),
        };
        finish_sync_run(&worker_app, run_id, end);
    });
    Ok(state.sync.status())
}

/// Called by the interface after it has saved any unsaved note, in answer to
/// a request to close the window. While a sync is running the window only
/// hides, so the sync can finish; otherwise the application exits.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn finish_close(app: AppHandle, window: tauri::Window) {
    let state = AppState::of(&app);
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
    let builder = tauri::Builder::default();
    // One Bever for one library. Two would each show the notes as they last
    // read them and save over what the other wrote; and while a
    // synchronization keeps Bever running without its window, starting it
    // again is the natural thing to do. So the one that is running comes to
    // the front instead. A library of its own (`BEVER_DATA_DIR`) is another
    // Bever and is left to run beside it. This plugin has to be the first.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = if erase::is_other_library() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _directory| restore_main_window(app),
        ))
    };
    let builder = builder
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
        // Before any window: the page of one may ask before set-up is done.
        .manage(Startup::<AppState>::default())
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
            app.state::<Startup<AppState>>().open(AppState {
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
            AppState::of(app.handle()).ocr.wake(app.handle());

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::TrayIconBuilder,
                };
                let open = MenuItem::with_id(app, "open", "Open Bever", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &quit])?;
                app.manage(QuitItem(quit));
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
                        "quit" => quit_now(app),
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
                let state = AppState::of(app);
                if should_defer_close(_window.label(), state.sync.is_running()) {
                    api.prevent_close();
                    state.exit_after_sync.store(true, Ordering::Release);
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
            commands::set_note_thumbnail,
            commands::set_notes_pinned,
            commands::keep_note_version,
            commands::note_versions,
            commands::restore_note_version,
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
            stop_sync,
            sync_history,
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
