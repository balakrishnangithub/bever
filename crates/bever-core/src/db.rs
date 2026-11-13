use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, RwLock, RwLockReadGuard},
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
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    note_id UNINDEXED,
    title,
    body,
    tags,
    resources,
    tokenize = 'unicode61 remove_diacritics 2'
);
-- The words of the index, for finding one that is spelt nearly as another.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_terms USING fts5vocab('notes_fts', 'row');
"#;

#[derive(Debug)]
pub struct Library {
    pub(crate) connection: Mutex<Connection>,
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
        ensure_default_notebook(&connection)?;
        let device_id = device_id(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            blob_dir,
            blob_gate: RwLock::new(()),
            device_id,
        })
    }

    /// Hold this while storing blobs and inserting the rows that reference
    /// them, so that blob cleanup cannot remove a file that is about to be
    /// referenced.
    pub fn blob_guard(&self) -> RwLockReadGuard<'_, ()> {
        self.blob_gate.read().expect("blob gate poisoned")
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn blob_dir(&self) -> &Path {
        &self.blob_dir
    }

    pub fn optimize(&self) -> Result<()> {
        let connection = self.connection.lock().expect("database mutex poisoned");
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
        let _blobs = self.blob_gate.write().expect("blob gate poisoned");
        let mut connection = self.connection.lock().expect("database mutex poisoned");
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
