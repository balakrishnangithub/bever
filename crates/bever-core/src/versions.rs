//! Earlier forms of a note, kept on this device.
//!
//! The editor saves by itself, so a change made by mistake is stored like
//! any other. Before the first save of each visit to a note, the editor
//! asks for the note to be kept as it is; a few such forms are held for
//! each note, and any of them can be put back. They are not synchronized
//! and not exported: they are this device's memory of what was here.
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{Note, NoteVersion},
    repository::{note_with, store_note_form, NoteForm},
};

/// Forms kept of one note; the oldest makes way for a new one.
const KEPT: i64 = 5;
/// Letters of a form's text shown to tell it from the others.
const PREVIEW: usize = 160;

impl Library {
    /// Keeps the note as it is stored now and returns the kept form's id.
    /// When the newest kept form is this very form, nothing is added and
    /// its id is returned. A note with nothing in it, as one just made, is
    /// not kept: there is nothing to go back to.
    pub fn keep_note_version(&self, id: &str) -> Result<Option<i64>> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let note = note_with(&transaction, id)?;
        let kept = keep(&transaction, &note)?;
        transaction.commit()?;
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
    /// and the date it was last changed. The note as it is now is kept
    /// first, so that putting a form back can itself be taken back. The
    /// note stays in the notebook it is in.
    pub fn restore_note_version(&self, id: &str, version: i64) -> Result<Note> {
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
        let now = note_with(&transaction, id)?;
        if now.deleted_at.is_some() {
            return Err(BeverError::Invalid(
                "a note in the trash cannot be changed".into(),
            ));
        }
        keep(&transaction, &now)?;
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
    let newest = connection
        .query_row(
            "SELECT id, title = ?2 AND content_html = ?3 AND attributes_json = ?4 AND tags_json = ?5
             FROM note_versions WHERE note_id = ?1 ORDER BY id DESC LIMIT 1",
            params![note.id, note.title, note.content_html, attributes, tags],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?;
    if let Some((id, true)) = newest {
        return Ok(Some(id));
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
    use crate::models::{NoteFilter, SaveNote};

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
}
