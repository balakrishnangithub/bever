//! Compares a library that was imported from the Evernote application's
//! own files with what Evernote has there now, note by note.
//!
//! ```text
//! cargo run --release -p bever-core --example audit_evernote_local -- \
//!     <library folder> [--files]
//! ```
//!
//! Both databases are opened for reading only, and neither is read through
//! the importer: the library's tables are compared with Evernote's tables.
//! For every note of Evernote that is outside its trash it checks that the
//! library has it once, under the title Evernote shows, with its times, its
//! notebook and stack, its tags, its attributes, and its attachments by
//! hash, size, type, name and order; that the note's text is, letter for
//! letter, the text Evernote keeps for its own search; and that every task
//! of the note is in it. With `--files`, every attachment's file in the
//! library is read and hashed as well.
//!
//! It prints counts, and for what differs the beginnings of Evernote's
//! identifiers of the notes; never a title or a word of a note. A note
//! that was changed in the library after it was imported differs, as it
//! should. `EVERNOTE_DATA_DIR` names another folder of Evernote data than
//! the system's own. The exit code is 1 when something differs.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use bever_core::evernote_local::default_data_dir;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

type Failure = Box<dyn std::error::Error>;

fn open(path: &Path) -> Result<Connection, Failure> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

/// Evernote's database under `data`: the first account found.
fn evernote_database(data: &Path) -> Option<PathBuf> {
    for site in std::fs::read_dir(data.join("conduit-storage"))
        .ok()?
        .flatten()
    {
        for entry in std::fs::read_dir(site.path()).ok()?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("UDB-User") && name.ends_with("+RemoteGraph.sql") {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Text without what is not letters of it: white space, and `/n`, which is
/// how Evernote's index marks the end of a line.
fn letters(text: &str) -> String {
    text.replace("/n", "")
        .chars()
        .filter(|character| {
            !character.is_whitespace() && !matches!(character, '\u{200a}' | '\u{200b}' | '\u{feff}')
        })
        .collect()
}

/// For each key, the values of the rows that have it, in the rows' order.
fn grouped(connection: &Connection, sql: &str) -> Result<HashMap<String, Vec<String>>, Failure> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut statement = connection.prepare(sql)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        groups
            .entry(row.get(0)?)
            .or_default()
            .push(row.get::<_, Option<String>>(1)?.unwrap_or_default());
    }
    Ok(groups)
}

#[derive(Default)]
struct Findings {
    counts: BTreeMap<&'static str, u64>,
    examples: BTreeMap<&'static str, Vec<String>>,
}

impl Findings {
    fn differs(&mut self, what: &'static str, id: &str) {
        *self.counts.entry(what).or_default() += 1;
        let examples = self.examples.entry(what).or_default();
        if examples.len() < 8 {
            examples.push(id.chars().take(8).collect());
        }
    }
}

fn main() -> Result<(), Failure> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let Some(library) = arguments
        .iter()
        .find(|argument| !argument.starts_with("--"))
    else {
        eprintln!("usage: audit_evernote_local <library folder> [--files]");
        std::process::exit(2);
    };
    let library = PathBuf::from(library);
    let data = std::env::var_os("EVERNOTE_DATA_DIR")
        .map(PathBuf::from)
        .or_else(default_data_dir)
        .ok_or("no folder of Evernote data is known on this system")?;
    let evernote = open(&evernote_database(&data).ok_or("no Evernote account was found")?)?;
    let bever = open(&library.join("bever.db"))?;

    let live = "(n.deleted IS NULL OR n.deleted = 0)";
    let their_tags = grouped(
        &evernote,
        "SELECT nt.Note_id, lower(trim(t.label)) FROM NoteTag nt JOIN Nodes_Tag t ON t.id = nt.Tag_id",
    )?;
    let their_files = grouped(
        &evernote,
        "SELECT parent_Note_id, lower(dataHash) || ' ' || dataSize || ' ' || coalesce(nullif(mime, ''), 'application/octet-stream') || ' ' || coalesce(filename, '')
         FROM Attachment WHERE isActive = 1 ORDER BY rowid",
    )?;
    let their_text = grouped(
        &evernote,
        "SELECT id, content FROM Offline_Search_Note_Content",
    )
    .unwrap_or_default();
    let their_tasks = grouped(
        &evernote,
        "SELECT parent_Note_id, label FROM Nodes_Task WHERE deleted IS NULL OR deleted = 0",
    )
    .unwrap_or_default();
    // What Evernote says about a note beside what is in it: the picture
    // chosen for it (empty where its thumbnail was removed), and the notes
    // pinned to notebooks, which are among the account's preferences.
    let their_thumbnails = grouped(
        &evernote,
        "SELECT id, lower(selectedThumbnailHash) FROM Nodes_Note WHERE selectedThumbnailHash IS NOT NULL",
    )
    .unwrap_or_default();
    let mut their_pins: HashSet<String> = HashSet::new();
    if let Ok(mut statement) = evernote.prepare("SELECT clientInfo FROM Nodes_Preferences") {
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let pinned = row
                .get::<_, Option<String>>(0)?
                .and_then(|info| serde_json::from_str::<serde_json::Value>(&info).ok())
                .and_then(|info| info.get("PINNED_NOTES_IN_NOTEBOOK").cloned())
                .and_then(|pinned| match pinned {
                    serde_json::Value::String(text) => serde_json::from_str(&text).ok(),
                    other => Some(other),
                });
            if let Some(serde_json::Value::Object(notebooks)) = pinned {
                for notes in notebooks.values() {
                    let notes = notes.as_array().into_iter().flatten();
                    their_pins.extend(notes.filter_map(|id| id.as_str().map(str::to_owned)));
                }
            }
        }
    }
    let our_tags = grouped(
        &bever,
        "SELECT n.evernote_guid, lower(t.name) FROM note_tags nt JOIN tags t ON t.id = nt.tag_id JOIN notes n ON n.id = nt.note_id
         WHERE n.evernote_guid IS NOT NULL",
    )?;
    let our_files = grouped(
        &bever,
        "SELECT n.evernote_guid, r.md5 || ' ' || r.size || ' ' || r.mime || ' ' || coalesce(r.file_name, '')
         FROM resources r JOIN notes n ON n.id = r.note_id WHERE n.evernote_guid IS NOT NULL ORDER BY r.note_id, r.position",
    )?;

    // The library's notes by Evernote's identifier.
    struct Ours {
        title: String,
        created: i64,
        updated: i64,
        notebook: String,
        stack: Option<String>,
        attributes: serde_json::Value,
        text: String,
        trashed: bool,
        notebook_id: String,
    }
    let mut ours: HashMap<String, Vec<Ours>> = HashMap::new();
    let mut without_identifier = 0u64;
    {
        let mut statement = bever.prepare(
            "SELECT n.evernote_guid, n.title, n.created_at, n.updated_at, nb.name, s.name, n.attributes_json, n.plain_text, n.deleted_at IS NOT NULL, n.notebook_id
             FROM notes n JOIN notebooks nb ON nb.id = n.notebook_id LEFT JOIN stacks s ON s.id = nb.stack_id",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let Some(identifier) = row.get::<_, Option<String>>(0)? else {
                without_identifier += 1;
                continue;
            };
            ours.entry(identifier).or_default().push(Ours {
                title: row.get(1)?,
                created: row.get(2)?,
                updated: row.get(3)?,
                notebook: row.get(4)?,
                stack: row.get(5)?,
                attributes: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
                text: row.get(7)?,
                trashed: row.get(8)?,
                notebook_id: row.get(9)?,
            });
        }
    }

    let mut findings = Findings::default();
    let (mut notes, mut same_text, mut no_text, mut tasks, mut characters) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut thumbnails, mut pins) = (0u64, 0u64);
    let mut theirs: HashSet<String> = HashSet::new();
    let mut statement = evernote.prepare(&format!(
        "SELECT n.id, trim(coalesce(n.label, '')), n.created, n.updated, trim(coalesce(nb.label, '')), nb.personal_Stack_id,
                n.editor_author, n.source, n.source_URL, n.source_application
         FROM Nodes_Note n LEFT JOIN Nodes_Notebook nb ON nb.id = n.parent_Notebook_id WHERE {live}"
    ))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        notes += 1;
        theirs.insert(id.clone());
        let Some(here) = ours.get(&id) else {
            findings.differs("not in the library", &id);
            continue;
        };
        if here.len() > 1 {
            findings.differs("in the library more than once", &id);
        }
        let note = &here[0];
        if note.trashed {
            findings.differs("in the library's trash", &id);
        }
        if note.title != row.get::<_, String>(1)? {
            findings.differs("title is not what Evernote shows", &id);
        }
        let seconds = |column: usize| -> rusqlite::Result<i64> {
            Ok(row.get::<_, f64>(column)?.div_euclid(1000.0) as i64 * 1000)
        };
        if note.created != seconds(2)? {
            findings.differs("time of creation differs", &id);
        }
        if note.updated != seconds(3)? {
            findings.differs("time of change differs", &id);
        }
        let notebook: String = row.get(4)?;
        let notebook = if notebook.is_empty() {
            "Imported notes".to_owned()
        } else {
            notebook
        };
        if !note.notebook.eq_ignore_ascii_case(&notebook)
            && note.notebook.to_lowercase() != notebook.to_lowercase()
        {
            findings.differs("notebook differs", &id);
        }
        let stack = row
            .get::<_, Option<String>>(5)?
            .map(|stack| {
                stack
                    .strip_prefix("Stack:")
                    .unwrap_or(&stack)
                    .trim()
                    .to_owned()
            })
            .filter(|stack| !stack.is_empty());
        if note.stack != stack {
            findings.differs("stack differs", &id);
        }
        for (column, name) in [
            (6, "author"),
            (7, "source"),
            (8, "source-url"),
            (9, "source-application"),
        ] {
            let there = row
                .get::<_, Option<String>>(column)?
                .filter(|value| !value.is_empty());
            if note.attributes.get(name).and_then(|value| value.as_str()) != there.as_deref() {
                findings.differs("an attribute differs", &id);
            }
        }
        // The picture that stands for the note, and its pin.
        let mark = |key: &str| {
            note.attributes
                .get("application-data")
                .and_then(|data| data.get(key))
                .and_then(|value| value.as_str())
        };
        let chosen_there = their_thumbnails.get(&id).and_then(|chosen| chosen.first());
        let same_choice = match (chosen_there, mark("bever.thumbnail")) {
            (None, None | Some("auto")) => true,
            (Some(there), Some("none")) => there.is_empty(),
            (Some(there), Some(here)) => !there.is_empty() && there.eq_ignore_ascii_case(here),
            _ => false,
        };
        if chosen_there.is_some() {
            thumbnails += 1;
        }
        if !same_choice {
            findings.differs("the thumbnail chosen differs", &id);
        }
        let pinned_here = mark("bever.pinned")
            .and_then(|pin| pin.strip_prefix(note.notebook_id.as_str()))
            .is_some_and(|rest| rest.starts_with(' '));
        if their_pins.contains(&id) {
            pins += 1;
        }
        if pinned_here != their_pins.contains(&id) {
            findings.differs("pinned in one and not in the other", &id);
        }
        let mut tags_there = their_tags.get(&id).cloned().unwrap_or_default();
        tags_there.retain(|tag| !tag.is_empty());
        tags_there.sort();
        tags_there.dedup();
        let mut tags_here = our_tags.get(&id).cloned().unwrap_or_default();
        tags_here.sort();
        if tags_there != tags_here {
            findings.differs("tags differ", &id);
        }
        if their_files.get(&id).cloned().unwrap_or_default()
            != our_files.get(&id).cloned().unwrap_or_default()
        {
            findings.differs("attachments differ", &id);
        }

        // The note's tasks are in its text; the rest of it is what Evernote
        // indexes. Where there are tasks the index has, in their place, the
        // words Evernote shows to a program that knows no tasks.
        let text = letters(&note.text);
        let labels = their_tasks.get(&id);
        if let Some(labels) = labels {
            for label in labels {
                tasks += 1;
                if !text.contains(&letters(label)) {
                    findings.differs("a task is not in the note", &id);
                }
            }
        }
        let indexed = their_text
            .get(&id)
            .and_then(|text| text.first())
            .map(|text| letters(text));
        match indexed {
            Some(indexed) if !indexed.is_empty() && labels.is_none() => {
                if indexed == text {
                    same_text += 1;
                    characters += text.chars().count() as u64;
                } else {
                    findings.differs("text is not what Evernote indexes", &id);
                }
            }
            Some(_) if labels.is_some() => {}
            _ if text.is_empty() => no_text += 1,
            _ => findings.differs("text where Evernote indexes none", &id),
        }
    }
    for identifier in ours.keys() {
        if !theirs.contains(identifier) {
            findings.differs(
                "in the library and not, or in the trash, in Evernote",
                identifier,
            );
        }
    }

    println!("Evernote has {notes} notes outside its trash; the library has {} from Evernote and {without_identifier} others.", ours.values().map(Vec::len).sum::<usize>());
    println!("Text the same as Evernote indexes: {same_text} notes, {characters} characters; without text in both: {no_text}; tasks looked for: {tasks}.");
    println!("Notes with a thumbnail chosen or removed in Evernote: {thumbnails}; notes pinned to their notebooks there: {pins}.");
    let count = |connection: &Connection, sql: &str| -> Result<i64, Failure> {
        Ok(connection.query_row(sql, [], |row| row.get(0))?)
    };
    println!(
        "Tags: {} in Evernote, {} in the library. Notebooks: {} and {}.",
        count(&evernote, "SELECT count(*) FROM Nodes_Tag")?,
        count(&bever, "SELECT count(*) FROM tags")?,
        count(&evernote, "SELECT count(*) FROM Nodes_Notebook")?,
        count(&bever, "SELECT count(*) FROM notebooks")?,
    );

    if arguments.iter().any(|argument| argument == "--files") {
        let (mut files, mut bytes) = (0u64, 0u64);
        let mut statement = bever.prepare("SELECT DISTINCT sha256, size FROM resources")?;
        let mut rows = statement.query([])?;
        let mut buffer = vec![0u8; 1 << 20];
        while let Some(row) = rows.next()? {
            let (hash, size): (String, u64) = (row.get(0)?, row.get(1)?);
            let path = library
                .join("blobs")
                .join(&hash[..2])
                .join(&hash[2..4])
                .join(&hash);
            let Ok(mut file) = File::open(&path) else {
                findings.differs("an attachment's file is not in the library", &hash);
                continue;
            };
            let mut hasher = Sha256::new();
            let mut read = 0u64;
            loop {
                let got = file.read(&mut buffer)?;
                if got == 0 {
                    break;
                }
                hasher.update(&buffer[..got]);
                read += got as u64;
            }
            if read != size || format!("{:x}", hasher.finalize()) != hash {
                findings.differs("an attachment's file is not what it was", &hash);
            }
            files += 1;
            bytes += read;
        }
        println!("Attachment files read and hashed: {files}, {bytes} bytes.");
    }

    if findings.counts.is_empty() {
        println!("Nothing differs.");
        return Ok(());
    }
    println!("What differs:");
    for (what, count) in &findings.counts {
        println!(
            "  {what}: {count}   ({})",
            findings.examples[what].join(" ")
        );
    }
    std::process::exit(1);
}
