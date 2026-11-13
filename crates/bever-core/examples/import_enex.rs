//! Imports an ENEX file into a library directory and prints a summary.
//!
//! ```sh
//! cargo run --release -p bever-core --example import_enex -- notes.enex data-dir [notebook] [--ocr]
//! ```
//!
//! Note titles and contents are never printed, so the output is safe to share.
use std::{env, path::PathBuf, time::Instant};

use bever_core::{
    enex::import_enex,
    ocr::{process_ocr_queue, LocalOcr},
    BeverError, Library,
};

fn main() -> bever_core::Result<()> {
    let mut arguments = env::args_os().skip(1).collect::<Vec<_>>();
    let run_ocr = arguments.iter().any(|argument| argument == "--ocr");
    arguments.retain(|argument| argument != "--ocr");
    let mut arguments = arguments.into_iter();
    let input = arguments.next().map(PathBuf::from).ok_or_else(|| {
        BeverError::Invalid(
            "usage: import_enex <input.enex> <data-directory> [notebook-name] [--ocr]".into(),
        )
    })?;
    let data_directory = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| BeverError::Invalid("a data directory is required".into()))?;
    let notebook_name = arguments
        .next()
        .map(|name| name.to_string_lossy().into_owned());

    let library = Library::open(data_directory)?;
    let started = Instant::now();
    let report = import_enex(&library, input, notebook_name.as_deref())?;
    let counts = library.counts()?;
    let snapshot = library.snapshot()?;
    println!(
        "Imported {} notes, {} attachments ({} bytes) in {:.2?}; {} already present, {} unreadable, {} links resolved, {} images queued for text recognition. Library now holds {} notes and {} tags.",
        report.notes_imported,
        report.resources_imported,
        report.bytes_imported,
        started.elapsed(),
        report.notes_skipped,
        report.notes_failed,
        report.links_resolved,
        report.images_queued,
        counts.all,
        snapshot.tags.len(),
    );
    println!("{} warnings", report.warnings.len());

    if run_ocr {
        let started = Instant::now();
        let mut engine = LocalOcr::new()?;
        let processed = process_ocr_queue(&library, &mut engine, || true, |_| {})?;
        println!(
            "Recognised text in {processed} images in {:.2?}.",
            started.elapsed()
        );
    }
    Ok(())
}
