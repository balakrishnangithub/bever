use std::{fs, io::Cursor};

use bever_core::{
    enex::{export_enex, import_enex, EnexItem, EnexReader, MemoryBlobs},
    enml::enml_to_html,
    models::{NoteFilter, SaveNote},
    ocr::{process_ocr_queue, LocalOcr},
    Library,
};
use serde_json::json;

const DUPLICATE_GUID_SAMPLE: &str = r#"<?xml version="1.0"?><en-export><note><title>First</title><guid>01234567-89ab-cdef-0123-456789abcdef</guid><created>20240102T030405Z</created><content><![CDATA[<en-note><div>One</div></en-note>]]></content><note-attributes><reminder-order>7</reminder-order></note-attributes></note><note><title>Second</title><guid>01234567-89ab-cdef-0123-456789abcdef</guid><created>20240102T030405Z</created><content><![CDATA[<en-note><div>Two</div></en-note>]]></content></note></en-export>"#;

#[test]
fn modern_evernote_checklists_become_editable_task_items() {
    let html = enml_to_html(
        r#"<en-note><ul><li style="--en-todo:true;--en-checked:false;">Later</li><li style="--en-todo:true;--en-checked:true;">Done</li></ul></en-note>"#,
    );
    assert!(html.contains("data-type=\"taskList\""));
    assert!(html.contains("data-checked=\"false\""));
    assert!(html.contains("data-checked=\"true\""));
    assert!(html.contains("Later"));
}

#[test]
fn duplicate_guids_do_not_prevent_reimport_and_attributes_keep_values() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let source = directory.path().join("duplicates.enex");
    fs::write(&source, DUPLICATE_GUID_SAMPLE).unwrap();
    let first_import = import_enex(&library, &source, Some("One")).unwrap();
    assert_eq!(first_import.notes_imported, 2);
    assert_eq!(first_import.notes_skipped, 0);
    let repeated = import_enex(&library, &source, Some("Two")).unwrap();
    assert_eq!(repeated.notes_imported, 0);
    assert_eq!(repeated.notes_skipped, 2);
    assert_eq!(library.list_notes(&NoteFilter::default()).unwrap().total, 2);

    // The two notes share a timestamp, so pick by title, not by list position.
    let first = library
        .list_notes(&NoteFilter::default())
        .unwrap()
        .notes
        .into_iter()
        .find(|note| note.title == "First")
        .unwrap();
    let mut note = library.get_note(&first.id).unwrap();
    note.content_html = "<p>My local edit must survive reimport.</p>".into();
    note.attributes
        .as_object_mut()
        .unwrap()
        .insert("reminder-done".into(), json!(true));
    note.attributes
        .as_object_mut()
        .unwrap()
        .insert("latitude".into(), json!(12.5));
    let saved = library
        .save_note(&SaveNote {
            id: note.id.clone(),
            notebook_id: note.notebook_id.clone(),
            title: note.title.clone(),
            content_html: note.content_html.clone(),
            attributes: note.attributes.clone(),
            tags: note.tags.clone(),
            base_revision: None,
        })
        .unwrap();
    let exported = directory.path().join("attributes.enex");
    export_enex(&library, &[saved], &exported).unwrap();
    let text = fs::read_to_string(exported).unwrap();
    assert!(text.contains("<reminder-order>7</reminder-order>"));
    assert!(text.contains("<reminder-done>true</reminder-done>"));
    assert!(text.contains("<latitude>12.5</latitude>"));

    let edited_reimport = import_enex(&library, &source, Some("Three")).unwrap();
    assert_eq!(edited_reimport.notes_skipped, 2);
    assert_eq!(
        library.get_note(&first.id).unwrap().content_html,
        "<p>My local edit must survive reimport.</p>"
    );
}

