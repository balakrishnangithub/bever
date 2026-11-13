//! Attachments and the background text-recognition queue.
use std::{io::Read, path::Path};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use uuid::Uuid;

use crate::{
    db::Library,
    error::{BeverError, Result},
    models::Resource,
    ocr::Recognized,
    repository::{insert_resource, reindex_note, require_note, resources_for_note},
};

/// Largest image handed to text recognition; larger ones would take minutes.
pub const OCR_MAX_BYTES: u64 = 40 * 1024 * 1024;

/// `resources.ocr_state` values.
const OCR_PENDING: i64 = 1;
const OCR_DONE: i64 = 2;
const OCR_FAILED: i64 = 3;

impl Library {
    /// Stores an attachment for a note without changing the note's content;
    /// the caller places the matching `<en-media>` element where it belongs.
    /// Attaching identical bytes to the same note again returns the existing
    /// attachment.
    pub fn add_resource(
        &self,
        note_id: &str,
        reader: &mut impl Read,
        file_name: &str,
        mime: Option<&str>,
    ) -> Result<Resource> {
        let _blobs = self.blob_guard();
        let stored = self.store_blob_reader(reader)?;
        let file_name = match file_name.trim() {
            "" => "attachment",
            name => name,
        };
        let mime = mime
            .map(str::trim)
            .filter(|mime| !mime.is_empty() && *mime != "application/octet-stream")
            .map(str::to_owned)
            .unwrap_or_else(|| {
                mime_guess::from_path(file_name)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_owned()
            });
        let (width, height) = if mime.starts_with("image/") {
            image::ImageReader::open(self.blob_path(&stored.sha256)?)
                .ok()
                .and_then(|reader| reader.with_guessed_format().ok())
                .and_then(|reader| reader.into_dimensions().ok())
                .map_or((None, None), |(width, height)| (Some(width), Some(height)))
        } else {
            (None, None)
        };

        let mut connection = self.connection.lock().expect("database mutex poisoned");
        let transaction = connection.transaction()?;
        require_note(&transaction, note_id)?;
        let existing = resources_for_note(&transaction, note_id)?
            .into_iter()
            .find(|resource| resource.sha256 == stored.sha256);
        if let Some(existing) = existing {
            return Ok(existing);
        }
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM resources WHERE note_id = ?1",
            [note_id],
            |row| row.get(0),
        )?;
        let resource = Resource {
            id: Uuid::new_v4().to_string(),
            note_id: note_id.to_owned(),
            sha256: stored.sha256,
            md5: stored.md5,
            mime,
            file_name: Some(file_name.to_owned()),
            size: stored.size,
            width,
            height,
            duration: None,
            recognition_xml: None,
            recognition_text: None,
            attributes: json!({ "file-name": file_name }),
            alternate_sha256: None,
            position,
        };
        insert_resource(&transaction, &resource)?;
        mark_ocr_pending(&transaction, note_id)?;
        transaction.execute(
            "UPDATE notes SET updated_at = ?2, revision = revision + 1, dirty = 1 WHERE id = ?1",
            params![note_id, Utc::now().timestamp_millis()],
        )?;
        reindex_note(&transaction, note_id)?;
        transaction.commit()?;
        Ok(resource)
    }

    /// Attaches a file from disk. See [`Library::add_resource`].
    pub fn attach_file(&self, note_id: &str, path: impl AsRef<Path>) -> Result<Resource> {
        let path = path.as_ref();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment");
        let mut file = std::fs::File::open(path)?;
        self.add_resource(note_id, &mut file, file_name, None)
    }

    pub fn resource(&self, id: &str) -> Result<Resource> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        let note_id = connection
            .query_row("SELECT note_id FROM resources WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .ok_or_else(|| BeverError::NotFound(format!("resource {id}")))?;
        resources_for_note(&connection, &note_id)?
            .into_iter()
            .find(|resource| resource.id == id)
            .ok_or_else(|| BeverError::NotFound(format!("resource {id}")))
    }

    /// Finds an attachment by the hash an `<en-media>` element carries (MD5)
    /// or by its SHA-256.
    pub fn resource_location(&self, md5_or_sha: &str) -> Result<Resource> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        let note_id = connection
            .query_row(
                "SELECT note_id FROM resources WHERE md5 = ?1 OR sha256 = ?1 ORDER BY position LIMIT 1",
                [md5_or_sha],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| BeverError::NotFound(format!("resource {md5_or_sha}")))?;
        let resources = resources_for_note(&connection, &note_id)?;
        resources
            .into_iter()
            .find(|resource| resource.md5 == md5_or_sha || resource.sha256 == md5_or_sha)
            .ok_or_else(|| BeverError::NotFound(format!("resource {md5_or_sha}")))
    }

    /// Number of distinct images waiting for text recognition.
    pub fn ocr_pending(&self) -> Result<u64> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        Ok(connection.query_row(
            "SELECT count(DISTINCT sha256) FROM resources WHERE ocr_state = ?1",
            [OCR_PENDING],
            |row| row.get(0),
        )?)
    }

    /// SHA-256 of the next image to recognise, if any.
    pub fn next_ocr_job(&self) -> Result<Option<String>> {
        let connection = self.connection.lock().expect("database mutex poisoned");
        Ok(connection
            .query_row(
                "SELECT sha256 FROM resources WHERE ocr_state = ?1 LIMIT 1",
                [OCR_PENDING],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Records the outcome for every attachment with these bytes and makes
    /// the text searchable. `found` is `None` when the image has no text;
    /// `recognised` is false when recognition failed and should not be retried.
    ///
    /// The note's revision is left alone: recognised text is derived data, and
    /// treating it as a user edit could produce conflict copies during sync.
    pub fn finish_ocr(
        &self,
        sha256: &str,
        found: Option<&Recognized>,
        recognised: bool,
    ) -> Result<()> {
        let mut connection = self.connection.lock().expect("database mutex poisoned");
        let transaction = connection.transaction()?;
        let notes = transaction
            .prepare("SELECT DISTINCT note_id FROM resources WHERE sha256 = ?1 AND ocr_state = ?2")?
            .query_map(params![sha256, OCR_PENDING], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        transaction.execute(
            "UPDATE resources SET recognition_text = ?2, recognition_xml = ?5, ocr_state = ?3 WHERE sha256 = ?1 AND ocr_state = ?4",
            params![
                sha256,
                found.map(|found| found.text.as_str()),
                if recognised { OCR_DONE } else { OCR_FAILED },
                OCR_PENDING,
                found.map(|found| found.xml.as_str()),
            ],
        )?;
        for note in &notes {
            reindex_note(&transaction, note)?;
            // The text is new to other devices, but it is not a user edit.
            crate::sync::mark_needs_push(&transaction, note)?;
        }
        transaction.commit()?;
        Ok(())
    }
}

/// Queues a note's images for text recognition and returns how many were
/// queued. Images that already carry Evernote recognition data are left
/// alone, and text already recognised for identical bytes is reused.
pub(crate) fn mark_ocr_pending(connection: &Connection, note_id: &str) -> Result<u64> {
    const ELIGIBLE: &str =
        "note_id = ?1 AND ocr_state = 0 AND recognition_xml IS NULL AND recognition_text IS NULL
         AND mime IN ('image/png', 'image/jpeg', 'image/webp')";
    let reused = connection.execute(
        &format!(
            "UPDATE resources SET ocr_state = {OCR_DONE},
                 recognition_text = (SELECT known.recognition_text FROM resources known
                                     WHERE known.sha256 = resources.sha256 AND known.ocr_state = {OCR_DONE} LIMIT 1),
                 recognition_xml = (SELECT known.recognition_xml FROM resources known
                                    WHERE known.sha256 = resources.sha256 AND known.ocr_state = {OCR_DONE} LIMIT 1)
             WHERE {ELIGIBLE}
               AND EXISTS(SELECT 1 FROM resources known
                          WHERE known.sha256 = resources.sha256 AND known.ocr_state = {OCR_DONE})"
        ),
        [note_id],
    )?;
    if reused > 0 {
        reindex_note(connection, note_id)?;
    }
    let queued = connection.execute(
        &format!("UPDATE resources SET ocr_state = {OCR_PENDING} WHERE {ELIGIBLE} AND size <= ?2"),
        params![note_id, OCR_MAX_BYTES],
    )?;
    Ok(queued as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NoteFilter;

    fn library() -> (tempfile::TempDir, Library) {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
        (directory, library)
    }

    /// A minimal valid 1×1 PNG.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn attaching_leaves_the_note_content_alone() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let resource = library
            .add_resource(&note.id, &mut &b"%PDF-1.4 test"[..], "report.pdf", None)
            .unwrap();
        assert_eq!(resource.mime, "application/pdf");
        assert_eq!(resource.file_name.as_deref(), Some("report.pdf"));
        let saved = library.get_note(&note.id).unwrap();
        assert_eq!(saved.content_html, note.content_html);
        assert_eq!(saved.resources.len(), 1);
        assert_eq!(saved.revision, note.revision + 1);
        // The file name is searchable straight away.
        let found = library
            .list_notes(&NoteFilter {
                query: "report".into(),
                ..NoteFilter::default()
            })
            .unwrap();
        assert_eq!(found.total, 1);
    }

    #[test]
    fn identical_bytes_attached_twice_share_one_attachment() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let first = library
            .add_resource(&note.id, &mut &b"same"[..], "a.txt", None)
            .unwrap();
        let second = library
            .add_resource(&note.id, &mut &b"same"[..], "b.txt", None)
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(library.get_note(&note.id).unwrap().resources.len(), 1);
        assert!(library
            .add_resource("missing", &mut &b"x"[..], "a.txt", None)
            .is_err());
    }

    #[test]
    fn images_are_measured_and_queued_for_recognition() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let image = library
            .add_resource(&note.id, &mut &PNG[..], "pixel.png", Some("image/png"))
            .unwrap();
        assert_eq!((image.width, image.height), (Some(1), Some(1)));
        library
            .add_resource(&note.id, &mut &b"plain"[..], "notes.txt", None)
            .unwrap();
        assert_eq!(library.ocr_pending().unwrap(), 1);
        assert_eq!(library.next_ocr_job().unwrap(), Some(image.sha256.clone()));

        let words = Recognized {
            text: "invoice total".into(),
            xml: "<recoIndex objWidth=\"1\" objHeight=\"1\"><item x=\"0\" y=\"0\" w=\"1\" h=\"1\"><t w=\"80\">invoice</t></item></recoIndex>".into(),
        };
        let revision = library.get_note(&note.id).unwrap().revision;
        library
            .finish_ocr(&image.sha256, Some(&words), true)
            .unwrap();
        assert_eq!(library.ocr_pending().unwrap(), 0);
        assert_eq!(library.next_ocr_job().unwrap(), None);
        let recognised = library.get_note(&note.id).unwrap();
        assert_eq!(
            recognised.resources[0].recognition_text.as_deref(),
            Some("invoice total")
        );
        assert_eq!(
            recognised.resources[0].recognition_xml.as_deref(),
            Some(words.xml.as_str())
        );
        assert_eq!(recognised.revision, revision);
        let found = library
            .list_notes(&NoteFilter {
                query: "invoice".into(),
                ..NoteFilter::default()
            })
            .unwrap();
        assert_eq!(found.total, 1);

        // The same image in another note reuses the recognised text.
        let other = library.create_note(None).unwrap();
        library
            .add_resource(&other.id, &mut &PNG[..], "copy.png", Some("image/png"))
            .unwrap();
        assert_eq!(library.ocr_pending().unwrap(), 0);
        let copy = &library.get_note(&other.id).unwrap().resources[0];
        assert_eq!(copy.recognition_text.as_deref(), Some("invoice total"));
        assert_eq!(copy.recognition_xml.as_deref(), Some(words.xml.as_str()));
    }

    /// A PNG of one colour, `width` by `height`.
    fn picture(width: u32, height: u32, shade: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::RgbImage::from_pixel(width, height, image::Rgb([shade, 90, 40]))
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn a_note_is_shown_by_its_largest_picture_or_the_one_chosen() {
        use crate::models::{SaveNote, THUMBNAIL_KEY};

        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let listed = |library: &Library| {
            library.list_notes(&NoteFilter::default()).unwrap().notes[0]
                .thumbnail
                .clone()
        };
        assert_eq!(listed(&library), None, "a note without pictures has none");

        let attach = |name: &str, bytes: &[u8]| {
            library
                .add_resource(&note.id, &mut &bytes[..], name, Some("image/png"))
                .unwrap()
        };
        let icon = attach("icon.png", &picture(16, 16, 10));
        let small = attach("small.png", &picture(60, 60, 20));
        let large = attach("large.png", &picture(200, 120, 30));
        let save = |library: &Library, shown: &[&Resource], chosen: Option<&str>| {
            let stored = library.get_note(&note.id).unwrap();
            let body = shown
                .iter()
                .map(|resource| {
                    format!(
                        "<en-media hash=\"{}\" type=\"image/png\"></en-media>",
                        resource.md5
                    )
                })
                .collect::<String>();
            let mut attributes = stored.attributes.clone();
            match chosen {
                Some(md5) => attributes["application-data"] = json!({ THUMBNAIL_KEY: md5 }),
                None => {
                    attributes
                        .as_object_mut()
                        .unwrap()
                        .remove("application-data");
                }
            }
            library
                .save_note(&SaveNote {
                    id: stored.id,
                    notebook_id: stored.notebook_id,
                    title: "Pictures".into(),
                    content_html: format!("<p>{body}</p>"),
                    attributes,
                    tags: Vec::new(),
                    base_revision: None,
                })
                .unwrap();
        };

        // Attached, but not in the note's content: not the note's picture.
        assert_eq!(listed(&library), None);
        save(&library, &[&icon, &small, &large], None);
        assert_eq!(listed(&library), Some(large.sha256.clone()));
        // An icon is not a picture of the note, even when it is all there is.
        save(&library, &[&icon], None);
        assert_eq!(listed(&library), None);
        // The picture chosen for the note stands for it, whatever its size.
        save(&library, &[&icon, &small, &large], Some(&small.md5));
        assert_eq!(listed(&library), Some(small.sha256.clone()));
        save(&library, &[&icon, &small, &large], Some(&icon.md5));
        assert_eq!(listed(&library), Some(icon.sha256.clone()));
        // Once it is taken out of the note, the largest one does again.
        save(&library, &[&small, &large], Some(&icon.md5));
        assert_eq!(listed(&library), Some(large.sha256.clone()));

        // The small picture is made once, and goes when the attachment goes.
        let made = library.thumbnail(&large.sha256).unwrap();
        let decoded = image::load_from_memory(&made).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (200, 120));
        let kept = library
            .blob_dir()
            .join("thumbnails")
            .join(format!("{}.jpg", large.sha256));
        assert_eq!(std::fs::read(&kept).unwrap(), made);
        assert_eq!(library.thumbnail(&large.sha256).unwrap(), made);
        assert!(library.thumbnail("../../outside").is_err());
        library
            .delete_notes_permanently(std::slice::from_ref(&note.id))
            .unwrap();
        assert!(!kept.exists());
        assert!(library.thumbnail(&large.sha256).is_err());
    }

    #[test]
    fn failed_recognition_is_not_retried() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        let image = library
            .add_resource(&note.id, &mut &PNG[..], "pixel.png", Some("image/png"))
            .unwrap();
        library.finish_ocr(&image.sha256, None, false).unwrap();
        assert_eq!(library.ocr_pending().unwrap(), 0);
        assert_eq!(library.next_ocr_job().unwrap(), None);
    }

    #[test]
    fn permanent_deletion_frees_blobs_nothing_else_uses() {
        let (_directory, library) = library();
        let first = library.create_note(None).unwrap();
        let second = library.create_note(None).unwrap();
        let shared = library
            .add_resource(&first.id, &mut &b"shared"[..], "shared.txt", None)
            .unwrap();
        library
            .add_resource(&second.id, &mut &b"shared"[..], "shared.txt", None)
            .unwrap();
        let only = library
            .add_resource(&first.id, &mut &b"only here"[..], "only.txt", None)
            .unwrap();
        let shared_path = library.blob_path(&shared.sha256).unwrap();
        let only_path = library.blob_path(&only.sha256).unwrap();
        assert!(shared_path.exists() && only_path.exists());

        library.toggle_shortcut("note", &first.id, "First").unwrap();
        library.set_note_trashed(&first.id, true).unwrap();
        assert_eq!(library.empty_trash().unwrap(), 1);
        assert!(shared_path.exists(), "still used by the second note");
        assert!(!only_path.exists(), "no longer referenced");
        assert!(library.get_note(&first.id).is_err());
        assert!(library.snapshot().unwrap().shortcuts.is_empty());

        library.delete_note_permanently(&second.id).unwrap();
        assert!(!shared_path.exists());
        // Deleting again is harmless.
        assert_eq!(
            library
                .delete_notes_permanently(std::slice::from_ref(&second.id))
                .unwrap(),
            0
        );
    }
}
