//! What is said about a note without being part of it: which picture stands
//! for it in a list, and whether it is pinned to the top of its notebook.
//!
//! Both are kept among the note's attributes, under `application-data`, so
//! they go wherever the note goes: to other devices with synchronization,
//! and into an export. Setting one is not an edit of the note. Its time of
//! change stays as it is, and an import still knows the note as the one it
//! brought: a note that only had its picture chosen or was pinned here has
//! not been changed here.
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{Note, ThumbnailChoice, AUTOMATIC_THUMBNAIL, NO_THUMBNAIL, PINNED_KEY, THUMBNAIL_KEY},
    repository::note_with,
};

const KEYS: [&str; 2] = [THUMBNAIL_KEY, PINNED_KEY];
const DATA: &str = "application-data";
/// The setting that holds the marks an import has offered before.
const OFFERED: &str = "import.marks-offered";

/// What another application says about one of its notes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignMarks {
    pub evernote_guid: String,
    /// The picture chosen for the note, by its MD5; empty when the note is
    /// to have none.
    pub thumbnail: Option<String>,
    /// The note's place among those pinned to its notebook: a later one was
    /// pinned later, and stands further up.
    pub pinned: Option<i64>,
}

/// A mark of a note's attributes, if it has that one.
pub(crate) fn mark<'a>(attributes: &'a Value, key: &str) -> Option<&'a str> {
    attributes.get(DATA)?.get(key)?.as_str()
}

/// `attributes` with a mark set, or taken away.
pub(crate) fn with_mark(attributes: &Value, key: &str, value: Option<&str>) -> Value {
    let mut attributes = match attributes {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let mut data = match attributes.get(DATA) {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    match value {
        Some(value) => {
            data.insert(key.to_owned(), Value::String(value.to_owned()));
        }
        None => {
            data.remove(key);
        }
    }
    if data.is_empty() {
        attributes.remove(DATA);
    } else {
        attributes.insert(DATA.to_owned(), Value::Object(data));
    }
    Value::Object(attributes)
}

/// `attributes` as they are without any mark: what the note itself has.
pub(crate) fn without_marks(attributes: &Value) -> Value {
    KEYS.iter().fold(attributes.clone(), |attributes, key| {
        if mark(&attributes, key).is_some() {
            with_mark(&attributes, key, None)
        } else {
            attributes
        }
    })
}

pub(crate) fn has_marks(attributes: &Value) -> bool {
    KEYS.iter().any(|key| mark(attributes, key).is_some())
}

/// The mark that pins a note to a notebook, at a place among its pinned.
fn pin(notebook_id: &str, place: i64) -> String {
    format!("{notebook_id} {place}")
}

/// Whether a pin is one to the notebook the note is in. A note that was
/// moved is not pinned where it went, and is pinned again where it was when
/// it comes back.
fn pinned_in(attributes: &Value, notebook_id: &str) -> bool {
    mark(attributes, PINNED_KEY)
        .and_then(|pin| pin.strip_prefix(notebook_id))
        .is_some_and(|rest| rest.starts_with(' '))
}

const PIN_SQL: &str = "json_extract(n.attributes_json, '$.\"application-data\".\"bever.pinned\"')";
const CHOSEN_SQL: &str =
    "json_extract(n.attributes_json, '$.\"application-data\".\"bever.thumbnail\"')";

/// For a note `n`: its place among the notes pinned to the notebook it is
/// in, or NULL when it is not pinned there.
pub(crate) fn pin_place_sql() -> String {
    format!(
        "CASE WHEN substr({PIN_SQL}, 1, length(n.notebook_id) + 1) = n.notebook_id || ' '
              THEN CAST(substr({PIN_SQL}, length(n.notebook_id) + 2) AS INTEGER) END"
    )
}

/// For a note `n`: the SHA-256 of the picture that stands for it in a list,
/// or NULL when it has none.
///
/// The choice made here comes first: a picture, or none at all. Then the
/// choice an export of Evernote carries, which is the note's `thumbnail`
/// attribute, empty when the thumbnail was removed there. A chosen picture
/// counts while it is still in the note. Otherwise it is the largest
/// picture in the note that is more than an icon. A picture taken out of a
/// note stays among its attachments, so the note's content is asked whether
/// it still shows it.
pub(crate) fn thumbnail_sql() -> String {
    let picture = |md5: &str| {
        format!(
            "(SELECT r.sha256 FROM resources r
               WHERE r.note_id = n.id AND r.mime LIKE 'image/%' AND r.md5 = {md5}
                 AND instr(n.content_html, r.md5) > 0
               LIMIT 1)"
        )
    };
    let exported = "json_extract(n.attributes_json, '$.thumbnail')";
    format!(
        "CASE
           WHEN {CHOSEN_SQL} = '{NO_THUMBNAIL}' THEN NULL
           WHEN {CHOSEN_SQL} IS NULL AND {exported} = '' THEN NULL
           ELSE COALESCE(
             {chosen},
             CASE WHEN {CHOSEN_SQL} IS NULL THEN {from_export} END,
             (SELECT r.sha256 FROM resources r
               WHERE r.note_id = n.id AND r.mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
                 AND (r.width IS NULL OR r.height IS NULL OR (r.width >= 48 AND r.height >= 48))
                 AND instr(n.content_html, r.md5) > 0
               ORDER BY COALESCE(r.width, 0) * COALESCE(r.height, 0) DESC, r.position
               LIMIT 1))
         END",
        chosen = picture(CHOSEN_SQL),
        from_export = picture(exported),
    )
}

/// Sets or takes away a mark of a stored note. Returns whether anything
/// changed. The note is marked for synchronization; its time of change is
/// left alone.
fn write_mark(
    connection: &Connection,
    note_id: &str,
    key: &str,
    value: Option<&str>,
) -> Result<bool> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT attributes_json FROM notes WHERE id = ?1",
            [note_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored) = stored else {
        return Err(BeverError::NotFound(format!("note {note_id}")));
    };
    let attributes: Value = serde_json::from_str(&stored)?;
    if mark(&attributes, key) == value {
        return Ok(false);
    }
    connection.execute(
        "UPDATE notes SET attributes_json = ?2, revision = revision + 1, dirty = 1 WHERE id = ?1",
        params![
            note_id,
            serde_json::to_string(&with_mark(&attributes, key, value))?
        ],
    )?;
    Ok(true)
}

