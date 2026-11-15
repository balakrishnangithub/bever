//! Reads notes straight from the Evernote application's own files.
//!
//! Exporting from Evernote is one notebook at a time. The application, once
//! it has synchronized, keeps all of an account on the computer it runs on,
//! and this module reads it there: no export, no sign-in, no network.
//!
//! Evernote 10 and later keep, under the folder of their data
//! (`%APPDATA%\Evernote` on Windows):
//!
//! ```text
//! conduit-storage/<site>/UDB-User<id>+RemoteGraph.sql    an SQLite database:
//!     Nodes_Notebook, Nodes_Note, Nodes_Tag, NoteTag     what there is
//!     Attachment, AttachmentRecognition                  and what belongs to it
//! conduit-fs/<site>/<name>/rte/Note/internal_rteDoc/<abc>/<xyz>/<note id>.dat
//!                                                        each note's body
//! resource-cache/<n>/<note id>/<md5 of the file>         each attachment
//! ```
//!
//! A note's body is a Yjs document ([`crate::ydoc`]) whose `content` is the
//! note's markup as a tree of elements. Written out the way Evernote's own
//! export writes it, it is, byte for byte, the content of an ENEX file.
//! That is the aim of everything here: a note read from these files is the
//! same [`EnexNote`] that reading its export gives, and goes through the
//! same import. Two things are added that an export from a current
//! Evernote leaves out: the note's identifier, and the text Evernote
//! recognised in its pictures. And one thing is read as Evernote shows it
//! and not as an export has it: the title of a note that was given none.
//!
//! The files are only ever read. None of this is a published format: it is
//! what Evernote 11 writes, and another version may write something else,
//! which is reported and never guessed at.

use std::{
    collections::HashSet,
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::DateTime;
use regex::Regex;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::marks::ForeignMarks;
use crate::{
    enex::{BlobSink, EarlierReading, EnexNote, EnexResource},
    error::{BeverError, Result},
    organize::ForeignShortcut,
    repository::ImportNoteResult,
    tasks::Task,
    ydoc::{Any, XmlNode, YDoc},
    Library,
};

/// What an export calls a note that was given no title, and what Bever
/// called it up to 1.1.1.
const UNTITLED: &str = "Untitled Note";

/// The attachments a note's markup names, by their hashes.
static MEDIA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<en-media\b[^>]*\shash="([0-9A-Fa-f]{32})""#).expect("valid regex")
});

fn unknown(what: &str) -> BeverError {
    BeverError::Invalid(format!(
        "Evernote’s data on this computer is not in the form Bever knows: {what}"
    ))
}

/// One account whose data the Evernote application keeps on this computer.
#[derive(Debug, Clone)]
pub struct EvernoteAccount {
    /// Evernote's number for the user.
    pub user_id: String,
    database: PathBuf,
    /// Folders that hold note bodies, `…/internal_rteDoc`.
    bodies: Vec<PathBuf>,
    /// Folders that hold a folder of attachments for each note.
    caches: Vec<PathBuf>,
}

/// A notebook of the account, with what importing it would bring.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalNotebook {
    pub id: String,
    pub name: String,
    pub stack: Option<String>,
    pub notes: u64,
    pub attachments: u64,
    pub bytes: u64,
    /// Notes that cannot be imported whole: their text or one of their
    /// attachments is not among Evernote's files on this computer.
    pub notes_not_downloaded: u64,
    /// Those notes, so that they can be named: Evernote does not say which
    /// they are, and they have to be opened there one by one.
    pub incomplete: Vec<LocalIncompleteNote>,
}

/// A note of which Evernote does not have everything on this computer.
///
/// Evernote fetches a note's attachments when it synchronizes. When the
/// service refuses one, Evernote records it as fetched all the same and does
/// not try again, so synchronizing longer does not bring it; opening the
/// note does.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalIncompleteNote {
    pub title: String,
    /// The note's text is missing. Such a note cannot be imported at all;
    /// one that only lacks attachments can be imported without them.
    pub text_missing: bool,
    pub attachments: u64,
    pub attachments_missing: u64,
}

/// What an import from Evernote's files is asked to do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalImportOptions {
    /// Import a note whose text is here although attachments of it are not,
    /// without those attachments, instead of leaving it out.
    pub without_missing_attachments: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalOverview {
    pub user_id: String,
    pub notebooks: Vec<LocalNotebook>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalImportProgress {
    /// `preparing`, then for each notebook `notebookReady` and
    /// `importing`, then `finalizing` and `complete`.
    pub phase: String,
    pub notebook: Option<String>,
    /// The notebook in this library that the notes go into.
    pub notebook_id: Option<String>,
    pub notebook_index: u64,
    pub notebook_count: u64,
    pub note_title: Option<String>,
    /// Notes looked at so far, of `note_count`.
    pub note_index: u64,
    pub note_count: u64,
    pub notes_imported: u64,
    pub notes_skipped: u64,
    pub notes_failed: u64,
    pub resources_imported: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalImportReport {
    pub notebooks: u64,
    pub notes_imported: u64,
    /// Notes whose newer form took the place of the one imported before.
    pub notes_updated: u64,
    /// Of the imported notes, those added beside an earlier form of
    /// themselves that had been changed in this library.
    pub notes_kept_both: u64,
    /// Notes already present from an earlier import of the same content.
    pub notes_skipped: u64,
    /// Notes that were not imported; each kind has an entry in `warnings`.
    pub notes_failed: u64,
    /// Of the imported and updated notes, those that came without
    /// attachments Evernote does not have on this computer.
    pub notes_incomplete: u64,
    pub resources_imported: u64,
    pub bytes_imported: u64,
    pub images_queued: u64,
    pub links_resolved: u64,
    /// Tags placed under the tags they are under in Evernote.
    pub tags_nested: u64,
    /// Shortcuts Evernote has that were added here.
    pub shortcuts_added: u64,
    /// Shortcuts Evernote has that lead to nothing that is in the library:
    /// a stack no notebook is in any more, a note that was not imported.
    pub shortcuts_nowhere: u64,
    /// Evernote's tasks that came as items of checklists, and the notes
    /// they are in.
    pub tasks_brought: u64,
    pub notes_with_tasks: u64,
    /// Notes of the chosen notebooks that lie in Evernote's trash. They are
    /// not imported.
    pub notes_in_trash: u64,
    /// Tags that no note has, made because the whole account was imported.
    pub tags_added: u64,
    /// Notes given the picture Evernote shows them by, or none where the
    /// thumbnail was removed there.
    #[serde(default)]
    pub thumbnails_brought: u64,
    /// Notes pinned to their notebooks as they are in Evernote.
    #[serde(default)]
    pub pins_brought: u64,
    pub cancelled: bool,
    pub warnings: Vec<String>,
}

/// The folder in which the Evernote application keeps its data for the
/// signed-in user of this computer, if the system has one.
pub fn default_data_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|base| PathBuf::from(base).join("Evernote"))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Evernote")
        })
    } else {
        None
    }
}

