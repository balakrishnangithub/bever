use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard},
};

use rusqlite::{Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::Result;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS stacks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    stack_id TEXT REFERENCES stacks(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id),
    title TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '',
    original_enml TEXT,
    plain_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    evernote_guid TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    dirty INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS notes_evernote_guid
    ON notes(evernote_guid) WHERE evernote_guid IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_notebook_updated ON notes(notebook_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS notes_updated ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS notes_deleted ON notes(deleted_at);
CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_parent_name
    ON tags(COALESCE(parent_id, ''), lower(name));
CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(note_id, tag_id)
);
CREATE INDEX IF NOT EXISTS note_tags_tag ON note_tags(tag_id, note_id);
CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    md5 TEXT NOT NULL,
    mime TEXT NOT NULL,
    file_name TEXT,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    recognition_xml TEXT,
    recognition_text TEXT,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    alternate_sha256 TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    -- Local-only text recognition queue: 0 none, 1 pending, 2 done, 3 failed.
    ocr_state INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS resources_note ON resources(note_id, position);
CREATE INDEX IF NOT EXISTS resources_md5 ON resources(md5);
CREATE INDEX IF NOT EXISTS resources_sha ON resources(sha256);
CREATE INDEX IF NOT EXISTS resources_ocr_pending ON resources(ocr_state) WHERE ocr_state = 1;
CREATE INDEX IF NOT EXISTS resources_alternate_sha
    ON resources(alternate_sha256) WHERE alternate_sha256 IS NOT NULL;
CREATE TABLE IF NOT EXISTS import_sources (
    import_key TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS import_sources_note ON import_sources(note_id);
CREATE TABLE IF NOT EXISTS shortcuts (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(target_type, target_id)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_items (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    remote_revision INTEGER NOT NULL DEFAULT 0,
    synced_hash TEXT NOT NULL DEFAULT '',
    synced_at INTEGER NOT NULL DEFAULT 0,
    -- What stands for the remote file's content as this library last saw it.
    remote_version TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(kind, id)
);
CREATE TABLE IF NOT EXISTS sync_tombstones (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY(kind, id)
);
-- A note as it was before it was changed in the editor, kept on this device
-- so that a change made by mistake can be taken back. See `versions`.
CREATE TABLE IF NOT EXISTS note_versions (
    id INTEGER PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kept_at INTEGER NOT NULL,
    title TEXT NOT NULL,
    content_html TEXT NOT NULL,
    attributes_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_versions_note ON note_versions(note_id, id);
"#;

/// The search index. What is short comes before the note's text, so that it
/// is read without passing over the text. The tags are divided by a
/// character that is no letter, so that each can be told from the next.
const INDEX: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    note_id UNINDEXED,
    title,
    notebook,
    tags,
    body,
    resources,
    tokenize = 'unicode61 remove_diacritics 2'
);
-- The words of the index, for finding one that is spelt nearly as another.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_terms USING fts5vocab('notes_fts', 'row');
-- Where each word stands, for ordering what a search found by how near to
-- each other its words are.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_places USING fts5vocab('notes_fts', 'instance');
-- Which row of the index is which note's. The index itself can find a
-- note's row only by reading every row; with this, changing a note costs
-- the same however many notes there are.
CREATE TABLE IF NOT EXISTS note_index (
    note_id TEXT PRIMARY KEY,
    fts_row INTEGER NOT NULL
) WITHOUT ROWID;
-- The index names a note's notebook. It follows a notebook that is renamed
-- and a note that is moved, whatever part of the program does either.
CREATE TRIGGER IF NOT EXISTS notes_fts_notebook_renamed
AFTER UPDATE OF name ON notebooks WHEN old.name IS NOT new.name
BEGIN
    UPDATE notes_fts SET notebook = new.name
     WHERE rowid IN (SELECT i.fts_row FROM note_index i JOIN notes n ON n.id = i.note_id
                      WHERE n.notebook_id = new.id);
END;
CREATE TRIGGER IF NOT EXISTS notes_fts_note_moved
AFTER UPDATE OF notebook_id ON notes WHEN old.notebook_id IS NOT new.notebook_id
BEGIN
    UPDATE notes_fts SET notebook = (SELECT name FROM notebooks WHERE id = new.notebook_id)
     WHERE rowid = (SELECT fts_row FROM note_index WHERE note_id = new.id);
END;
"#;

/// The database connection, which one thread at a time has.
///
/// A thread that panics while it has the connection does not take it from
/// the others. What that thread had begun in a transaction is undone as
/// the transaction is dropped, so the connection is left as it was; to
/// refuse it to everyone afterwards, as a plain mutex does, would turn one
/// failed operation into a library that fails until the application is
/// started again.
#[derive(Debug)]
pub(crate) struct Shared(Mutex<Connection>);

impl Shared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Debug)]
pub struct Library {
    pub(crate) connection: Shared,
    pub(crate) blob_dir: PathBuf,
    /// Readers add blobs and the rows that reference them; the writer removes
    /// unreferenced blob files. See [`Library::blob_guard`].
    pub(crate) blob_gate: RwLock<()>,
    device_id: String,
}

impl Library {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        let data_dir = data_dir.as_ref();
        fs::create_dir_all(data_dir)?;
        Self::open_at(data_dir.join("bever.db"), data_dir.join("blobs"))
    }

    pub fn open_at(db_path: impl AsRef<Path>, blob_dir: impl AsRef<Path>) -> Result<Self> {
        let blob_dir = blob_dir.as_ref().to_path_buf();
        fs::create_dir_all(&blob_dir)?;
        let connection = Connection::open(db_path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
        )?;
        // The order names are listed in; see `natural`. Only queries name it,
        // never the schema, so the file stays readable by other programs.
        connection.create_collation(crate::natural::COLLATION, crate::natural::compare)?;
        connection.execute_batch(SCHEMA)?;
        prepare_index(&connection)?;
        ensure_default_notebook(&connection)?;
        let device_id = device_id(&connection)?;
        Ok(Self {
            connection: Shared(Mutex::new(connection)),
            blob_dir,
            blob_gate: RwLock::new(()),
            device_id,
        })
    }

    /// Hold this while storing blobs and inserting the rows that reference
    /// them, so that blob cleanup cannot remove a file that is about to be
    /// referenced.
    pub fn blob_guard(&self) -> RwLockReadGuard<'_, ()> {
        self.blob_gate
            .read()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Hold this while removing attachment files that nothing references,
    /// so that none is removed while a row that references it is being
    /// written.
    pub(crate) fn blob_sweep(&self) -> std::sync::RwLockWriteGuard<'_, ()> {
        self.blob_gate
            .write()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn blob_dir(&self) -> &Path {
        &self.blob_dir
    }

    pub fn optimize(&self) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute_batch("PRAGMA optimize;")?;
        Ok(())
    }

    /// Removes the library from this device: the database with its journal
    /// files, and every attachment file. The folders that held them are
    /// removed too when nothing else is in them.
    ///
    /// The library cannot be used afterwards: every later call fails. The
    /// application calls this as the last thing before it exits.
    pub fn erase(&self) -> Result<()> {
        let _blobs = self.blob_sweep();
        let mut connection = self.connection.lock();
        let database = connection
            .path()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        // The file can only be removed once it is closed; an empty database
        // in memory takes its place, so that later calls fail instead of
        // creating the file again.
        let open = std::mem::replace(&mut *connection, Connection::open_in_memory()?);
        open.close().map_err(|(_, error)| error)?;
        if let Some(database) = &database {
            for suffix in ["", "-wal", "-shm"] {
                let mut name = database.clone().into_os_string();
                name.push(suffix);
                remove_file_if_present(Path::new(&name))?;
            }
        }
        match fs::remove_dir_all(&self.blob_dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        // Only an empty folder goes: it may be one the user chose, with
        // other things in it.
        if let Some(folder) = database.as_deref().and_then(Path::parent) {
            let _ = fs::remove_dir(folder);
        }
        Ok(())
    }
}

