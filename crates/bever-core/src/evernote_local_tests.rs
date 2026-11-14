//! Tests of reading the Evernote application's files. The folder they read
//! is made here, in the form Evernote 11 keeps its data; the two note
//! bodies were made with the Yjs library.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};

use super::*;
use crate::{
    enex::import_enex,
    models::{NoteFilter, SaveNote},
};

const SITE: &str = "https%3A%2F%2Fwww.evernote.com";
const FIRST: &str = "11111111-2222-3333-4444-555555555555";
const SECOND: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
/// The MD5 of `attachment bytes`.
const HASH: &str = "72adfd72c0caeec500581c85d0f5ce67";
/// `<en-note><div>Hello &amp; goodbye</div><div><en-media hash type/></div><div><br/></div></en-note>`,
/// titled "First note", with heading styles that say they are empty.
const FIRST_BODY: &str = "AQwVAAcBB2NvbnRlbnQDB2VuLW5vdGUHABUAAwNkaXYHABUBBgQAFQIPSGVsbG8gJiBnb29kYnllhxUBAwNkaXYHABUSAwhlbi1tZWRpYSgAFRMEaGFzaAF3IDcyYWRmZDcyYzBjYWVlYzUwMDU4MWM4NWQwZjVjZTY3KAAVEwR0eXBlAXcKdGV4dC9wbGFpbocVEgMDZGl2BwAVFgMCYnIEAQV0aXRsZQpGaXJzdCBub3RlKAEQY3VzdG9tTm90ZVN0eWxlcw1oZWFkaW5nU3R5bGVzAXYBB2lzRW1wdHl4AA==";
/// `<en-note><div>No title here</div></en-note>`, with heading styles that
/// do not say whether they are empty.
const SECOND_BODY: &str = "AQUWAAcBB2NvbnRlbnQDB2VuLW5vdGUHABYAAwNkaXYHABYBBgQAFgINTm8gdGl0bGUgaGVyZSgBEGN1c3RvbU5vdGVTdHlsZXMNaGVhZGluZ1N0eWxlcwF2AQJoMXYBCGZvbnRTaXpldwQzMHB4AA==";
const FIRST_MARKUP: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\"><en-note><div style=\"display:none;--en-chs:&quot;eyJpc0VtcHR5Ijp0cnVlfQ==&quot;\">\u{200a}</div><div>Hello &amp; goodbye</div><div><en-media hash=\"72adfd72c0caeec500581c85d0f5ce67\" type=\"text/plain\" /></div><div><br/></div></en-note>";

/// A folder as the Evernote application keeps one, with two notebooks, one
/// of them in a stack, and two notes.
struct Evernote {
    _directory: tempfile::TempDir,
    data: PathBuf,
    database: Connection,
}

impl Evernote {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("Evernote");
        let storage = data.join("conduit-storage").join(SITE);
        fs::create_dir_all(&storage).unwrap();
        let database = Connection::open(storage.join("UDB-User42+RemoteGraph.sql")).unwrap();
        database
            .execute_batch(
                "CREATE TABLE Nodes_Notebook(id TEXT, label TEXT, personal_Stack_id TEXT);
                 CREATE TABLE Nodes_Note(id TEXT, label TEXT, isUntitled BOOLEAN, created INTEGER, updated INTEGER,
                     deleted INTEGER, parent_Notebook_id TEXT, editor_author TEXT, source TEXT, source_URL TEXT,
                     source_application TEXT, attributes_subjectDate INTEGER, attributes_contentClass TEXT,
                     reminder_order INTEGER, reminder_time INTEGER, reminder_doneTime INTEGER);
                 CREATE TABLE Nodes_Tag(id TEXT, label TEXT);
                 CREATE TABLE NoteTag(id TEXT, Note_id TEXT, Tag_id TEXT);
                 CREATE TABLE Attachment(id TEXT, filename TEXT, mime TEXT, width INTEGER, height INTEGER,
                     isActive BOOLEAN, dataHash TEXT, dataSize INTEGER, applicationDataKeys TEXT,
                     applicationData TEXT, shardId TEXT, parent_Note_id TEXT);
                 CREATE TABLE AttachmentRecognition(id TEXT, content TEXT);
                 INSERT INTO Nodes_Notebook VALUES ('nb-1', 'Travel', 'Stack:Life & leisure'), ('nb-2', 'Loose', NULL);
                 INSERT INTO Nodes_Tag VALUES ('tag-1', 'paris'), ('tag-2', 'A & B');",
            )
            .unwrap();
        let evernote = Self {
            _directory: directory,
            data,
            database,
        };
        evernote.note(
            FIRST,
            "First note",
            false,
            "nb-1",
            1_700_000_000_789,
            1_700_000_100_123,
        );
        evernote.note(
            SECOND,
            "No title here",
            true,
            "nb-2",
            1_600_000_000_000,
            1_600_000_000_000,
        );
        evernote
            .database
            .execute_batch(&format!(
                "UPDATE Nodes_Note SET editor_author = 'Ada', source = 'web.clip',
                     source_URL = 'https://example.com/?a=1&b=2', source_application = 'webclipper.evernote'
                 WHERE id = '{FIRST}';
                 INSERT INTO NoteTag VALUES ('1', '{FIRST}', 'tag-1'), ('2', '{FIRST}', 'tag-2');"
            ))
            .unwrap();
        evernote.body(FIRST, FIRST_BODY);
        evernote.body(SECOND, SECOND_BODY);
        evernote.attachment(FIRST, "att-1", Some("notes.txt"), "text/plain", HASH, true);
        // One that was taken out of the note again: Evernote keeps its row.
        evernote.attachment(
            FIRST,
            "att-old",
            Some("old.txt"),
            "text/plain",
            "0000",
            false,
        );
        evernote.file(FIRST, HASH, b"attachment bytes");
        evernote
            .database
            .execute(
                "UPDATE Attachment SET applicationDataKeys = ?1, applicationData = ?2 WHERE id = 'att-1'",
                params![r#"["0","evernote.caption"]"#, r#"{"evernote.caption":"A text file."}"#],
            )
            .unwrap();
        // Recognition data is kept as the XML's bytes in hexadecimal.
        let recognition = "<recoIndex><item><t w=\"90\">receipt</t></item></recoIndex>";
        let hex: String = recognition
            .bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        evernote
            .database
            .execute(
                "INSERT INTO AttachmentRecognition VALUES ('att-1', ?1)",
                [hex],
            )
            .unwrap();
        evernote
    }

    fn note(
        &self,
        id: &str,
        label: &str,
        untitled: bool,
        notebook: &str,
        created: i64,
        updated: i64,
    ) {
        self.database
            .execute(
                "INSERT INTO Nodes_Note(id, label, isUntitled, created, updated, parent_Notebook_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, label, untitled, created, updated, notebook],
            )
            .unwrap();
    }

