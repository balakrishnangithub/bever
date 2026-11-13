//! Synchronization of notes and their attachments.
//!
//! Each note is one remote envelope with a revision that only grows. The
//! listing of the folder they are in gives each envelope's version, which
//! stands for its content; the library keeps the version it last saw of each,
//! so a run can tell which envelopes changed without downloading any.
//!
//! An envelope also describes the notebook its note is in. A run uploads the
//! notebook list last, so a second device that synchronizes meanwhile, or
//! after an interrupted run, meets notes whose notebook is in no list yet;
//! the description lets it file them correctly all the same.
use std::collections::{HashMap, HashSet};

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use super::{
    metadata, note_file,
    remote::{RemoteFile, RemoteStore},
    transfer::{for_each_parallel, WORKERS},
    Layout, Progress,
};
use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{Note, Notebook, Stack, SyncReport},
    repository::{default_notebook, insert_note, note_with, reindex_note, sorted_json},
    resources::mark_ocr_pending,
};

/// Notes handled per round. Bounds memory: only this many note bodies are
/// held at once, however large the library is.
const BATCH: usize = 32;

/// Most bytes of notes sent in one request. Notes are small, and a batch of
/// them nearly always travels in one; this keeps a few very long ones from
/// making a request that takes minutes and is repeated whole when it fails.
const REQUEST_BYTES: usize = 8 * 1024 * 1024;

/// `sync_items.remote_version` of an envelope whose version is not known:
/// it is downloaded when next listed.
const UNKNOWN: &str = "-";

/// `sync_items.synced_hash` of a note whose deletion is known to the remote.
const DELETED: &str = "tombstone";
/// `sync_items.synced_hash` of a note that must be uploaded although the
/// user did not edit it (for example after text recognition finished).
const NEEDS_PUSH: &str = "";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    id: String,
    revision: i64,
    updated_at: i64,
    device_id: String,
    deleted: bool,
    payload: Option<Note>,
    /// The notebook the note is in, and the stack that notebook is in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notebook: Option<Notebook>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stack: Option<Stack>,
}

/// Where a remote note belongs, as its envelope describes it.
struct Placement {
    notebook: Option<Notebook>,
    stack: Option<Stack>,
}

#[derive(Debug, Clone, Default)]
struct SyncState {
    remote_revision: i64,
    synced_hash: String,
    /// The version of the envelope this library last saw; see
    /// [`RemoteFile::version`].
    remote_version: String,
}

/// Which of the folders a run works in were already there when it began. One
/// that was made by this run is empty, and is not listed.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Folders {
    pub(crate) items: bool,
    pub(crate) blobs: bool,
}

/// Notes that travel in one request, and the files they travel as.
struct Upload<T> {
    notes: Vec<T>,
    files: Vec<(String, Vec<u8>)>,
}

/// Divides files into requests of at most [`REQUEST_BYTES`] each; a file
/// larger than that travels alone.
fn requests<T>(files: Vec<(T, String, Vec<u8>)>) -> Vec<Upload<T>> {
    let mut uploads: Vec<Upload<T>> = Vec::new();
    let mut bytes_in_last = 0;
    for (note, name, bytes) in files {
        let fits = uploads.last().is_some_and(|last| last.files.len() < BATCH)
            && bytes_in_last + bytes.len() <= REQUEST_BYTES;
        if !fits {
            uploads.push(Upload {
                notes: Vec::new(),
                files: Vec::new(),
            });
            bytes_in_last = 0;
        }
        bytes_in_last += bytes.len();
        let last = uploads.last_mut().expect("one was just added");
        last.notes.push(note);
        last.files.push((name, bytes));
    }
    uploads
}

/// One synchronization run's view of the remote notes.
pub(crate) struct Session<'a> {
    library: &'a Library,
    remote: &'a dyn RemoteStore,
    layout: &'a Layout,
    files: Vec<RemoteFile>,
    folders: Folders,
    states: HashMap<String, SyncState>,
}