/// Makes the search index, or makes it anew when the one in the file is
/// not in the form above or does not account for its rows. The index holds
/// nothing that the notes do not: it is filled again from them.
fn prepare_index(connection: &Connection) -> Result<()> {
    const DROP: &str = "DROP TABLE IF EXISTS notes_fts_places;
         DROP TABLE IF EXISTS notes_fts_terms;
         DROP TABLE IF EXISTS notes_fts;
         DROP TABLE IF EXISTS note_index;";
    let columns = connection
        .prepare("SELECT name FROM pragma_table_info('notes_fts')")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let current = ["note_id", "title", "notebook", "tags", "body", "resources"];
    let mut stale = !columns.is_empty() && columns != current;
    if stale {
        connection.execute_batch(DROP)?;
    }
    connection.execute_batch(INDEX)?;
    if !stale {
        // Every row of the index is some note's, and the one that note is
        // said to have. A program that does not know of `note_index`, as
        // 1.0.0, changes the index without it; this finds that out.
        stale = connection.query_row(
            "SELECT (SELECT count(*) FROM notes_fts_docsize) <> (SELECT count(*) FROM note_index)
                 OR (SELECT count(*) FROM note_index) <>
                    (SELECT count(*) FROM note_index i JOIN notes_fts f ON f.rowid = i.fts_row
                      WHERE f.note_id = i.note_id)
                 OR (SELECT count(*) FROM note_index) <> (SELECT count(*) FROM notes)",
            [],
            |row| row.get(0),
        )?;
        if stale {
            connection.execute_batch(DROP)?;
            connection.execute_batch(INDEX)?;
        }
    }
    if stale {
        connection.execute_batch(&format!(
            "BEGIN;
             INSERT INTO notes_fts(rowid, note_id, title, notebook, tags, body, resources)
                 SELECT n.rowid, {};
             INSERT INTO note_index(note_id, fts_row) SELECT id, rowid FROM notes;
             COMMIT;",
            crate::repository::INDEX_ROW
        ))?;
    }
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

fn ensure_default_notebook(connection: &Connection) -> Result<()> {
    let exists: Option<String> = connection
        .query_row("SELECT id FROM notebooks LIMIT 1", [], |row| row.get(0))
        .optional()?;
    if exists.is_none() {
        let now = chrono::Utc::now().timestamp_millis();
        connection.execute(
            "INSERT INTO notebooks(id, name, created_at, updated_at) VALUES (?1, 'Inbox', ?2, ?2)",
            [Uuid::new_v4().to_string(), now.to_string()],
        )?;
    }
    Ok(())
}

fn device_id(connection: &Connection) -> Result<String> {
    if let Some(id) = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'device_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    connection.execute(
        "INSERT INTO settings(key, value) VALUES ('device_id', ?1)",
        [&id],
    )?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erasing_removes_the_database_and_every_attachment() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("library");
        let library = Library::open(&data).unwrap();
        let note = library.create_note(None).unwrap();
        library
            .add_resource(&note.id, &mut "attachment".as_bytes(), "a.txt", None)
            .unwrap();
        assert!(data.join("bever.db").exists());
        assert!(fs::read_dir(data.join("blobs")).unwrap().next().is_some());

        library.erase().unwrap();
        assert!(!data.exists(), "the folder goes when nothing else is in it");
        // What is left of the library answers with errors, and writes nothing.
        assert!(library.create_note(None).is_err());
        assert!(library.snapshot().is_err());
        assert!(!data.exists());
    }

    #[test]
    fn an_index_in_another_form_is_made_anew_from_the_notes() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();
        let note = library.create_note(None).unwrap();
        library
            .save_note(&crate::models::SaveNote {
                id: note.id.clone(),
                notebook_id: note.notebook_id.clone(),
                title: "Quarterly report".into(),
                content_html: "<p>Figures</p>".into(),
                attributes: serde_json::json!({}),
                tags: vec![],
                base_revision: None,
            })
            .unwrap();
        {
            let connection = library.connection.lock();
            connection
                .execute_batch(
                    "DROP TABLE notes_fts_places; DROP TABLE notes_fts_terms; DROP TABLE notes_fts;
                     DROP TABLE note_index;
                     CREATE VIRTUAL TABLE notes_fts USING fts5(note_id UNINDEXED, title, body);",
                )
                .unwrap();
        }
        drop(library);

        let library = Library::open(directory.path()).unwrap();
        let found = library
            .list_notes(&crate::models::NoteFilter {
                query: "quarterly".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(found.total, 1);
        // And the notebook's name is in it, which the other form had not.
        let found = library
            .list_notes(&crate::models::NoteFilter {
                query: "inbox".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(found.total, 1);
        // The note is found in the index when it is changed: once, not twice.
        library
            .save_note(&crate::models::SaveNote {
                id: note.id.clone(),
                notebook_id: note.notebook_id.clone(),
                title: "Yearly report".into(),
                content_html: "<p>Figures</p>".into(),
                attributes: serde_json::json!({}),
                tags: vec![],
                base_revision: None,
            })
            .unwrap();
        let count = |query: &str| {
            library
                .list_notes(&crate::models::NoteFilter {
                    query: query.into(),
                    ..Default::default()
                })
                .unwrap()
                .total
        };
        assert_eq!(
            (count("quarterly"), count("yearly"), count("report")),
            (0, 1, 1)
        );

        // An index whose rows are not the notes they are said to be is made
        // anew as well: here two notes, each with the other's row.
        let second = library.create_note(None).unwrap();
        library
            .connection
            .lock()
            .execute(
                "UPDATE note_index SET fts_row = (SELECT sum(fts_row) FROM note_index) - fts_row",
                [],
            )
            .unwrap();
        drop(library);
        let library = Library::open(directory.path()).unwrap();
        library.delete_note_permanently(&second.id).unwrap();
        assert_eq!(
            library
                .list_notes(&crate::models::NoteFilter {
                    query: "yearly".into(),
                    ..Default::default()
                })
                .unwrap()
                .total,
            1,
            "the other note's row was not the one removed"
        );

        // And one that does not account for its rows.
        library
            .connection
            .lock()
            .execute_batch("DELETE FROM note_index")
            .unwrap();
        drop(library);
        let library = Library::open(directory.path()).unwrap();
        let rows: (i64, i64) = library
            .connection
            .lock()
            .query_row(
                "SELECT (SELECT count(*) FROM note_index), (SELECT count(*) FROM notes_fts)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(rows, (1, 1));
    }

    #[test]
    fn a_thread_that_panics_with_the_database_does_not_take_it_from_the_others() {
        let directory = tempfile::tempdir().unwrap();
        let library = std::sync::Arc::new(Library::open(directory.path()).unwrap());
        let note = library.create_note(None).unwrap();
        let failing = std::sync::Arc::clone(&library);
        let id = note.id.clone();
        let outcome = std::thread::spawn(move || {
            let mut connection = failing.connection.lock();
            let transaction = connection.transaction().unwrap();
            transaction
                .execute("UPDATE notes SET title = 'half done' WHERE id = ?1", [&id])
                .unwrap();
            panic!("in the middle of a change");
        })
        .join();
        assert!(outcome.is_err());
        // The library answers, and what was begun is undone.
        assert_eq!(library.get_note(&note.id).unwrap().title, "");
        assert_eq!(library.counts().unwrap().all, 1);
        library.create_note(None).unwrap();
    }

    #[test]
    fn erasing_leaves_other_files_in_the_folder_alone() {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();
        let other = directory.path().join("not-bever.txt");
        fs::write(&other, "mine").unwrap();

        library.erase().unwrap();
        assert_eq!(fs::read_to_string(&other).unwrap(), "mine");
        let left: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, ["not-bever.txt"]);
    }

    #[test]
    fn a_library_opened_after_an_erase_is_new_and_empty() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("library");
        let library = Library::open(&data).unwrap();
        let device = library.device_id().to_owned();
        library.create_note(None).unwrap();
        library.erase().unwrap();
        drop(library);

        let fresh = Library::open(&data).unwrap();
        assert_eq!(fresh.counts().unwrap().all, 0);
        assert_ne!(fresh.device_id(), device);
    }
}