fn folders(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// The accounts the Evernote application keeps under `data_dir`. Empty when
/// Evernote is not installed there or has never been signed in to.
pub fn find_accounts(data_dir: &Path) -> Vec<EvernoteAccount> {
    let mut bodies = Vec::new();
    for site in folders(&data_dir.join("conduit-fs")) {
        for name in folders(&site) {
            let path = name.join("rte").join("Note").join("internal_rteDoc");
            if path.is_dir() {
                bodies.push(path);
            }
        }
    }
    let caches = folders(&data_dir.join("resource-cache"));
    let mut accounts = Vec::new();
    for site in folders(&data_dir.join("conduit-storage")) {
        let Ok(entries) = fs::read_dir(&site) else {
            continue;
        };
        for entry in entries.filter_map(|entry| entry.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let user = name
                .strip_prefix("UDB-User")
                .and_then(|rest| rest.strip_suffix("+RemoteGraph.sql"));
            if let Some(user) = user.filter(|user| !user.is_empty()) {
                accounts.push(EvernoteAccount {
                    user_id: user.to_owned(),
                    database: entry.path(),
                    bodies: bodies.clone(),
                    caches: caches.clone(),
                });
            }
        }
    }
    accounts.sort_by(|a, b| a.user_id.cmp(&b.user_id));
    accounts
}

struct NoteRow {
    id: String,
    /// What Evernote shows as the note's title.
    title: String,
    /// The note was given no title: Evernote shows words of its text.
    untitled: bool,
    created: i64,
    updated: i64,
    author: Option<String>,
    source: Option<String>,
    source_url: Option<String>,
    source_application: Option<String>,
    subject_date: Option<i64>,
    content_class: Option<String>,
    reminder_order: Option<i64>,
    reminder_time: Option<i64>,
    reminder_done_time: Option<i64>,
}

struct AttachmentRow {
    id: String,
    file_name: Option<String>,
    mime: String,
    width: Option<i64>,
    height: Option<i64>,
    hash: String,
    size: u64,
    shard: Option<String>,
    data_keys: Option<String>,
    data: Option<String>,
    recognition: Option<String>,
}

impl EvernoteAccount {
    fn open(&self) -> Result<Connection> {
        let connection = Connection::open_with_flags(
            &self.database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // Evernote may be running, and writing.
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        for (table, columns) in [
            ("Nodes_Notebook", "id, label, personal_Stack_id"),
            (
                "Nodes_Note",
                "id, label, created, updated, deleted, parent_Notebook_id, editor_author, source, source_URL, source_application",
            ),
            ("Nodes_Tag", "id, label"),
            ("NoteTag", "Note_id, Tag_id"),
            (
                "Attachment",
                "id, filename, mime, width, height, isActive, dataHash, dataSize, parent_Note_id",
            ),
        ] {
            connection
                .prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))
                .map_err(|error| unknown(&format!("{table}: {error}")))?;
        }
        Ok(connection)
    }

    fn body_path(&self, note_id: &str) -> Option<PathBuf> {
        // The folders are the first and the last three letters of the id.
        let first = note_id.get(..3)?;
        let last = note_id.get(note_id.len().checked_sub(3)?..)?;
        self.bodies
            .iter()
            .map(|folder| folder.join(first).join(last).join(format!("{note_id}.dat")))
            .find(|path| path.is_file())
    }

    fn attachment_path(&self, note_id: &str, hash: &str) -> Option<PathBuf> {
        self.caches
            .iter()
            .map(|folder| folder.join(note_id).join(hash))
            .find(|path| path.is_file())
    }

    /// The account's notebooks and what each holds.
    pub fn overview(&self) -> Result<LocalOverview> {
        let connection = self.open()?;
        let mut notebooks = Vec::new();
        let mut statement = connection.prepare(
            "SELECT id, label, personal_Stack_id FROM Nodes_Notebook ORDER BY label COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (id, name, stack) = row?;
            let mut notebook = LocalNotebook {
                id,
                name: name.unwrap_or_default(),
                stack: stack.as_deref().and_then(stack_name),
                notes: 0,
                attachments: 0,
                bytes: 0,
                notes_not_downloaded: 0,
                incomplete: Vec::new(),
            };
            for note in self.notes(&connection, &notebook.id)? {
                notebook.notes += 1;
                let mut incomplete = LocalIncompleteNote {
                    title: note.title.trim().to_owned(),
                    text_missing: self.body_path(&note.id).is_none(),
                    attachments: 0,
                    attachments_missing: 0,
                };
                for attachment in self.attachments(&connection, &note.id)? {
                    notebook.attachments += 1;
                    notebook.bytes += attachment.size;
                    incomplete.attachments += 1;
                    if self.attachment_path(&note.id, &attachment.hash).is_none() {
                        incomplete.attachments_missing += 1;
                    }
                }
                if incomplete.text_missing || incomplete.attachments_missing > 0 {
                    notebook.notes_not_downloaded += 1;
                    notebook.incomplete.push(incomplete);
                }
            }
            notebooks.push(notebook);
        }
        Ok(LocalOverview {
            user_id: self.user_id.clone(),
            notebooks,
        })
    }

    fn notes(&self, connection: &Connection, notebook_id: &str) -> Result<Vec<NoteRow>> {
        // Columns that not every version has are asked for by name only when
        // they are there.
        let has = |column: &str| {
            connection
                .prepare(&format!("SELECT {column} FROM Nodes_Note LIMIT 0"))
                .is_ok()
        };
        let optional = |column: &str| {
            if has(column) {
                column.to_owned()
            } else {
                "NULL".to_owned()
            }
        };
        let sql = format!(
            "SELECT id, label, created, updated, editor_author, source, source_URL, source_application,
                    {}, {}, {}, {}, {}, {}
             FROM Nodes_Note
             WHERE parent_Notebook_id = ?1 AND (deleted IS NULL OR deleted = 0)
             ORDER BY created, id",
            optional("attributes_subjectDate"),
            optional("attributes_contentClass"),
            optional("reminder_order"),
            optional("reminder_time"),
            optional("reminder_doneTime"),
            optional("isUntitled"),
        );
        let mut statement = connection.prepare(&sql)?;
        let text = |value: Option<String>| value.filter(|text| !text.is_empty());
        let rows = statement.query_map([notebook_id], |row| {
            Ok(NoteRow {
                id: row.get(0)?,
                // What Evernote shows. For a note that was given no title
                // those are words of its text, or "Untitled"; an export
                // calls every such note "Untitled Note", under which nobody
                // would look for it.
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                untitled: number(row, 13)? == Some(1),
                created: number(row, 2)?.unwrap_or(0),
                updated: number(row, 3)?.unwrap_or(0),
                author: text(row.get(4)?),
                source: text(row.get(5)?),
                source_url: text(row.get(6)?),
                source_application: text(row.get(7)?),
                subject_date: number(row, 8)?.filter(|value| *value > 0),
                content_class: text(row.get(9)?),
                reminder_order: number(row, 10)?.filter(|value| *value > 0),
                reminder_time: number(row, 11)?.filter(|value| *value > 0),
                reminder_done_time: number(row, 12)?.filter(|value| *value > 0),
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// A note's attachments that are in use, in the order Evernote has them.
    fn attachments(&self, connection: &Connection, note_id: &str) -> Result<Vec<AttachmentRow>> {
        let has = |table: &str, column: &str| {
            connection
                .prepare(&format!("SELECT {column} FROM {table} LIMIT 0"))
                .is_ok()
        };
        let column = |name: &str| {
            if has("Attachment", name) {
                format!("a.{name}")
            } else {
                "NULL".to_owned()
            }
        };
        let recognition = has("AttachmentRecognition", "content");
        let sql = format!(
            "SELECT a.id, a.filename, a.mime, a.width, a.height, a.dataHash, a.dataSize, {}, {}, {}, {}
             FROM Attachment a {}
             WHERE a.parent_Note_id = ?1 AND a.isActive = 1
             ORDER BY a.rowid",
            column("shardId"),
            column("applicationDataKeys"),
            column("applicationData"),
            if recognition { "r.content" } else { "NULL" },
            if recognition {
                "LEFT JOIN AttachmentRecognition r ON r.id = a.id"
            } else {
                ""
            },
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map([note_id], |row| {
            Ok(AttachmentRow {
                id: row.get(0)?,
                file_name: row.get(1)?,
                mime: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                width: number(row, 3)?,
                height: number(row, 4)?,
                hash: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                size: number(row, 6)?.unwrap_or(0).max(0) as u64,
                shard: row.get(7)?,
                data_keys: row.get(8)?,
                data: row.get(9)?,
                recognition: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// A note's tasks, with the times at which they are to remind. Empty
    /// when this version of Evernote's data has none.
    fn tasks(&self, connection: &Connection, note_id: &str) -> Result<Vec<Task>> {
        let Ok(mut statement) = connection.prepare(
            "SELECT id, taskGroupNoteLevelID, label, status, sortWeight, created, dueDate, dueDateUIOption
             FROM Nodes_Task
             WHERE parent_Note_id = ?1 AND (deleted IS NULL OR deleted = 0)
             ORDER BY rowid",
        ) else {
            return Ok(Vec::new());
        };
        let rows = statement.query_map([note_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Task {
                    group: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    done: row.get::<_, Option<String>>(3)?.as_deref() == Some("completed"),
                    weight: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    created: number(row, 5)?.unwrap_or(0),
                    due: number(row, 6)?.filter(|at| *at > 0),
                    due_is_a_day: row.get::<_, Option<String>>(7)?.as_deref() == Some("date_only"),
                    reminders: Vec::new(),
                },
            ))
        })?;
        let mut tasks = Vec::new();
        for row in rows {
            let (id, mut task) = row?;
            if let Ok(mut reminders) = connection.prepare_cached(
                "SELECT reminderDate FROM Nodes_Reminder
                 WHERE source_Task_id = ?1 AND (status IS NULL OR status <> 'muted')
                 ORDER BY reminderDate",
            ) {
                let times = reminders.query_map([&id], |row| number(row, 0))?;
                for time in times {
                    task.reminders.extend(time?.filter(|at| *at > 0));
                }
            }
            tasks.push(task);
        }
        Ok(tasks)
    }

    /// The names of all the account's tags.
    fn tag_names(&self, connection: &Connection) -> Result<Vec<String>> {
        let mut statement = connection.prepare("SELECT label FROM Nodes_Tag ORDER BY rowid")?;
        let rows = statement.query_map([], |row| row.get::<_, Option<String>>(0))?;
        Ok(rows
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// For each tag that is inside another, its name in lower case and the
    /// name of the tag it is inside. Empty when this version of Evernote's
    /// data does not say.
    fn tag_parents(
        &self,
        connection: &Connection,
    ) -> Result<std::collections::HashMap<String, String>> {
        let Ok(mut statement) = connection.prepare(
            "SELECT t.label, p.label FROM Nodes_Tag t JOIN Nodes_Tag p ON p.id = t.parent_Tag_id",
        ) else {
            return Ok(Default::default());
        };
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })?;
        let mut parents = std::collections::HashMap::new();
        for row in rows {
            if let (Some(tag), Some(parent)) = row? {
                let (tag, parent) = (tag.trim(), parent.trim());
                if !tag.is_empty() && !parent.is_empty() {
                    parents.insert(tag.to_lowercase(), parent.to_owned());
                }
            }
        }
        Ok(parents)
    }

    /// What Evernote says about notes beside what is in them: the picture
    /// chosen to stand for a note, or that it is to have none, and the notes
    /// pinned to a notebook. Empty where this version of Evernote's data
    /// does not say.
    fn marks(&self, connection: &Connection) -> Result<Vec<ForeignMarks>> {
        let mut marks = std::collections::BTreeMap::<String, ForeignMarks>::new();
        fn of<'a>(
            marks: &'a mut std::collections::BTreeMap<String, ForeignMarks>,
            id: &str,
        ) -> &'a mut ForeignMarks {
            marks.entry(id.to_owned()).or_insert_with(|| ForeignMarks {
                evernote_guid: id.to_owned(),
                thumbnail: None,
                pinned: None,
            })
        }
        // The hash of the picture chosen for the note; empty where its
        // thumbnail was removed; nothing where Evernote chooses.
        if let Ok(mut statement) = connection.prepare(
            "SELECT id, selectedThumbnailHash FROM Nodes_Note
             WHERE selectedThumbnailHash IS NOT NULL AND (deleted IS NULL OR deleted = 0)",
        ) {
            let chosen = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (id, hash) in chosen {
                of(&mut marks, &id).thumbnail = Some(hash.trim().to_lowercase());
            }
        }
        // The pinned notes are among the account's preferences: for each
        // notebook, its notes in the order they were pinned in.
        if let Ok(mut statement) = connection.prepare("SELECT clientInfo FROM Nodes_Preferences") {
            let preferences = statement
                .query_map([], |row| row.get::<_, Option<String>>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for preferences in preferences.into_iter().flatten() {
                let pinned = serde_json::from_str::<Value>(&preferences)
                    .ok()
                    .and_then(|all| all.get("PINNED_NOTES_IN_NOTEBOOK").cloned())
                    // Kept as text that is itself a list by notebook.
                    .and_then(|pinned| match pinned {
                        Value::String(text) => serde_json::from_str::<Value>(&text).ok(),
                        other => Some(other),
                    });
                let Some(Value::Object(notebooks)) = pinned else {
                    continue;
                };
                for notes in notebooks.values() {
                    let notes = notes.as_array().into_iter().flatten();
                    for (place, id) in notes.filter_map(Value::as_str).enumerate() {
                        of(&mut marks, id).pinned = Some(place as i64);
                    }
                }
            }
        }
        Ok(marks.into_values().collect())
    }

    /// The shortcuts Evernote has, in its order, and how many more it has
    /// that lead to nothing it still has itself. Empty when this version
    /// of Evernote's data does not say.
    fn shortcuts(&self, connection: &Connection) -> Result<(Vec<ForeignShortcut>, u64)> {
        let Ok(mut statement) = connection.prepare(
            "SELECT s.source_Note_id, nb.label, s.source_Stack_id, t.label, q.query, q.label
             FROM Nodes_Shortcut s
             LEFT JOIN Nodes_Notebook nb ON nb.id = s.source_Notebook_id
             LEFT JOIN Nodes_Tag t ON t.id = s.source_Tag_id
             LEFT JOIN Nodes_SavedSearch q ON q.id = s.source_SavedSearch_id
             ORDER BY s.sortOrder, s.rowid",
        ) else {
            return Ok((Vec::new(), 0));
        };
        let text = |row: &rusqlite::Row, column: usize| -> rusqlite::Result<Option<String>> {
            Ok(row
                .get::<_, Option<String>>(column)?
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()))
        };
        let rows = statement.query_map([], |row| {
            Ok(if let Some(evernote_guid) = text(row, 0)? {
                Some(ForeignShortcut::Note { evernote_guid })
            } else if let Some(name) = text(row, 1)? {
                Some(ForeignShortcut::Notebook { name })
            } else if let Some(name) = text(row, 2)?.as_deref().and_then(stack_name) {
                Some(ForeignShortcut::Stack { name })
            } else if let Some(name) = text(row, 3)? {
                Some(ForeignShortcut::Tag { name })
            } else {
                text(row, 4)?.map(|query| ForeignShortcut::Search {
                    label: text(row, 5).ok().flatten().unwrap_or_default(),
                    query,
                })
            })
        })?;
        let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        let nowhere = rows.iter().filter(|row| row.is_none()).count() as u64;
        Ok((rows.into_iter().flatten().collect(), nowhere))
    }

    fn tags(&self, connection: &Connection, note_id: &str) -> Result<Vec<String>> {
        let mut statement = connection.prepare(
            "SELECT t.label FROM NoteTag nt JOIN Nodes_Tag t ON t.id = nt.Tag_id
             WHERE nt.Note_id = ?1 ORDER BY nt.rowid",
        )?;
        let rows = statement.query_map([note_id], |row| row.get::<_, Option<String>>(0))?;
        Ok(rows
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .map(|tag| tag.trim().to_owned())
            .filter(|tag| !tag.is_empty())
            .collect())
    }

    /// Reads one note the way the ENEX reader reads it from an export. The
    /// attachments' bytes go to `sink`. `Err` carries why the note cannot be
    /// read, in words for the person importing.
    ///
    /// With `without_missing`, attachments that are not on this computer are
    /// left out instead of making the note unreadable; `missing` says how
    /// many were. The note's text still names them.
    fn note(
        &self,
        connection: &Connection,
        row: &NoteRow,
        sink: &mut dyn BlobSink,
        without_missing: bool,
    ) -> std::result::Result<LocalNote, String> {
        let all = self
            .attachments(connection, &row.id)
            .map_err(|error| error.to_string())?;
        let listed: HashSet<String> = all
            .iter()
            .map(|attachment| attachment.hash.to_lowercase())
            .collect();
        // Looked for before anything is stored: a note is taken whole, or
        // without what is missing, or not at all.
        let mut attachments = Vec::new();
        let mut files = Vec::new();
        let mut missing = 0;
        for attachment in all {
            match self.attachment_path(&row.id, &attachment.hash) {
                Some(path) => {
                    attachments.push(attachment);
                    files.push(path);
                }
                None if without_missing => missing += 1,
                None => return Err(NOT_DOWNLOADED.into()),
            }
        }
        let body = self.body_path(&row.id).ok_or(NOT_DOWNLOADED)?;
        let bytes = fs::read(&body).map_err(|error| format!("its text cannot be read: {error}"))?;
        let document = YDoc::from_state(&bytes)
            .map_err(|error| format!("its text cannot be read: {error}"))?;
        let markup = note_markup(&document).ok_or("its text is not a note")?;
        // Attachments the text names that Evernote does not list for the
        // note. It has no file for them either; they are missing there too.
        let absent = MEDIA
            .captures_iter(&markup)
            .map(|found| found[1].to_lowercase())
            .filter(|hash| !listed.contains(hash))
            .collect::<HashSet<_>>()
            .len() as u64;
        // The note's tasks are not in its text. They become checklists in it.
        let tasks = self
            .tasks(connection, &row.id)
            .map_err(|error| error.to_string())?;
        let content = crate::tasks::place(&markup, &tasks);

        let mut resources = Vec::new();
        for (attachment, path) in attachments.iter().zip(files) {
            let file = File::open(&path)
                .map_err(|error| format!("an attachment cannot be read: {error}"))?;
            let blob = sink
                .store(&mut BufReader::with_capacity(1024 * 1024, file))
                .map_err(|error| format!("an attachment cannot be stored: {error}"))?;
            if !blob.md5.eq_ignore_ascii_case(&attachment.hash) {
                return Err("an attachment on this computer is damaged".into());
            }
            let mut attributes = Map::new();
            // An export names every attachment, with nothing when it has no name.
            attributes.insert(
                "file-name".into(),
                Value::String(attachment.file_name.clone().unwrap_or_default()),
            );
            // Evernote's export gives every attachment the address it has in
            // Evernote's own cache; so does this.
            attributes.insert(
                "source-url".into(),
                Value::String(format!(
                    "en-cache://tokenKey%3D%22AuthToken%3AUser%3A{}%22+{}+{}+https%3A%2F%2Fpublic.www.evernote.com%2Fresources%2F{}%2F{}",
                    self.user_id,
                    row.id,
                    attachment.hash,
                    attachment.shard.as_deref().unwrap_or_default(),
                    attachment.id
                )),
            );
            let data =
                application_data(attachment.data_keys.as_deref(), attachment.data.as_deref());
            if !data.is_empty() {
                attributes.insert("application-data".into(), Value::Object(data));
            }
            resources.push(EnexResource {
                blob,
                alternate: None,
                mime: if attachment.mime.is_empty() {
                    "application/octet-stream".into()
                } else {
                    attachment.mime.clone()
                },
                width: attachment
                    .width
                    .filter(|value| *value > 0)
                    .map(|value| value as u32),
                height: attachment
                    .height
                    .filter(|value| *value > 0)
                    .map(|value| value as u32),
                duration: None,
                recognition_xml: attachment.recognition.as_deref().and_then(recognition_xml),
                attributes: Value::Object(attributes),
            });
        }

        let mut attributes = Map::new();
        let mut set = |name: &str, value: Option<String>| {
            if let Some(value) = value {
                attributes.insert(name.to_owned(), Value::String(value));
            }
        };
        set("subject-date", row.subject_date.map(enex_date));
        set("author", row.author.clone());
        set("source", row.source.clone());
        set("source-url", row.source_url.clone());
        set("source-application", row.source_application.clone());
        set(
            "reminder-order",
            row.reminder_order.map(|value| value.to_string()),
        );
        set("reminder-time", row.reminder_time.map(enex_date));
        set("reminder-done-time", row.reminder_done_time.map(enex_date));
        set("content-class", row.content_class.clone());
        let tags = self
            .tags(connection, &row.id)
            .map_err(|error| error.to_string())?;
        let attributes = Value::Object(attributes);
        let title = row.title.trim();
        // As Bever read the note up to 1.1.1: under the export's name for a
        // note without a title, and without its tasks.
        let title_then = if row.untitled { UNTITLED } else { title };
        let earlier = (title_then != title || !tasks.is_empty()).then(|| {
            Box::new(EarlierReading {
                title: title_then.to_owned(),
                content: markup,
                attributes: attributes.clone(),
            })
        });
        let note = EnexNote {
            title: title.to_owned(),
            content,
            // An export gives times to the second.
            created_at: row.created.div_euclid(1000) * 1000,
            updated_at: row.updated.div_euclid(1000) * 1000,
            tags,
            attributes,
            evernote_guid: Some(row.id.clone()),
            resources,
            earlier,
            tasks: tasks.len() as u64,
        };
        Ok(LocalNote {
            note,
            missing,
            absent,
        })
    }

    /// Reads every note of a notebook as an export of it would be read, for
    /// comparing the two. `each` gets the note, or why it could not be read.
    pub fn read_notebook(
        &self,
        notebook_id: &str,
        sink: &mut dyn BlobSink,
        mut each: impl FnMut(std::result::Result<EnexNote, (String, String)>),
    ) -> Result<()> {
        let connection = self.open()?;
        for row in self.notes(&connection, notebook_id)? {
            each(
                self.note(&connection, &row, sink, false)
                    .map(|read| read.note)
                    .map_err(|reason| (row.title.clone(), reason)),
            );
        }
        Ok(())
    }
}

/// A note as it was read from Evernote's files.
struct LocalNote {
    note: EnexNote,
    /// Attachments of it that are not on this computer and were left out.
    missing: u64,
    /// Attachments its text names that Evernote does not have at all.
    absent: u64,
}

/// Why a note is left out when part of it is not among Evernote's files.
const NOT_DOWNLOADED: &str = "Evernote does not have all of it on this computer";

/// How many notes are named in one warning; the rest are counted.
const NAMED: usize = 20;

/// `“Title” in “Notebook”`, as a warning names a note.
fn named(title: &str, notebook: &str) -> String {
    let title = title.trim();
    format!(
        "“{}” in “{notebook}”",
        if title.is_empty() { "Untitled" } else { title }
    )
}

/// `names`, of which there are `count` in all, as a list in a sentence.
fn listed(names: &[String], count: u64) -> String {
    let more = count.saturating_sub(names.len() as u64);
    if more > 0 {
        format!("{}, and {more} more", names.join(", "))
    } else {
        names.join(", ")
    }
}

fn number(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<i64>> {
    // Evernote declares whole numbers as INTEGER in one table and REAL in another.
    Ok(match row.get_ref(index)? {
        rusqlite::types::ValueRef::Integer(value) => Some(value),
        rusqlite::types::ValueRef::Real(value) => Some(value as i64),
        _ => None,
    })
}

/// `Stack:Name` is how Evernote names a stack: it has no other identity.
fn stack_name(id: &str) -> Option<String> {
    let name = id.strip_prefix("Stack:").unwrap_or(id).trim();
    (!name.is_empty()).then(|| name.to_owned())
}

fn enex_date(milliseconds: i64) -> String {
    DateTime::from_timestamp_millis(milliseconds)
        .unwrap_or_default()
        .format("%Y%m%dT%H%M%SZ")
        .to_string()
}

/// An attachment's keyed data. Evernote lists the keys and keeps the values
/// of only some; an export writes the others empty.
fn application_data(keys: Option<&str>, values: Option<&str>) -> Map<String, Value> {
    let values: Map<String, Value> = values
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let keys: Vec<String> = keys
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let mut data = Map::new();
    for key in keys {
        let value = match values.get(&key) {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => String::new(),
        };
        data.insert(key, Value::String(value));
    }
    for (key, value) in values {
        data.entry(key).or_insert(match value {
            Value::String(text) => Value::String(text),
            other => Value::String(other.to_string()),
        });
    }
    data
}

/// The recognition data of a picture, which Evernote keeps as the XML's
/// bytes written in hexadecimal.
fn recognition_xml(stored: &str) -> Option<String> {
    let stored = stored.trim();
    if stored.starts_with('<') {
        return Some(stored.to_owned());
    }
    if stored.is_empty() || !stored.len().is_multiple_of(2) {
        return None;
    }
    let bytes = (0..stored.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(stored.get(at..at + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    let text = String::from_utf8(bytes).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

// --- A note's markup, as Evernote's export writes it -----------------------

/// Elements an export closes in their opening tag when they are empty.
const VOID: [&str; 9] = [
    "br", "hr", "en-media", "img", "en-todo", "col", "area", "input", "en-crypt",
];

fn escape_text(text: &str, out: &mut String) {
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            other => out.push(other),
        }
    }
}

fn escape_attribute(text: &str, out: &mut String) {
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
}

fn write_attributes(attributes: &[(String, String)], out: &mut String) {
    for (name, value) in attributes {
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        escape_attribute(value, out);
        out.push('"');
    }
}

fn write_node(node: &XmlNode, out: &mut String) {
    match node {
        XmlNode::Text(text) => escape_text(text, out),
        XmlNode::Element {
            name,
            attributes,
            children,
        } => {
            out.push('<');
            out.push_str(name);
            write_attributes(attributes, out);
            if children.is_empty() && VOID.contains(&name.as_str()) {
                out.push_str(if attributes.is_empty() { "/>" } else { " />" });
                return;
            }
            out.push('>');
            for child in children {
                write_node(child, out);
            }
            out.push_str("</");
            out.push_str(name);
            out.push('>');
        }
    }
}

#[cfg(test)]
/// `nodes` as markup, the way Evernote's export writes elements and text.
pub(crate) fn markup(nodes: &[XmlNode]) -> String {
    let mut out = String::new();
    for node in nodes {
        write_node(node, &mut out);
    }
    out
}

/// The content of a note as an ENEX file has it, from the note's document:
/// the declaration, the note with its attributes, a hidden block that
/// carries the note's own heading styles when it has any, and the note's
/// elements. An export follows the note with six spaces, which the ENEX
/// reader takes off again, as it takes off the line breaks around the
/// content; so they are not written here.
pub fn note_markup(document: &YDoc) -> Option<String> {
    let nodes = document.xml("content");
    let XmlNode::Element {
        name,
        attributes,
        children,
    } = nodes.into_iter().next()?
    else {
        return None;
    };
    if name != "en-note" {
        return None;
    }
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\"><en-note",
    );
    write_attributes(&attributes, &mut out);
    out.push('>');
    let styles = document.map("customNoteStyles");
    if let Some(headings) = styles.get("headingStyles") {
        // Only a note whose headings were looked at carries the block.
        if matches!(headings, Any::Object(_)) && headings.get("isEmpty").is_some() {
            out.push_str("<div style=\"display:none;--en-chs:&quot;");
            out.push_str(&BASE64.encode(headings.to_json()));
            out.push_str("&quot;\">\u{200a}</div>");
        }
    }
    for child in &children {
        write_node(child, &mut out);
    }
    out.push_str("</en-note>");
    Some(out)
}

// --- Importing -------------------------------------------------------------

/// Imports the notebooks named by `notebook_ids` (all of them when `None`)
/// into `library`, each into a notebook of its own name, in the stack it is
/// in. `cancel` is checked between notes.
pub fn import_local(
    library: &Library,
    account: &EvernoteAccount,
    notebook_ids: Option<&[String]>,
    options: LocalImportOptions,
    cancel: &AtomicBool,
    mut progress: impl FnMut(LocalImportProgress),
) -> Result<LocalImportReport> {
    let connection = account.open()?;
    let mut report = LocalImportReport::default();
    let mut state = LocalImportProgress {
        phase: "preparing".into(),
        ..LocalImportProgress::default()
    };
    progress(state.clone());

    let mut notebooks: Vec<(String, String, Option<String>)> = Vec::new();
    let mut notebooks_in_all = 0;
    {
        let mut statement = connection.prepare(
            "SELECT id, label, personal_Stack_id FROM Nodes_Notebook ORDER BY label COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (id, name, stack) = row?;
            notebooks_in_all += 1;
            if notebook_ids.is_none_or(|wanted| wanted.contains(&id)) {
                notebooks.push((
                    id,
                    name.unwrap_or_default(),
                    stack.as_deref().and_then(stack_name),
                ));
            }
        }
    }
    // With every notebook chosen it is the account that is imported.
    let whole = notebooks.len() == notebooks_in_all;
    let mut work = Vec::new();
    for (id, name, stack) in notebooks {
        report.notes_in_trash += connection.query_row(
            "SELECT count(*) FROM Nodes_Note WHERE parent_Notebook_id = ?1 AND deleted > 0",
            [&id],
            |row| row.get::<_, u64>(0),
        )?;
        let notes = account.notes(&connection, &id)?;
        state.note_count += notes.len() as u64;
        for note in &notes {
            for attachment in account.attachments(&connection, &note.id)? {
                state.bytes_total += attachment.size;
            }
        }
        work.push((name, stack, notes));
    }
    state.notebook_count = work.len() as u64;

    let run_mark = library.import_run_mark()?;
    // Notes left out because Evernote does not have all of them, and notes
    // imported without the attachments it does not have: the first of each
    // by name.
    let mut left_out: Vec<String> = Vec::new();
    let mut without: Vec<String> = Vec::new();
    let mut not_downloaded = 0u64;
    let mut unreadable: Vec<String> = Vec::new();
    // Notes whose text names attachments that Evernote does not have.
    let mut lacking: Vec<String> = Vec::new();
    let mut lacking_in_all = 0u64;
    'notebooks: for (name, stack, notes) in work {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        state.notebook_index += 1;
        state.notebook = Some(name.clone());
        state.note_title = None;
        let stack_id = match &stack {
            Some(stack) => Some(library.ensure_stack(stack)?),
            None => None,
        };
        let notebook_name = if name.trim().is_empty() {
            "Imported notes"
        } else {
            &name
        };
        let notebook_id = library.ensure_notebook(notebook_name, stack_id.as_deref())?;
        report.notebooks += 1;
        state.phase = "notebookReady".into();
        state.notebook_id = Some(notebook_id.clone());
        progress(state.clone());
        state.phase = "importing".into();
        for row in notes {
            if cancel.load(Ordering::Relaxed) {
                report.cancelled = true;
                break 'notebooks;
            }
            state.note_index += 1;
            state.note_title = Some(row.title.clone());
            progress(state.clone());
            // Blobs are stored while the note is read and referenced when it
            // is inserted; cleanup must not run in between.
            let _blobs = library.blob_guard();
            let mut sink = library;
            match account.note(
                &connection,
                &row,
                &mut sink,
                options.without_missing_attachments,
            ) {
                Ok(LocalNote {
                    note,
                    missing,
                    absent,
                }) => {
                    let bytes: u64 = note.resources.iter().map(|item| item.blob.size).sum();
                    let attachments = note.resources.len() as u64 + missing;
                    let tasks = note.tasks;
                    let result =
                        library.import_local_note(note, &notebook_id, run_mark, missing > 0)?;
                    let arrived = !matches!(result, ImportNoteResult::Duplicate(_));
                    if arrived && tasks > 0 {
                        report.tasks_brought += tasks;
                        report.notes_with_tasks += 1;
                    }
                    if arrived && absent > 0 {
                        lacking_in_all += 1;
                        if lacking.len() < NAMED {
                            lacking.push(named(&row.title, &name));
                        }
                    }
                    match result {
                        ImportNoteResult::Imported {
                            note,
                            images_queued,
                            kept_both,
                        } => {
                            report.notes_imported += 1;
                            report.notes_kept_both += u64::from(kept_both);
                            report.resources_imported += note.resources.len() as u64;
                            report.bytes_imported += bytes;
                            report.images_queued += images_queued;
                        }
                        ImportNoteResult::Updated {
                            note,
                            images_queued,
                        } => {
                            report.notes_updated += 1;
                            report.resources_imported += note.resources.len() as u64;
                            report.bytes_imported += bytes;
                            report.images_queued += images_queued;
                        }
                        ImportNoteResult::Duplicate(_) => report.notes_skipped += 1,
                    }
                    if missing > 0 && arrived {
                        report.notes_incomplete += 1;
                        if without.len() < NAMED {
                            without.push(format!(
                                "{} ({missing} of {attachments})",
                                named(&row.title, &name)
                            ));
                        }
                    }
                    state.bytes_done += bytes;
                }
                Err(reason) => {
                    report.notes_failed += 1;
                    if reason == NOT_DOWNLOADED {
                        not_downloaded += 1;
                        if left_out.len() < NAMED {
                            left_out.push(named(&row.title, &name));
                        }
                    } else if unreadable.len() < 20 {
                        let title = if row.title.trim().is_empty() {
                            "Untitled"
                        } else {
                            row.title.trim()
                        };
                        unreadable
                            .push(format!("“{title}” in “{name}” was not imported: {reason}."));
                    }
                }
            }
            state.notes_imported = report.notes_imported;
            state.notes_skipped = report.notes_skipped;
            state.notes_failed = report.notes_failed;
            state.resources_imported = report.resources_imported;
        }
    }
    if not_downloaded > 0 {
        let one = not_downloaded == 1;
        report.warnings.push(format!(
            "{not_downloaded} {} not imported because Evernote does not have all of {} on this computer: {}. Open {} in Evernote while online, so that Evernote fetches what is missing, then import again: notes already imported are not imported twice. Synchronizing Evernote again does not bring a file it has given up on.",
            if one { "note was" } else { "notes were" },
            if one { "it" } else { "them" },
            listed(&left_out, not_downloaded),
            if one { "it" } else { "each of them" },
        ));
    }
    if report.notes_incomplete > 0 {
        let one = report.notes_incomplete == 1;
        report.warnings.push(format!(
            "{} {} imported without attachments that Evernote does not have on this computer: {}. To complete {}, open {} in Evernote while online, then import again; a note you have changed here by then is kept as it is, and the whole one is added beside it.",
            report.notes_incomplete,
            if one { "note was" } else { "notes were" },
            listed(&without, report.notes_incomplete),
            if one { "it" } else { "them" },
            if one { "it" } else { "each of them" },
        ));
    }
    if lacking_in_all > 0 {
        let one = lacking_in_all == 1;
        report.warnings.push(format!(
            "{lacking_in_all} {} attachments that Evernote itself does not have, so they are missing here as they are there: {}.",
            if one { "note names" } else { "notes name" },
            listed(&lacking, lacking_in_all),
        ));
    }
    report.warnings.extend(unreadable);
    state.phase = "finalizing".into();
    state.note_title = None;
    progress(state.clone());
    report.links_resolved = library.rewrite_import_links()?;
    // An export has a note's tags by name only. Evernote's own files also
    // say which tag is inside which, and the tags that came are placed so.
    if !report.cancelled {
        // Notes bring the tags they have. The tags that no note has come
        // when it is the whole account that is imported.
        if whole {
            report.tags_added = library.add_tags_once(&account.tag_names(&connection)?)?;
        }
        report.tags_nested = library.nest_tags_as(&account.tag_parents(&connection)?)?;
        // Nor does an export have the shortcuts. Those whose notes,
        // notebooks, stacks and tags are here now are added.
        let (shortcuts, nowhere) = account.shortcuts(&connection)?;
        (report.shortcuts_added, report.shortcuts_nowhere) =
            library.add_shortcuts_as(&shortcuts)?;
        report.shortcuts_nowhere += nowhere;
        // Nor what is said about a note beside what is in it: the picture
        // that stands for it, and that it is pinned to its notebook.
        (report.thumbnails_brought, report.pins_brought) =
            library.offer_marks(&account.marks(&connection)?)?;
    }
    library.optimize()?;
    state.phase = "complete".into();
    progress(state);
    Ok(report)
}

/// Whether the application's database exists and has notebooks: a quick
/// answer for a button that offers the import.
pub fn has_notebooks(account: &EvernoteAccount) -> bool {
    account
        .open()
        .and_then(|connection| {
            Ok(connection
                .query_row("SELECT 1 FROM Nodes_Notebook LIMIT 1", [], |row| {
                    row.get::<_, i64>(0)
                })
                .optional()?
                .is_some())
        })
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "evernote_local_tests.rs"]
mod tests;
