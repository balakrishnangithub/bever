//! Note storage: reading, editing, organizing, and importing notes.
//!
//! Notebook, stack, tag, and shortcut management lives in `organize.rs`;
//! attachments and the text-recognition queue live in `resources.rs`.
use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    db::Library,
    enex::EnexNote,
    enml::{enml_to_html, normalized_title, plain_text, recognition_text, rewrite_internal_links},
    error::{BeverError, Result},
    models::{
        LibraryCounts, LibrarySnapshot, Note, NoteFilter, NotePage, Notebook, Resource, SaveNote,
        SavedNote, Shortcut, Stack, Tag,
    },
    organize::{record_tombstone, remove_shortcut},
    resources::mark_ocr_pending,
};

const NOTE_COLUMNS: &str = "id, notebook_id, title, content_html, original_enml, plain_text, created_at, updated_at, deleted_at, attributes_json, evernote_guid, revision";
const RESOURCE_COLUMNS: &str = "id, note_id, sha256, md5, mime, file_name, size, width, height, duration, recognition_xml, recognition_text, attributes_json, alternate_sha256, position";

#[derive(Debug)]
pub enum ImportNoteResult {
    Imported {
        note: Box<Note>,
        /// Images of this note waiting for background text recognition.
        images_queued: u64,
        /// An earlier form of the note is here and was changed here, so
        /// this one was added beside it instead of taking its place.
        kept_both: bool,
    },
    /// An earlier form of the note was here, untouched since it was
    /// imported, and this newer form has taken its place.
    Updated { note: Box<Note>, images_queued: u64 },
    /// The same content was imported before; holds the existing note's id.
    Duplicate(String),
}