    fn body(&self, id: &str, state: &str) {
        let folder = self
            .data
            .join("conduit-fs")
            .join(SITE)
            .join("someone")
            .join("rte")
            .join("Note")
            .join("internal_rteDoc")
            .join(&id[..3])
            .join(&id[id.len() - 3..]);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join(format!("{id}.dat")),
            STANDARD.decode(state).unwrap(),
        )
        .unwrap();
    }

    fn attachment(
        &self,
        note: &str,
        id: &str,
        name: Option<&str>,
        mime: &str,
        hash: &str,
        active: bool,
    ) {
        self.database
            .execute(
                "INSERT INTO Attachment(id, filename, mime, width, height, isActive, dataHash, dataSize, applicationDataKeys, shardId, parent_Note_id)
                 VALUES (?1, ?2, ?3, 0, 0, ?4, ?5, 16, '[]', 's1', ?6)",
                params![id, name, mime, active, hash, note],
            )
            .unwrap();
    }

    fn file(&self, note: &str, hash: &str, bytes: &[u8]) {
        let folder = self.data.join("resource-cache").join("7").join(note);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join(hash), bytes).unwrap();
    }

    fn account(&self) -> EvernoteAccount {
        let mut accounts = find_accounts(&self.data);
        assert_eq!(accounts.len(), 1);
        accounts.remove(0)
    }
}

fn library() -> (tempfile::TempDir, Library) {
    let directory = tempfile::tempdir().unwrap();
    let library = Library::open(directory.path()).unwrap();
    (directory, library)
}