impl<'a> Session<'a> {
    pub(crate) fn open(
        library: &'a Library,
        remote: &'a dyn RemoteStore,
        layout: &'a Layout,
        folders: Folders,
        progress: &mut Progress<'_>,
    ) -> Result<Self> {
        let files = if folders.items {
            progress.emit("discovering", "Listing remote notes", 0, 0);
            remote
                .list(&layout.items())?
                .map(|listing| listing.files)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(Self {
            library,
            remote,
            layout,
            files,
            folders,
            states: sync_states(library)?,
        })
    }

    /// Downloads and applies every remote note that changed since this
    /// library last saw it.
    pub(crate) fn pull(
        &mut self,
        report: &mut SyncReport,
        progress: &mut Progress<'_>,
    ) -> Result<()> {
        let changed: Vec<RemoteFile> = self
            .files
            .iter()
            .filter(|file| {
                note_id_from_filename(&file.name).is_some_and(|id| !self.is_unchanged(id, file))
            })
            .cloned()
            .collect();
        let total = changed.len() as u64;
        if total == 0 {
            return Ok(());
        }
        let deleted_here = local_note_tombstones(self.library)?
            .into_iter()
            .map(|(id, _)| id)
            .collect::<HashSet<_>>();
        let (remote, items) = (self.remote, self.layout.items());
        let mut downloaded = 0;
        for batch in changed.chunks(BATCH) {
            let mut envelopes = Vec::with_capacity(batch.len());
            for_each_parallel(
                batch.to_vec(),
                WORKERS,
                |file| remote.download(&format!("{items}/{}", file.name)),
                |file, bytes| {
                    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|error| {
                        BeverError::Remote(format!(
                            "the remote note {} is unreadable: {error}",
                            file.name
                        ))
                    })?;
                    if note_id_from_filename(&file.name) != Some(envelope.id.as_str()) {
                        return Err(BeverError::Remote(format!(
                            "the remote note {} names a different note",
                            file.name
                        )));
                    }
                    downloaded += 1;
                    progress.emit(
                        "pulling",
                        format!("Downloading notes ({downloaded} of {total})"),
                        downloaded,
                        total,
                    );
                    envelopes.push((envelope, file.version));
                    Ok(())
                },
            )?;
            // Completion order varies; apply in a stable order.
            envelopes.sort_by(|(left, _), (right, _)| left.id.cmp(&right.id));

            let mut to_apply = Vec::new();
            let mut placements = Vec::new();
            for (envelope, version) in envelopes {
                let seen = self
                    .states
                    .get(&envelope.id)
                    .map_or(0, |state| state.remote_revision);
                if envelope.revision <= seen {
                    // Nothing new, but it is now known by its version and is
                    // not downloaded again.
                    self.remember_version(&envelope.id, &version)?;
                    continue;
                }
                if envelope.deleted {
                    let kept = !apply_remote_deletion(self.library, &envelope.id)?;
                    if !kept {
                        report.pulled += 1;
                    }
                    // A note edited here since the last run outlives a remote
                    // deletion and is uploaded again.
                    let mark = if kept { NEEDS_PUSH } else { DELETED };
                    self.record(&envelope.id, envelope.revision, mark, &version)?;
                    continue;
                }
                let Some(mut note) = envelope.payload else {
                    return Err(BeverError::Remote(format!(
                        "the remote note {} has no content",
                        envelope.id
                    )));
                };
                note.revision = envelope.revision;
                if deleted_here.contains(&note.id) {
                    // Deleted here since the last run; the deletion is
                    // uploaded by `push` with a revision above this one.
                    self.record(&note.id, envelope.revision, NEEDS_PUSH, &version)?;
                    continue;
                }
                placements.push(Placement {
                    notebook: envelope.notebook,
                    stack: envelope.stack,
                });
                to_apply.push((note, version));
            }
            // Attachments are stored now and referenced when the notes are
            // applied just below; cleanup must wait until both have happened.
            // (Taken only here: deleting a note above needs the gate itself.)
            let _blobs = self.library.blob_guard();
            self.download_blobs(&to_apply, report, progress)?;
            for ((note, version), placement) in to_apply.into_iter().zip(placements) {
                let outcome = apply_remote_note(self.library, &note, &placement)?;
                if outcome.conflict {
                    report.conflicts += 1;
                }
                report.pulled += 1;
                let mark = if outcome.needs_push {
                    NEEDS_PUSH.to_owned()
                } else {
                    content_hash(&note)?
                };
                self.record(&note.id, note.revision, &mark, &version)?;
            }
        }
        Ok(())
    }

