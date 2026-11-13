//! Removing everything Bever keeps on this device, for a clean uninstall.
//!
//! An uninstaller removes the program. What the program stored is elsewhere:
//! the library in the data folder, the pCloud login in the system's credential
//! store, and the interface's own preferences in the WebView's storage. This
//! command removes all three and ends the application; nothing is changed in
//! pCloud.
use tauri::AppHandle;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use {
    crate::{blocking, credentials::delete_access_token, files},
    bever_core::error::BeverError,
    std::time::Duration,
    tauri::Manager,
};

/// Whether the library is one named by `BEVER_DATA_DIR` instead of the
/// installation's own. The pCloud login is kept once for the user, not once
/// for each library, so erasing such a library leaves the login alone: it
/// belongs to the installed application.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_other_library() -> bool {
    std::env::var_os("BEVER_DATA_DIR").is_some_and(|directory| !directory.is_empty())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub(crate) async fn erase_local_data(app: AppHandle) -> Result<(), String> {
    blocking(&app, |app, state| {
        if state.sync.is_running() {
            return Err(BeverError::Invalid(
                "Synchronization is running. Wait until it has finished, then try again.".into(),
            ));
        }
        if state.imports.is_running() {
            return Err(BeverError::Invalid(
                "An import is running. Cancel it or wait until it has finished, then try again."
                    .into(),
            ));
        }
        state.library.erase()?;
        files::purge_opened_attachments(app);
        if !is_other_library() {
            delete_access_token()?;
        }
        Ok(())
    })
    .await?;
    // The interface's preferences. The WebView clears them in the background
    // and gives no sign when it is done, so it gets a moment before the exit.
    for window in app.webview_windows().into_values() {
        let _ = window.clear_all_browsing_data();
    }
    let _ = tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(Duration::from_millis(1200));
    })
    .await;
    app.exit(0);
    Ok(())
}

/// Android and iOS remove an application's data themselves when it is
/// uninstalled, and offer the same from the system settings.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub(crate) async fn erase_local_data(_app: AppHandle) -> Result<(), String> {
    Err("Uninstalling Bever removes its data from this device.".into())
}