impl Library {
    /// Chooses the picture that stands for a note in a list: one of its
    /// own, none, or the one found for it.
    pub fn set_thumbnail(&self, note_id: &str, choice: &ThumbnailChoice) -> Result<Note> {
        let connection = self.connection.lock();
        let note = note_with(&connection, note_id)?;
        let value = match choice {
            ThumbnailChoice::Picture(md5) => {
                if !note
                    .resources
                    .iter()
                    .any(|resource| resource.md5.eq_ignore_ascii_case(md5))
                {
                    return Err(BeverError::Invalid(
                        "the picture is not one of the note's".into(),
                    ));
                }
                Some(md5.as_str())
            }
            ThumbnailChoice::None => Some(NO_THUMBNAIL),
            // Where the note came with a choice of its own, "the one found
            // for it" has to be said; elsewhere it is what no mark means.
            ThumbnailChoice::Automatic if note.attributes.get("thumbnail").is_some() => {
                Some(AUTOMATIC_THUMBNAIL)
            }
            ThumbnailChoice::Automatic => None,
        };
        write_mark(&connection, note_id, THUMBNAIL_KEY, value)?;
        note_with(&connection, note_id)
    }

    /// Pins notes to the top of the notebook each is in, or takes them
    /// down. Returns how many changed. The one pinned last stands first.
    pub fn set_pinned(&self, note_ids: &[String], pinned: bool) -> Result<u64> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let now = Utc::now().timestamp_millis();
        let mut changed = 0;
        for (index, id) in note_ids.iter().enumerate() {
            let stored: Option<(String, String)> = transaction
                .query_row(
                    "SELECT notebook_id, attributes_json FROM notes WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((notebook_id, attributes)) = stored else {
                return Err(BeverError::NotFound(format!("note {id}")));
            };
            let is_pinned = pinned_in(&serde_json::from_str(&attributes)?, &notebook_id);
            let value = match (pinned, is_pinned) {
                (true, false) => Some(pin(&notebook_id, now + index as i64)),
                (false, _) => None,
                (true, true) => continue,
            };
            changed += u64::from(write_mark(&transaction, id, PINNED_KEY, value.as_deref())?);
        }
        transaction.commit()?;
        Ok(changed)
    }

    /// Gives notes that came from another application the marks they have
    /// there. Each mark is offered once: one that was changed or taken away
    /// here afterwards is not brought back by importing again, while a mark
    /// that has changed there is offered anew. A mark of a note that is not
    /// here is kept for when the note is. Returns how many thumbnails and
    /// how many pins were set.
    pub fn offer_marks(&self, marks: &[ForeignMarks]) -> Result<(u64, u64)> {
        if marks.is_empty() {
            return Ok((0, 0));
        }
        let mut offered: Vec<String> = self
            .setting(OFFERED)?
            .and_then(|offered| serde_json::from_str(&offered).ok())
            .unwrap_or_default();
        let before = offered.len();
        let (mut thumbnails, mut pins) = (0, 0);
        {
            let mut connection = self.connection.lock();
            let transaction = connection.transaction()?;
            // Just under the present, in their order: a note pinned here
            // from now on stands above those that came pinned.
            let base = Utc::now().timestamp_millis() - 100_000;
            for marks in marks {
                let here: Option<(String, String, String)> = transaction
                    .query_row(
                        "SELECT id, notebook_id, attributes_json FROM notes
                         WHERE evernote_guid = ?1 COLLATE NOCASE AND deleted_at IS NULL
                         ORDER BY updated_at DESC LIMIT 1",
                        [&marks.evernote_guid],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((id, notebook_id, attributes)) = here else {
                    continue;
                };
                let attributes: Value = serde_json::from_str(&attributes)?;
                if let Some(thumbnail) = &marks.thumbnail {
                    let offer = format!("{} thumbnail {thumbnail}", marks.evernote_guid);
                    if !offered.contains(&offer) {
                        offered.push(offer);
                        if mark(&attributes, THUMBNAIL_KEY).is_none() {
                            let value = if thumbnail.is_empty() {
                                NO_THUMBNAIL
                            } else {
                                thumbnail
                            };
                            thumbnails += u64::from(write_mark(
                                &transaction,
                                &id,
                                THUMBNAIL_KEY,
                                Some(value),
                            )?);
                        }
                    }
                }
                if let Some(place) = marks.pinned {
                    let offer = format!("{} pinned", marks.evernote_guid);
                    if !offered.contains(&offer) {
                        offered.push(offer);
                        if !pinned_in(&attributes, &notebook_id) {
                            pins += u64::from(write_mark(
                                &transaction,
                                &id,
                                PINNED_KEY,
                                Some(&pin(&notebook_id, base + place)),
                            )?);
                        }
                    }
                }
            }
            transaction.commit()?;
        }
        if offered.len() != before {
            self.set_setting(OFFERED, &serde_json::to_string(&offered)?)?;
        }
        Ok((thumbnails, pins))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::models::{NoteFilter, SaveNote};

    fn library() -> (tempfile::TempDir, Library) {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
        (directory, library)
    }

    fn titled(library: &Library, notebook: Option<&str>, title: &str) -> Note {
        let note = library.create_note(notebook).unwrap();
        library
            .save_note(&SaveNote {
                id: note.id,
                notebook_id: note.notebook_id,
                title: title.into(),
                content_html: "<p>Body</p>".into(),
                attributes: json!({}),
                tags: Vec::new(),
                base_revision: None,
            })
            .unwrap()
    }

    fn listed(library: &Library, notebook: Option<&str>) -> Vec<(String, bool)> {
        library
            .list_notes(&NoteFilter {
                notebook_id: notebook.map(str::to_owned),
                ..NoteFilter::default()
            })
            .unwrap()
            .notes
            .into_iter()
            .map(|note| (note.title, note.pinned))
            .collect()
    }

    #[test]
    fn saving_a_note_as_it_is_stored_changes_nothing() {
        let (_directory, library) = library();
        let note = titled(&library, None, "Same");
        let pending = |library: &Library| -> i64 {
            library
                .connection
                .lock()
                .query_row("SELECT count(*) FROM notes WHERE dirty != 0", [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        library
            .connection
            .lock()
            .execute("UPDATE notes SET dirty = 0", [])
            .unwrap();
        let save = |title: &str, body: &str, tags: &[&str]| {
            library
                .save_note(&SaveNote {
                    id: note.id.clone(),
                    notebook_id: note.notebook_id.clone(),
                    title: title.into(),
                    content_html: body.into(),
                    attributes: json!({}),
                    tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
                    base_revision: Some(note.revision),
                })
                .unwrap()
        };
        // An editor that saves although nothing was changed, as when only
        // the cursor was moved: the note is what it was, to its time.
        let again = save(" Same ", "<p>Body</p>", &[]);
        assert_eq!(
            (again.revision, again.updated_at),
            (note.revision, note.updated_at)
        );
        assert_eq!(pending(&library), 0, "nothing to send to other devices");
        // Anything that differs is a change.
        std::thread::sleep(std::time::Duration::from_millis(3));
        let changed = save("Same", "<p>Body.</p>", &[]);
        assert_eq!(changed.revision, note.revision + 1);
        assert!(changed.updated_at > note.updated_at);
        assert_eq!(pending(&library), 1);
        let tagged = save("Same", "<p>Body.</p>", &["b", "a"]);
        assert_eq!(tagged.revision, note.revision + 2);
        // The same tags in another order are the same tags.
        let reordered = save("Same", "<p>Body.</p>", &["a", "b"]);
        assert_eq!(reordered.revision, tagged.revision);
    }

    #[test]
    fn an_export_that_says_which_thumbnail_or_none_is_believed() {
        use base64::{engine::general_purpose::STANDARD, Engine};

        let (directory, library) = library();
        let png = |side: u32| {
            let mut bytes = Vec::new();
            image::RgbImage::from_pixel(side, side, image::Rgb([side as u8, 90, 40]))
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .unwrap();
            bytes
        };
        let (small, large) = (png(60), png(200));
        let (small_md5, large_md5) = (
            library.store_blob(&small).unwrap().md5,
            library.store_blob(&large).unwrap().md5,
        );
        let note = |title: &str, thumbnail: &str| {
            format!(
                "<note><title>{title}</title><created>20240102T030405Z</created><note-attributes>{thumbnail}</note-attributes>\
                 <content><![CDATA[<en-note><en-media hash=\"{small_md5}\" type=\"image/png\"/><en-media hash=\"{large_md5}\" type=\"image/png\"/></en-note>]]></content>\
                 <resource><data encoding=\"base64\">{}</data><mime>image/png</mime><width>60</width><height>60</height></resource>\
                 <resource><data encoding=\"base64\">{}</data><mime>image/png</mime><width>200</width><height>200</height></resource></note>",
                STANDARD.encode(&small),
                STANDARD.encode(&large)
            )
        };
        let source = directory.path().join("thumbnails.enex");
        std::fs::write(
            &source,
            format!(
                "<en-export>{}{}{}</en-export>",
                note("Found", ""),
                note("Removed", "<thumbnail></thumbnail>"),
                note("Chosen", &format!("<thumbnail>{small_md5}</thumbnail>")),
            ),
        )
        .unwrap();
        crate::enex::import_enex(&library, &source, None).unwrap();
        let shown = |title: &str| {
            library
                .list_notes(&NoteFilter::default())
                .unwrap()
                .notes
                .into_iter()
                .find(|note| note.title == title)
                .unwrap()
                .thumbnail
        };
        let sha = |md5: &str| {
            let connection = library.connection.lock();
            connection
                .query_row(
                    "SELECT sha256 FROM resources WHERE md5 = ?1 LIMIT 1",
                    [md5],
                    |row| row.get::<_, String>(0),
                )
                .unwrap()
        };
        assert_eq!(shown("Found"), Some(sha(&large_md5)));
        assert_eq!(shown("Removed"), None);
        assert_eq!(shown("Chosen"), Some(sha(&small_md5)));
        // And an export of them says the same again.
        let out = directory.path().join("out.enex");
        crate::enex::export_enex(&library, &library.all_notes().unwrap(), &out).unwrap();
        let written = std::fs::read_to_string(&out).unwrap();
        assert!(
            written.contains("<thumbnail></thumbnail>"),
            "the removed one"
        );
        assert!(written.contains(&format!("<thumbnail>{small_md5}</thumbnail>")));
    }

    #[test]
    fn marks_are_set_and_taken_away_without_leaving_anything_behind() {
        let plain = json!({ "author": "Ada" });
        let pinned = with_mark(&plain, PINNED_KEY, Some("nb 5"));
        assert_eq!(mark(&pinned, PINNED_KEY), Some("nb 5"));
        assert_eq!(pinned["author"], "Ada");
        assert!(has_marks(&pinned) && !has_marks(&plain));
        assert_eq!(with_mark(&pinned, PINNED_KEY, None), plain);
        // What else an application keeps there stays.
        let other = json!({ "application-data": { "evernote.caption": "x" } });
        let both = with_mark(&other, THUMBNAIL_KEY, Some(NO_THUMBNAIL));
        assert_eq!(without_marks(&both), other);
        assert_eq!(without_marks(&plain), plain);
    }

    #[test]
    fn a_pinned_note_stands_first_in_its_notebook_and_keeps_its_time() {
        let (_directory, library) = library();
        let inbox = library.snapshot().unwrap().notebooks[0].id.clone();
        let other = library.ensure_notebook("Other", None).unwrap();
        let first = titled(&library, Some(&inbox), "First");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = titled(&library, Some(&inbox), "Second");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let third = titled(&library, Some(&inbox), "Third");
        // Newest first, as a list is without pins.
        assert_eq!(
            listed(&library, Some(&inbox)),
            [
                ("Third".to_owned(), false),
                ("Second".to_owned(), false),
                ("First".to_owned(), false)
            ]
        );

        assert_eq!(
            library
                .set_pinned(std::slice::from_ref(&first.id), true)
                .unwrap(),
            1
        );
        // Pinned once is pinned; asking again changes nothing.
        assert_eq!(
            library
                .set_pinned(std::slice::from_ref(&first.id), true)
                .unwrap(),
            0
        );
        let after = library.get_note(&first.id).unwrap();
        assert_eq!(after.updated_at, first.updated_at);
        assert_eq!(after.revision, first.revision + 1);
        assert_eq!(
            listed(&library, Some(&inbox)),
            [
                ("First".to_owned(), true),
                ("Third".to_owned(), false),
                ("Second".to_owned(), false)
            ]
        );
        // The one pinned last stands first.
        std::thread::sleep(std::time::Duration::from_millis(5));
        library
            .set_pinned(std::slice::from_ref(&second.id), true)
            .unwrap();
        assert_eq!(
            listed(&library, Some(&inbox))
                .iter()
                .map(|(title, _)| title.as_str())
                .collect::<Vec<_>>(),
            ["Second", "First", "Third"]
        );
        // Among all notes a pinned one is where its time puts it, and is
        // shown as pinned.
        assert_eq!(
            listed(&library, None),
            [
                ("Third".to_owned(), false),
                ("Second".to_owned(), true),
                ("First".to_owned(), true)
            ]
        );

        // Moved to another notebook it is not pinned there; moved back, it
        // is pinned again where it was.
        library
            .move_notes(std::slice::from_ref(&first.id), &other)
            .unwrap();
        assert_eq!(
            listed(&library, Some(&other)),
            [("First".to_owned(), false)]
        );
        library
            .move_notes(std::slice::from_ref(&first.id), &inbox)
            .unwrap();
        assert!(listed(&library, Some(&inbox)).contains(&("First".to_owned(), true)));

        assert_eq!(
            library
                .set_pinned(&[first.id, second.id, third.id], false)
                .unwrap(),
            2
        );
        assert!(listed(&library, Some(&inbox))
            .iter()
            .all(|(_, pinned)| !pinned));
    }

    #[test]
    fn a_note_can_have_a_chosen_picture_none_or_the_one_found_for_it() {
        let (_directory, library) = library();
        let note = library.create_note(None).unwrap();
        // Two pictures; the larger one is the one found for the note.
        let png = |side: u32| {
            let mut bytes = Vec::new();
            image::RgbImage::from_pixel(side, side, image::Rgb([side as u8, 90, 40]))
                .write_to(
                    &mut std::io::Cursor::new(&mut bytes),
                    image::ImageFormat::Png,
                )
                .unwrap();
            bytes
        };
        let small = library
            .add_resource(&note.id, &mut &png(60)[..], "small.png", Some("image/png"))
            .unwrap();
        let large = library
            .add_resource(&note.id, &mut &png(200)[..], "large.png", Some("image/png"))
            .unwrap();
        let saved = library
            .save_note(&SaveNote {
                id: note.id.clone(),
                notebook_id: note.notebook_id.clone(),
                title: "Pictures".into(),
                content_html: format!(
                    "<p><en-media hash=\"{}\" type=\"image/png\"></en-media><en-media hash=\"{}\" type=\"image/png\"></en-media></p>",
                    small.md5, large.md5
                ),
                attributes: json!({}),
                tags: Vec::new(),
                base_revision: None,
            })
            .unwrap();
        let shown = || {
            library
                .list_notes(&NoteFilter::default())
                .unwrap()
                .notes
                .remove(0)
                .thumbnail
        };
        assert_eq!(shown().as_deref(), Some(large.sha256.as_str()));

        let chosen = library
            .set_thumbnail(&note.id, &ThumbnailChoice::Picture(small.md5.clone()))
            .unwrap();
        assert_eq!(shown().as_deref(), Some(small.sha256.as_str()));
        // Choosing is not editing: the note's time stays.
        assert_eq!(chosen.updated_at, saved.updated_at);
        assert_eq!(chosen.revision, saved.revision + 1);

        library
            .set_thumbnail(&note.id, &ThumbnailChoice::None)
            .unwrap();
        assert_eq!(shown(), None);
        let back = library
            .set_thumbnail(&note.id, &ThumbnailChoice::Automatic)
            .unwrap();
        assert_eq!(shown().as_deref(), Some(large.sha256.as_str()));
        // Nothing is left behind of a choice that was taken back.
        assert_eq!(back.attributes, json!({}));
        assert!(library
            .set_thumbnail(&note.id, &ThumbnailChoice::Picture("0".repeat(32)))
            .is_err());

        // A note that came from an export with its thumbnail removed has
        // none; with one chosen there, that one; and what is chosen here
        // comes before either.
        let exported = |thumbnail: &str| {
            library
                .save_note(&SaveNote {
                    id: note.id.clone(),
                    notebook_id: note.notebook_id.clone(),
                    title: "Pictures".into(),
                    content_html: saved.content_html.clone(),
                    attributes: json!({ "thumbnail": thumbnail }),
                    tags: Vec::new(),
                    base_revision: None,
                })
                .unwrap()
        };
        exported("");
        assert_eq!(shown(), None);
        exported(&small.md5);
        assert_eq!(shown().as_deref(), Some(small.sha256.as_str()));
        let automatic = library
            .set_thumbnail(&note.id, &ThumbnailChoice::Automatic)
            .unwrap();
        assert_eq!(
            mark(&automatic.attributes, THUMBNAIL_KEY),
            Some(AUTOMATIC_THUMBNAIL)
        );
        assert_eq!(shown().as_deref(), Some(large.sha256.as_str()));
        library
            .set_thumbnail(&note.id, &ThumbnailChoice::None)
            .unwrap();
        assert_eq!(shown(), None);
    }
}
