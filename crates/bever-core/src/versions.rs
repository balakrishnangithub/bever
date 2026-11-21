//! Earlier forms of a note, kept on this device.
//!
//! The editor saves by itself, so a change made by mistake is stored like
//! any other. Before the first save of each visit to a note, the editor
//! asks for the note to be kept as it is; a few such forms are held for
//! each note, and any of them can be put back. They are not synchronized
//! and not exported: they are this device's memory of what was here.
//!
//! A form is the note's title, text, tags and details, and the attachments
//! it had. An attachment added since is not the form's: putting the form
//! back takes it off the note, or the note would not be as it was, and
//! would be sent to the other devices for an attachment nothing in it
//! shows. It is not lost: the note as it was just before is kept too, and
//! has it.
use std::{collections::HashSet, sync::TryLockError};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{Note, NoteVersion},
    repository::{blob_referenced, note_with, store_note_form, NoteForm},
};

/// Forms kept of one note; the oldest makes way for a new one.
const KEPT: i64 = 5;
/// Letters of a form's text shown to tell it from the others.
const PREVIEW: usize = 160;
/// The columns of an attachment's row, where it is on its note
/// (`resources`) and where it was taken off it (`kept_resources`).
const ATTACHMENT: &str = "id, note_id, sha256, md5, mime, file_name, size, width, height, duration, recognition_xml, recognition_text, attributes_json, alternate_sha256, position, ocr_state";

impl Library {
    /// Keeps the note as it is stored now and returns the kept form's id.
    /// When the newest kept form is this very form, nothing is added and
    /// its id is returned. A note with nothing in it, as one just made, is
    /// not kept: there is nothing to go back to.
    pub fn keep_note_version(&self, id: &str) -> Result<Option<i64>> {
        let kept = {
            let mut connection = self.connection.lock();
            let transaction = connection.transaction()?;
            let note = note_with(&transaction, id)?;
            let kept = keep(&transaction, &note)?;
            transaction.commit()?;
            kept
        };
        self.let_go_of_attachments(id)?;
        Ok(kept)
    }