impl Library {
    pub fn snapshot(&self) -> Result<LibrarySnapshot> {
        let connection = self.connection.lock();
        let mut stacks = connection.prepare("SELECT id, name, created_at, updated_at, revision FROM stacks ORDER BY name COLLATE NATSORT")?;
        let stacks = stacks
            .query_map([], |row| {
                Ok(Stack {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    revision: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut notebooks = connection.prepare("SELECT id, name, stack_id, created_at, updated_at, revision FROM notebooks ORDER BY name COLLATE NATSORT")?;
        let notebooks = notebooks
            .query_map([], |row| {
                Ok(Notebook {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    stack_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    revision: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut tags = connection.prepare("SELECT id, name, parent_id, color, created_at, updated_at FROM tags ORDER BY name COLLATE NATSORT")?;
        let tags = tags
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    color: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut shortcuts = connection.prepare("SELECT id, target_type, target_id, label, sort_order, created_at FROM shortcuts ORDER BY sort_order, created_at")?;
        let shortcuts = shortcuts
            .query_map([], |row| {
                Ok(Shortcut {
                    id: row.get(0)?,
                    target_type: row.get(1)?,
                    target_id: row.get(2)?,
                    label: row.get(3)?,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(LibrarySnapshot {
            stacks,
            notebooks,
            tags,
            shortcuts,
        })
    }

    /// Number of notes outside the trash per notebook and tag, plus totals.
    pub fn counts(&self) -> Result<LibraryCounts> {
        let connection = self.connection.lock();
        let (all, trash) = connection.query_row(
            "SELECT count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM notes",
            [],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
        )?;
        let notebooks = connection
            .prepare("SELECT notebook_id, count(*) FROM notes WHERE deleted_at IS NULL GROUP BY notebook_id")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)))?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        let tags = connection
            .prepare("SELECT nt.tag_id, count(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id WHERE n.deleted_at IS NULL GROUP BY nt.tag_id")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)))?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        Ok(LibraryCounts {
            all,
            trash,
            notebooks,
            tags,
        })
    }

    pub fn create_note(&self, notebook_id: Option<&str>) -> Result<Note> {
        let connection = self.connection.lock();
        let notebook_id = match notebook_id {
            Some(id) => id.to_owned(),
            None => default_notebook(&connection, None)?,
        };
        let now = Utc::now().timestamp_millis();
        let id = Uuid::new_v4().to_string();
        connection.execute(
            "INSERT INTO notes(id, notebook_id, title, content_html, plain_text, created_at, updated_at, attributes_json) VALUES (?1, ?2, '', '<p></p>', '', ?3, ?3, '{}')",
            params![id, notebook_id, now],
        )?;
        reindex_note(&connection, &id)?;
        note_with(&connection, &id)
    }

    pub fn save_note(&self, input: &SaveNote) -> Result<Note> {
        self.save_note_checked(input).map(|saved| saved.note)
    }

    /// Saves a note and reports whether the version it replaced had to be
    /// preserved as a conflict copy (see [`SaveNote::base_revision`]).
    ///
    /// Saving a note as it already is stored is not a change: nothing is
    /// written, and the note keeps its time of change and its revision. So
    /// whatever makes an editor save without anything having been changed
    /// cannot move a note's date or send it to other devices again.
    pub fn save_note_checked(&self, input: &SaveNote) -> Result<SavedNote> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let stored = note_with(&transaction, &input.id)?;
        let mut tags = (stored.tags.clone(), input.tags.clone());
        tags.0.sort();
        tags.1.sort();
        if stored.notebook_id == input.notebook_id
            && stored.title == input.title.trim()
            && stored.content_html == input.content_html
            && sorted_json(&stored.attributes) == sorted_json(&input.attributes)
            && tags.0 == tags.1
        {
            return Ok(SavedNote {
                note: stored,
                conflict_copy: None,
            });
        }
        let conflict_copy = match input.base_revision {
            Some(base) => preserve_replaced_version(&transaction, input, base)?,
            None => None,
        };
        store_note_form(
            &transaction,
            &NoteForm {
                id: &input.id,
                notebook_id: Some(&input.notebook_id),
                title: &input.title,
                content_html: &input.content_html,
                attributes: &input.attributes,
                tags: &input.tags,
                updated_at: Utc::now().timestamp_millis(),
            },
        )?;
        transaction.commit()?;
        Ok(SavedNote {
            note: note_with(&connection, &input.id)?,
            conflict_copy,
        })
    }

    pub fn move_notes(&self, ids: &[String], notebook_id: &str) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        require_notebook(&transaction, notebook_id)?;
        let now = Utc::now().timestamp_millis();
        let mut moved = 0;
        for id in ids {
            let changed = transaction.execute(
                "UPDATE notes SET notebook_id = ?2, updated_at = ?3, revision = revision + 1, dirty = 1 WHERE id = ?1",
                params![id, notebook_id, now],
            )?;
            if changed == 0 {
                return Err(BeverError::NotFound(format!("note {id}")));
            }
            moved += 1;
        }
        transaction.commit()?;
        Ok(moved)
    }

    pub fn copy_notes(&self, ids: &[String], notebook_id: &str) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        // Copies reference the originals' blobs; cleanup must not interleave.
        let _blobs = self.blob_guard();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        require_notebook(&transaction, notebook_id)?;
        for id in ids {
            let original = note_with(&transaction, id)?;
            let now = Utc::now().timestamp_millis();
            let mut copy = original.clone();
            copy.id = Uuid::new_v4().to_string();
            copy.notebook_id = notebook_id.to_owned();
            let title = original.title.trim();
            copy.title = format!(
                "{} (copy)",
                if title.is_empty() { "Untitled" } else { title }
            );
            copy.created_at = now;
            copy.updated_at = now;
            copy.deleted_at = None;
            copy.evernote_guid = None;
            copy.revision = 1;
            for resource in &mut copy.resources {
                resource.id = Uuid::new_v4().to_string();
                resource.note_id = copy.id.clone();
            }
            insert_note(&transaction, &copy)?;
            mark_ocr_pending(&transaction, &copy.id)?;
        }
        transaction.commit()?;
        Ok(ids.len() as u64)
    }

    pub fn add_tags_to_notes(&self, ids: &[String], tags: &[String]) -> Result<u64> {
        if ids.is_empty() || tags.is_empty() {
            return Ok(0);
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let tag_ids = tags
            .iter()
            .map(|name| ensure_tag_with(&transaction, name))
            .collect::<Result<Vec<_>>>()?;
        let now = Utc::now().timestamp_millis();
        let mut changed_notes = 0;
        for id in ids {
            require_note(&transaction, id)?;
            let mut changed = false;
            for tag_id in &tag_ids {
                changed |= transaction.execute(
                    "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1, ?2)",
                    params![id, tag_id],
                )? > 0;
            }
            if changed {
                touch_note(&transaction, id, now)?;
                changed_notes += 1;
            }
        }
        transaction.commit()?;
        Ok(changed_notes)
    }

    /// Removes the named tags from the notes; tags a note lacks are ignored.
    /// Returns the number of notes that changed.
    pub fn remove_tags_from_notes(&self, ids: &[String], tags: &[String]) -> Result<u64> {
        if ids.is_empty() || tags.is_empty() {
            return Ok(0);
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let mut tag_ids = Vec::new();
        for name in tags {
            let mut statement =
                transaction.prepare("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE")?;
            let found = statement
                .query_map([name.trim()], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            tag_ids.extend(found);
        }
        let now = Utc::now().timestamp_millis();
        let mut changed_notes = 0;
        for id in ids {
            require_note(&transaction, id)?;
            let mut changed = false;
            for tag_id in &tag_ids {
                changed |= transaction.execute(
                    "DELETE FROM note_tags WHERE note_id = ?1 AND tag_id = ?2",
                    params![id, tag_id],
                )? > 0;
            }
            if changed {
                touch_note(&transaction, id, now)?;
                changed_notes += 1;
            }
        }
        transaction.commit()?;
        Ok(changed_notes)
    }

    pub fn update_note_timestamps(
        &self,
        id: &str,
        created_at: i64,
        updated_at: i64,
    ) -> Result<Note> {
        if created_at < 0 || updated_at < created_at {
            return Err(BeverError::Invalid(
                "updated time must be at or after created time".into(),
            ));
        }
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE notes SET created_at = ?2, updated_at = ?3, revision = revision + 1, dirty = 1 WHERE id = ?1",
            params![id, created_at, updated_at],
        )?;
        if changed == 0 {
            return Err(BeverError::NotFound(format!("note {id}")));
        }
        note_with(&connection, id)
    }

    pub fn set_note_trashed(&self, id: &str, trashed: bool) -> Result<()> {
        let changed = self.set_notes_trashed(std::slice::from_ref(&id.to_owned()), trashed)?;
        if changed == 0 {
            return Err(BeverError::NotFound(format!("note {id}")));
        }
        Ok(())
    }

    /// Moves notes into or out of the trash. Unknown ids are ignored.
    pub fn set_notes_trashed(&self, ids: &[String], trashed: bool) -> Result<u64> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let deleted_at = trashed.then(|| Utc::now().timestamp_millis());
        let mut changed = 0;
        for id in ids {
            changed += transaction.execute(
                "UPDATE notes SET deleted_at = ?2, revision = revision + 1, dirty = 1 WHERE id = ?1",
                params![id, deleted_at],
            )? as u64;
        }
        transaction.commit()?;
        Ok(changed)
    }

    pub fn delete_note_permanently(&self, id: &str) -> Result<()> {
        self.delete_notes_permanently(std::slice::from_ref(&id.to_owned()))?;
        Ok(())
    }

    /// Deletes notes for good, leaves tombstones so the deletion reaches other
    /// devices, and removes attachment files nothing references any more.
    pub fn delete_notes_permanently(&self, ids: &[String]) -> Result<u64> {
        self.purge_notes(ids, true)
    }

    pub fn empty_trash(&self) -> Result<u64> {
        let ids = {
            let connection = self.connection.lock();
            let ids = connection
                .prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL")?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids
        };
        self.delete_notes_permanently(&ids)
    }

    pub fn get_note(&self, id: &str) -> Result<Note> {
        let connection = self.connection.lock();
        note_with(&connection, id)
    }

    pub fn all_notes(&self) -> Result<Vec<Note>> {
        let connection = self.connection.lock();
        let ids = connection
            .prepare("SELECT id FROM notes ORDER BY created_at")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.iter().map(|id| note_with(&connection, id)).collect()
    }

    /// Ids of the notes outside the trash, oldest first, optionally limited
    /// to one notebook. Used to export without loading every note at once.
    /// The notes of a notebook, or of the library, that are not in the
    /// trash, in the order they came into it. For notes that were imported
    /// that is the order of the export they came from, so that exporting
    /// them again writes them in that order.
    pub fn note_ids(&self, notebook_id: Option<&str>) -> Result<Vec<String>> {
        let connection = self.connection.lock();
        let ids = connection
            .prepare("SELECT id FROM notes WHERE deleted_at IS NULL AND (?1 IS NULL OR notebook_id = ?1) ORDER BY rowid")?
            .query_map([notebook_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    pub fn list_notes(&self, filter: &NoteFilter) -> Result<NotePage> {
        crate::search::search_notes(self, filter)
    }

    /// Marks the beginning of an import, for [`Library::import_enex_note`]:
    /// what the records of imported notes say now, before the run adds to
    /// them.
    pub fn import_run_mark(&self) -> Result<i64> {
        let connection = self.connection.lock();
        Ok(connection.query_row(
            "SELECT COALESCE(MAX(rowid), 0) FROM import_sources",
            [],
            |row| row.get(0),
        )?)
    }

    /// Imports one note. `run_mark` is [`Library::import_run_mark`] taken
    /// when the import it belongs to began: a note that this same import
    /// brought is not taken for an earlier form of another.
    pub fn import_enex_note(
        &self,
        imported: EnexNote,
        notebook_id: &str,
        run_mark: i64,
    ) -> Result<ImportNoteResult> {
        self.import_note_form(imported, notebook_id, run_mark, ImportForm::default())
    }

    /// Imports a note read from the Evernote application's own files, whole
    /// or (`partial`) without attachments that could not be had. There a
    /// note's identifier is its own and what is read is what Evernote has
    /// now. So a note that is here under that identifier, and was not
    /// changed here, is brought to what Evernote has whatever the times of
    /// the two say: Evernote changes tags, and sometimes a time, without
    /// the note becoming later.
    pub fn import_local_note(
        &self,
        imported: EnexNote,
        notebook_id: &str,
        run_mark: i64,
        partial: bool,
    ) -> Result<ImportNoteResult> {
        self.import_note_form(
            imported,
            notebook_id,
            run_mark,
            ImportForm {
                partial,
                identified: true,
            },
        )
    }

    /// Imports a note some of whose attachments could not be had: its text
    /// names them, and they are not among its resources. Such a form is
    /// imported where the library has none of the note, and takes the place
    /// of an earlier one only where that loses nothing; it never stands
    /// beside another form of the note. The whole note, imported later,
    /// takes its place.
    pub fn import_enex_note_partial(
        &self,
        imported: EnexNote,
        notebook_id: &str,
        run_mark: i64,
    ) -> Result<ImportNoteResult> {
        self.import_note_form(
            imported,
            notebook_id,
            run_mark,
            ImportForm {
                partial: true,
                identified: false,
            },
        )
    }

    fn import_note_form(
        &self,
        imported: EnexNote,
        notebook_id: &str,
        run_mark: i64,
        form: ImportForm,
    ) -> Result<ImportNoteResult> {
        let partial = form.partial;
        let reading = imported.earlier;
        let note_id = Uuid::new_v4().to_string();
        let resources = imported
            .resources
            .into_iter()
            .enumerate()
            .map(|(position, resource)| {
                let file_name = resource
                    .attributes
                    .get("file-name")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Resource {
                    id: Uuid::new_v4().to_string(),
                    note_id: note_id.clone(),
                    sha256: resource.blob.sha256,
                    md5: resource.blob.md5,
                    mime: resource.mime,
                    file_name,
                    size: resource.blob.size,
                    width: resource.width,
                    height: resource.height,
                    duration: resource.duration,
                    recognition_text: resource.recognition_xml.as_deref().map(recognition_text),
                    recognition_xml: resource.recognition_xml,
                    attributes: resource.attributes,
                    alternate_sha256: resource.alternate.map(|blob| blob.sha256),
                    position: position as i64,
                }
            })
            .collect();
        let html = enml_to_html(&imported.content);
        let note = Note {
            id: note_id,
            notebook_id: notebook_id.to_owned(),
            title: imported.title,
            plain_text: plain_text(&html),
            content_html: html,
            original_enml: Some(imported.content),
            created_at: imported.created_at,
            updated_at: imported.updated_at,
            deleted_at: None,
            attributes: imported.attributes,
            evernote_guid: imported.evernote_guid,
            revision: 1,
            tags: imported.tags,
            resources,
        };
        let import_key = note_import_key(&note)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        // Up to 1.1.3 a note's marks were part of its key.
        for key in [Some(import_key.clone()), marked_import_key(&note)?]
            .into_iter()
            .flatten()
        {
            let duplicate = transaction
                .query_row(
                    "SELECT note_id FROM import_sources WHERE import_key = ?1",
                    [&key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(existing) = duplicate {
                return Ok(ImportNoteResult::Duplicate(existing));
            }
        }
        // Here as an earlier version of Bever read it, under another title
        // or without its tasks? Then it is this note, and reading it better
        // is no second note.
        if let Some(reading) = reading {
            let mut read_then = note.clone();
            read_then.title = reading.title;
            read_then.original_enml = Some(reading.content);
            read_then.attributes = reading.attributes;
            let then_key = note_import_key(&read_then)?;
            let here = transaction
                .query_row(
                    "SELECT note_id FROM import_sources WHERE import_key = ?1",
                    [&then_key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(here) = here {
                let earlier = note_with(&transaction, &here)?;
                if note_import_key(&earlier)? == then_key {
                    let note = replace_imported(&transaction, &earlier, note, &import_key)?;
                    let images_queued = mark_ocr_pending(&transaction, &note.id)?;
                    transaction.commit()?;
                    return Ok(ImportNoteResult::Updated {
                        note: Box::new(note),
                        images_queued,
                    });
                }
                // Changed here since. What was written here stays; this
                // form is on record as that note's, and a title that is
                // still the one it was given then is put right.
                transaction.execute(
                    "INSERT OR IGNORE INTO import_sources(import_key, note_id, imported_at) VALUES (?1, ?2, ?3)",
                    params![import_key, earlier.id, Utc::now().timestamp_millis()],
                )?;
                let retitled = earlier.title == read_then.title && earlier.title != note.title;
                if retitled {
                    transaction.execute(
                        "UPDATE notes SET title = ?2, revision = revision + 1, dirty = 1 WHERE id = ?1",
                        params![earlier.id, note.title],
                    )?;
                    title_shortcut(&transaction, &earlier.id, &note.title)?;
                    reindex_note(&transaction, &earlier.id)?;
                }
                let kept = note_with(&transaction, &earlier.id)?;
                transaction.commit()?;
                return Ok(if retitled {
                    ImportNoteResult::Updated {
                        note: Box::new(kept),
                        images_queued: 0,
                    }
                } else {
                    ImportNoteResult::Duplicate(kept.id)
                });
            }
        }
        // Not here in this form. Where an earlier form of the same note is,
        // importing again is how changes made in Evernote arrive: the newer
        // form takes the earlier one's place, provided nothing was changed
        // in it here. A note changed in both places is kept in both forms.
        let mut kept_both = false;
        if let Some(earlier_id) = earlier_form(&transaction, &note, run_mark)? {
            let earlier = note_with(&transaction, &earlier_id)?;
            let untouched = [
                Some(note_import_key(&earlier)?),
                marked_import_key(&earlier)?,
            ]
            .into_iter()
            .flatten()
            .map(|key| {
                transaction
                    .prepare("SELECT 1 FROM import_sources WHERE note_id = ?1 AND import_key = ?2")?
                    .exists(params![earlier.id, key])
            })
            .collect::<std::result::Result<Vec<_>, _>>()?
            .contains(&true);
            // Whether this form has every attachment the earlier one has.
            let keeps_all = earlier.resources.iter().all(|had| {
                note.resources
                    .iter()
                    .any(|has| has.md5.eq_ignore_ascii_case(&had.md5))
            });
            // The same text with attachments the earlier form lacks: the
            // note, whole or more nearly whole, that was imported while
            // Evernote did not have all of it.
            let completes = keeps_all
                && note.resources.len() > earlier.resources.len()
                && note.original_enml == earlier.original_enml;
            if partial && (!untouched || !keeps_all) {
                // A form with parts missing is not put beside a note that
                // was changed here, nor in place of one that has more.
                return Ok(ImportNoteResult::Duplicate(earlier.id));
            }
            if !untouched {
                kept_both = true;
            } else if note.updated_at > earlier.updated_at
                || completes
                || (form.identified && !partial)
            {
                let note = replace_imported(&transaction, &earlier, note, &import_key)?;
                let images_queued = mark_ocr_pending(&transaction, &note.id)?;
                transaction.commit()?;
                return Ok(ImportNoteResult::Updated {
                    note: Box::new(note),
                    images_queued,
                });
            } else if note.updated_at < earlier.updated_at || partial {
                // An older form than the one that is here, from an export
                // made before it: the newer one stays. So does the one that
                // is here when this is no more than the same note with
                // parts missing.
                return Ok(ImportNoteResult::Duplicate(earlier.id));
            }
            // Changed at the same moment and not the same: two notes that
            // only look like one, as some exports have them. Both are kept.
        }
        insert_note(&transaction, &note)?;
        let images_queued = mark_ocr_pending(&transaction, &note.id)?;
        transaction.execute(
            "INSERT INTO import_sources(import_key, note_id, imported_at) VALUES (?1, ?2, ?3)",
            params![import_key, note.id, Utc::now().timestamp_millis()],
        )?;
        transaction.commit()?;
        Ok(ImportNoteResult::Imported {
            note: Box::new(note),
            images_queued,
            kept_both,
        })
    }

    /// Points Evernote note links at notes in this library and returns how
    /// many links changed. Safe to repeat: links whose target arrives with a
    /// later import are resolved then.
    pub fn rewrite_import_links(&self) -> Result<u64> {
        let mut connection = self.connection.lock();
        let candidates = connection
            .prepare(
                "SELECT id, content_html FROM notes
                 WHERE content_html LIKE '%evernote:///view/%' OR content_html LIKE '%evernote.com/shard/%' OR content_html LIKE '%evernote.com/l/%'",
            )?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if candidates.is_empty() {
            return Ok(0);
        }
        let by_guid = connection
            .prepare("SELECT lower(evernote_guid), id FROM notes WHERE evernote_guid IS NOT NULL")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        // A title identifies a note only while it is unique.
        let mut by_title: HashMap<String, Option<String>> = HashMap::new();
        {
            let mut statement = connection
                .prepare("SELECT title, id FROM notes WHERE deleted_at IS NULL AND title != ''")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let title = normalized_title(&row.get::<_, String>(0)?);
                let id: String = row.get(1)?;
                by_title
                    .entry(title)
                    .and_modify(|existing| *existing = None)
                    .or_insert(Some(id));
            }
        }
        let resolve = |guid: Option<&str>, text: &str| {
            guid.and_then(|guid| by_guid.get(guid).cloned())
                .or_else(|| by_title.get(text).cloned().flatten())
        };
        let transaction = connection.transaction()?;
        let mut resolved = 0;
        for (id, html) in candidates {
            let (rewritten, changed) = rewrite_internal_links(&html, &resolve);
            if changed > 0 {
                transaction.execute(
                    "UPDATE notes SET content_html = ?2, revision = revision + 1, dirty = 1 WHERE id = ?1",
                    params![id, rewritten],
                )?;
                resolved += changed as u64;
            }
        }
        transaction.commit()?;
        Ok(resolved)
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        let connection = self.connection.lock();
        Ok(connection
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Removes notes and whatever only they referenced. `leave_tombstones` is
    /// false when the deletion itself arrived from another device.
    pub(crate) fn purge_notes(&self, ids: &[String], leave_tombstones: bool) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let _blobs = self.blob_sweep();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let now = Utc::now().timestamp_millis();
        let mut blobs = Vec::new();
        let mut deleted = 0;
        for id in ids {
            {
                let mut statement = transaction
                    .prepare("SELECT sha256, alternate_sha256 FROM resources WHERE note_id = ?1")?;
                let mut rows = statement.query([id])?;
                while let Some(row) = rows.next()? {
                    blobs.push(row.get::<_, String>(0)?);
                    blobs.extend(row.get::<_, Option<String>>(1)?);
                }
            }
            unindex_note(&transaction, id)?;
            let removed = transaction.execute("DELETE FROM notes WHERE id = ?1", [id])?;
            if removed == 0 && !leave_tombstones {
                continue;
            }
            deleted += removed as u64;
            remove_shortcut(&transaction, "note", id, now, leave_tombstones)?;
            if leave_tombstones {
                record_tombstone(&transaction, "note", id, now)?;
            }
        }
        transaction.commit()?;
        blobs.sort();
        blobs.dedup();
        for sha256 in blobs {
            let referenced = connection
                .prepare_cached(
                    "SELECT 1 FROM resources WHERE sha256 = ?1 OR alternate_sha256 = ?1 LIMIT 1",
                )?
                .exists([&sha256])?;
            if !referenced {
                self.remove_blob(&sha256)?;
            }
        }
        Ok(deleted)
    }
}

/// What the editor changes of a note, as it is to be stored.
pub(crate) struct NoteForm<'a> {
    pub id: &'a str,
    /// `None` leaves the note in the notebook it is in.
    pub notebook_id: Option<&'a str>,
    pub title: &'a str,
    pub content_html: &'a str,
    pub attributes: &'a Value,
    pub tags: &'a [String],
    pub updated_at: i64,
}

/// Stores a form of a note in place of the one that is there: its text,
/// title, details and tags, with the index and the note's shortcut
/// following. The note counts as changed and is synchronized again.
pub(crate) fn store_note_form(connection: &Connection, form: &NoteForm) -> Result<()> {
    let plain_text = plain_text(form.content_html);
    let title = form.title.trim();
    let changed = connection.execute(
        "UPDATE notes SET notebook_id = COALESCE(?2, notebook_id), title = ?3, content_html = ?4, plain_text = ?5, attributes_json = ?6, updated_at = ?7, revision = revision + 1, dirty = 1 WHERE id = ?1",
        params![
            form.id,
            form.notebook_id,
            title,
            form.content_html,
            plain_text,
            serde_json::to_string(form.attributes)?,
            form.updated_at,
        ],
    )?;
    if changed == 0 {
        return Err(BeverError::NotFound(format!("note {}", form.id)));
    }
    connection.execute("DELETE FROM note_tags WHERE note_id = ?1", [form.id])?;
    for name in form.tags {
        let tag_id = ensure_tag_with(connection, name)?;
        connection.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1, ?2)",
            params![form.id, tag_id],
        )?;
    }
    // A shortcut shows the note's title, so it follows a rename.
    connection.execute(
        "UPDATE shortcuts SET label = ?2 WHERE target_type = 'note' AND target_id = ?1",
        params![form.id, if title.is_empty() { "Untitled" } else { title }],
    )?;
    reindex_note(connection, form.id)
}

/// Keeps the stored version of a note as a separate note when it is not the
/// version the editor started from and its body differs from what is being
/// saved. Returns the title of the copy.
fn preserve_replaced_version(
    connection: &Connection,
    input: &SaveNote,
    base_revision: i64,
) -> Result<Option<String>> {
    let stored = match note_with(connection, &input.id) {
        Ok(note) => note,
        Err(BeverError::NotFound(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    if stored.revision == base_revision || stored.content_html == input.content_html {
        return Ok(None);
    }
    let mut copy = stored.clone();
    copy.id = Uuid::new_v4().to_string();
    let title = if stored.title.is_empty() {
        "Untitled"
    } else {
        &stored.title
    };
    copy.title = format!("{title} (conflict copy)");
    copy.revision = 1;
    copy.evernote_guid = None;
    for resource in &mut copy.resources {
        resource.id = Uuid::new_v4().to_string();
        resource.note_id = copy.id.clone();
    }
    insert_note(connection, &copy)?;
    mark_ocr_pending(connection, &copy.id)?;
    Ok(Some(copy.title))
}

pub(crate) fn normalized_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        Err(BeverError::Invalid("name cannot be empty".into()))
    } else if name.chars().count() > 255 {
        Err(BeverError::Invalid(
            "name cannot exceed 255 characters".into(),
        ))
    } else {
        Ok(name)
    }
}

/// The notebook new and displaced notes go to: "Inbox" when it exists,
/// otherwise the first by name. `except` leaves one notebook out.
pub(crate) fn default_notebook(connection: &Connection, except: Option<&str>) -> Result<String> {
    connection
        .query_row(
            "SELECT id FROM notebooks WHERE (?1 IS NULL OR id != ?1) ORDER BY name = 'Inbox' COLLATE NOCASE DESC, name COLLATE NOCASE LIMIT 1",
            [except],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| BeverError::NotFound("default notebook".into()))
}

pub(crate) fn require_notebook(connection: &Connection, id: &str) -> Result<()> {
    let exists = connection
        .prepare_cached("SELECT 1 FROM notebooks WHERE id = ?1")?
        .exists([id])?;
    if exists {
        Ok(())
    } else {
        Err(BeverError::NotFound(format!("notebook {id}")))
    }
}

pub(crate) fn require_note(connection: &Connection, id: &str) -> Result<()> {
    let exists = connection
        .prepare_cached("SELECT 1 FROM notes WHERE id = ?1")?
        .exists([id])?;
    if exists {
        Ok(())
    } else {
        Err(BeverError::NotFound(format!("note {id}")))
    }
}

/// Records a change to a note's tags or membership and refreshes its index.
pub(crate) fn touch_note(connection: &Connection, id: &str, now: i64) -> Result<()> {
    connection.execute(
        "UPDATE notes SET updated_at = ?2, revision = revision + 1, dirty = 1 WHERE id = ?1",
        params![id, now],
    )?;
    reindex_note(connection, id)
}

/// Finds a tag by name, whatever its parent, or creates a top-level one.
pub(crate) fn ensure_tag_with(connection: &Connection, name: &str) -> Result<String> {
    let name = normalized_name(name)?;
    if let Some(id) = connection
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE ORDER BY parent_id IS NULL DESC LIMIT 1",
            [name],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp_millis();
    connection.execute(
        "INSERT INTO tags(id, name, parent_id, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?3)",
        params![id, name, now],
    )?;
    Ok(id)
}

pub(crate) fn insert_note(connection: &Connection, note: &Note) -> Result<()> {
    connection.execute(
        "INSERT INTO notes(id, notebook_id, title, content_html, original_enml, plain_text, created_at, updated_at, deleted_at, attributes_json, evernote_guid, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            note.id,
            note.notebook_id,
            note.title,
            note.content_html,
            note.original_enml,
            note.plain_text,
            note.created_at,
            note.updated_at,
            note.deleted_at,
            serde_json::to_string(&note.attributes)?,
            note.evernote_guid,
            note.revision,
        ],
    )?;
    for tag in &note.tags {
        if tag.trim().is_empty() {
            continue;
        }
        let tag_id = ensure_tag_with(connection, tag)?;
        connection.execute(
            "INSERT OR IGNORE INTO note_tags(note_id, tag_id) VALUES (?1, ?2)",
            params![note.id, tag_id],
        )?;
    }
    for resource in &note.resources {
        insert_resource(connection, resource)?;
    }
    reindex_note(connection, &note.id)?;
    Ok(())
}

pub(crate) fn insert_resource(connection: &Connection, resource: &Resource) -> Result<()> {
    connection.execute(
        "INSERT INTO resources(id, note_id, sha256, md5, mime, file_name, size, width, height, duration, recognition_xml, recognition_text, attributes_json, alternate_sha256, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            resource.id,
            resource.note_id,
            resource.sha256,
            resource.md5,
            resource.mime,
            resource.file_name,
            resource.size,
            resource.width,
            resource.height,
            resource.duration,
            resource.recognition_xml,
            resource.recognition_text,
            serde_json::to_string(&resource.attributes)?,
            resource.alternate_sha256,
            resource.position,
        ],
    )?;
    Ok(())
}

pub(crate) fn note_with(connection: &Connection, id: &str) -> Result<Note> {
    let sql = format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1");
    let mut note = connection
        .prepare_cached(&sql)?
        .query_row([id], |row| {
            let attributes: String = row.get(9)?;
            Ok(Note {
                id: row.get(0)?,
                notebook_id: row.get(1)?,
                title: row.get(2)?,
                content_html: row.get(3)?,
                original_enml: row.get(4)?,
                plain_text: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                deleted_at: row.get(8)?,
                attributes: serde_json::from_str(&attributes).unwrap_or_else(|_| json!({})),
                evernote_guid: row.get(10)?,
                revision: row.get(11)?,
                tags: Vec::new(),
                resources: Vec::new(),
            })
        })
        .optional()?
        .ok_or_else(|| BeverError::NotFound(format!("note {id}")))?;
    note.tags = tags_for_note(connection, id)?;
    note.resources = resources_for_note(connection, id)?;
    Ok(note)
}

/// The note in the library that `note` is a later form of: the one with
/// its Evernote identifier, or, where one of the two has no identifier (a
/// current export gives none), the one imported note with its title and its
/// time of creation, neither of which changes when a note's text does.
/// `None` when there is no such note or more than one.
fn earlier_form(connection: &Connection, note: &Note, run_mark: i64) -> Result<Option<String>> {
    // A note this run brought is another note, whatever it shares.
    let one = |ids: Vec<String>| -> Result<Option<String>> {
        if ids.len() != 1 {
            return Ok(None);
        }
        let of_this_run = connection
            .prepare("SELECT 1 FROM import_sources WHERE note_id = ?1 AND rowid > ?2")?
            .exists(params![ids[0], run_mark])?;
        Ok((!of_this_run).then(|| ids[0].clone()))
    };
    if let Some(guid) = &note.evernote_guid {
        let ids = connection
            .prepare("SELECT id FROM notes WHERE evernote_guid = ?1 COLLATE NOCASE LIMIT 2")?
            .query_map([guid], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if !ids.is_empty() {
            return one(ids);
        }
    }
    let ids = connection
        .prepare(
            "SELECT n.id FROM notes n
             WHERE n.created_at = ?1 AND n.title = ?2
               AND (n.evernote_guid IS NULL OR ?3 IS NULL)
               AND EXISTS (SELECT 1 FROM import_sources s WHERE s.note_id = n.id)
             LIMIT 2",
        )?
        .query_map(
            params![note.created_at, note.title, note.evernote_guid],
            |row| row.get::<_, String>(0),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    one(ids)
}

/// Puts `note` in the place of `earlier`: the same note in the library, in
/// the notebook it is in now, with what was imported of it before still on
/// record, so that neither form is imported again.
fn replace_imported(
    connection: &Connection,
    earlier: &Note,
    mut note: Note,
    import_key: &str,
) -> Result<Note> {
    let imports = connection
        .prepare("SELECT import_key, imported_at FROM import_sources WHERE note_id = ?1")?
        .query_map([&earlier.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    // Text this device recognised in pictures that are still in the note.
    let recognised = connection
        .prepare("SELECT sha256, recognition_text, ocr_state, recognition_xml FROM resources WHERE note_id = ?1 AND ocr_state IN (2, 3)")?
        .query_map([&earlier.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    note.id = earlier.id.clone();
    note.notebook_id = earlier.notebook_id.clone();
    note.deleted_at = earlier.deleted_at;
    note.revision = earlier.revision + 1;
    if note.evernote_guid.is_none() {
        note.evernote_guid = earlier.evernote_guid.clone();
    }
    for resource in &mut note.resources {
        resource.note_id = note.id.clone();
    }
    unindex_note(connection, &note.id)?;
    connection.execute("DELETE FROM notes WHERE id = ?1", [&note.id])?;
    // A note newly inserted is marked as changed, which is what sends this
    // form to the other devices.
    insert_note(connection, &note)?;
    title_shortcut(connection, &note.id, &note.title)?;
    let now = Utc::now().timestamp_millis();
    for (key, imported_at) in imports {
        connection.execute(
            "INSERT OR IGNORE INTO import_sources(import_key, note_id, imported_at) VALUES (?1, ?2, ?3)",
            params![key, note.id, imported_at],
        )?;
    }
    connection.execute(
        "INSERT OR IGNORE INTO import_sources(import_key, note_id, imported_at) VALUES (?1, ?2, ?3)",
        params![import_key, note.id, now],
    )?;
    let mut restored = false;
    for (sha256, text, state, xml) in recognised {
        let changed = connection.execute(
            "UPDATE resources SET recognition_text = ?3, ocr_state = ?4, recognition_xml = ?5
             WHERE note_id = ?1 AND sha256 = ?2 AND recognition_text IS NULL AND recognition_xml IS NULL",
            params![note.id, sha256, text, state, xml],
        )?;
        restored |= changed > 0;
    }
    if restored {
        reindex_note(connection, &note.id)?;
    }
    Ok(note)
}

/// A shortcut shows its note's title, so it follows the title.
fn title_shortcut(connection: &Connection, note_id: &str, title: &str) -> Result<()> {
    let title = title.trim();
    connection.execute(
        "UPDATE shortcuts SET label = ?2 WHERE target_type = 'note' AND target_id = ?1",
        params![note_id, if title.is_empty() { "Untitled" } else { title }],
    )?;
    Ok(())
}

/// How a note that is being imported is to be taken.
#[derive(Debug, Clone, Copy, Default)]
struct ImportForm {
    /// Some of its attachments could not be had.
    partial: bool,
    /// Its identifier is its own and no other note's, and it is what
    /// Evernote has now: it comes from Evernote's files, not from an export.
    identified: bool,
}

/// Identifies imported content: the same note exported twice has the same
/// key, and so has a note read from the Evernote application's own files.
/// Those say two things more than a current export does, Evernote's
/// identifier for the note and the text it recognised in pictures; neither
/// is part of the key, or the same note would be imported twice.
///
/// What is said about a note without being part of it, its marks, is not in
/// the key: a note that was only pinned, or given another thumbnail, is
/// still the note that was imported.
fn note_import_key(note: &Note) -> Result<String> {
    import_key_with(note, &crate::marks::without_marks(&note.attributes))
}

/// The key of a note that has marks as it was made up to 1.1.3, when the
/// marks were part of it. A library has such keys where a note was imported
/// from an export that Bever itself had written.
fn marked_import_key(note: &Note) -> Result<Option<String>> {
    crate::marks::has_marks(&note.attributes)
        .then(|| import_key_with(note, &note.attributes))
        .transpose()
}

fn import_key_with(note: &Note, attributes: &Value) -> Result<String> {
    let mut tags = note.tags.clone();
    tags.sort_by_key(|tag| tag.to_lowercase());
    let resources = note
        .resources
        .iter()
        .map(|resource| {
            json!({
                "sha256": resource.sha256,
                "md5": resource.md5,
                "mime": resource.mime,
                "fileName": resource.file_name,
                "size": resource.size,
                "width": resource.width,
                "height": resource.height,
                "duration": resource.duration,
                "attributes": resource.attributes,
                "alternateSha256": resource.alternate_sha256,
                "position": resource.position,
            })
        })
        .collect::<Vec<_>>();
    let fingerprint = json!({
        "originalEnml": note.original_enml,
        "title": note.title,
        "createdAt": note.created_at,
        "updatedAt": note.updated_at,
        "attributes": attributes,
        "tags": tags,
        "resources": resources,
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&sorted_json(&fingerprint))?);
    Ok(format!("{:x}", hasher.finalize()))
}

/// `value` with the names in every object in the order of the alphabet.
///
/// Attributes are kept in the order they came in, which is the order an
/// export writes them in again. What identifies a note must not depend on
/// that order.
pub(crate) fn sorted_json(value: &Value) -> Value {
    match value {
        Value::Object(entries) => {
            let mut names = entries.keys().collect::<Vec<_>>();
            names.sort();
            Value::Object(
                names
                    .into_iter()
                    .map(|name| (name.clone(), sorted_json(&entries[name])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted_json).collect()),
        other => other.clone(),
    }
}

/// A note's tags in the order they were put on it, which for an imported
/// note is the order its export has them in.
pub(crate) fn tags_for_note(connection: &Connection, note_id: &str) -> Result<Vec<String>> {
    Ok(connection
        .prepare_cached("SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ?1 ORDER BY nt.rowid")?
        .query_map([note_id], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

pub(crate) fn resources_for_note(connection: &Connection, note_id: &str) -> Result<Vec<Resource>> {
    let sql =
        format!("SELECT {RESOURCE_COLUMNS} FROM resources WHERE note_id = ?1 ORDER BY position");
    Ok(connection
        .prepare_cached(&sql)?
        .query_map([note_id], |row| {
            let attributes: String = row.get(12)?;
            Ok(Resource {
                id: row.get(0)?,
                note_id: row.get(1)?,
                sha256: row.get(2)?,
                md5: row.get(3)?,
                mime: row.get(4)?,
                file_name: row.get(5)?,
                size: row.get(6)?,
                width: row.get(7)?,
                height: row.get(8)?,
                duration: row.get(9)?,
                recognition_xml: row.get(10)?,
                recognition_text: row.get(11)?,
                attributes: serde_json::from_str(&attributes).unwrap_or_else(|_| json!({})),
                alternate_sha256: row.get(13)?,
                position: row.get(14)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

/// What the index holds of a note: the columns of its row, and where they
/// are read from. The tags are in the order they were put on the note, with
/// [`TAG_DIVIDER`] between them.
pub(crate) const INDEX_ROW: &str = "n.id, n.title, nb.name,
    COALESCE((SELECT group_concat(name, char(31)) FROM
        (SELECT t.name AS name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = n.id ORDER BY nt.rowid)), ''),
    n.plain_text,
    COALESCE((SELECT group_concat(COALESCE(r.file_name, '') || ' ' || COALESCE(r.recognition_text, ''), ' ')
        FROM resources r WHERE r.note_id = n.id), '')
 FROM notes n JOIN notebooks nb ON nb.id = n.notebook_id";

/// What stands between a note's tags in the index: no letter, so that the
/// index reads the tags as words apart, and one a name does not have, so
/// that the tags can be told from each other again.
pub(crate) const TAG_DIVIDER: &str = "\u{1f}";

/// Puts a note into the index as it is now, in place of what the index had
/// of it.
pub(crate) fn reindex_note(connection: &Connection, note_id: &str) -> Result<()> {
    unindex_note(connection, note_id)?;
    let indexed = connection
        .prepare_cached(&format!(
            "INSERT INTO notes_fts(note_id, title, notebook, tags, body, resources)
             SELECT {INDEX_ROW} WHERE n.id = ?1"
        ))?
        .execute([note_id])?;
    if indexed == 0 {
        return Err(BeverError::NotFound(format!("note {note_id}")));
    }
    connection
        .prepare_cached(
            "INSERT INTO note_index(note_id, fts_row) VALUES (?1, last_insert_rowid())",
        )?
        .execute([note_id])?;
    Ok(())
}

/// Takes a note out of the index.
pub(crate) fn unindex_note(connection: &Connection, note_id: &str) -> Result<()> {
    connection
        .prepare_cached(
            "DELETE FROM notes_fts WHERE rowid = (SELECT fts_row FROM note_index WHERE note_id = ?1)",
        )?
        .execute([note_id])?;
    connection
        .prepare_cached("DELETE FROM note_index WHERE note_id = ?1")?
        .execute([note_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What identifies an imported note must not change with the version:
    /// a library records it for every note it imported, and a note whose
    /// record no longer answers is imported a second time.
    #[test]
    fn the_record_of_an_imported_note_is_the_same_in_every_version() {
        let note = Note {
            id: "note".into(),
            notebook_id: "notebook".into(),
            title: "A title".into(),
            content_html: "<p>Text</p>".into(),
            original_enml: Some("<en-note><div>Text</div></en-note>".into()),
            plain_text: "Text".into(),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_100_000,
            deleted_at: None,
            // Not in the order of the alphabet, as an export has them.
            attributes: serde_json::from_str(
                r#"{"source-url":"https://example.com/?a=1&b=2","author":"Ada","application-data":{"zeta":"1","alpha":"2"}}"#,
            )
            .unwrap(),
            evernote_guid: Some("guid".into()),
            revision: 7,
            tags: vec!["zebra".into(), "Apple".into()],
            resources: vec![Resource {
                id: "resource".into(),
                note_id: "note".into(),
                sha256: "sha".into(),
                md5: "md5".into(),
                mime: "image/png".into(),
                file_name: Some("picture.png".into()),
                size: 12,
                width: Some(3),
                height: Some(4),
                duration: None,
                recognition_xml: None,
                recognition_text: None,
                attributes: serde_json::from_str(
                    r#"{"file-name":"picture.png","source-url":"en-cache://x","application-data":{"evernote.captionState":"a","evernote.caption":"b"}}"#,
                )
                .unwrap(),
                alternate_sha256: None,
                position: 0,
            }],
        };
        assert_eq!(
            note_import_key(&note).unwrap(),
            "2f59bd55f62bacef4bd74a79680e8dc51e6ee54ed04a9caabff44b0befc2efa3"
        );
    }
}