#[test]
fn notes_without_guids_also_deduplicate() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let source = directory.path().join("without-guid.enex");
    fs::write(
        &source,
        r#"<?xml version="1.0"?><en-export><note><title>No GUID</title><created>20240102T030405Z</created><content><![CDATA[<en-note><div>Original</div></en-note>]]></content></note></en-export>"#,
    )
    .unwrap();
    assert_eq!(
        import_enex(&library, &source, None).unwrap().notes_imported,
        1
    );
    let report = import_enex(&library, &source, None).unwrap();
    assert_eq!(report.notes_imported, 0);
    assert_eq!(report.notes_skipped, 1);
    assert_eq!(library.list_notes(&NoteFilter::default()).unwrap().total, 1);
}

#[test]
#[ignore = "OCR inference is intentionally tested in release mode"]
fn local_ocr_extracts_image_text_into_offline_search() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let source = directory.path().join("ocr.enex");
    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        include_bytes!("fixtures/ocr-invoice.png"),
    );
    fs::write(
        &source,
        format!(r#"<?xml version="1.0"?><en-export><note><title>Scanned receipt</title><created>20240102T030405Z</created><content><![CDATA[<en-note><div>Scan</div></en-note>]]></content><resource><data encoding="base64">{encoded}</data><mime>image/png</mime></resource></note></en-export>"#),
    )
    .unwrap();
    let report = import_enex(&library, &source, None).unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    // Import only queues the image; recognition happens afterwards.
    assert_eq!(report.images_queued, 1);
    assert_eq!(library.ocr_pending().unwrap(), 1);
    assert!(library.all_notes().unwrap()[0].resources[0]
        .recognition_text
        .is_none());
    let mut engine = LocalOcr::new().unwrap();
    let mut remaining = Vec::new();
    let processed =
        process_ocr_queue(&library, &mut engine, || true, |left| remaining.push(left)).unwrap();
    assert_eq!(processed, 1);
    assert_eq!(remaining, [0]);
    assert_eq!(library.ocr_pending().unwrap(), 0);
    let notes = library.all_notes().unwrap();
    let ocr = notes[0].resources[0]
        .recognition_text
        .as_deref()
        .unwrap_or("");
    assert!(ocr.to_lowercase().contains("invoice"), "OCR result: {ocr}");
    // Each word is kept with its place in the picture, in the picture's own
    // pixels, so that a search can show where it found the word.
    let places = notes[0].resources[0]
        .recognition_xml
        .as_deref()
        .unwrap_or("");
    let picture = image::load_from_memory(include_bytes!("fixtures/ocr-invoice.png")).unwrap();
    assert!(
        places.contains(&format!(
            "objWidth=\"{}\" objHeight=\"{}\"",
            picture.width(),
            picture.height()
        )),
        "{places}"
    );
    let number = |item: &str, name: &str| -> u32 {
        let from = item.find(&format!("{name}=\"")).unwrap() + name.len() + 2;
        item[from..from + item[from..].find('"').unwrap()]
            .parse()
            .unwrap()
    };
    let items = places.split("<item ").skip(1).collect::<Vec<_>>();
    assert!(!items.is_empty(), "{places}");
    for item in &items {
        assert!(number(item, "w") > 0 && number(item, "h") > 0, "{item}");
        assert!(
            number(item, "x") + number(item, "w") <= picture.width(),
            "{item}"
        );
        assert!(
            number(item, "y") + number(item, "h") <= picture.height(),
            "{item}"
        );
    }
    assert!(
        items
            .iter()
            .any(|item| item.to_lowercase().contains(">invoice<")),
        "{places}"
    );
    let results = library
        .list_notes(&NoteFilter {
            query: "invoice".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(results.total, 1);
}

#[test]
fn attachments_can_be_retrieved_by_id_and_content_hash() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let note = library.create_note(None).unwrap();
    let source = directory.path().join("report.pdf");
    fs::write(&source, b"%PDF-1.4\nattachment test\n").unwrap();
    let attached = library.attach_file(&note.id, &source).unwrap();
    assert_eq!(
        library.get_note(&note.id).unwrap().content_html,
        note.content_html,
        "the editor, not the library, places the attachment in the note"
    );

    let by_id = library.resource(&attached.id).unwrap();
    assert_eq!(by_id.file_name.as_deref(), Some("report.pdf"));
    assert_eq!(by_id.mime, "application/pdf");
    assert_eq!(by_id.size, 25);
    let by_md5 = library.resource_location(&attached.md5).unwrap();
    let by_sha256 = library.resource_location(&attached.sha256).unwrap();
    assert_eq!(by_md5.id, attached.id);
    assert_eq!(by_sha256.id, attached.id);
    assert_eq!(
        library.read_blob(&by_id.sha256).unwrap(),
        b"%PDF-1.4\nattachment test\n"
    );
}

#[test]
fn reader_handles_cdata_and_multiple_notes_without_losing_text() {
    let mut reader = EnexReader::new(Cursor::new(DUPLICATE_GUID_SAMPLE));
    let mut blobs = MemoryBlobs::default();
    let mut titles = Vec::new();
    while let Some(item) = reader.next_item(&mut blobs, &mut |_| {}).unwrap() {
        match item {
            EnexItem::Note(note) => titles.push(note.title),
            EnexItem::Skipped { reason, .. } => panic!("skipped: {reason}"),
        }
    }
    assert_eq!(titles, ["First", "Second"]);
}

#[test]
fn import_progress_exposes_notebook_before_notes_and_finishes_completely() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    library.set_setting("ocr_enabled", "false").unwrap();
    let source = directory.path().join("progress.enex");
    fs::write(&source, DUPLICATE_GUID_SAMPLE).unwrap();
    let mut events = Vec::new();
    let report = bever_core::enex::import_enex_with_progress(
        &library,
        &source,
        Some("Progress"),
        |progress| {
            events.push((
                progress.phase,
                progress.note_index,
                progress.bytes_read,
                progress.total_bytes,
                progress.notebook_id,
            ));
        },
    )
    .unwrap();

    assert_eq!(events.first().unwrap().0, "preparing");
    let notebook_ready = events
        .iter()
        .position(|event| event.0 == "notebookReady")
        .unwrap();
    let first_note = events
        .iter()
        .position(|event| event.0 == "noteImported")
        .unwrap();
    assert!(notebook_ready < first_note);
    assert!(events
        .iter()
        .any(|event| event.0 == "finalizing" && event.1 == 2));
    let complete = events.last().unwrap();
    assert_eq!(complete.0, "complete");
    assert_eq!(complete.1, 2);
    assert_eq!(complete.2, source.metadata().unwrap().len());
    assert_eq!(complete.2, complete.3);
    assert!(events
        .iter()
        .filter(|event| event.0 == "notebookReady" || event.0 == "noteImported")
        .all(|event| event.4 == report.notebook_id));
}