    fn download_blobs(
        &self,
        notes: &[(Note, String)],
        report: &mut SyncReport,
        progress: &mut Progress<'_>,
    ) -> Result<()> {
        let mut wanted = Vec::new();
        let mut seen = HashSet::new();
        for (note, _) in notes {
            for resource in &note.resources {
                let name = resource.file_name.as_deref().unwrap_or("attachment");
                let blobs = [
                    Some((&resource.sha256, resource.size)),
                    resource.alternate_sha256.as_ref().map(|sha| (sha, 0)),
                ];
                for (sha, size) in blobs.into_iter().flatten() {
                    if seen.insert(sha.clone()) && !self.library.blob_path(sha)?.exists() {
                        wanted.push((sha.clone(), size, name.to_owned()));
                    }
                }
            }
        }
        let total = wanted.len() as u64;
        let (library, remote, layout) = (self.library, self.remote, self.layout);
        let mut finished = 0;
        for_each_parallel(
            wanted,
            WORKERS,
            |(sha, size, _)| {
                remote.download_to(&layout.blob(sha), *size, &mut |mut reader| {
                    let stored = library.store_blob_reader(&mut reader)?;
                    if stored.sha256 == *sha {
                        Ok(())
                    } else {
                        Err(BeverError::Remote(format!(
                            "the attachment {sha} arrived damaged"
                        )))
                    }
                })
            },
            |(_, _, name), ()| {
                finished += 1;
                report.blobs_downloaded += 1;
                progress.emit(
                    "attachments",
                    format!("Downloading attachments ({finished} of {total}): {name}"),
                    finished,
                    total,
                );
                Ok(())
            },
        )
    }

