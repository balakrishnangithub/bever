//! Checks that an ENEX file survives import, export, and a second import.
//!
//! ```sh
//! cargo run --release -p bever-core --example verify_enex -- notes.enex new-empty-work-directory
//! ```
//!
//! The file is first read on its own, then imported, exported, and imported
//! again. Titles, dates, tags, attributes, attachment hashes, and text must
//! agree at every step. Notes Bever did not change (no link was rewritten)
//! must export their original ENML byte for byte; the rest must export ENML
//! that parses and carries the same text. Only counts are printed.
use std::{
    collections::BTreeMap,
    env,
    fs::File,
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

use bever_core::{
    blob::StoredBlob,
    enex::{export_enex_writer, import_enex, BlobSink, EnexItem, EnexNote, EnexReader},
    enml::{enml_to_html, plain_text, without_note_link_targets},
    models::Note,
    BeverError, Library,
};
use sha2::{Digest as _, Sha256};

/// Hashes attachments without keeping them, so the file can be of any size.
struct HashOnly;

impl BlobSink for HashOnly {
    fn store(&mut self, reader: &mut dyn Read) -> bever_core::Result<StoredBlob> {
        let mut sha256 = Sha256::new();
        let mut md5 = md5::Context::new();
        let mut size = 0;
        let mut buffer = vec![0; 256 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            sha256.update(&buffer[..read]);
            md5.consume(&buffer[..read]);
            size += read as u64;
        }
        Ok(StoredBlob {
            sha256: format!("{:x}", sha256.finalize()),
            md5: format!("{:x}", md5.compute()),
            size,
        })
    }
}

fn read_export(path: &Path) -> bever_core::Result<Vec<EnexNote>> {
    let mut reader = EnexReader::new(BufReader::with_capacity(1024 * 1024, File::open(path)?));
    let mut notes = Vec::new();
    while let Some(item) = reader.next_item(&mut HashOnly, &mut |_| {})? {
        match item {
            EnexItem::Note(note) => notes.push(*note),
            EnexItem::Skipped { reason, .. } => {
                return Err(BeverError::Invalid(format!(
                    "note {} of the export is unreadable: {reason}",
                    notes.len() + 1
                )));
            }
        }
    }
    Ok(notes)
}

/// What must be identical between an export file and the library.
fn file_facts(note: &EnexNote) -> String {
    let mut tags = note
        .tags
        .iter()
        .map(|tag| tag.to_lowercase())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    serde_json::to_string(&(
        &note.title,
        note.created_at,
        note.updated_at,
        tags,
        &note.attributes,
        note.resources
            .iter()
            .map(|resource| {
                (
                    &resource.blob.sha256,
                    resource.blob.size,
                    &resource.mime,
                    &resource.attributes,
                    &resource.recognition_xml,
                    resource.alternate.as_ref().map(|blob| &blob.sha256),
                )
            })
            .collect::<Vec<_>>(),
    ))
    .expect("facts are serializable")
}

fn library_facts(note: &Note) -> String {
    let mut tags = note
        .tags
        .iter()
        .map(|tag| tag.to_lowercase())
        .collect::<Vec<_>>();
    tags.sort();
    serde_json::to_string(&(
        &note.title,
        note.created_at,
        note.updated_at,
        tags,
        &note.attributes,
        note.resources
            .iter()
            .map(|resource| {
                (
                    &resource.sha256,
                    resource.size,
                    &resource.mime,
                    &resource.attributes,
                    &resource.recognition_xml,
                    &resource.alternate_sha256,
                )
            })
            .collect::<Vec<_>>(),
    ))
    .expect("facts are serializable")
}

fn count_by<T>(items: impl Iterator<Item = T>, key: impl Fn(T) -> String) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for item in items {
        *counts.entry(key(item)).or_insert(0) += 1;
    }
    counts
}