#[test]
fn copied_notes_have_new_identity_but_reuse_attachment_blobs() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    library.set_setting("ocr_enabled", "false").unwrap();
    let source = directory.path().join("copy-source.enex");
    fs::write(
        &source,
        r#"<?xml version="1.0"?><en-export><note><title>Source note</title><guid>11234567-89ab-cdef-0123-456789abcdef</guid><created>20240102T030405Z</created><updated>20240102T030405Z</updated><content><![CDATA[<en-note><div>Copied body</div><en-media hash="2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae" type="text/plain"/></en-note>]]></content><tag>original</tag><resource><data encoding="base64">YXR0YWNobWVudCBib2R5</data><mime>text/plain</mime><resource-attributes><file-name>source.txt</file-name></resource-attributes></resource></note></en-export>"#,
    )
    .unwrap();
    import_enex(&library, &source, Some("Imports")).unwrap();
    let original = library.all_notes().unwrap().remove(0);
    let destination = library.ensure_notebook("Copies", None).unwrap();

    assert_eq!(
        library
            .copy_notes(std::slice::from_ref(&original.id), &destination)
            .unwrap(),
        1
    );
    let copied = library
        .all_notes()
        .unwrap()
        .into_iter()
        .find(|note| note.id != original.id)
        .unwrap();
    assert_eq!(copied.title, "Source note (copy)");
    assert_eq!(copied.notebook_id, destination);
    assert!(copied.evernote_guid.is_none());
    assert!(original.evernote_guid.is_some());
    assert!(copied.created_at > original.created_at);
    assert_eq!(copied.tags, original.tags);
    assert_eq!(copied.resources.len(), 1);
    assert_ne!(copied.resources[0].id, original.resources[0].id);
    assert_eq!(copied.resources[0].note_id, copied.id);
    assert_eq!(copied.resources[0].sha256, original.resources[0].sha256);
    assert_eq!(
        library.read_blob(&copied.resources[0].sha256).unwrap(),
        b"attachment body"
    );

    let repeated = import_enex(&library, &source, Some("Imports")).unwrap();
    assert_eq!(repeated.notes_imported, 0);
    assert_eq!(repeated.notes_skipped, 1);
    assert_eq!(library.all_notes().unwrap().len(), 2);
}