    /// Uploads notes that changed here, then deletions.
    pub(crate) fn push(
        &mut self,
        report: &mut SyncReport,
        progress: &mut Progress<'_>,
    ) -> Result<()> {
        let pending = pending_note_ids(self.library)?;
        let total = pending.len() as u64;
        let (library, remote, layout) = (self.library, self.remote, self.layout);
        let device_id = library.device_id().to_owned();
        // What the remote holds of attachments is asked once, and only when
        // a note with an attachment is uploaded: a run that uploads text
        // alone never asks. A folder this run made holds nothing.
        let mut remote_blobs: Option<HashSet<String>> = (!self.folders.blobs).then(HashSet::new);
        let mut no_blobs = HashSet::new();
        let mut uploaded_notes = 0;
        let mut uploaded_blobs = 0;
        for batch in pending.chunks(BATCH) {
            // Keeps the attachment files in place while they are uploaded.
            let _blobs = library.blob_guard();
            let mut notes = Vec::with_capacity(batch.len());
            for id in batch {
                match library.get_note(id) {
                    Ok(note) => notes.push(note),
                    // Deleted since the list was made.
                    Err(BeverError::NotFound(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            if remote_blobs.is_none() && notes.iter().any(|note| !note.resources.is_empty()) {
                progress.emit("discovering", "Listing remote attachments", 0, 0);
                let listed = remote
                    .list(&layout.blobs())?
                    .map(|listing| listing.files)
                    .unwrap_or_default();
                remote_blobs = Some(listed.into_iter().map(|file| file.name).collect());
            }
            // Without a listing no note here has an attachment, and the set
            // is not looked at.
            let known = remote_blobs.as_mut().unwrap_or(&mut no_blobs);

            // A note whose attachment file is missing here cannot be uploaded
            // whole; it is reported and left for a later run.
            let mut missing = Vec::new();
            let mut queued = HashSet::new();
            let mut uploadable = Vec::with_capacity(notes.len());
            for note in notes {
                let mut needed = Vec::new();
                let mut complete = true;
                for resource in &note.resources {
                    let name = resource.file_name.as_deref().unwrap_or("attachment");
                    for sha in [Some(&resource.sha256), resource.alternate_sha256.as_ref()]
                        .into_iter()
                        .flatten()
                    {
                        if known.contains(sha) || queued.contains(sha) {
                            continue;
                        }
                        match std::fs::metadata(library.blob_path(sha)?) {
                            Ok(file) => needed.push((sha.clone(), file.len(), name.to_owned())),
                            Err(_) => complete = false,
                        }
                    }
                }
                if complete {
                    for blob in needed {
                        queued.insert(blob.0.clone());
                        missing.push(blob);
                    }
                    uploadable.push(note);
                } else {
                    let title = if note.title.is_empty() {
                        "Untitled"
                    } else {
                        &note.title
                    };
                    report.warnings.push(format!(
                        "“{title}” was not uploaded: one of its attachment files is missing on this device."
                    ));
                }
            }

            for_each_parallel(
                missing,
                WORKERS,
                |(sha, size, _)| {
                    remote.upload_file(&layout.blob(sha), &library.blob_path(sha)?, *size)
                },
                |(sha, _, name), ()| {
                    known.insert(sha);
                    uploaded_blobs += 1;
                    report.blobs_uploaded += 1;
                    progress.emit(
                        "attachments",
                        format!("Uploading attachments ({uploaded_blobs}): {name}"),
                        0,
                        0,
                    );
                    Ok(())
                },
            )?;

            let prepared = uploadable
                .into_iter()
                .map(|mut note| {
                    let loaded_revision = note.revision;
                    let seen = self
                        .states
                        .get(&note.id)
                        .map_or(0, |state| state.remote_revision);
                    note.revision = loaded_revision.max(seen) + 1;
                    (note, loaded_revision)
                })
                .collect::<Vec<_>>();
            // Read per batch, so a notebook made during a long run is known.
            let snapshot = library.snapshot()?;
            let mut files = Vec::with_capacity(prepared.len());
            for (note, loaded_revision) in prepared {
                let notebook = snapshot
                    .notebooks
                    .iter()
                    .find(|notebook| notebook.id == note.notebook_id);
                let stack = notebook
                    .and_then(|notebook| notebook.stack_id.as_ref())
                    .and_then(|id| snapshot.stacks.iter().find(|stack| stack.id == *id));
                let envelope = Envelope {
                    id: note.id.clone(),
                    revision: note.revision,
                    updated_at: note.updated_at,
                    device_id: device_id.clone(),
                    deleted: false,
                    payload: Some(note),
                    notebook: notebook.cloned(),
                    stack: stack.cloned(),
                };
                let bytes = serde_json::to_vec(&envelope)?;
                let note = envelope.payload.expect("set just above");
                let name = note_file(&note.id);
                files.push(((note, loaded_revision), name, bytes));
            }
            // The notes of a batch travel together, in one request unless
            // they are very long.
            let items = layout.items();
            for_each_parallel(
                requests(files),
                WORKERS,
                |upload| remote.upload_all(&items, &upload.files),
                |upload, stored| {
                    for ((note, loaded_revision), file) in upload.notes.into_iter().zip(stored) {
                        // A note edited while it was being uploaded stays pending.
                        let current =
                            mark_note_synced(library, &note.id, loaded_revision, note.revision)?;
                        let mark = if current {
                            content_hash(&note)?
                        } else {
                            NEEDS_PUSH.to_owned()
                        };
                        self.record(&note.id, note.revision, &mark, &file.version)?;
                        report.pushed += 1;
                        uploaded_notes += 1;
                        progress.emit(
                            "pushing",
                            format!(
                                "Uploading notes ({uploaded_notes} of {total}): {}",
                                note.title
                            ),
                            uploaded_notes,
                            total,
                        );
                    }
                    Ok(())
                },
            )?;
        }
        self.push_deletions(report, progress)
    }

    fn push_deletions(
        &mut self,
        report: &mut SyncReport,
        progress: &mut Progress<'_>,
    ) -> Result<()> {
        let (library, remote, layout) = (self.library, self.remote, self.layout);
        let device_id = library.device_id().to_owned();
        let tombstones = local_note_tombstones(library)?;
        if tombstones.is_empty() {
            return Ok(());
        }
        let listed = self
            .files
            .iter()
            .filter_map(|file| note_id_from_filename(&file.name))
            .collect::<HashSet<_>>();
        let mut files = Vec::new();
        for (id, deleted_at) in tombstones {
            let state = self.states.get(&id);
            let known_remotely = state.is_some() || listed.contains(id.as_str());
            let already_pushed = state.is_some_and(|state| state.synced_hash == DELETED);
            if !known_remotely || already_pushed {
                // Nothing to tell the remote: it never had the note, or
                // already knows the note is gone.
                clear_note_tombstone(library, &id)?;
                continue;
            }
            let revision = state.map_or(0, |state| state.remote_revision) + 1;
            let envelope = Envelope {
                id: id.clone(),
                revision,
                updated_at: deleted_at,
                device_id: device_id.clone(),
                deleted: true,
                payload: None,
                notebook: None,
                stack: None,
            };
            let name = note_file(&id);
            files.push(((id, revision), name, serde_json::to_vec(&envelope)?));
        }
        if files.is_empty() {
            return Ok(());
        }
        progress.emit("pushing", "Uploading deletions", 0, 0);
        let items = layout.items();
        for_each_parallel(
            requests(files),
            WORKERS,
            |upload| remote.upload_all(&items, &upload.files),
            |upload, stored| {
                for ((id, revision), file) in upload.notes.into_iter().zip(stored) {
                    self.record(&id, revision, DELETED, &file.version)?;
                    clear_note_tombstone(library, &id)?;
                    report.pushed += 1;
                }
                Ok(())
            },
        )
    }

    /// Whether an envelope is the one this library last saw.
    fn is_unchanged(&self, id: &str, file: &RemoteFile) -> bool {
        !file.version.is_empty()
            && self
                .states
                .get(id)
                .is_some_and(|state| state.remote_version == file.version)
    }

    /// Records what the remote holds of a note and how this library stands
    /// to it.
    fn record(&mut self, id: &str, revision: i64, mark: &str, version: &str) -> Result<()> {
        let version = if version.is_empty() { UNKNOWN } else { version };
        let connection = self
            .library
            .connection
            .lock()
            .expect("database mutex poisoned");
        connection.execute(
            "INSERT INTO sync_items(kind, id, remote_revision, synced_hash, synced_at, remote_version) VALUES ('note', ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(kind, id) DO UPDATE SET remote_revision = excluded.remote_revision, synced_hash = excluded.synced_hash, synced_at = excluded.synced_at, remote_version = excluded.remote_version",
            params![id, revision, mark, Utc::now().timestamp_millis(), version],
        )?;
        self.states.insert(
            id.to_owned(),
            SyncState {
                remote_revision: revision,
                synced_hash: mark.to_owned(),
                remote_version: version.to_owned(),
            },
        );
        Ok(())
    }

    /// Records the version of an envelope that told this library nothing new.
    fn remember_version(&mut self, id: &str, version: &str) -> Result<()> {
        let Some(state) = self.states.get_mut(id) else {
            return Ok(());
        };
        let version = if version.is_empty() { UNKNOWN } else { version };
        let connection = self
            .library
            .connection
            .lock()
            .expect("database mutex poisoned");
        connection.execute(
            "UPDATE sync_items SET remote_version = ?2 WHERE kind = 'note' AND id = ?1",
            params![id, version],
        )?;
        state.remote_version = version.to_owned();
        Ok(())
    }
}

fn note_id_from_filename(filename: &str) -> Option<&str> {
    filename
        .strip_prefix("note-")?
        .strip_suffix(".json")
        .filter(|id| !id.is_empty())
}

/// Identity of a note's content. The revision is bookkeeping, not content.
fn content_hash(note: &Note) -> Result<String> {
    let mut note = note.clone();
    note.revision = 0;
    // The order tags and attributes are written in is not content.
    note.tags.sort();
    note.attributes = sorted_json(&note.attributes);
    for resource in &mut note.resources {
        resource.attributes = sorted_json(&resource.attributes);
    }
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&note)?)))
}