fn import(library: &Library, account: &EvernoteAccount) -> LocalImportReport {
    import_local(
        library,
        account,
        None,
        LocalImportOptions::default(),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap()
}

/// An import that takes notes without the attachments Evernote lacks.
fn import_without_missing(library: &Library, account: &EvernoteAccount) -> LocalImportReport {
    let options = LocalImportOptions {
        without_missing_attachments: true,
    };
    import_local(
        library,
        account,
        None,
        options,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap()
}

fn note_titled(library: &Library, title: &str) -> crate::models::Note {
    let page = library.list_notes(&NoteFilter::default()).unwrap();
    let summary = page
        .notes
        .iter()
        .find(|note| note.title == title)
        .unwrap_or_else(|| panic!("no note titled {title}"));
    library.get_note(&summary.id).unwrap()
}

#[test]
fn finds_the_account_and_says_what_it_holds() {
    let evernote = Evernote::new();
    let account = evernote.account();
    assert_eq!(account.user_id, "42");
    assert!(has_notebooks(&account));
    let overview = account.overview().unwrap();
    assert_eq!(
        overview.notebooks,
        [
            LocalNotebook {
                id: "nb-2".into(),
                name: "Loose".into(),
                stack: None,
                notes: 1,
                attachments: 0,
                bytes: 0,
                notes_not_downloaded: 0,
                incomplete: Vec::new(),
            },
            LocalNotebook {
                id: "nb-1".into(),
                name: "Travel".into(),
                stack: Some("Life & leisure".into()),
                notes: 1,
                // The one that was taken out of the note is not counted.
                attachments: 1,
                bytes: 16,
                notes_not_downloaded: 0,
                incomplete: Vec::new(),
            },
        ]
    );
    // A folder without Evernote in it has no accounts.
    assert!(find_accounts(Path::new("no such folder")).is_empty());
}

#[test]
fn imports_notes_into_their_notebooks_and_stacks() {
    let evernote = Evernote::new();
    let (_directory, library) = library();
    let mut phases = Vec::new();
    let report = import_local(
        &library,
        &evernote.account(),
        None,
        LocalImportOptions::default(),
        &AtomicBool::new(false),
        |progress| {
            if phases.last() != Some(&progress.phase) {
                phases.push(progress.phase.clone());
            }
            // Once it has looked, it knows how much there is to do.
            if progress.phase != "preparing" {
                assert_eq!(progress.note_count, 2);
                assert_eq!(progress.notebook_count, 2);
            }
        },
    )
    .unwrap();
    assert_eq!(
        phases,
        [
            "preparing",
            "notebookReady",
            "importing",
            "notebookReady",
            "importing",
            "finalizing",
            "complete"
        ]
    );
    assert_eq!(
        (
            report.notebooks,
            report.notes_imported,
            report.notes_failed,
            report.resources_imported
        ),
        (2, 2, 0, 1)
    );
    assert!(report.warnings.is_empty());

    let snapshot = library.snapshot().unwrap();
    let stack = snapshot
        .stacks
        .iter()
        .find(|stack| stack.name == "Life & leisure")
        .unwrap();
    let travel = snapshot
        .notebooks
        .iter()
        .find(|notebook| notebook.name == "Travel")
        .unwrap();
    assert_eq!(travel.stack_id.as_deref(), Some(stack.id.as_str()));
    let loose = snapshot
        .notebooks
        .iter()
        .find(|notebook| notebook.name == "Loose")
        .unwrap();
    assert_eq!(loose.stack_id, None);

    let first = note_titled(&library, "First note");
    assert_eq!(first.notebook_id, travel.id);
    // The note's content is what an export of it holds.
    assert_eq!(first.original_enml.as_deref(), Some(FIRST_MARKUP));
    assert!(first.plain_text.contains("Hello & goodbye"));
    // Times are to the second, as in an export.
    assert_eq!(
        (first.created_at, first.updated_at),
        (1_700_000_000_000, 1_700_000_100_000)
    );
    assert_eq!(first.tags, ["paris", "A & B"]);
    assert_eq!(first.evernote_guid.as_deref(), Some(FIRST));
    assert_eq!(
        first.attributes,
        serde_json::json!({
            "author": "Ada",
            "source": "web.clip",
            "source-url": "https://example.com/?a=1&b=2",
            "source-application": "webclipper.evernote",
        })
    );
    assert_eq!(first.resources.len(), 1);
    let resource = &first.resources[0];
    assert_eq!(resource.md5, HASH);
    assert_eq!(
        library.read_blob(&resource.sha256).unwrap(),
        b"attachment bytes"
    );
    assert_eq!(resource.file_name.as_deref(), Some("notes.txt"));
    assert_eq!((resource.width, resource.height), (None, None));
    assert_eq!(
        resource.attributes,
        serde_json::json!({
            "file-name": "notes.txt",
            "source-url": format!("en-cache://tokenKey%3D%22AuthToken%3AUser%3A42%22+{FIRST}+{HASH}+https%3A%2F%2Fpublic.www.evernote.com%2Fresources%2Fs1%2Fatt-1"),
            // A key Evernote lists without a value is written empty.
            "application-data": { "0": "", "evernote.caption": "A text file." },
        })
    );
    // What Evernote recognised in the attachment comes along and is searchable.
    assert_eq!(
        resource.recognition_text.as_deref().map(str::trim),
        Some("receipt")
    );
    let found = library
        .list_notes(&NoteFilter {
            query: "receipt".into(),
            ..NoteFilter::default()
        })
        .unwrap();
    assert_eq!(found.total, 1);

    // A note without a title is called what Evernote shows for it, words
    // of its text, and one whose heading styles were never looked at has
    // no hidden block.
    let second = note_titled(&library, "No title here");
    assert_eq!(second.notebook_id, loose.id);
    assert_eq!(
        second.original_enml.as_deref(),
        Some("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\"><en-note><div>No title here</div></en-note>")
    );
}

#[test]
fn imports_only_the_notebooks_asked_for_and_nothing_twice() {
    let evernote = Evernote::new();
    let (_directory, library) = library();
    let account = evernote.account();
    let only = import_local(
        &library,
        &account,
        Some(&["nb-2".to_owned()]),
        LocalImportOptions::default(),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!((only.notebooks, only.notes_imported), (1, 1));
    assert!(library
        .snapshot()
        .unwrap()
        .notebooks
        .iter()
        .all(|notebook| notebook.name != "Travel"));
    // Then everything: the note that is there already is passed over.
    let all = import(&library, &account);
    assert_eq!((all.notes_imported, all.notes_skipped), (1, 1));
    let again = import(&library, &account);
    assert_eq!((again.notes_imported, again.notes_skipped), (0, 2));
    assert_eq!(library.counts().unwrap().all, 2);
}

#[test]
fn a_note_evernote_has_not_downloaded_is_left_out_whole() {
    let evernote = Evernote::new();
    let folder = evernote.data.join("resource-cache").join("7").join(FIRST);
    fs::remove_file(folder.join(HASH)).unwrap();
    let account = evernote.account();
    let travel = &account.overview().unwrap().notebooks[1];
    assert_eq!(travel.notes_not_downloaded, 1);
    // It is named, with what is missing of it: Evernote does not say.
    assert_eq!(
        travel.incomplete,
        [LocalIncompleteNote {
            title: "First note".into(),
            text_missing: false,
            attachments: 1,
            attachments_missing: 1,
        }]
    );

    let (_directory, library) = library();
    let report = import(&library, &account);
    assert_eq!((report.notes_imported, report.notes_failed), (1, 1));
    assert_eq!(report.warnings.len(), 1);
    assert!(
        report.warnings[0].starts_with(
            "1 note was not imported because Evernote does not have all of it on this computer: “First note” in “Travel”. Open it in Evernote while online"
        ),
        "{}",
        report.warnings[0]
    );
    assert_eq!(library.counts().unwrap().all, 1);
    // Nothing of the note was stored. Its tags are here as tags of the
    // account, which come when every notebook is imported; no note has them.
    assert_eq!(library.snapshot().unwrap().tags.len(), 2);
    assert!(note_titled(&library, "No title here").tags.is_empty());

    // Once Evernote has the file, another run brings the note.
    evernote.file(FIRST, HASH, b"attachment bytes");
    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_skipped,
            report.notes_failed
        ),
        (1, 1, 0)
    );
}

#[test]
fn an_attachment_that_is_not_what_evernote_says_is_refused() {
    let evernote = Evernote::new();
    evernote.file(FIRST, HASH, b"other bytes");
    let (_directory, library) = library();
    let report = import(&library, &evernote.account());
    assert_eq!((report.notes_imported, report.notes_failed), (1, 1));
    assert!(report.warnings[0].contains(
        "“First note” in “Travel” was not imported: an attachment on this computer is damaged."
    ));
}

#[test]
fn stops_between_notes_when_cancelled() {
    let evernote = Evernote::new();
    let (_directory, library) = library();
    let cancel = AtomicBool::new(false);
    let report = import_local(
        &library,
        &evernote.account(),
        None,
        LocalImportOptions::default(),
        &cancel,
        |progress| {
            if progress.notes_imported == 1 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
    )
    .unwrap();
    assert!(report.cancelled);
    assert_eq!(report.notes_imported, 1);
}

#[test]
fn the_same_note_from_an_export_and_from_evernotes_files_is_one_note() {
    // The first note the way Evernote 11 exports it: line breaks and
    // indentation around the content, six spaces after it, no identifier,
    // no recognition data, and an empty value for the key "0".
    let export = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20261111T012835Z" application="Evernote" version="11.41.9">
  <note>
    <title>First note</title>
    <created>20231114T221320Z</created>
    <updated>20231114T221500Z</updated>
    <tag>paris</tag>
    <tag>A &amp; B</tag>
    <note-attributes>
      <author>Ada</author>
      <source>web.clip</source>
      <source-url>
        https://example.com/?a=1&amp;b=2
      </source-url>
      <source-application>webclipper.evernote</source-application>
    </note-attributes>
    <content>
      <![CDATA[{FIRST_MARKUP}      ]]>
    </content>
    <resource>
      <data encoding="base64">
YXR0YWNobWVudCBieXRlcw==
      </data>
      <mime>text/plain</mime>
      <resource-attributes>
        <file-name>notes.txt</file-name>
        <source-url>en-cache://tokenKey%3D%22AuthToken%3AUser%3A42%22+{FIRST}+{HASH}+https%3A%2F%2Fpublic.www.evernote.com%2Fresources%2Fs1%2Fatt-1</source-url>
        <application-data key="0"></application-data>
        <application-data key="evernote.caption">A text file.</application-data>
      </resource-attributes>
    </resource>
  </note>
</en-export>
"#
    );
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("Travel.enex");
    fs::write(&file, export).unwrap();
    let evernote = Evernote::new();

    // From the export first, then from Evernote's files: nothing new.
    let (_first, library) = library();
    assert_eq!(
        import_enex(&library, &file, None).unwrap().notes_imported,
        1
    );
    let exported = note_titled(&library, "First note");
    let report = import_local(
        &library,
        &evernote.account(),
        Some(&["nb-1".to_owned()]),
        LocalImportOptions::default(),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!((report.notes_imported, report.notes_skipped), (0, 1));

    // And the other way about, in another library.
    let (_second, other) = self::library();
    import(&other, &evernote.account());
    assert_eq!(import_enex(&other, &file, None).unwrap().notes_skipped, 1);

    // The two are the same note in everything an export says.
    let local = note_titled(&other, "First note");
    assert_eq!(exported.original_enml, local.original_enml);
    assert_eq!(exported.content_html, local.content_html);
    assert_eq!(exported.plain_text, local.plain_text);
    assert_eq!(
        (exported.created_at, exported.updated_at),
        (local.created_at, local.updated_at)
    );
    assert_eq!(exported.tags, local.tags);
    assert_eq!(exported.attributes, local.attributes);
    assert_eq!(exported.resources[0].sha256, local.resources[0].sha256);
    assert_eq!(
        exported.resources[0].attributes,
        local.resources[0].attributes
    );
    assert_eq!(
        exported.resources[0].file_name,
        local.resources[0].file_name
    );
    // Evernote's files add what a current export leaves out.
    assert_eq!(exported.evernote_guid, None);
    assert_eq!(exported.resources[0].recognition_xml, None);
    assert!(local.resources[0].recognition_xml.is_some());
}

#[test]
fn data_in_another_form_is_said_to_be_unknown() {
    let evernote = Evernote::new();
    evernote
        .database
        .execute_batch("ALTER TABLE Attachment RENAME COLUMN dataHash TO hash")
        .unwrap();
    let error = evernote.account().overview().unwrap_err().to_string();
    assert!(error.contains("not in the form Bever knows"), "{error}");
    let (_directory, library) = library();
    assert!(import_local(
        &library,
        &evernote.account(),
        None,
        LocalImportOptions::default(),
        &AtomicBool::new(false),
        |_| {}
    )
    .is_err());
    assert_eq!(library.counts().unwrap().all, 0);
}

#[test]
fn reads_recognition_data_and_keyed_data() {
    assert_eq!(recognition_xml("3c613e"), Some("<a>".to_owned()));
    assert_eq!(
        recognition_xml("<recoIndex/>"),
        Some("<recoIndex/>".to_owned())
    );
    assert_eq!(recognition_xml(""), None);
    assert_eq!(recognition_xml("zz"), None);
    assert_eq!(recognition_xml("3c6"), None);
    assert_eq!(stack_name("Stack:Work"), Some("Work".to_owned()));
    assert_eq!(stack_name("Stack:"), None);
    assert!(application_data(None, None).is_empty());
    assert_eq!(
        Value::Object(application_data(Some(r#"["a"]"#), Some(r#"{"b":"2"}"#))),
        serde_json::json!({ "a": "", "b": "2" })
    );
}

impl Evernote {
    /// Changes the first note the way editing it in Evernote does: another
    /// title, another text, a later time, and its attachment taken out.
    fn revise_first_note(&self) {
        self.database
            .execute_batch(&format!(
                "UPDATE Nodes_Note SET label = 'First note, revised', updated = 1700000200456 WHERE id = '{FIRST}';
                 UPDATE Attachment SET isActive = 0 WHERE parent_Note_id = '{FIRST}';"
            ))
            .unwrap();
        self.body(FIRST, SECOND_BODY);
    }
}

#[test]
fn a_note_changed_in_evernote_takes_the_place_of_the_one_imported() {
    let evernote = Evernote::new();
    let (_directory, library) = library();
    let account = evernote.account();
    import(&library, &account);
    let before = note_titled(&library, "First note");
    // The note is moved to another place in the meantime, by a rule that
    // does not count as changing it: links between notes being connected.
    evernote.revise_first_note();

    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_updated,
            report.notes_imported,
            report.notes_kept_both,
            report.notes_skipped
        ),
        (1, 0, 0, 1)
    );
    assert_eq!(library.counts().unwrap().all, 2, "no second copy");
    let after = note_titled(&library, "First note, revised");
    assert_eq!(after.id, before.id, "the same note, not a new one");
    assert_eq!(after.notebook_id, before.notebook_id);
    assert!(after.plain_text.contains("No title here"));
    assert!(!after.plain_text.contains("goodbye"));
    assert_eq!(after.updated_at, 1_700_000_200_000);
    assert!(after.resources.is_empty());
    assert!(after.revision > before.revision);
    assert_eq!(after.tags, before.tags);
    // The older form is not found any more, and neither form comes again.
    assert_eq!(
        library
            .list_notes(&NoteFilter {
                query: "goodbye".into(),
                ..NoteFilter::default()
            })
            .unwrap()
            .total,
        0
    );
    let again = import(&library, &account);
    assert_eq!(
        (
            again.notes_updated,
            again.notes_imported,
            again.notes_skipped
        ),
        (0, 0, 2)
    );
}

#[test]
fn a_note_changed_here_and_in_evernote_is_kept_in_both_forms() {
    let evernote = Evernote::new();
    let (_directory, library) = library();
    let account = evernote.account();
    import(&library, &account);
    let mine = note_titled(&library, "First note");
    library
        .save_note(&crate::models::SaveNote {
            id: mine.id.clone(),
            notebook_id: mine.notebook_id.clone(),
            title: "First note".into(),
            content_html: "<p>What I wrote here</p>".into(),
            attributes: mine.attributes.clone(),
            tags: mine.tags.clone(),
            base_revision: None,
        })
        .unwrap();
    evernote.revise_first_note();

    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_updated,
            report.notes_imported,
            report.notes_kept_both,
            report.notes_skipped
        ),
        (0, 1, 1, 1)
    );
    assert_eq!(library.counts().unwrap().all, 3);
    // What was written here is still here, and Evernote's form is beside it.
    assert!(library
        .get_note(&mine.id)
        .unwrap()
        .plain_text
        .contains("What I wrote here"));
    let theirs = note_titled(&library, "First note, revised");
    assert_ne!(theirs.id, mine.id);
    assert!(theirs.plain_text.contains("No title here"));
    // Importing once more does not add it a second time.
    let again = import(&library, &account);
    assert_eq!(
        (
            again.notes_updated,
            again.notes_imported,
            again.notes_skipped
        ),
        (0, 0, 2)
    );
    assert_eq!(library.counts().unwrap().all, 3);
}

#[test]
fn an_export_made_later_brings_a_note_up_to_date() {
    // A current export has no identifier for a note: the note is known
    // again by its title and its time of creation.
    let export = |updated: &str, text: &str, tag: &str| {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Shopping</title>
    <created>20240102T030405Z</created>
    <updated>{updated}</updated>
    <tag>{tag}</tag>
    <content>
      <![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>{text}</div></en-note>      ]]>
    </content>
  </note>
  <note>
    <title>Unrelated</title>
    <created>20240102T030405Z</created>
    <updated>20240102T030405Z</updated>
    <content><![CDATA[<en-note><div>Stays as it is</div></en-note>]]></content>
  </note>
</en-export>
"#
        )
    };
    let directory = tempfile::tempdir().unwrap();
    let write = |name: &str, content: String| {
        let path = directory.path().join(name);
        fs::write(&path, content).unwrap();
        path
    };
    let first = write("first.enex", export("20240102T030405Z", "Milk", "list"));
    let second = write(
        "second.enex",
        export("20240305T000000Z", "Milk and bread", "list"),
    );
    let (_directory, library) = library();
    let report = import_enex(&library, &first, Some("Lists")).unwrap();
    assert_eq!((report.notes_imported, report.notes_updated), (2, 0));
    let before = note_titled(&library, "Shopping");

    let report = import_enex(&library, &second, Some("Lists")).unwrap();
    assert_eq!(
        (
            report.notes_imported,
            report.notes_updated,
            report.notes_skipped,
            report.notes_kept_both
        ),
        (0, 1, 1, 0)
    );
    assert_eq!(library.counts().unwrap().all, 2);
    let after = note_titled(&library, "Shopping");
    assert_eq!(after.id, before.id);
    assert!(after.plain_text.contains("Milk and bread"));
    // The first export again: its form of the note was here once and is
    // not brought back over the newer one.
    let report = import_enex(&library, &first, Some("Lists")).unwrap();
    assert_eq!(
        (
            report.notes_imported,
            report.notes_updated,
            report.notes_skipped
        ),
        (0, 0, 2)
    );
    assert!(note_titled(&library, "Shopping")
        .plain_text
        .contains("Milk and bread"));
}

