//! Library commands: notes, notebooks, stacks, tags, shortcuts, settings.
//!
//! Every command runs on a blocking worker thread. A command declared as a
//! plain function would run on the UI thread and freeze the window while it
//! waits for the database.
use std::collections::HashMap;

use bever_core::{
    error::{BeverError, Result as BeverResult},
    models::{
        LibraryCounts, LibrarySnapshot, Note, NoteFilter, NotePage, NoteVersion, SaveNote,
        SavedNote, ThumbnailChoice,
    },
    Library,
};
use serde::Serialize;
use tauri::AppHandle;

use crate::blocking;

/// Navigation data: the synchronized metadata plus local note counts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Overview {
    #[serde(flatten)]
    snapshot: LibrarySnapshot,
    counts: LibraryCounts,
}

pub(crate) fn overview(library: &Library) -> BeverResult<Overview> {
    Ok(Overview {
        snapshot: library.snapshot()?,
        counts: library.counts()?,
    })
}

#[tauri::command]
pub(crate) async fn bootstrap(app: AppHandle) -> Result<Overview, String> {
    blocking(&app, |_, state| overview(&state.library)).await
}

#[tauri::command]
pub(crate) async fn list_notes(app: AppHandle, filter: NoteFilter) -> Result<NotePage, String> {
    blocking(&app, move |_, state| state.library.list_notes(&filter)).await
}

/// How many notes of a listing have each tag, for choosing among them.
#[tauri::command]
pub(crate) async fn listing_tags(
    app: AppHandle,
    filter: NoteFilter,
) -> Result<HashMap<String, u64>, String> {
    blocking(&app, move |_, state| state.library.listing_tags(&filter)).await
}

#[tauri::command]
pub(crate) async fn get_note(app: AppHandle, id: String) -> Result<Note, String> {
    blocking(&app, move |_, state| state.library.get_note(&id)).await
}