/// Marks a note as needing upload without treating it as edited by the user.
pub(crate) fn mark_needs_push(connection: &rusqlite::Connection, note_id: &str) -> Result<()> {
    connection.execute(
        "UPDATE sync_items SET synced_hash = ?2 WHERE kind = 'note' AND id = ?1",
        params![note_id, NEEDS_PUSH],
    )?;
    Ok(())
}

struct Applied {
    conflict: bool,
    needs_push: bool,
}

/// Replaces the local copy of a note with the remote one, in one transaction.
///
/// When the local copy was edited since the last run and differs, it is kept
/// as a separate "conflict copy" note first. The decision is made inside the
/// transaction, so an edit saved while attachments were downloading is seen.
fn apply_remote_note(library: &Library, remote: &Note, placement: &Placement) -> Result<Applied> {
    let mut connection = library.connection.lock().expect("database mutex poisoned");
    let transaction = connection.transaction()?;
    let local = match note_with(&transaction, &remote.id) {
        Ok(note) => Some(note),
        Err(BeverError::NotFound(_)) => None,
        Err(error) => return Err(error),
    };
    let mut conflict = false;
    if let Some(local) = &local {
        let edited: bool = transaction.query_row(
            "SELECT dirty != 0 FROM notes WHERE id = ?1",
            [&remote.id],
            |row| row.get(0),
        )?;
        if edited && content_hash(local)? != content_hash(remote)? {
            let mut copy = local.clone();
            copy.id = Uuid::new_v4().to_string();
            let title = if local.title.is_empty() {
                "Untitled"
            } else {
                &local.title
            };
            copy.title = format!("{title} (conflict copy)");
            copy.revision = 1;
            copy.evernote_guid = None;
            for resource in &mut copy.resources {
                resource.id = Uuid::new_v4().to_string();
                resource.note_id = copy.id.clone();
            }
            insert_note(&transaction, &copy)?;
            mark_ocr_pending(&transaction, &copy.id)?;
            conflict = true;
        }
    }

    // Replacing the row would otherwise lose what only this device knows:
    // text it recognised in images, and which import the note came from.
    let recognised = transaction
        .prepare("SELECT sha256, recognition_text, ocr_state, recognition_xml FROM resources WHERE note_id = ?1 AND ocr_state IN (2, 3)")?
        .query_map([&remote.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let imports = transaction
        .prepare("SELECT import_key, imported_at FROM import_sources WHERE note_id = ?1")?
        .query_map([&remote.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut note = remote.clone();
    let mut needs_push = false;
    let mut refiled = false;
    let notebook_exists = transaction
        .prepare("SELECT 1 FROM notebooks WHERE id = ?1")?
        .exists([&note.notebook_id])?;
    if !notebook_exists {
        let described = placement
            .notebook
            .as_ref()
            .filter(|notebook| notebook.id == note.notebook_id);
        let deleted = metadata::deleted_at(&transaction, "notebook", &note.notebook_id)?.is_some();
        match described {
            // Not deleted, only not heard of yet: the device that wrote the
            // note has not uploaded its notebook list. Filing the note
            // elsewhere, and uploading that, would undo its notebook for
            // every device.
            Some(notebook) if !deleted => {
                metadata::adopt_notebook(&transaction, notebook, placement.stack.as_ref())?;
            }
            // Its notebook was deleted; the corrected placement is uploaded.
            _ => {
                note.notebook_id = default_notebook(&transaction, None)?;
                needs_push = true;
                refiled = true;
            }
        }
    }
    transaction.execute("DELETE FROM notes_fts WHERE note_id = ?1", [&note.id])?;
    transaction.execute("DELETE FROM notes WHERE id = ?1", [&note.id])?;
    insert_note(&transaction, &note)?;
    for (import_key, imported_at) in imports {
        transaction.execute(
            "INSERT OR IGNORE INTO import_sources(import_key, note_id, imported_at) VALUES (?1, ?2, ?3)",
            params![import_key, note.id, imported_at],
        )?;
    }
    let mut restored_text = false;
    for (sha256, text, state, xml) in recognised {
        let restored = transaction.execute(
            "UPDATE resources SET recognition_text = ?3, ocr_state = ?4, recognition_xml = ?5
             WHERE note_id = ?1 AND sha256 = ?2 AND recognition_text IS NULL AND recognition_xml IS NULL",
            params![note.id, sha256, text, state, xml],
        )?;
        restored_text |= restored > 0 && text.is_some();
    }
    if restored_text {
        reindex_note(&transaction, &note.id)?;
        needs_push = true;
    }
    mark_ocr_pending(&transaction, &note.id)?;
    transaction.execute(
        "UPDATE notes SET dirty = ?2 WHERE id = ?1",
        params![note.id, refiled],
    )?;
    transaction.commit()?;
    Ok(Applied {
        conflict,
        needs_push,
    })
}

/// Removes a note the remote deleted. Returns false, leaving the note alone,
/// when it was edited here since the last run.
fn apply_remote_deletion(library: &Library, id: &str) -> Result<bool> {
    let edited: Option<bool> = {
        let connection = library.connection.lock().expect("database mutex poisoned");
        connection
            .query_row("SELECT dirty != 0 FROM notes WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
    };
    match edited {
        Some(true) => Ok(false),
        Some(false) => {
            library.purge_notes(std::slice::from_ref(&id.to_owned()), false)?;
            Ok(true)
        }
        None => Ok(true),
    }
}

/// Notes to upload: edited ones, ones the remote has never seen, and ones
/// marked by [`mark_needs_push`]. Decided from flags alone, so a run with
/// nothing to do never loads a note.
fn pending_note_ids(library: &Library) -> Result<Vec<String>> {
    let connection = library.connection.lock().expect("database mutex poisoned");
    let ids = connection
        .prepare(
            "SELECT n.id FROM notes n
             LEFT JOIN sync_items s ON s.kind = 'note' AND s.id = n.id
             WHERE n.dirty != 0 OR s.id IS NULL OR s.synced_hash = ?1
             ORDER BY n.title COLLATE NOCASE, n.id",
        )?
        .query_map([NEEDS_PUSH], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Records an upload. Returns false when the note changed after it was read
/// for uploading; it then stays marked as edited so the change is not lost.
fn mark_note_synced(
    library: &Library,
    id: &str,
    loaded_revision: i64,
    uploaded_revision: i64,
) -> Result<bool> {
    let connection = library.connection.lock().expect("database mutex poisoned");
    let unchanged = connection.execute(
        "UPDATE notes SET revision = ?3, dirty = 0 WHERE id = ?1 AND revision = ?2",
        params![id, loaded_revision, uploaded_revision],
    )? > 0;
    Ok(unchanged)
}

fn local_note_tombstones(library: &Library) -> Result<Vec<(String, i64)>> {
    let connection = library.connection.lock().expect("database mutex poisoned");
    let rows = connection
        .prepare("SELECT id, deleted_at FROM sync_tombstones WHERE kind = 'note' ORDER BY id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn clear_note_tombstone(library: &Library, id: &str) -> Result<()> {
    let connection = library.connection.lock().expect("database mutex poisoned");
    connection.execute(
        "DELETE FROM sync_tombstones WHERE kind = 'note' AND id = ?1",
        [id],
    )?;
    Ok(())
}

fn sync_states(library: &Library) -> Result<HashMap<String, SyncState>> {
    let connection = library.connection.lock().expect("database mutex poisoned");
    let rows = connection
        .prepare(
            "SELECT id, remote_revision, synced_hash, remote_version FROM sync_items WHERE kind = 'note'",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SyncState {
                    remote_revision: row.get::<_, i64>(1)?,
                    synced_hash: row.get::<_, String>(2)?,
                    remote_version: row.get::<_, String>(3)?,
                },
            ))
        })?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_note_ids_accept_only_note_envelopes() {
        assert_eq!(note_id_from_filename("note-abc.json"), Some("abc"));
        assert_eq!(note_id_from_filename("index.json"), None);
        assert_eq!(note_id_from_filename("note-.json"), None);
    }
}
