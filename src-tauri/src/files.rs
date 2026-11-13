//! Everything that crosses between the library and the user's files:
//! importing and exporting ENEX, and adding, opening, and saving attachments.
//!
//! No command here accepts a path from the WebView. Files are chosen in
//! native dialogs opened from this side, and a file chosen for a later step
//! is referred to by an opaque token. Files are opened through the fs plugin,
//! which also understands the `content://` URIs Android's picker returns.
use std::{
    borrow::Cow,
    collections::HashMap,
    io::{self, BufReader, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use bever_core::{
    enex::{default_notebook_name, export_enex_writer, import_enex_reader},
    error::{BeverError, Result as BeverResult},
    models::{ImportProgress, ImportReport, Resource},
};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::{ipc::InvokeBody, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::{blocking, AppState};

/// Largest attachment accepted from the clipboard or a drop. Larger files go
/// through the file dialog, which streams them without holding them in memory.
const MAX_INLINE_ATTACHMENT: usize = 100 * 1024 * 1024;

/// Files chosen for import and the state of the running import.
#[derive(Default)]
pub(crate) struct ImportState {
    picked: Mutex<HashMap<String, PickedSource>>,
    running: AtomicBool,
    cancel: AtomicBool,
}

impl ImportState {
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    pub(crate) fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Marks an import as running until what is returned is dropped; refused
    /// while another runs.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    pub(crate) fn begin(&self) -> BeverResult<RunningImport<'_>> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(BeverError::Invalid("an import is already running".into()));
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(RunningImport(&self.running))
    }

    /// Set by `cancel_import`; an import looks at it between notes.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    pub(crate) fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }
}

struct PickedSource {
    path: FilePath,
    name: String,
}

struct FileInfo {
    name: String,
    size: u64,
    mime: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedFile {
    token: String,
    name: String,
    size: u64,
    /// Suggested notebook: the file name without `.enex` and a note count.
    notebook_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportRequest {
    token: String,
    notebook_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportEvent<'a> {
    import_id: &'a str,
    file_index: usize,
    file_count: usize,
    file_name: &'a str,
    #[serde(flatten)]
    progress: ImportProgress,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportOutcome {
    file_name: String,
    notebook_name: String,
    report: Option<ImportReport>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ExportScope {
    #[serde(rename_all = "camelCase")]
    Notes {
        note_ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Notebook {
        notebook_id: String,
    },
    All,
}

fn file_dialog(app: &AppHandle, title: &str) -> FileDialogBuilder<tauri::Wry> {
    let dialog = app.dialog().file().set_title(title);
    #[cfg(desktop)]
    let dialog = match app.get_webview_window("main") {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    };
    dialog
}

fn open_for_reading(app: &AppHandle, path: &FilePath) -> BeverResult<std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    Ok(app.fs().open(path.clone(), options)?)
}

fn open_for_writing(app: &AppHandle, path: &FilePath) -> BeverResult<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    Ok(app.fs().open(path.clone(), options)?)
}

/// Name, size, and type of a picked file. Android describes picked files by
/// URI, so the system is asked; if it will not say, the name is read from
/// the URI as well as it can be.
fn file_info(_state: &AppState, path: &FilePath) -> FileInfo {
    match path {
        FilePath::Path(path) => FileInfo {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size: path.metadata().map(|metadata| metadata.len()).unwrap_or(0),
            mime: None,
        },
        FilePath::Url(url) => {
            #[cfg(target_os = "android")]
            if let Some(info) = _state.platform.file_info(url.as_str()) {
                return FileInfo {
                    name: info.name,
                    size: info.size,
                    mime: info.mime,
                };
            }
            FileInfo {
                name: name_from_uri(url),
                size: 0,
                mime: None,
            }
        }
    }
}

/// Last component of a URI, such as `Trip notes.enex` in
/// `content://…/document/primary%3ADownload%2FTrip%20notes.enex`.
fn name_from_uri(url: &Url) -> String {
    let decoded = percent_decode_str(url.path()).decode_utf8_lossy();
    decoded
        .rsplit(['/', ':'])
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[tauri::command]
pub(crate) async fn pick_enex_files(app: AppHandle) -> Result<Vec<PickedFile>, String> {
    blocking(&app, |app, state| {
        let dialog = file_dialog(app, "Import Evernote exports");
        // Android filters by media type and knows none for `.enex`, so a
        // filter there would leave nothing selectable.
        #[cfg(not(target_os = "android"))]
        let dialog = dialog.add_filter("Evernote export", &["enex"]);
        let Some(paths) = dialog.blocking_pick_files() else {
            return Ok(Vec::new());
        };
        let mut picked = state.imports.picked.lock().expect("import state poisoned");
        // Files from a dialog that was abandoned are no longer needed.
        picked.clear();
        Ok(paths
            .into_iter()
            .map(|path| {
                let info = file_info(state, &path);
                let token = uuid::Uuid::new_v4().to_string();
                let file = PickedFile {
                    token: token.clone(),
                    notebook_name: default_notebook_name(&info.name),
                    size: info.size,
                    name: info.name.clone(),
                };
                picked.insert(
                    token,
                    PickedSource {
                        path,
                        name: info.name,
                    },
                );
                file
            })
            .collect())
    })
    .await
}

/// Clears the running flag even if an import panics.
pub(crate) struct RunningImport<'a>(&'a AtomicBool);

impl Drop for RunningImport<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Imports the chosen files one after another. A file that fails does not
/// stop the others; cancelling stops after the note being read.
#[tauri::command]
pub(crate) async fn import_enex(
    app: AppHandle,
    import_id: String,
    files: Vec<ImportRequest>,
) -> Result<Vec<ImportOutcome>, String> {
    blocking(&app, move |app, state| {
        if state.imports.running.swap(true, Ordering::SeqCst) {
            return Err(BeverError::Invalid("an import is already running".into()));
        }
        let _running = RunningImport(&state.imports.running);
        state.imports.cancel.store(false, Ordering::SeqCst);
        let sources = {
            let mut picked = state.imports.picked.lock().expect("import state poisoned");
            files
                .into_iter()
                .map(|request| {
                    picked
                        .remove(&request.token)
                        .map(|source| (source, request.notebook_name))
                        .ok_or_else(|| {
                            BeverError::Invalid("choose the files to import again".into())
                        })
                })
                .collect::<BeverResult<Vec<_>>>()?
        };
        let file_count = sources.len();
        let mut outcomes = Vec::with_capacity(file_count);
        for (file_index, (source, notebook_name)) in sources.into_iter().enumerate() {
            let mut last_emit: Option<(Instant, String)> = None;
            let result = open_for_reading(app, &source.path).and_then(|file| {
                let total_bytes = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                import_enex_reader(
                    &state.library,
                    BufReader::with_capacity(1024 * 1024, file),
                    total_bytes,
                    &notebook_name,
                    &state.imports.cancel,
                    |progress| {
                        // Thousands of notes a second would flood the
                        // interface; phase changes always get through.
                        let due = last_emit.as_ref().is_none_or(|(at, phase)| {
                            *phase != progress.phase || at.elapsed() >= Duration::from_millis(80)
                        });
                        if due {
                            last_emit = Some((Instant::now(), progress.phase.clone()));
                            let _ = app.emit(
                                "bever:import-progress",
                                ImportEvent {
                                    import_id: &import_id,
                                    file_index,
                                    file_count,
                                    file_name: &source.name,
                                    progress,
                                },
                            );
                        }
                    },
                )
            });
            let cancelled = matches!(&result, Ok(report) if report.cancelled);
            outcomes.push(match result {
                Ok(report) => ImportOutcome {
                    file_name: source.name,
                    notebook_name,
                    report: Some(report),
                    error: None,
                },
                Err(error) => ImportOutcome {
                    file_name: source.name,
                    notebook_name,
                    report: None,
                    error: Some(error.to_string()),
                },
            });
            if cancelled {
                break;
            }
        }
        state.ocr.wake(app);
        Ok(outcomes)
    })
    .await
}

#[tauri::command]
pub(crate) fn cancel_import(app: AppHandle) {
    app.state::<AppState>()
        .imports
        .cancel
        .store(true, Ordering::SeqCst);
}

/// Lets the user choose files and stores them as attachments of a note. The
/// editor then places them at the cursor.
#[tauri::command]
pub(crate) async fn attach_files(app: AppHandle, note_id: String) -> Result<Vec<Resource>, String> {
    blocking(&app, move |app, state| {
        let Some(paths) = file_dialog(app, "Attach files").blocking_pick_files() else {
            return Ok(Vec::new());
        };
        let mut resources = Vec::with_capacity(paths.len());
        for path in paths {
            let info = file_info(state, &path);
            let mut file = open_for_reading(app, &path)?;
            resources.push(state.library.add_resource(
                &note_id,
                &mut file,
                &info.name,
                info.mime.as_deref(),
            )?);
        }
        state.ocr.wake(app);
        Ok(resources)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InlineAttachment<'a> {
    note_id: String,
    file_name: String,
    mime: Option<String>,
    /// Base64, for platforms whose IPC cannot carry raw bytes (Android).
    /// Borrowed from the request: it can be tens of megabytes.
    #[serde(borrow)]
    data: Cow<'a, str>,
}

/// Stores bytes the editor received from the clipboard or a drop. Desktop
/// sends them as the raw request body with the details in headers; Android
/// sends JSON with base64 data.
#[tauri::command(async)]
pub(crate) fn attach_bytes(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Resource, String> {
    let state = app.state::<AppState>();
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
    };
    let too_large =
        || "This file is too large to paste or drop. Use Attach a file instead.".to_owned();
    let resource = match request.body() {
        InvokeBody::Raw(bytes) => {
            if bytes.len() > MAX_INLINE_ATTACHMENT {
                return Err(too_large());
            }
            let note_id = header("x-note-id").ok_or("missing note")?;
            let file_name = header("x-file-name").unwrap_or_default();
            state.library.add_resource(
                &note_id,
                &mut &bytes[..],
                &file_name,
                header("x-mime").as_deref(),
            )
        }
        InvokeBody::Json(value) => {
            let attachment =
                InlineAttachment::deserialize(value).map_err(|error| error.to_string())?;
            if attachment.data.len() / 4 * 3 > MAX_INLINE_ATTACHMENT {
                return Err(too_large());
            }
            let bytes =
                base64_decode(&attachment.data).ok_or("the attachment data is unreadable")?;
            state.library.add_resource(
                &attachment.note_id,
                &mut &bytes[..],
                &attachment.file_name,
                attachment.mime.as_deref(),
            )
        }
    }
    .map_err(|error| error.to_string())?;
    state.ocr.wake(&app);
    Ok(resource)
}

/// Standard base64 without a dependency on the encoding used elsewhere.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(text.len() / 4 * 3);
    let (mut buffer, mut bits) = (0u32, 0u8);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(output)
}

/// Exports notes to an ENEX file the user chooses. Returns the number of
/// notes written, or `None` when the dialog was cancelled.
#[tauri::command]
pub(crate) async fn export_notes(
    app: AppHandle,
    scope: ExportScope,
    suggested_name: String,
) -> Result<Option<u64>, String> {
    blocking(&app, move |app, state| {
        let ids = match scope {
            ExportScope::Notes { note_ids } => note_ids,
            ExportScope::Notebook { notebook_id } => state.library.note_ids(Some(&notebook_id))?,
            ExportScope::All => state.library.note_ids(None)?,
        };
        if ids.is_empty() {
            return Err(BeverError::Invalid("there are no notes to export".into()));
        }
        let name = format!("{}.enex", safe_file_name(&suggested_name, "Bever export"));
        let Some(destination) = file_dialog(app, "Export notes")
            .set_file_name(name)
            .add_filter("Evernote export", &["enex"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let file = open_for_writing(app, &destination)?;
        export_enex_writer(&state.library, &ids, file, |_, _| {}).map(Some)
    })
    .await
}

/// Saves an attachment where the user chooses. Returns false when the dialog
/// was cancelled.
#[tauri::command]
pub(crate) async fn save_attachment(app: AppHandle, resource_id: String) -> Result<bool, String> {
    blocking(&app, move |app, state| {
        let resource = state.library.resource(&resource_id)?;
        let Some(destination) = file_dialog(app, "Save attachment")
            .set_file_name(attachment_file_name(&resource))
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut source = state.library.open_blob(&resource.sha256)?;
        let mut target = open_for_writing(app, &destination)?;
        io::copy(&mut source, &mut target)?;
        Ok(true)
    })
    .await
}

fn opened_attachments_dir(app: &AppHandle) -> BeverResult<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| BeverError::Invalid(format!("cannot locate the cache folder: {error}")))?
        .join("attachments"))
}

/// Copies of attachments handed to other applications live only until the
/// next start, so they do not accumulate outside the library.
pub(crate) fn purge_opened_attachments(app: &AppHandle) {
    if let Ok(directory) = opened_attachments_dir(app) {
        let _ = std::fs::remove_dir_all(directory);
    }
}

/// Opens an attachment in the application the system associates with it.
/// The other application gets a copy under the attachment's own file name,
/// never the library's content-addressed file.
#[tauri::command]
pub(crate) async fn open_attachment(app: AppHandle, resource_id: String) -> Result<(), String> {
    blocking(&app, move |app, state| {
        let resource = state.library.resource(&resource_id)?;
        let directory = opened_attachments_dir(app)?.join(&resource.id);
        std::fs::create_dir_all(&directory)?;
        let destination = directory.join(attachment_file_name(&resource));
        copy_blob(
            &mut state.library.open_blob(&resource.sha256)?,
            &destination,
        )?;
        let path = destination.to_string_lossy().into_owned();
        #[cfg(target_os = "android")]
        return state.platform.open_file(&path, &resource.mime);
        #[cfg(not(target_os = "android"))]
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|error| BeverError::Invalid(format!("cannot open the attachment: {error}")))
    })
    .await
}

fn copy_blob(source: &mut impl Read, destination: &Path) -> BeverResult<()> {
    let mut target = std::fs::File::create(destination)?;
    io::copy(source, &mut target)?;
    Ok(())
}

/// Opens a link from a note in the browser or mail client. Only web, mail,
/// and telephone addresses are passed on: a note is untrusted content and
/// must not be able to start arbitrary programs or open local files.
#[tauri::command]
pub(crate) fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed =
        Url::parse(url.trim()).map_err(|_| "This link is not a valid address.".to_owned())?;
    if !is_external_scheme(parsed.scheme()) {
        return Err(format!(
            "Links starting with “{}:” are not opened from notes.",
            parsed.scheme()
        ));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

fn is_external_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "mailto" | "tel")
}

/// File name for an attachment handed to the system: safe on every platform
/// and with an extension, so the system knows which application opens it.
pub(crate) fn attachment_file_name(resource: &Resource) -> String {
    let name = safe_file_name(
        resource.file_name.as_deref().unwrap_or_default(),
        "attachment",
    );
    if Path::new(&name).extension().is_some() {
        return name;
    }
    match extension_for_mime(&resource.mime) {
        Some(extension) => format!("{name}.{extension}"),
        None => name,
    }
}

fn extension_for_mime(mime: &str) -> Option<&'static str> {
    // The registry lists several extensions per type in no useful order.
    let preferred = match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/html" => "html",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "application/zip" | "application/x-zip-compressed" => "zip",
        _ => return mime_guess::get_mime_extensions_str(mime).and_then(|all| all.first().copied()),
    };
    Some(preferred)
}

/// Removes what a file system or a path would misread from a suggested name.
pub(crate) fn safe_file_name(name: &str, fallback: &str) -> String {
    let cleaned = name
        .chars()
        .map(|character| {
            if matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim().trim_matches(['.', ' ']).trim();
    let mut name: String = if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned.chars().take(160).collect()
    };
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        name.insert(0, '_');
    }
    name
}

#[cfg(test)]
mod tests {
    use bever_core::Library;

    use super::*;

    fn resource(file_name: Option<&str>, mime: &str) -> Resource {
        Resource {
            id: "id".into(),
            note_id: "note".into(),
            sha256: String::new(),
            md5: String::new(),
            mime: mime.into(),
            file_name: file_name.map(str::to_owned),
            size: 0,
            width: None,
            height: None,
            duration: None,
            recognition_xml: None,
            recognition_text: None,
            attributes: serde_json::json!({}),
            alternate_sha256: None,
            position: 0,
        }
    }

    #[test]
    fn file_names_are_safe_and_keep_their_extension() {
        assert_eq!(
            safe_file_name("Quarterly report.pdf", "x"),
            "Quarterly report.pdf"
        );
        assert_eq!(safe_file_name("../bad\\name:.pdf", "x"), "_bad_name_.pdf");
        assert_eq!(safe_file_name("CON.txt", "x"), "_CON.txt");
        assert_eq!(safe_file_name("com1", "x"), "_com1");
        assert_eq!(safe_file_name("COM0", "x"), "COM0");
        assert_eq!(safe_file_name("Compass", "x"), "Compass");
        assert_eq!(safe_file_name("...", "attachment"), "attachment");
        assert_eq!(safe_file_name("", "Bever export"), "Bever export");
        assert_eq!(safe_file_name("a\0b.txt", "x"), "a_b.txt");
    }

    #[test]
    fn attachments_without_a_name_or_extension_get_one_from_their_type() {
        assert_eq!(
            attachment_file_name(&resource(None, "image/png")),
            "attachment.png"
        );
        assert_eq!(
            attachment_file_name(&resource(None, "image/jpeg")),
            "attachment.jpg"
        );
        assert_eq!(
            attachment_file_name(&resource(Some("scan"), "application/pdf")),
            "scan.pdf"
        );
        assert_eq!(
            attachment_file_name(&resource(Some("photo.JPG"), "image/jpeg")),
            "photo.JPG"
        );
        assert_eq!(
            attachment_file_name(&resource(None, "application/x-unknown-thing")),
            "attachment"
        );
    }

    #[test]
    fn only_web_mail_and_phone_links_leave_the_application() {
        for allowed in ["http", "https", "mailto", "tel"] {
            assert!(is_external_scheme(allowed));
        }
        for refused in [
            "file",
            "javascript",
            "evernote",
            "bever",
            "ms-settings",
            "data",
            "smb",
        ] {
            assert!(!is_external_scheme(refused), "{refused}");
        }
    }

    #[test]
    fn android_document_uris_yield_a_file_name() {
        let uri = Url::parse(
            "content://com.android.externalstorage.documents/document/primary%3ADownload%2FTrip%20notes%20(12%20notes).enex",
        )
        .unwrap();
        assert_eq!(name_from_uri(&uri), "Trip notes (12 notes).enex");
        assert_eq!(default_notebook_name(&name_from_uri(&uri)), "Trip notes");
    }

    #[test]
    fn base64_from_the_webview_is_decoded() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(
            base64_decode("aGVsbG8gd29ybGQ=\r\n").unwrap(),
            b"hello world"
        );
        assert_eq!(base64_decode("").unwrap(), b"");
        assert!(base64_decode("not base64!").is_none());
    }

    #[test]
    fn an_attachment_sent_as_json_is_read_without_copying_its_data() {
        let request = serde_json::json!({
            "noteId": "note",
            "fileName": "picture.png",
            "mime": "image/png",
            "data": "aGVsbG8=",
        });
        let attachment = InlineAttachment::deserialize(&request).unwrap();
        assert_eq!(attachment.note_id, "note");
        assert_eq!(attachment.file_name, "picture.png");
        assert_eq!(attachment.mime.as_deref(), Some("image/png"));
        assert!(matches!(attachment.data, Cow::Borrowed("aGVsbG8=")));
    }

    #[test]
    fn an_opened_attachment_is_a_faithful_copy_of_the_stored_blob() {
        // Regression: attachments were looked up at `blobs/<sha>` although the
        // store keeps them at `blobs/<aa>/<bb>/<sha>`, so opening always failed.
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path().join("library")).unwrap();
        let note = library.create_note(None).unwrap();
        let attached = library
            .add_resource(
                &note.id,
                &mut &b"%PDF-1.4 attachment"[..],
                "report.pdf",
                None,
            )
            .unwrap();
        let destination = directory.path().join(attachment_file_name(&attached));
        copy_blob(
            &mut library.open_blob(&attached.sha256).unwrap(),
            &destination,
        )
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"%PDF-1.4 attachment");
        assert_eq!(destination.file_name().unwrap(), "report.pdf");
    }
}