#[tauri::command]
pub(crate) async fn create_note(
    app: AppHandle,
    notebook_id: Option<String>,
) -> Result<Note, String> {
    blocking(&app, move |_, state| {
        state.library.create_note(notebook_id.as_deref())
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_note(app: AppHandle, input: SaveNote) -> Result<SavedNote, String> {
    blocking(&app, move |_, state| {
        state.library.save_note_checked(&input)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_notes_trashed(
    app: AppHandle,
    note_ids: Vec<String>,
    trashed: bool,
) -> Result<u64, String> {
    blocking(&app, move |_, state| {
        state.library.set_notes_trashed(&note_ids, trashed)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_notes_permanently(
    app: AppHandle,
    note_ids: Vec<String>,
) -> Result<u64, String> {
    blocking(&app, move |_, state| {
        state.library.delete_notes_permanently(&note_ids)
    })
    .await
}

#[tauri::command]
pub(crate) async fn empty_trash(app: AppHandle) -> Result<u64, String> {
    blocking(&app, |_, state| state.library.empty_trash()).await
}

#[tauri::command]
pub(crate) async fn create_notebook(
    app: AppHandle,
    name: String,
    stack_id: Option<String>,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.ensure_notebook(&name, stack_id.as_deref())?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn rename_notebook(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.rename_notebook(&id, &name)?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_notebook(app: AppHandle, id: String) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.delete_notebook(&id)?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_notebook_stack(
    app: AppHandle,
    notebook_id: String,
    stack_id: Option<String>,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state
            .library
            .set_notebook_stack(&notebook_id, stack_id.as_deref())?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_stack(app: AppHandle, name: String) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.create_stack(&name)?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn rename_stack(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.rename_stack(&id, &name)?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_stack(app: AppHandle, id: String) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.delete_stack(&id)?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_tag(
    app: AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.create_tag(&name, parent_id.as_deref())?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn rename_tag(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.rename_tag(&id, &name)?;
        overview(&state.library)
    })
    .await
}

/// Places a tag under another, or at the top when no parent is named.
#[tauri::command]
pub(crate) async fn set_tag_parent(
    app: AppHandle,
    id: String,
    parent_id: Option<String>,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.set_tag_parent(&id, parent_id.as_deref())?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_tag(app: AppHandle, id: String) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state.library.delete_tag(&id)?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn toggle_shortcut(
    app: AppHandle,
    target_type: String,
    target_id: String,
    label: String,
) -> Result<Overview, String> {
    blocking(&app, move |_, state| {
        state
            .library
            .toggle_shortcut(&target_type, &target_id, &label)?;
        overview(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn organize_notes(
    app: AppHandle,
    note_ids: Vec<String>,
    action: String,
    notebook_id: Option<String>,
    tags: Vec<String>,
) -> Result<u64, String> {
    blocking(&app, move |_, state| {
        let library = &state.library;
        match action.as_str() {
            "move" | "copy" => {
                let notebook_id = notebook_id
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| BeverError::Invalid("choose a destination notebook".into()))?;
                if action == "move" {
                    library.move_notes(&note_ids, &notebook_id)
                } else {
                    library.copy_notes(&note_ids, &notebook_id)
                }
            }
            "addTags" => library.add_tags_to_notes(&note_ids, &tags),
            "removeTags" => library.remove_tags_from_notes(&note_ids, &tags),
            _ => Err(BeverError::Invalid(
                "unknown note organization action".into(),
            )),
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn update_note_timestamps(
    app: AppHandle,
    id: String,
    created_at: i64,
    updated_at: i64,
) -> Result<Note, String> {
    blocking(&app, move |_, state| {
        state
            .library
            .update_note_timestamps(&id, created_at, updated_at)
    })
    .await
}

/// Chooses the picture that stands for a note in a list: one of its own,
/// none, or the one found for it. Not an edit: the note keeps its date.
#[tauri::command]
pub(crate) async fn set_note_thumbnail(
    app: AppHandle,
    id: String,
    choice: ThumbnailChoice,
) -> Result<Note, String> {
    blocking(&app, move |_, state| {
        state.library.set_thumbnail(&id, &choice)
    })
    .await
}

/// Pins notes to the top of the notebook each is in, or takes them down.
/// Returns how many changed.
#[tauri::command]
pub(crate) async fn set_notes_pinned(
    app: AppHandle,
    ids: Vec<String>,
    pinned: bool,
) -> Result<u64, String> {
    blocking(&app, move |_, state| state.library.set_pinned(&ids, pinned)).await
}

/// Keeps the note as it is stored, before the editor changes it.
#[tauri::command]
pub(crate) async fn keep_note_version(app: AppHandle, id: String) -> Result<Option<i64>, String> {
    blocking(&app, move |_, state| state.library.keep_note_version(&id)).await
}

#[tauri::command]
pub(crate) async fn note_versions(app: AppHandle, id: String) -> Result<Vec<NoteVersion>, String> {
    blocking(&app, move |_, state| state.library.note_versions(&id)).await
}

#[tauri::command]
pub(crate) async fn restore_note_version(
    app: AppHandle,
    id: String,
    version: i64,
) -> Result<Note, String> {
    blocking(&app, move |_, state| {
        state.library.restore_note_version(&id, version)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    ocr_enabled: bool,
    load_remote_images: bool,
}

/// Text recognition is heavy for a phone; there it starts switched off.
pub(crate) fn ocr_enabled(library: &Library) -> BeverResult<bool> {
    Ok(match library.setting("ocr_enabled")?.as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => !cfg!(mobile),
    })
}

fn settings(library: &Library) -> BeverResult<Settings> {
    Ok(Settings {
        ocr_enabled: ocr_enabled(library)?,
        load_remote_images: library.setting("load_remote_images")?.as_deref() == Some("true"),
    })
}

#[tauri::command]
pub(crate) async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    blocking(&app, |_, state| settings(&state.library)).await
}

/// Changes one of the switches in Settings. Only these keys are accepted, so
/// the interface cannot overwrite sync bookkeeping kept in the same table.
#[tauri::command]
pub(crate) async fn set_setting(
    app: AppHandle,
    key: String,
    enabled: bool,
) -> Result<Settings, String> {
    blocking(&app, move |app, state| {
        if !matches!(key.as_str(), "ocr_enabled" | "load_remote_images") {
            return Err(BeverError::Invalid(format!("unknown setting: {key}")));
        }
        state
            .library
            .set_setting(&key, if enabled { "true" } else { "false" })?;
        if key == "ocr_enabled" {
            state.ocr.wake(app);
        }
        settings(&state.library)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppInfo {
    version: &'static str,
    platform: &'static str,
}

#[tauri::command]
pub(crate) fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}