#[test]
fn a_note_moved_to_the_trash_here_is_updated_where_it_lies() {
    let evernote = Evernote::new();
    let (_directory, library) = library();
    let account = evernote.account();
    import(&library, &account);
    let note = note_titled(&library, "First note");
    library
        .set_notes_trashed(std::slice::from_ref(&note.id), true)
        .unwrap();
    // Putting a note in the trash says it is not wanted, not that its text
    // was changed: Evernote's newer form takes its place there, and the
    // note does not come back out of the trash.
    evernote.revise_first_note();
    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_updated,
            report.notes_imported,
            report.notes_kept_both
        ),
        (1, 0, 0)
    );
    let trashed = library.get_note(&note.id).unwrap();
    assert!(trashed.deleted_at.is_some());
    assert_eq!(trashed.title, "First note, revised");
    assert_eq!(
        library.counts().unwrap().all,
        1,
        "only the other note is listed"
    );
}

#[test]
fn two_notes_of_one_export_are_never_taken_for_two_forms_of_one() {
    // Some exports give two notes one identifier. Even with a later time
    // on the second, it is another note: the first is not replaced by it.
    let export = r#"<?xml version="1.0"?><en-export>
<note><title>Same</title><guid>01234567-89ab-cdef-0123-456789abcdef</guid><created>20240102T030405Z</created><updated>20240102T030405Z</updated><content><![CDATA[<en-note><div>One</div></en-note>]]></content></note>
<note><title>Same</title><guid>01234567-89ab-cdef-0123-456789abcdef</guid><created>20240102T030405Z</created><updated>20240505T000000Z</updated><content><![CDATA[<en-note><div>Two</div></en-note>]]></content></note>
</en-export>"#;
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("twins.enex");
    fs::write(&file, export).unwrap();
    let (_directory, library) = library();
    let report = import_enex(&library, &file, None).unwrap();
    assert_eq!((report.notes_imported, report.notes_updated), (2, 0));
    assert_eq!(library.counts().unwrap().all, 2);
    let again = import_enex(&library, &file, None).unwrap();
    assert_eq!(
        (
            again.notes_imported,
            again.notes_updated,
            again.notes_skipped
        ),
        (0, 0, 2)
    );
}