fn main() -> bever_core::Result<()> {
    let input = env::args_os().nth(1).map(PathBuf::from).ok_or_else(|| {
        BeverError::Invalid("usage: verify_enex <input.enex> <empty-work-directory>".into())
    })?;
    let work = env::args_os()
        .nth(2)
        .map(PathBuf::from)
        .ok_or_else(|| BeverError::Invalid("an empty work directory is required".into()))?;
    if work.exists() {
        return Err(BeverError::Invalid(
            "work directory must not already exist".into(),
        ));
    }

    // 1. The file as written.
    let source_notes = read_export(&input)?;
    let source_resources: usize = source_notes.iter().map(|note| note.resources.len()).sum();
    let entity_tags = source_notes
        .iter()
        .flat_map(|note| &note.tags)
        .filter(|tag| tag.contains(['&', '<', '>']))
        .count();
    println!(
        "Source: {} notes, {} attachments, {} tag uses containing & < or >.",
        source_notes.len(),
        source_resources,
        entity_tags
    );

    // 2. Imported.
    let library = Library::open(work.join("source"))?;
    let report = import_enex(&library, &input, Some("Verification"))?;
    // In the order they were imported, which is the order they are exported in.
    let notes = library
        .note_ids(None)?
        .iter()
        .map(|id| library.get_note(id))
        .collect::<bever_core::Result<Vec<_>>>()?;
    let mut failures = Vec::new();
    if report.notes_failed > 0 {
        failures.push(format!("{} notes were not imported", report.notes_failed));
    }
    let imported = count_by(notes.iter(), library_facts);
    let expected = count_by(source_notes.iter(), file_facts);
    // Identical notes inside one export are imported once.
    let distinct = expected.len();
    if imported.keys().ne(expected.keys()) {
        let missing = expected
            .keys()
            .filter(|key| !imported.contains_key(*key))
            .count();
        let extra = imported
            .keys()
            .filter(|key| !expected.contains_key(*key))
            .count();
        failures.push(format!(
            "import changed note facts: {missing} source notes have no exact counterpart, {extra} imported notes match no source note"
        ));
    }
    let checklists = notes
        .iter()
        .filter(|note| note.content_html.contains("data-type=\"taskList\""))
        .count();
    let unresolved_links = notes
        .iter()
        .filter(|note| note.content_html.contains("evernote:///view/"))
        .count();
    println!(
        "Imported: {} notes ({} distinct in the file, {} skipped as duplicates), {} attachments, {} links resolved, {} notes still hold an unresolved Evernote link, {} notes with checklists, {} images queued for recognition.",
        notes.len(),
        distinct,
        report.notes_skipped,
        report.resources_imported,
        report.links_resolved,
        unresolved_links,
        checklists,
        report.images_queued,
    );

    // 3. Exported and read back.
    let exported_path = work.join("roundtrip.enex");
    let ids = notes.iter().map(|note| note.id.clone()).collect::<Vec<_>>();
    export_enex_writer(&library, &ids, File::create(&exported_path)?, |_, _| {})?;
    let exported = read_export(&exported_path)?;
    if exported.len() != notes.len() {
        failures.push(format!(
            "export wrote {} notes for {} in the library",
            exported.len(),
            notes.len()
        ));
    }
    let (mut verbatim, mut reserialized) = (0, 0);
    for (index, (note, exported)) in notes.iter().zip(&exported).enumerate() {
        if library_facts(note) != file_facts(exported) {
            failures.push(format!("note {} changed its facts on export", index + 1));
        }
        let original = note.original_enml.as_deref().unwrap_or_default();
        // A link pointed at a note of this library is no change: the
        // export writes the source's own link.
        let unchanged = enml_to_html(original) == note.content_html
            || without_note_link_targets(&enml_to_html(original))
                == without_note_link_targets(&note.content_html);
        if unchanged {
            verbatim += 1;
            if exported.content != original {
                failures.push(format!(
                    "note {} did not export its original ENML",
                    index + 1
                ));
            }
        } else {
            reserialized += 1;
            if plain_text(&enml_to_html(&exported.content)) != note.plain_text {
                failures.push(format!("note {} changed its text on export", index + 1));
            }
        }
    }
    println!(
        "Exported: {verbatim} notes as their original ENML, {reserialized} written anew because they were changed here."
    );

    // 4. Imported again from our own export.
    let restored = Library::open(work.join("restored"))?;
    let second = import_enex(&restored, &exported_path, Some("Restored"))?;
    let restored_notes = restored.all_notes()?;
    if count_by(restored_notes.iter(), library_facts) != imported {
        failures.push("a second import of the export changed note facts".into());
    }
    if second.notes_failed > 0 {
        failures.push(format!(
            "{} exported notes were unreadable",
            second.notes_failed
        ));
    }
    println!("Re-imported: {} notes.", restored_notes.len());

    if failures.is_empty() {
        println!("PASS: every note, tag, attribute, and attachment hash survived the round trip.");
        Ok(())
    } else {
        for failure in &failures {
            println!("FAIL: {failure}");
        }
        Err(BeverError::Invalid(format!(
            "{} verification failures",
            failures.len()
        )))
    }
}
