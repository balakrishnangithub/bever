//! Where this library is kept at the storage: looking at the folders there,
//! and choosing one. What a folder is, and what choosing one does to the
//! library, is the core's (`sync::folder`); nothing here knows which
//! storage service it is.
use bever_core::{
    error::BeverError,
    sync::{
        folder::{choose, look, Choice, FolderView},
        Cancel,
    },
};
use tauri::AppHandle;

use crate::{
    blocking,
    pcloud_auth::{pcloud_status_inner, PCloudStatus},
    remote_store,
};

/// What is in a folder of the storage; `/` is its top.
#[tauri::command]
pub(crate) async fn look_at_sync_folder(
    app: AppHandle,
    path: String,
) -> Result<FolderView, String> {
    blocking(&app, move |_, state| {
        let remote = remote_store(&state.library, Cancel::new())?;
        look(&state.library, &*remote, &path)
    })
    .await
}

/// Settles the folder this library is kept in: one made for it, or one that
/// holds a library already.
#[tauri::command]
pub(crate) async fn choose_sync_folder(
    app: AppHandle,
    path: String,
    existing: bool,
) -> Result<PCloudStatus, String> {
    blocking(&app, move |_, state| {
        // A run works in the folder it began in, with what the library
        // knows of that folder.
        if state.sync.is_running() {
            return Err(BeverError::Invalid(
                "stop the synchronization first, or wait until it has finished".into(),
            ));
        }
        let remote = remote_store(&state.library, Cancel::new())?;
        let choice = if existing {
            Choice::Existing
        } else {
            Choice::New
        };
        choose(&state.library, &*remote, &path, choice)?;
        pcloud_status_inner(&state.library)
    })
    .await
}
