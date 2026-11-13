//! Importing from the Evernote application installed on this computer.
//!
//! The interface never names a folder: where Evernote keeps its data is
//! known on this side, and the interface chooses among the accounts and
//! notebooks found there. Evernote's files are only read.
use tauri::AppHandle;

use bever_core::evernote_local::{LocalImportReport, LocalOverview};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use {
    crate::blocking,
    bever_core::{
        error::BeverError,
        evernote_local::{
            default_data_dir, find_accounts, import_local, LocalImportOptions, LocalImportProgress,
        },
    },
    serde::Serialize,
    std::{
        path::PathBuf,
        sync::atomic::Ordering,
        time::{Duration, Instant},
    },
    tauri::Emitter,
};

/// The folder of Evernote's data. `BEVER_EVERNOTE_DIR` names another
/// one, which is how the tests give the application a folder of their own.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn data_dir() -> Option<PathBuf> {
    match std::env::var_os("BEVER_EVERNOTE_DIR") {
        Some(directory) if !directory.is_empty() => Some(directory.into()),
        _ => default_data_dir(),
    }
}

/// Progress in the form the interface already shows for an ENEX import: the
/// whole run is one "file", measured in notes.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalEvent<'a> {
    import_id: &'a str,
    file_index: usize,
    file_count: usize,
    file_name: String,
    phase: &'a str,
    notebook_id: String,
    note_index: u64,
    note_title: Option<String>,
    notes_imported: u64,
    notes_skipped: u64,
    notes_failed: u64,
    resources_imported: u64,
    bytes_read: u64,
    total_bytes: u64,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl<'a> LocalEvent<'a> {
    fn new(import_id: &'a str, progress: &'a LocalImportProgress) -> Self {
        let file_name = match &progress.notebook {
            Some(name) if progress.notebook_count > 1 => format!(
                "Notebook {} of {}: {name}",
                progress.notebook_index, progress.notebook_count
            ),
            Some(name) => name.clone(),
            None => "Evernote on this computer".to_owned(),
        };
        Self {
            import_id,
            file_index: 0,
            file_count: 1,
            file_name,
            phase: match progress.phase.as_str() {
                "importing" => "processing",
                other => other,
            },
            notebook_id: progress.notebook_id.clone().unwrap_or_default(),
            note_index: progress.note_index,
            note_title: progress.note_title.clone(),
            notes_imported: progress.notes_imported,
            notes_skipped: progress.notes_skipped,
            notes_failed: progress.notes_failed,
            resources_imported: progress.resources_imported,
            bytes_read: progress.note_index,
            total_bytes: progress.note_count,
        }
    }
}

/// The accounts Evernote keeps on this computer, each with its notebooks.
/// Empty when Evernote is not installed or was never signed in to.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub(crate) async fn evernote_local_overview(app: AppHandle) -> Result<Vec<LocalOverview>, String> {
    blocking(&app, |_, _| {
        let Some(directory) = data_dir() else {
            return Ok(Vec::new());
        };
        find_accounts(&directory)
            .iter()
            .map(|account| account.overview())
            .collect()
    })
    .await
}

/// Imports the notebooks named by `notebook_ids`, or all of them, from the
/// account `user_id`. Reports progress as an ENEX import does, and stops at
/// the same request. With `without_missing`, a note whose attachments
/// Evernote does not all have is imported without those, not left out.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub(crate) async fn import_evernote_local(
    app: AppHandle,
    import_id: String,
    user_id: String,
    notebook_ids: Option<Vec<String>>,
    without_missing: bool,
) -> Result<LocalImportReport, String> {
    blocking(&app, move |app, state| {
        let _running = state.imports.begin()?;
        let account = data_dir()
            .map(|directory| find_accounts(&directory))
            .unwrap_or_default()
            .into_iter()
            .find(|account| account.user_id == user_id)
            .ok_or_else(|| {
                BeverError::Invalid("Evernote’s data was not found on this computer".into())
            })?;
        let mut last_emit: Option<(Instant, String)> = None;
        let report = import_local(
            &state.library,
            &account,
            notebook_ids.as_deref(),
            LocalImportOptions {
                without_missing_attachments: without_missing,
            },
            state.imports.cancel_flag(),
            |progress| {
                // Thousands of notes would flood the interface; a change of
                // phase always gets through.
                let due = last_emit.as_ref().is_none_or(|(at, phase)| {
                    *phase != progress.phase || at.elapsed() >= Duration::from_millis(80)
                });
                if due {
                    last_emit = Some((Instant::now(), progress.phase.clone()));
                    let _ = app.emit(
                        "bever:import-progress",
                        LocalEvent::new(&import_id, &progress),
                    );
                }
            },
        );
        state.imports.cancel_flag().store(false, Ordering::SeqCst);
        state.ocr.wake(app);
        report
    })
    .await
}

/// Evernote's desktop application does not exist on Android or iOS.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub(crate) async fn evernote_local_overview(_app: AppHandle) -> Result<Vec<LocalOverview>, String> {
    Ok(Vec::new())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub(crate) async fn import_evernote_local(
    _app: AppHandle,
    _import_id: String,
    _user_id: String,
    _notebook_ids: Option<Vec<String>>,
    _without_missing: bool,
) -> Result<LocalImportReport, String> {
    Err("Importing from the Evernote application is available on a computer.".into())
}
