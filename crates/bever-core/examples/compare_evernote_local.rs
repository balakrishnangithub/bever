//! Checks that importing from the Evernote application's own files gives
//! what importing an export gives.
//!
//! ```text
//! cargo run --release -p bever-core --example compare_evernote_local -- \
//!     "Notebook.enex" ["Notebook name in Evernote"] [folder of Evernote's data]
//! ```
//!
//! The export is read with the ENEX reader, and the notebook of the same
//! name is read from Evernote's files on this computer. Nothing is imported
//! and nothing is written. Each note of the export is paired with the note
//! Evernote has, by title and time of creation, and every field is compared.
//! Only counts and the kinds of difference are printed, never a note's text.

use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::{BufReader, Read},
    path::PathBuf,
};

use bever_core::{
    blob::StoredBlob,
    enex::{default_notebook_name, BlobSink, EnexItem, EnexNote, EnexReader},
    evernote_local::{default_data_dir, find_accounts},
    Result,
};
use sha2::{Digest, Sha256};

/// Takes attachments' bytes and keeps only what identifies them.
struct Hashes;

impl BlobSink for Hashes {
    fn store(&mut self, reader: &mut dyn Read) -> Result<StoredBlob> {
        let mut sha = Sha256::new();
        let mut md5 = md5::Context::new();
        let mut size = 0u64;
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            sha.update(&buffer[..read]);
            md5.consume(&buffer[..read]);
            size += read as u64;
        }
        Ok(StoredBlob {
            sha256: format!("{:x}", sha.finalize()),
            md5: format!("{:x}", md5.compute()),
            size,
        })
    }
}

#[derive(Default)]
struct Tally(BTreeMap<String, u64>);

impl Tally {
    fn count(&mut self, what: impl Into<String>) {
        *self.0.entry(what.into()).or_default() += 1;
    }
}

/// Where two texts first differ, as the kinds of characters around it.
fn first_difference(export: &str, local: &str) -> String {
    let at = export
        .char_indices()
        .zip(local.chars())
        .find(|((_, a), b)| a != b)
        .map_or(export.len().min(local.len()), |((index, _), _)| index);
    let shape = |text: &str| {
        text.get(at..)
            .unwrap_or_default()
            .chars()
            .take(12)
            .map(|character| {
                if character.is_alphanumeric() {
                    'x'
                } else {
                    character
                }
            })
            .collect::<String>()
    };
    format!(
        "export “{}” / Evernote’s files “{}”",
        shape(export),
        shape(local)
    )
}