/// Takes the first note's attachment out of Evernote's files, as when
/// Evernote was refused it and did not ask again.
fn lose_attachment(evernote: &Evernote) {
    let folder = evernote.data.join("resource-cache").join("7").join(FIRST);
    fs::remove_file(folder.join(HASH)).unwrap();
}

#[test]
fn a_note_is_imported_without_what_evernote_lacks_when_asked_and_completed_later() {
    let evernote = Evernote::new();
    lose_attachment(&evernote);
    let account = evernote.account();
    let (_directory, library) = library();

    let report = import_without_missing(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_failed,
            report.notes_incomplete,
            report.resources_imported
        ),
        (2, 0, 1, 0)
    );
    assert_eq!(report.warnings.len(), 1);
    assert!(
        report.warnings[0].starts_with(
            "1 note was imported without attachments that Evernote does not have on this computer: “First note” in “Travel” (1 of 1)."
        ),
        "{}",
        report.warnings[0]
    );
    let partial = note_titled(&library, "First note");
    assert!(partial.resources.is_empty());
    // Its text still says where the attachment belongs.
    assert_eq!(partial.original_enml.as_deref(), Some(FIRST_MARKUP));
    assert_eq!(partial.tags, ["paris", "A & B"]);

    // Importing again while it is still missing brings nothing twice.
    let again = import_without_missing(&library, &account);
    assert_eq!(
        (
            again.notes_imported,
            again.notes_updated,
            again.notes_skipped,
            again.notes_incomplete
        ),
        (0, 0, 2, 0)
    );
    assert!(again.warnings.is_empty());
    assert_eq!(library.counts().unwrap().all, 2);

    // Once Evernote has the file, the whole note takes the place of the one
    // without it: the same note, not a second one, although Evernote says
    // it was last changed at the same moment.
    evernote.file(FIRST, HASH, b"attachment bytes");
    let whole = import(&library, &account);
    assert_eq!(
        (
            whole.notes_imported,
            whole.notes_updated,
            whole.notes_skipped
        ),
        (0, 1, 1)
    );
    assert_eq!(library.counts().unwrap().all, 2);
    let completed = note_titled(&library, "First note");
    assert_eq!(completed.id, partial.id);
    assert_eq!(completed.resources.len(), 1);
    assert_eq!(
        library.read_blob(&completed.resources[0].sha256).unwrap(),
        b"attachment bytes"
    );
}

#[test]
fn a_note_with_parts_missing_never_replaces_or_doubles_one_that_is_here() {
    let evernote = Evernote::new();
    let account = evernote.account();
    let (_directory, library) = library();
    import(&library, &account);
    let whole = note_titled(&library, "First note");

    // Evernote's files lose the attachment after the note was imported
    // whole: the note here keeps it.
    lose_attachment(&evernote);
    let report = import_without_missing(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_updated,
            report.notes_skipped,
            report.notes_incomplete
        ),
        (0, 0, 2, 0)
    );
    assert_eq!(library.counts().unwrap().all, 2);
    assert_eq!(note_titled(&library, "First note").resources.len(), 1);

    // Not even when Evernote has a later form of the note.
    evernote
        .database
        .execute(
            "UPDATE Nodes_Note SET updated = updated + 60000 WHERE id = ?1",
            [FIRST],
        )
        .unwrap();
    let later = import_without_missing(&library, &account);
    assert_eq!((later.notes_updated, later.notes_skipped), (0, 2));
    assert_eq!(note_titled(&library, "First note").resources.len(), 1);

    // Nor beside a note that was changed here.
    library
        .save_note(&SaveNote {
            id: whole.id.clone(),
            notebook_id: whole.notebook_id.clone(),
            title: "First note".into(),
            content_html: "<p>Changed here</p>".into(),
            attributes: serde_json::json!({}),
            tags: Vec::new(),
            base_revision: None,
        })
        .unwrap();
    let beside = import_without_missing(&library, &account);
    assert_eq!((beside.notes_imported, beside.notes_skipped), (0, 2));
    assert_eq!(library.counts().unwrap().all, 2);
}