#[test]
fn bulk_move_and_additive_tagging_are_transactional_and_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let first = library.create_note(None).unwrap();
    let second = library.create_note(None).unwrap();
    let destination = library.ensure_notebook("Destination", None).unwrap();
    assert_eq!(
        library
            .copy_notes(std::slice::from_ref(&second.id), &destination)
            .unwrap(),
        1
    );
    assert!(library
        .all_notes()
        .unwrap()
        .iter()
        .any(|note| note.title == "Untitled (copy)"));

    let ids = vec![first.id.clone(), second.id.clone()];
    assert_eq!(library.move_notes(&ids, &destination).unwrap(), 2);
    assert!(library
        .all_notes()
        .unwrap()
        .iter()
        .filter(|note| ids.contains(&note.id))
        .all(|note| note.notebook_id == destination));
    let tags = vec!["Review".to_owned(), "follow-up".to_owned()];
    assert_eq!(library.add_tags_to_notes(&ids, &tags).unwrap(), 2);
    assert_eq!(library.add_tags_to_notes(&ids, &tags).unwrap(), 0);
    for id in &ids {
        let note = library.get_note(id).unwrap();
        assert!(note.tags.contains(&"Review".to_owned()));
        assert!(note.tags.contains(&"follow-up".to_owned()));
    }
    assert!(library.move_notes(&ids, "missing-notebook").is_err());
    assert!(library
        .all_notes()
        .unwrap()
        .iter()
        .filter(|note| ids.contains(&note.id))
        .all(|note| note.notebook_id == destination));
}

#[test]
fn note_timestamps_can_be_corrected_without_accepting_invalid_ranges() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let note = library.create_note(None).unwrap();
    let created_at = 1_704_164_645_000;
    let updated_at = created_at + 60_000;
    let updated = library
        .update_note_timestamps(&note.id, created_at, updated_at)
        .unwrap();
    assert_eq!(updated.created_at, created_at);
    assert_eq!(updated.updated_at, updated_at);
    assert_eq!(updated.revision, note.revision + 1);
    assert!(library
        .update_note_timestamps(&note.id, created_at, created_at - 1)
        .is_err());
    assert!(library
        .update_note_timestamps(&note.id, -1, updated_at)
        .is_err());
    let unchanged = library.get_note(&note.id).unwrap();
    assert_eq!(unchanged.created_at, created_at);
    assert_eq!(unchanged.updated_at, updated_at);
}