fn compare(export: &EnexNote, local: &EnexNote, tally: &mut Tally) {
    let mut same = true;
    let mut differs = |what: String, tally: &mut Tally| {
        same = false;
        tally.count(what);
    };
    if export.content != local.content {
        differs(
            format!(
                "  text differs: {}",
                first_difference(&export.content, &local.content)
            ),
            tally,
        );
    }
    let mut a = export.tags.clone();
    let mut b = local.tags.clone();
    a.sort();
    b.sort();
    if a != b {
        differs("  tags differ".into(), tally);
    }
    let keys = |note: &EnexNote| {
        note.attributes
            .as_object()
            .map(|map| map.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let mut all = keys(export);
    all.extend(keys(local));
    all.sort();
    all.dedup();
    for key in all {
        let (a, b) = (export.attributes.get(&key), local.attributes.get(&key));
        if a != b {
            differs(
                format!(
                    "  attribute {key}: {}",
                    match (a, b) {
                        (Some(_), None) => "only in the export".to_owned(),
                        (None, Some(_)) => "only in Evernote’s files".to_owned(),
                        (Some(a), Some(b)) => first_difference(
                            a.as_str().unwrap_or_default(),
                            b.as_str().unwrap_or_default()
                        ),
                        (None, None) => String::new(),
                    }
                ),
                tally,
            );
        }
    }
    if export.resources.len() != local.resources.len() {
        differs(
            format!(
                "  attachments: {} in the export, {} in Evernote’s files",
                export.resources.len(),
                local.resources.len()
            ),
            tally,
        );
    } else {
        let order = |note: &EnexNote| {
            note.resources
                .iter()
                .map(|item| item.blob.md5.clone())
                .collect::<Vec<_>>()
        };
        if order(export) != order(local) {
            let mut a = order(export);
            let mut b = order(local);
            a.sort();
            b.sort();
            differs(
                if a == b {
                    "  attachments are in another order".to_owned()
                } else {
                    "  attachments differ in their bytes".to_owned()
                },
                tally,
            );
        }
        let by_hash: HashMap<&str, _> = local
            .resources
            .iter()
            .map(|item| (item.blob.md5.as_str(), item))
            .collect();
        for theirs in &export.resources {
            tally.count("attachments compared");
            let Some(ours) = by_hash.get(theirs.blob.md5.as_str()) else {
                continue;
            };
            if theirs.blob.sha256 != ours.blob.sha256 || theirs.blob.size != ours.blob.size {
                differs("  an attachment’s bytes differ".into(), tally);
            }
            if theirs.mime != ours.mime {
                differs("  an attachment’s type differs".into(), tally);
            }
            if theirs.width != ours.width || theirs.height != ours.height {
                differs(
                    format!(
                        "  an attachment’s size in pixels: export {:?}x{:?}, Evernote’s files {:?}x{:?}",
                        theirs.width.is_some(),
                        theirs.height.is_some(),
                        ours.width.is_some(),
                        ours.height.is_some()
                    ),
                    tally,
                );
            }
            if theirs.attributes != ours.attributes {
                let keys = |value: &serde_json::Value| {
                    value
                        .as_object()
                        .map(|map| map.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default()
                };
                let mut all = keys(&theirs.attributes);
                all.extend(keys(&ours.attributes));
                all.sort();
                all.dedup();
                for key in all {
                    let (a, b) = (theirs.attributes.get(&key), ours.attributes.get(&key));
                    if a != b {
                        differs(
                            format!(
                                "  an attachment’s attribute {key}: {}",
                                match (a, b) {
                                    (Some(_), None) => "only in the export".to_owned(),
                                    (None, Some(_)) => "only in Evernote’s files".to_owned(),
                                    (Some(a), Some(b)) =>
                                        first_difference(&a.to_string(), &b.to_string()),
                                    (None, None) => String::new(),
                                }
                            ),
                            tally,
                        );
                    }
                }
            }
            match (&theirs.recognition_xml, &ours.recognition_xml) {
                (None, Some(_)) => {
                    tally.count("attachments whose recognised text only Evernote’s files have")
                }
                (Some(a), Some(b)) if a != b => {
                    differs("  an attachment’s recognised text differs".into(), tally)
                }
                (Some(_), None) => differs(
                    "  an attachment’s recognised text is only in the export".into(),
                    tally,
                ),
                _ => {}
            }
        }
    }
    tally.count(if same {
        "notes that are the same in both"
    } else {
        "notes that differ"
    });
}

/// The note as an export holds it. In two things Bever reads a note as
/// Evernote shows it instead: the title of a note that was given none, and
/// the tasks, which it puts into the note's text. What is compared here is
/// the note before that.
fn as_exported(mut note: EnexNote) -> EnexNote {
    if let Some(earlier) = note.earlier.take() {
        note.title = earlier.title;
        note.content = earlier.content;
        note.attributes = earlier.attributes;
        note.tasks = 0;
    }
    note
}

fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1);
    let Some(export) = arguments.next().map(PathBuf::from) else {
        eprintln!(
            "usage: compare_evernote_local <export.enex> [notebook name] [Evernote data folder]"
        );
        std::process::exit(2);
    };
    let name = arguments.next().unwrap_or_else(|| {
        default_notebook_name(&export.file_name().unwrap_or_default().to_string_lossy())
    });
    let data = arguments
        .next()
        .map(PathBuf::from)
        .or_else(default_data_dir)
        .expect("no folder of Evernote data is known on this system");
    let mut tally = Tally::default();

    let mut exported: HashMap<(String, i64), Vec<EnexNote>> = HashMap::new();
    let mut reader = EnexReader::new(BufReader::with_capacity(1 << 20, File::open(&export)?));
    let mut sink = Hashes;
    while let Some(item) = reader.next_item(&mut sink, &mut |_| {})? {
        match item {
            EnexItem::Note(note) => {
                tally.count("notes in the export");
                let note = as_exported(*note);
                exported
                    .entry((note.title.clone(), note.created_at))
                    .or_default()
                    .push(note);
            }
            EnexItem::Skipped { .. } => tally.count("notes of the export that cannot be read"),
        }
    }

    let accounts = find_accounts(&data);
    let mut found = false;
    for account in &accounts {
        let overview = account.overview()?;
        let total: u64 = exported.values().map(|notes| notes.len() as u64).sum();
        let named: Vec<_> = overview
            .notebooks
            .iter()
            .filter(|notebook| notebook.name.eq_ignore_ascii_case(&name))
            .collect();
        // A file is not always named after its notebook: failing the name,
        // the one notebook with as many notes as the export is taken.
        let sized: Vec<_> = overview
            .notebooks
            .iter()
            .filter(|notebook| notebook.notes == total)
            .collect();
        let chosen = if !named.is_empty() {
            named
        } else if sized.len() == 1 {
            sized
        } else {
            Vec::new()
        };
        for notebook in chosen {
            found = true;
            println!(
                "Notebook “{}”: {} notes, {} attachments in Evernote’s files; {} not downloaded",
                notebook.name, notebook.notes, notebook.attachments, notebook.notes_not_downloaded
            );
            account.read_notebook(&notebook.id, &mut sink, |note| match note {
                Ok(local) => {
                    let local = as_exported(local);
                    tally.count("notes read from Evernote’s files");
                    let key = (local.title.clone(), local.created_at);
                    match exported.get_mut(&key) {
                        Some(candidates) if candidates.len() == 1 => {
                            let theirs = candidates.pop().expect("one candidate");
                            if theirs.updated_at != local.updated_at {
                                tally.count("notes changed since the export (not compared)");
                            } else {
                                compare(&theirs, &local, &mut tally);
                            }
                        }
                        Some(candidates) if candidates.len() > 1 => {
                            // Several notes with one title and one second of
                            // creation: paired by their text.
                            match candidates
                                .iter()
                                .position(|theirs| theirs.content == local.content)
                            {
                                Some(at) => {
                                    let theirs = candidates.remove(at);
                                    compare(&theirs, &local, &mut tally);
                                }
                                None => tally.count("notes that could not be paired"),
                            }
                        }
                        _ => tally.count("notes in Evernote’s files that the export does not have"),
                    }
                }
                Err((_, reason)) => tally.count(format!("notes not read: {reason}")),
            })?;
        }
    }
    if !found {
        eprintln!(
            "No notebook named “{name}” in Evernote’s files under {} ({} account(s) found).",
            data.display(),
            accounts.len()
        );
        std::process::exit(1);
    }
    let left: usize = exported.values().map(Vec::len).sum();
    if left > 0 {
        tally.0.insert(
            "notes of the export that Evernote’s files do not have".into(),
            left as u64,
        );
    }
    for (what, count) in &tally.0 {
        println!("{count:>7}  {what}");
    }
    Ok(())
}