#[test]
fn a_note_changed_here_while_it_lacked_attachments_is_kept_beside_the_whole_one() {
    let evernote = Evernote::new();
    lose_attachment(&evernote);
    let account = evernote.account();
    let (_directory, library) = library();
    import_without_missing(&library, &account);
    let partial = note_titled(&library, "First note");
    library
        .save_note(&SaveNote {
            id: partial.id.clone(),
            notebook_id: partial.notebook_id.clone(),
            title: "First note, changed here".into(),
            content_html: "<p>Changed here</p>".into(),
            attributes: serde_json::json!({}),
            tags: Vec::new(),
            base_revision: None,
        })
        .unwrap();

    evernote.file(FIRST, HASH, b"attachment bytes");
    let report = import(&library, &account);
    assert_eq!(
        (report.notes_imported, report.notes_kept_both),
        (1, 1),
        "the whole note is added, and the changed one stays"
    );
    assert_eq!(library.counts().unwrap().all, 3);
    assert_eq!(note_titled(&library, "First note").resources.len(), 1);
    assert!(note_titled(&library, "First note, changed here")
        .resources
        .is_empty());
}

#[test]
fn a_note_whose_text_evernote_lacks_is_left_out_even_when_asked() {
    let evernote = Evernote::new();
    let bodies = evernote
        .data
        .join("conduit-fs")
        .join(SITE)
        .join("someone")
        .join("rte")
        .join("Note")
        .join("internal_rteDoc");
    fs::remove_file(
        bodies
            .join(&SECOND[..3])
            .join(&SECOND[SECOND.len() - 3..])
            .join(format!("{SECOND}.dat")),
    )
    .unwrap();
    let account = evernote.account();
    let loose = &account.overview().unwrap().notebooks[0];
    assert_eq!(
        loose.incomplete,
        [LocalIncompleteNote {
            title: "No title here".into(),
            text_missing: true,
            attachments: 0,
            attachments_missing: 0,
        }]
    );

    let (_directory, library) = library();
    let report = import_without_missing(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_failed,
            report.notes_incomplete
        ),
        (1, 1, 0)
    );
    assert!(
        report.warnings[0].contains("“No title here” in “Loose”"),
        "{}",
        report.warnings[0]
    );
}

#[test]
fn tags_come_nested_as_evernote_has_them() {
    let evernote = Evernote::new();
    evernote
        .database
        .execute_batch(
            "ALTER TABLE Nodes_Tag ADD COLUMN parent_Tag_id TEXT;
             INSERT INTO Nodes_Tag(id, label, parent_Tag_id) VALUES ('tag-3', 'Europe', 'tag-4'), ('tag-4', 'Places', NULL);
             UPDATE Nodes_Tag SET parent_Tag_id = 'tag-3' WHERE id = 'tag-1';",
        )
        .unwrap();
    let account = evernote.account();
    let (_directory, library) = library();
    let report = import(&library, &account);
    assert_eq!(report.tags_nested, 2);
    let tags = library.snapshot().unwrap().tags;
    let tag = |name: &str| tags.iter().find(|tag| tag.name == name).unwrap();
    // "Europe" and "Places" are on no note; they came for what they hold.
    assert_eq!(tag("paris").parent_id.as_ref(), Some(&tag("Europe").id));
    assert_eq!(tag("Europe").parent_id.as_ref(), Some(&tag("Places").id));
    assert_eq!(tag("Places").parent_id, None);
    assert_eq!(tag("A & B").parent_id, None);
    assert_eq!(tags.len(), 4);
    // The note has the tags it had.
    assert_eq!(note_titled(&library, "First note").tags, ["paris", "A & B"]);

    // Importing again places nothing twice, and a tag moved here stays.
    library.set_tag_parent(&tag("paris").id, None).unwrap();
    let again = import(&library, &account);
    assert_eq!(again.tags_nested, 0);
    let tags = library.snapshot().unwrap().tags;
    assert_eq!(
        tags.iter()
            .find(|tag| tag.name == "paris")
            .unwrap()
            .parent_id,
        None
    );
}

#[test]
fn a_library_imported_before_tags_were_nested_gets_them_nested_by_importing_again() {
    let evernote = Evernote::new();
    let account = evernote.account();
    let (_directory, library) = library();
    assert_eq!(import(&library, &account).tags_nested, 0);
    evernote
        .database
        .execute_batch(
            "ALTER TABLE Nodes_Tag ADD COLUMN parent_Tag_id TEXT;
             UPDATE Nodes_Tag SET parent_Tag_id = 'tag-2' WHERE id = 'tag-1';",
        )
        .unwrap();
    let again = import(&library, &evernote.account());
    assert_eq!((again.notes_imported, again.notes_skipped), (0, 2));
    assert_eq!(again.tags_nested, 1);
    let tags = library.snapshot().unwrap().tags;
    let tag = |name: &str| tags.iter().find(|tag| tag.name == name).unwrap();
    assert_eq!(tag("paris").parent_id.as_ref(), Some(&tag("A & B").id));
}