#[test]
fn repeated_tags_in_one_enex_note_do_not_abort_import() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    library.set_setting("ocr_enabled", "false").unwrap();
    let source = directory.path().join("repeated-tags.enex");
    fs::write(
        &source,
        r#"<?xml version="1.0"?><en-export><note><title>Repeated tags</title><created>20240102T030405Z</created><content><![CDATA[<en-note><div>Body</div></en-note>]]></content><tag>Review</tag><tag>Review</tag><tag>review</tag></note></en-export>"#,
    )
    .unwrap();
    let report = import_enex(&library, &source, None).unwrap();
    assert_eq!(report.notes_imported, 1);
    let notes = library.all_notes().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].tags.len(), 1);
    assert_eq!(notes[0].tags[0].to_lowercase(), "review");
    let repeated = import_enex(&library, &source, None).unwrap();
    assert_eq!(repeated.notes_imported, 0);
    assert_eq!(repeated.notes_skipped, 1);
}

#[test]
#[ignore = "set BEVER_LARGE_ENEX to a local private export to run this bounded check"]
fn private_large_enex_streams_with_ordered_progress() {
    let Ok(source) = std::env::var("BEVER_LARGE_ENEX") else {
        return;
    };
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    // Keep this bounded check focused on streaming/progress; OCR is tested separately.
    library.set_setting("ocr_enabled", "false").unwrap();
    let started = std::time::Instant::now();
    let mut notebook_ready = false;
    let mut complete = false;
    let mut note_index = 0;
    let mut progress_events = 0_u64;
    let report = bever_core::enex::import_enex_with_progress(
        &library,
        source,
        Some("Large import verification"),
        |progress| {
            progress_events += 1;
            match progress.phase.as_str() {
                "notebookReady" => notebook_ready = true,
                "noteImported" => {
                    assert!(
                        notebook_ready,
                        "notebook must be visible before note events"
                    );
                    note_index = progress.note_index;
                }
                "complete" => complete = true,
                _ => {}
            }
        },
    )
    .unwrap();
    assert!(notebook_ready);
    assert!(complete);
    assert_eq!(
        report.notes_imported + report.notes_skipped + report.notes_failed,
        note_index
    );
    eprintln!(
        "Private large ENEX: {note_index} notes, {} attachments, {progress_events} progress events, {} warnings, {:.1?}; OCR disabled",
        report.resources_imported,
        report.warnings.len(),
        started.elapsed(),
    );
}

#[test]
fn saving_over_a_version_the_editor_never_saw_keeps_that_version() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let note = library.create_note(None).unwrap();
    let save = |html: &str, base_revision: Option<i64>| {
        library
            .save_note_checked(&SaveNote {
                id: note.id.clone(),
                notebook_id: note.notebook_id.clone(),
                title: "Minutes".into(),
                content_html: html.into(),
                attributes: json!({}),
                tags: Vec::new(),
                base_revision,
            })
            .unwrap()
    };

    // An editor that always passes the revision it last saw never conflicts.
    let first = save("<p>Draft</p>", Some(note.revision));
    assert_eq!(first.conflict_copy, None);
    let second = save("<p>Draft, continued</p>", Some(first.note.revision));
    assert_eq!(second.conflict_copy, None);

    // Something else (synchronization) replaces the note in the meantime.
    let replaced = save("<p>Changed on another device</p>", None);
    let saved = save(
        "<p>Draft, continued further</p>",
        Some(second.note.revision),
    );
    assert_eq!(
        saved.conflict_copy.as_deref(),
        Some("Minutes (conflict copy)")
    );
    assert_eq!(saved.note.content_html, "<p>Draft, continued further</p>");
    let notes = library.all_notes().unwrap();
    assert_eq!(notes.len(), 2);
    let copy = notes.iter().find(|item| item.id != note.id).unwrap();
    assert_eq!(copy.content_html, replaced.note.content_html);
    assert_eq!(copy.title, "Minutes (conflict copy)");

    // A stale revision alone is harmless when the body is already the same.
    let same = save("<p>Draft, continued further</p>", Some(1));
    assert_eq!(same.conflict_copy, None);
    assert_eq!(library.all_notes().unwrap().len(), 2);
}