    /// The forms kept of a note, the newest first.
    pub fn note_versions(&self, id: &str) -> Result<Vec<NoteVersion>> {
        let connection = self.connection.lock();
        let versions = connection
            .prepare(
                "SELECT id, kept_at, updated_at, title, content_html FROM note_versions
                 WHERE note_id = ?1 ORDER BY id DESC",
            )?
            .query_map([id], |row| {
                let html: String = row.get(4)?;
                Ok(NoteVersion {
                    id: row.get(0)?,
                    kept_at: row.get(1)?,
                    updated_at: row.get(2)?,
                    title: row.get(3)?,
                    preview: crate::enml::plain_text(&html)
                        .chars()
                        .take(PREVIEW)
                        .collect(),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(versions)
    }

    /// Makes a kept form the note again: its title, text, tags, details,
    /// attachments, and the date it was last changed. The note as it is now
    /// is kept first, so that putting a form back can itself be taken back.
    /// The note stays in the notebook it is in.
    pub fn restore_note_version(&self, id: &str, version: i64) -> Result<Note> {
        let note = self.put_back(id, version)?;
        self.let_go_of_attachments(id)?;
        Ok(note)
    }

    fn put_back(&self, id: &str, version: i64) -> Result<Note> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let kept = transaction
            .query_row(
                "SELECT title, content_html, attributes_json, tags_json, updated_at
                 FROM note_versions WHERE id = ?1 AND note_id = ?2",
                params![version, id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| BeverError::NotFound(format!("version {version} of note {id}")))?;
        let (title, content_html, attributes, tags, updated_at) = kept;
        // Read before the note is kept as it is now, which may let this
        // form go as the oldest.
        let had = attachments_of(&transaction, version)?;
        let now = note_with(&transaction, id)?;
        if now.deleted_at.is_some() {
            return Err(BeverError::Invalid(
                "a note in the trash cannot be changed".into(),
            ));
        }
        keep(&transaction, &now)?;
        if let Some(had) = &had {
            for attachment in &now.resources {
                if !had.contains(&attachment.id) {
                    move_attachment(&transaction, &attachment.id, "resources", "kept_resources")?;
                }
            }
            for attachment in had {
                if !now.resources.iter().any(|on| on.id == *attachment) {
                    move_attachment(&transaction, attachment, "kept_resources", "resources")?;
                }
            }
        }
        let attributes: Value = serde_json::from_str(&attributes)?;
        let tags: Vec<String> = serde_json::from_str(&tags)?;
        store_note_form(
            &transaction,
            &NoteForm {
                id,
                notebook_id: None,
                title: &title,
                content_html: &content_html,
                attributes: &attributes,
                tags: &tags,
                updated_at,
            },
        )?;
        let note = note_with(&transaction, id)?;
        transaction.commit()?;
        Ok(note)
    }

    /// Lets go of the attachments that were taken off a note and that no
    /// form kept of it has any more, with their files where no note has
    /// those.
    ///
    /// Files are removed only by whoever has the gate to them, and that is
    /// not waited for here, where the editor waits to save: while a run of
    /// synchronization or an import has it, this is left for the next time
    /// a form of the note is kept.
    fn let_go_of_attachments(&self, note_id: &str) -> Result<()> {
        let any = self
            .connection
            .lock()
            .prepare_cached("SELECT 1 FROM kept_resources WHERE note_id = ?1 LIMIT 1")?
            .exists([note_id])?;
        if !any {
            return Ok(());
        }
        let _sweep = match self.blob_gate.try_write() {
            Ok(gate) => gate,
            Err(TryLockError::Poisoned(gate)) => gate.into_inner(),
            Err(TryLockError::WouldBlock) => return Ok(()),
        };
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let mut had = HashSet::new();
        {
            let mut lists = transaction.prepare(
                "SELECT r.resources_json FROM note_version_resources r
                 JOIN note_versions v ON v.id = r.version_id WHERE v.note_id = ?1",
            )?;
            let mut rows = lists.query([note_id])?;
            while let Some(row) = rows.next()? {
                had.extend(serde_json::from_str::<Vec<String>>(
                    &row.get::<_, String>(0)?,
                )?);
            }
        }
        let taken_off = transaction
            .prepare("SELECT id, sha256, alternate_sha256 FROM kept_resources WHERE note_id = ?1")?
            .query_map([note_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut files = Vec::new();
        for (attachment, sha256, alternate) in taken_off {
            if had.contains(&attachment) {
                continue;
            }
            transaction.execute("DELETE FROM kept_resources WHERE id = ?1", [&attachment])?;
            files.push(sha256);
            files.extend(alternate);
        }
        transaction.commit()?;
        for sha256 in files {
            if !blob_referenced(&connection, &sha256)? {
                self.remove_blob(&sha256)?;
            }
        }
        Ok(())
    }
}

/// The attachments the note had when this form of it was kept, by their
/// identifiers; `None` for a form kept before they were recorded.
fn attachments_of(connection: &Connection, version: i64) -> Result<Option<Vec<String>>> {
    let list = connection
        .query_row(
            "SELECT resources_json FROM note_version_resources WHERE version_id = ?1",
            [version],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(match list {
        Some(list) => Some(serde_json::from_str(&list)?),
        None => None,
    })
}

/// Takes an attachment off its note, or puts it on the note again, as it
/// is: with its place among the others, and the text recognised in it.
fn move_attachment(connection: &Connection, id: &str, from: &str, to: &str) -> Result<()> {
    connection.execute(
        &format!("INSERT INTO {to}({ATTACHMENT}) SELECT {ATTACHMENT} FROM {from} WHERE id = ?1"),
        [id],
    )?;
    connection.execute(&format!("DELETE FROM {from} WHERE id = ?1"), [id])?;
    Ok(())
}

/// Keeps `note` as a form of itself, unless the newest kept form is the
/// same, and lets the oldest forms go. Returns the id of the form that
/// stands for the note as it is, or `None` for a note with nothing in it.
fn keep(connection: &Connection, note: &Note) -> Result<Option<i64>> {
    if note.title.trim().is_empty()
        && note.plain_text.trim().is_empty()
        && note.resources.is_empty()
    {
        return Ok(None);
    }
    let attributes = serde_json::to_string(&note.attributes)?;
    let tags = serde_json::to_string(&note.tags)?;
    let attachments = serde_json::to_string(
        &note
            .resources
            .iter()
            .map(|attachment| attachment.id.as_str())
            .collect::<Vec<_>>(),
    )?;
    let record = |version: i64| {
        connection.execute(
            "INSERT INTO note_version_resources(version_id, resources_json) VALUES (?1, ?2)",
            params![version, attachments],
        )
    };
    let newest = connection
        .query_row(
            "SELECT v.id, v.title = ?2 AND v.content_html = ?3 AND v.attributes_json = ?4 AND v.tags_json = ?5,
                    (SELECT r.resources_json FROM note_version_resources r WHERE r.version_id = v.id)
             FROM note_versions v WHERE v.note_id = ?1 ORDER BY v.id DESC LIMIT 1",
            params![note.id, note.title, note.content_html, attributes, tags],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    match newest {
        Some((id, true, Some(had))) if had == attachments => return Ok(Some(id)),
        // Kept before attachments were recorded, and the note has not been
        // written in since: it is taken to have had the ones the note has.
        Some((id, true, None)) => {
            record(id)?;
            return Ok(Some(id));
        }
        _ => {}
    }
    connection.execute(
        "INSERT INTO note_versions(note_id, kept_at, title, content_html, attributes_json, tags_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            note.id,
            Utc::now().timestamp_millis(),
            note.title,
            note.content_html,
            attributes,
            tags,
            note.updated_at
        ],
    )?;
    let id = connection.last_insert_rowid();
    record(id)?;
    connection.execute(
        "DELETE FROM note_versions WHERE note_id = ?1 AND id NOT IN
            (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY id DESC LIMIT ?2)",
        params![note.id, KEPT],
    )?;
    Ok(Some(id))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::models::{NoteFilter, Resource, SaveNote};

    fn library() -> (tempfile::TempDir, Library) {
        let directory = tempfile::tempdir().unwrap();
        let library = Library::open(directory.path()).unwrap();
        (directory, library)
    }

    fn save(library: &Library, note: &Note, title: &str, html: &str, tags: &[&str]) -> Note {
        library
            .save_note(&SaveNote {
                id: note.id.clone(),
                notebook_id: note.notebook_id.clone(),
                title: title.into(),
                content_html: html.into(),
                attributes: json!({ "author": title }),
                tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
                base_revision: None,
            })
            .unwrap()
    }

    #[test]
    fn a_note_changed_by_mistake_is_put_back_as_it_was() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        save(&library, &note, "Recipe", "<p>Two eggs</p>", &["kitchen"]);
        // Written long ago, as a note that was imported is.
        let dated = library
            .update_note_timestamps(&note.id, 1_000, 2_000)
            .unwrap();

        // The editor keeps the note before its first save of a visit.
        let kept = library.keep_note_version(&note.id).unwrap().unwrap();
        let spoilt = save(&library, &note, "Recipe", "<p>Two eggsxxxx</p>", &[]);
        assert!(spoilt.updated_at > dated.updated_at);

        let restored = library.restore_note_version(&note.id, kept).unwrap();
        assert_eq!(restored.content_html, "<p>Two eggs</p>");
        assert_eq!(restored.plain_text, "Two eggs");
        assert_eq!(restored.tags, ["kitchen"]);
        assert_eq!(restored.attributes, json!({ "author": "Recipe" }));
        // The date it was last changed is the one it had: the note takes
        // its old place in a list ordered by date.
        assert_eq!(restored.updated_at, dated.updated_at);
        assert!(restored.revision > spoilt.revision, "it is sent again");
        // The search finds what is there again, and not what was undone.
        let search = |query: &str| {
            library
                .list_notes(&NoteFilter {
                    query: query.into(),
                    ..NoteFilter::default()
                })
                .unwrap()
                .total
        };
        assert_eq!((search("eggs"), search("eggsxxxx")), (1, 0));

        // Putting a form back kept the spoilt one, so that can be undone.
        let versions = library.note_versions(&note.id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].preview, "Two eggsxxxx");
        assert_eq!(versions[1].id, kept);
    }

    #[test]
    fn the_same_form_is_kept_once_and_only_a_few_forms_are_kept() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        // A note just made has nothing to go back to.
        assert_eq!(library.keep_note_version(&note.id).unwrap(), None);
        save(&library, &note, "Log", "<p>0</p>", &[]);
        let first = library.keep_note_version(&note.id).unwrap();
        assert!(first.is_some());
        assert_eq!(library.keep_note_version(&note.id).unwrap(), first);
        for step in 1..=7 {
            save(&library, &note, "Log", &format!("<p>{step}</p>"), &[]);
            library.keep_note_version(&note.id).unwrap();
        }
        let versions = library.note_versions(&note.id).unwrap();
        let previews = versions
            .iter()
            .map(|version| version.preview.as_str())
            .collect::<Vec<_>>();
        assert_eq!(previews, ["7", "6", "5", "4", "3"]);
    }

    #[test]
    fn kept_forms_go_with_their_note_and_belong_to_it_alone() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let other = library.create_note(None).unwrap();
        save(&library, &note, "One", "<p>one</p>", &[]);
        let kept = library.keep_note_version(&note.id).unwrap().unwrap();
        // A form of one note cannot be put on another.
        assert!(library.restore_note_version(&other.id, kept).is_err());
        // A note in the trash is not changed.
        library.set_note_trashed(&note.id, true).unwrap();
        assert!(library.restore_note_version(&note.id, kept).is_err());
        library.delete_note_permanently(&note.id).unwrap();
        let left: i64 = library
            .connection
            .lock()
            .query_row("SELECT count(*) FROM note_versions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    fn attach(library: &Library, note: &Note, bytes: &[u8], name: &str) -> Resource {
        library
            .add_resource(&note.id, &mut &bytes[..], name, None)
            .unwrap()
    }

    /// The text of a note that shows an attachment.
    fn showing(attachment: &Resource) -> String {
        format!(
            "<p><en-media hash=\"{}\" type=\"image/png\"></en-media></p>",
            attachment.md5
        )
    }

    fn attachments(library: &Library, note: &Note) -> Vec<String> {
        library
            .get_note(&note.id)
            .unwrap()
            .resources
            .into_iter()
            .map(|attachment| attachment.id)
            .collect()
    }

    fn taken_off(library: &Library) -> i64 {
        library
            .connection
            .lock()
            .query_row("SELECT count(*) FROM kept_resources", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn an_attachment_added_since_goes_with_the_change_and_comes_back_with_it() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let picture = attach(&library, &note, b"picture", "picture.png");
        save(&library, &note, "Sketch", &showing(&picture), &[]);

        // Drawn on: the picture with the drawing is another attachment,
        // added before the note is saved with it in the other's place. The
        // editor keeps the note before either.
        let kept = library.keep_note_version(&note.id).unwrap().unwrap();
        let drawn = attach(&library, &note, b"picture, drawn on", "drawn.png");
        save(&library, &note, "Sketch", &showing(&drawn), &[]);
        assert_eq!(
            attachments(&library, &note),
            [picture.id.clone(), drawn.id.clone()]
        );
        // A note that has another attachment is not the form that was kept.
        assert_ne!(library.keep_note_version(&note.id).unwrap(), Some(kept));

        let restored = library.restore_note_version(&note.id, kept).unwrap();
        assert_eq!(restored.content_html, showing(&picture));
        assert_eq!(
            attachments(&library, &note),
            std::slice::from_ref(&picture.id)
        );
        let search = |query: &str| {
            library
                .list_notes(&NoteFilter {
                    query: query.into(),
                    ..NoteFilter::default()
                })
                .unwrap()
                .total
        };
        assert_eq!((search("picture.png"), search("drawn.png")), (1, 0));
        // Its file stays: the note as it was just now is kept, and has it.
        let file = library.blob_path(&drawn.sha256).unwrap();
        assert!(file.exists());
        assert_eq!(taken_off(&library), 1);

        let spoilt = library.note_versions(&note.id).unwrap()[0].id;
        let again = library.restore_note_version(&note.id, spoilt).unwrap();
        assert_eq!(again.content_html, showing(&drawn));
        assert_eq!(
            attachments(&library, &note),
            [picture.id.clone(), drawn.id.clone()]
        );
        let back = &again.resources[1];
        assert_eq!(
            (
                back.sha256.as_str(),
                back.file_name.as_deref(),
                back.position
            ),
            (drawn.sha256.as_str(), Some("drawn.png"), drawn.position)
        );
        assert_eq!((search("drawn.png"), taken_off(&library)), (1, 0));
        // And off again, as often as one likes.
        library.restore_note_version(&note.id, kept).unwrap();
        assert_eq!(attachments(&library, &note), [picture.id]);
    }

    #[test]
    fn an_attachment_no_kept_form_has_is_let_go_with_its_file() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let other = library.create_note(None).unwrap();
        save(&library, &note, "Log", "<p>0</p>", &[]);
        let kept = library.keep_note_version(&note.id).unwrap().unwrap();
        let only = attach(&library, &note, b"only here", "only.txt");
        let shared = attach(&library, &note, b"shared", "shared.txt");
        attach(&library, &other, b"shared", "shared.txt");
        library.restore_note_version(&note.id, kept).unwrap();
        assert!(attachments(&library, &note).is_empty());
        let (only, shared) = (
            library.blob_path(&only.sha256).unwrap(),
            library.blob_path(&shared.sha256).unwrap(),
        );

        // Five forms are kept: the one that had them goes with the fifth after it.
        for step in 1..=5 {
            save(&library, &note, "Log", &format!("<p>{step}</p>"), &[]);
            library.keep_note_version(&note.id).unwrap();
            let held = step < 5;
            assert_eq!(
                (taken_off(&library), only.exists()),
                (2 * held as i64, held)
            );
        }
        assert!(shared.exists(), "another note has it");

        // A note that goes takes what was taken off it along.
        let gone = attach(&library, &other, b"gone", "gone.txt");
        save(&library, &other, "Other", "<p>other</p>", &[]);
        let kept = library.keep_note_version(&other.id).unwrap().unwrap();
        let late = attach(&library, &other, b"late", "late.txt");
        library.restore_note_version(&other.id, kept).unwrap();
        let late = library.blob_path(&late.sha256).unwrap();
        assert!(late.exists());
        library.delete_note_permanently(&other.id).unwrap();
        assert!(!late.exists() && !shared.exists());
        assert!(!library.blob_path(&gone.sha256).unwrap().exists());
        assert_eq!(taken_off(&library), 0);
    }

    #[test]
    fn a_form_kept_before_attachments_were_recorded_leaves_them_alone() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        save(&library, &note, "Old", "<p>old</p>", &[]);
        let kept = library.keep_note_version(&note.id).unwrap().unwrap();
        let forget = || {
            library
                .connection
                .lock()
                .execute("DELETE FROM note_version_resources", [])
                .unwrap()
        };
        assert_eq!(forget(), 1);
        // Not written in since: it is the same form, and is not kept twice.
        assert_eq!(library.keep_note_version(&note.id).unwrap(), Some(kept));
        assert_eq!(forget(), 1);

        let added = attach(&library, &note, b"added", "added.txt");
        save(&library, &note, "Old", "<p>changed</p>", &[]);
        let restored = library.restore_note_version(&note.id, kept).unwrap();
        assert_eq!(restored.content_html, "<p>old</p>");
        assert_eq!(attachments(&library, &note), [added.id]);
    }
}