#[test]
fn shortcuts_come_as_evernote_has_them() {
    let evernote = Evernote::new();
    evernote
        .database
        .execute_batch(&format!(
            "CREATE TABLE Nodes_SavedSearch(id TEXT, query TEXT, label TEXT);
             INSERT INTO Nodes_SavedSearch VALUES ('search-1', 'tag:paris louvre', 'Museums');
             CREATE TABLE Nodes_Shortcut(id TEXT, sortOrder TEXT, source_Stack_id TEXT, source_Note_id TEXT,
                 source_Notebook_id TEXT, source_Tag_id TEXT, source_SavedSearch_id TEXT, label TEXT);
             INSERT INTO Nodes_Shortcut VALUES
                 ('s-1', 'YM', NULL, NULL, NULL, NULL, 'search-1', ''),
                 ('s-2', 'M', NULL, NULL, 'nb-1', NULL, NULL, ''),
                 ('s-3', 'V', 'Stack:Life & leisure', NULL, NULL, NULL, NULL, ''),
                 ('s-4', 'X', NULL, NULL, NULL, 'tag-1', NULL, ''),
                 ('s-5', 'Y', NULL, '{FIRST}', NULL, NULL, NULL, ''),
                 ('s-6', 'YS', NULL, 'a-note-that-is-not-here', NULL, NULL, NULL, ''),
                 ('s-7', 'YV', NULL, NULL, 'a-notebook-that-is-not-here', NULL, NULL, '');"
        ))
        .unwrap();
    let account = evernote.account();
    let (_directory, library) = library();
    let report = import(&library, &account);
    assert_eq!((report.shortcuts_added, report.shortcuts_nowhere), (5, 2));
    let snapshot = library.snapshot().unwrap();
    let shown = snapshot
        .shortcuts
        .iter()
        .map(|shortcut| (shortcut.target_type.as_str(), shortcut.label.as_str()))
        .collect::<Vec<_>>();
    // In Evernote's order; what points to nothing that is here is left out.
    assert_eq!(
        shown,
        [
            ("notebook", "Travel"),
            ("stack", "Life & leisure"),
            ("tag", "paris"),
            ("note", "First note"),
            ("search", "Museums"),
        ]
    );
    let search = &snapshot.shortcuts[4];
    assert_eq!(search.target_id, "tag:paris louvre");
    assert_eq!(
        snapshot.shortcuts[3].target_id,
        note_titled(&library, "First note").id
    );

    // Importing again adds nothing twice, and a shortcut removed here stays
    // removed.
    library
        .toggle_shortcut("tag", &snapshot.shortcuts[2].target_id, "paris")
        .unwrap();
    let again = import(&library, &account);
    assert_eq!(again.shortcuts_added, 0);
    assert_eq!(library.snapshot().unwrap().shortcuts.len(), 4);
}

/// The notes of the account as Bever read them up to 1.1.1: a note without
/// a title under the name an export gives it, tasks left out.
fn import_as_before(library: &Library, account: &EvernoteAccount) {
    struct Stored<'a>(&'a Library);
    impl BlobSink for Stored<'_> {
        fn store(&mut self, reader: &mut dyn std::io::Read) -> Result<crate::blob::StoredBlob> {
            let mut library = self.0;
            library.store(reader)
        }
    }
    let run = library.import_run_mark().unwrap();
    for notebook in account.overview().unwrap().notebooks {
        let stack = notebook
            .stack
            .as_deref()
            .map(|stack| library.ensure_stack(stack).unwrap());
        let here = library
            .ensure_notebook(&notebook.name, stack.as_deref())
            .unwrap();
        let mut notes = Vec::new();
        account
            .read_notebook(&notebook.id, &mut Stored(library), |note| {
                notes.push(note.unwrap())
            })
            .unwrap();
        for mut note in notes {
            if let Some(earlier) = note.earlier.take() {
                note.title = earlier.title;
                note.content = earlier.content;
                note.attributes = earlier.attributes;
            }
            library.import_enex_note(note, &here, run).unwrap();
        }
    }
}

#[test]
fn a_library_imported_before_gets_its_titles_put_right_by_importing_again() {
    let evernote = Evernote::new();
    // One more note without a title, which has no text either.
    let third = "cccccccc-0000-1111-2222-333333333333";
    evernote.note(
        third,
        "Untitled",
        true,
        "nb-2",
        1_650_000_000_000,
        1_650_000_000_000,
    );
    evernote.body(third, SECOND_BODY);
    let account = evernote.account();
    let (_directory, library) = library();
    import_as_before(&library, &account);
    let before = library.list_notes(&NoteFilter::default()).unwrap();
    assert_eq!(
        before
            .notes
            .iter()
            .filter(|note| note.title == "Untitled Note")
            .count(),
        2
    );
    // A shortcut to one of them, and the other changed here in its text.
    let ids: Vec<String> = before
        .notes
        .iter()
        .filter(|note| note.title == "Untitled Note")
        .map(|note| note.id.clone())
        .collect();
    let (kept, changed) = (
        library.get_note(&ids[0]).unwrap(),
        library.get_note(&ids[1]).unwrap(),
    );
    library
        .toggle_shortcut("note", &kept.id, "Untitled Note")
        .unwrap();
    library
        .save_note(&SaveNote {
            id: changed.id.clone(),
            notebook_id: changed.notebook_id.clone(),
            title: changed.title.clone(),
            content_html: "<p>What I wrote here</p>".into(),
            attributes: changed.attributes.clone(),
            tags: changed.tags.clone(),
            base_revision: None,
        })
        .unwrap();

    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_updated,
            report.notes_kept_both,
            report.notes_skipped
        ),
        (0, 2, 0, 1)
    );
    // The same notes, under what Evernote shows for them.
    assert_eq!(library.counts().unwrap().all, 3);
    let (kept, changed) = (
        library.get_note(&kept.id).unwrap(),
        library.get_note(&changed.id).unwrap(),
    );
    let mut titles = [kept.title.as_str(), changed.title.as_str()];
    titles.sort_unstable();
    assert_eq!(titles, ["No title here", "Untitled"]);
    // What was written here is still there, and the shortcut follows.
    assert!(changed.plain_text.contains("What I wrote here"));
    assert_eq!(library.snapshot().unwrap().shortcuts[0].label, kept.title);
    let found = library
        .list_notes(&NoteFilter {
            query: format!("intitle:\"{}\"", kept.title),
            ..NoteFilter::default()
        })
        .unwrap();
    assert_eq!(found.total, 1);

    // Importing once more changes nothing.
    let again = import(&library, &account);
    assert_eq!(
        (
            again.notes_imported,
            again.notes_updated,
            again.notes_skipped
        ),
        (0, 0, 3)
    );
    assert_eq!(library.counts().unwrap().all, 3);
}

#[test]
fn a_title_given_here_is_not_taken_back_by_importing_again() {
    let evernote = Evernote::new();
    let account = evernote.account();
    let (_directory, library) = library();
    import_as_before(&library, &account);
    let mine = note_titled(&library, "Untitled Note");
    library
        .save_note(&SaveNote {
            id: mine.id.clone(),
            notebook_id: mine.notebook_id.clone(),
            title: "My own name for it".into(),
            content_html: mine.content_html.clone(),
            attributes: mine.attributes.clone(),
            tags: mine.tags.clone(),
            base_revision: None,
        })
        .unwrap();
    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_updated,
            report.notes_kept_both,
            report.notes_skipped
        ),
        (0, 0, 0, 2)
    );
    assert_eq!(library.counts().unwrap().all, 2);
    assert_eq!(
        library.get_note(&mine.id).unwrap().title,
        "My own name for it"
    );
}