/// An export in the form Evernote 11 writes one: its indentation, the order
/// of a note's parts and of its tags and attributes, quotation marks as
/// entities, attachment bytes in lines of 256 letters, a very long value on
/// a line of its own, and six spaces after a note's content.
fn evernote_export() -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = (0..400u32)
        .map(|index| (index * 7 % 251) as u8)
        .collect::<Vec<_>>();
    let encoded = STANDARD.encode(&bytes);
    let data = encoded
        .as_bytes()
        .chunks(256)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let long = format!("https://example.com/?q={}", "x".repeat(600));
    let hash = format!("{:x}", md5::compute(&bytes));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20261104T044621Z" application="Evernote" version="11.40.3">
  <note>
    <title>It&apos;s &quot;quoted&quot; &amp; &lt;marked&gt;</title>
    <created>20240102T030405Z</created>
    <updated>20240203T040506Z</updated>
    <tag>zebra</tag>
    <tag>Apple &amp; pear</tag>
    <note-attributes>
      <author>Ada</author>
      <source>web.clip7</source>
      <source-url>
        {long}
      </source-url>
      <source-application>webclipper.evernote</source-application>
    </note-attributes>
    <content>
      <![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Text with a picture</div><div><en-media hash="{hash}" type="image/png" /></div></en-note>      ]]>
    </content>
    <resource>
      <data encoding="base64">
{data}
      </data>
      <mime>image/png</mime>
      <width>40</width>
      <height>30</height>
      <resource-attributes>
        <file-name>picture.png</file-name>
        <source-url>en-cache://tokenKey%3D%22AuthToken%3AUser%3A1%22+a+b+https%3A%2F%2Fexample.com</source-url>
        <application-data key="evernote.captionState">generated</application-data>
        <application-data key="evernote.caption">A &quot;picture&quot;.</application-data>
        <application-data key="evernote.captionSource">ai</application-data>
      </resource-attributes>
    </resource>
  </note>
  <note>
    <title>Plain</title>
    <created>20240105T000000Z</created>
    <updated>20240105T000000Z</updated>
    <content>
      <![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>No attributes, tags, or attachments</div></en-note>      ]]>
    </content>
  </note>
</en-export>"#,
        hash = hash,
    )
}

#[test]
fn a_note_from_an_evernote_export_is_exported_as_the_text_it_was() {
    let directory = tempfile::tempdir().unwrap();
    let library =
        Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
    let source = directory.path().join("from-evernote.enex");
    let original = evernote_export();
    fs::write(&source, &original).unwrap();
    assert_eq!(
        import_enex(&library, &source, Some("Imported"))
            .unwrap()
            .notes_imported,
        2
    );
    let exported = directory.path().join("from-bever.enex");
    let ids = library.note_ids(None).unwrap();
    bever_core::enex::export_enex_writer(
        &library,
        &ids,
        fs::File::create(&exported).unwrap(),
        |_, _| {},
    )
    .unwrap();
    let exported = fs::read_to_string(&exported).unwrap();

    // The third line names the application and the moment; nothing else differs.
    let lines = |text: &str| text.lines().map(str::to_owned).collect::<Vec<_>>();
    let (mut ours, mut theirs) = (lines(&exported), lines(&original));
    assert!(
        ours[2].starts_with("<en-export export-date=\"")
            && ours[2].contains("application=\"Bever\"")
    );
    ours.remove(2);
    theirs.remove(2);
    assert_eq!(ours.len(), theirs.len());
    for (index, (ours, theirs)) in ours.iter().zip(&theirs).enumerate() {
        assert_eq!(ours, theirs, "line {}", index + 4);
    }
    assert!(!exported.ends_with('\n'));
}