impl Evernote {
    /// Tasks of the second note, as Evernote keeps them: two that count and
    /// one that was deleted, with a reminder that is on and one that is off.
    fn tasks(&self) {
        self.database
            .execute_batch(&format!(
                "CREATE TABLE Nodes_Task(id TEXT, label TEXT, status TEXT, sortWeight TEXT, taskGroupNoteLevelID TEXT,
                     created INTEGER, dueDate INTEGER, dueDateUIOption TEXT, deleted INTEGER, parent_Note_id TEXT);
                 CREATE TABLE Nodes_Reminder(id TEXT, reminderDate INTEGER, status TEXT, source_Task_id TEXT);
                 INSERT INTO Nodes_Task VALUES
                     ('task-1', 'Book <the> hotel', 'open', 'M', 'group-1', 1600000001000, NULL, NULL, NULL, '{SECOND}'),
                     ('task-2', 'Renew passport', 'completed', 'B', 'group-1', 1600000002000, 1700000000000, 'date_time', NULL, '{SECOND}'),
                     ('task-3', 'Deleted long ago', 'open', 'A', 'group-1', 1600000003000, NULL, NULL, 1600000009000, '{SECOND}');
                 INSERT INTO Nodes_Reminder VALUES
                     ('reminder-1', 1699990000000, 'active', 'task-2'),
                     ('reminder-2', 1699980000000, 'muted', 'task-2');"
            ))
            .unwrap();
    }
}

#[test]
fn tasks_come_as_a_checklist_in_their_note() {
    let evernote = Evernote::new();
    evernote.tasks();
    let account = evernote.account();
    let (_directory, library) = library();
    let report = import(&library, &account);
    assert_eq!((report.tasks_brought, report.notes_with_tasks), (2, 1));
    let note = note_titled(&library, "No title here");
    // In Evernote's order, the finished one ticked, the deleted one not
    // there; the group has no place in this note's text, so it is at its end.
    let markup = note.original_enml.as_deref().unwrap();
    assert!(markup.contains("<div>No title here</div><ul style=\"--en-todo:true;\"><li style=\"--en-checked:true;\"><div>Renew passport (due "));
    assert!(markup.ends_with("</div></li><li style=\"--en-checked:false;\"><div>Book &lt;the> hotel</div></li></ul></en-note>"));
    assert!(markup.contains("; reminder "));
    assert_eq!(markup.matches("reminder ").count(), 1);
    assert!(!markup.contains("Deleted long ago"));
    assert_eq!(
        note.content_html.matches("data-type=\"taskItem\"").count(),
        2
    );
    assert_eq!(
        note.content_html.matches("data-checked=\"true\"").count(),
        1
    );
    assert!(note.plain_text.contains("Book <the> hotel"));
    let found = library
        .list_notes(&NoteFilter {
            query: "passport".into(),
            ..NoteFilter::default()
        })
        .unwrap();
    assert_eq!(found.total, 1);

    // A library that has the note without its tasks gets them by importing
    // again, in the note that is there.
    let (_other, earlier) = self::library();
    import_as_before(&earlier, &account);
    let before = note_titled(&earlier, "Untitled Note");
    assert!(!before.plain_text.contains("passport"));
    let report = import(&earlier, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_updated,
            report.tasks_brought
        ),
        (0, 1, 2)
    );
    assert_eq!(earlier.counts().unwrap().all, 2);
    let after = earlier.get_note(&before.id).unwrap();
    assert_eq!(after.title, "No title here");
    assert!(after.plain_text.contains("Renew passport"));
}

#[test]
fn what_evernote_changed_without_a_later_time_is_brought_into_the_note_that_is_here() {
    let evernote = Evernote::new();
    let account = evernote.account();
    let (_directory, library) = library();
    import(&library, &account);
    let second = note_titled(&library, "No title here");
    // A tag put on a note leaves the time of its last change as it was.
    evernote
        .database
        .execute("INSERT INTO NoteTag VALUES ('3', ?1, 'tag-1')", [SECOND])
        .unwrap();
    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_updated,
            report.notes_kept_both,
            report.notes_skipped
        ),
        (0, 1, 0, 1)
    );
    assert_eq!(library.counts().unwrap().all, 2);
    assert_eq!(library.get_note(&second.id).unwrap().tags, ["paris"]);

    // Nor does a time that Evernote has set back leave the note behind.
    evernote
        .database
        .execute(
            "UPDATE Nodes_Note SET updated = updated - 86400000, label = 'Named at last', isUntitled = 0 WHERE id = ?1",
            [SECOND],
        )
        .unwrap();
    let report = import(&library, &account);
    assert_eq!((report.notes_imported, report.notes_updated), (0, 1));
    assert_eq!(library.counts().unwrap().all, 2);
    let now = library.get_note(&second.id).unwrap();
    assert_eq!(now.title, "Named at last");
    assert_eq!(now.updated_at, second.updated_at - 86_400_000);
}

#[test]
fn what_is_not_brought_is_counted() {
    let evernote = Evernote::new();
    // A note in Evernote's trash, a tag that no note has, and an attachment
    // that the first note's text names though Evernote has it no more.
    evernote.note(
        "trashed-note-0000-0000-000000000000",
        "Thrown away",
        false,
        "nb-1",
        1,
        1,
    );
    evernote
        .database
        .execute_batch(
            "UPDATE Nodes_Note SET deleted = 1700000000000 WHERE label = 'Thrown away';
             INSERT INTO Nodes_Tag VALUES ('tag-3', 'spare');
             DELETE FROM Attachment WHERE id = 'att-1';",
        )
        .unwrap();
    let account = evernote.account();

    // One notebook: its notes, and no tags but theirs.
    let (_one, partly) = library();
    let only = import_local(
        &partly,
        &account,
        Some(&["nb-2".to_owned()]),
        LocalImportOptions::default(),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!((only.notes_in_trash, only.tags_added), (0, 0));
    assert!(partly.snapshot().unwrap().tags.is_empty());

    let (_directory, library) = library();
    let report = import(&library, &account);
    assert_eq!(
        (
            report.notes_imported,
            report.notes_in_trash,
            report.tags_added
        ),
        (2, 1, 1)
    );
    assert_eq!(library.counts().unwrap().all, 2);
    let tags = library.snapshot().unwrap().tags;
    assert_eq!(tags.len(), 3);
    assert_eq!(report.warnings.len(), 1);
    assert_eq!(
        report.warnings[0],
        "1 note names attachments that Evernote itself does not have, so they are missing here as they are there: “First note” in “Travel”."
    );
    assert!(note_titled(&library, "First note").resources.is_empty());

    // A tag deleted here is not made again by the next import.
    let spare = tags.iter().find(|tag| tag.name == "spare").unwrap();
    library.delete_tag(&spare.id).unwrap();
    let again = import(&library, &account);
    assert_eq!(again.tags_added, 0);
    assert_eq!(library.snapshot().unwrap().tags.len(), 2);
}
