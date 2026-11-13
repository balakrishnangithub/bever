//! Imports notebooks from the Evernote application's own files into a
//! library, without the interface.
//!
//! ```text
//! cargo run --release -p bever-core --example import_evernote_local -- \
//!     <library folder> [notebook name]...
//! ```
//!
//! With no names, every notebook is imported. Evernote's files are only
//! read. `EVERNOTE_DATA_DIR` names another folder of Evernote data than the
//! system's own.

use std::{path::PathBuf, sync::atomic::AtomicBool, time::Instant};

use bever_core::{
    evernote_local::{default_data_dir, find_accounts, import_local, LocalImportOptions},
    Library, Result,
};

fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1);
    let Some(library_dir) = arguments.next() else {
        eprintln!("usage: import_evernote_local <library folder> [notebook name]...");
        std::process::exit(2);
    };
    let names: Vec<String> = arguments.collect();
    let data = std::env::var_os("EVERNOTE_DATA_DIR")
        .map(PathBuf::from)
        .or_else(default_data_dir)
        .expect("no folder of Evernote data is known on this system");
    let accounts = find_accounts(&data);
    let Some(account) = accounts.first() else {
        eprintln!("No Evernote account was found under {}.", data.display());
        std::process::exit(1);
    };
    let overview = account.overview()?;
    let ids: Option<Vec<String>> = (!names.is_empty()).then(|| {
        overview
            .notebooks
            .iter()
            .filter(|notebook| {
                names
                    .iter()
                    .any(|name| name.eq_ignore_ascii_case(&notebook.name))
            })
            .map(|notebook| notebook.id.clone())
            .collect()
    });
    let library = Library::open(library_dir)?;
    let started = Instant::now();
    let mut last = Instant::now();
    let report = import_local(
        &library,
        account,
        ids.as_deref(),
        LocalImportOptions::default(),
        &AtomicBool::new(false),
        |progress| {
            if last.elapsed().as_secs() >= 5 {
                last = Instant::now();
                eprintln!(
                    "{} of {} notes, notebook {} of {}",
                    progress.note_index,
                    progress.note_count,
                    progress.notebook_index,
                    progress.notebook_count
                );
            }
        },
    )?;
    println!(
        "Imported {} notes and {} attachments ({} bytes) from {} notebooks in {:.2?}; {} brought up to date, {} added beside a note changed here, {} already present, {} not imported, {} links resolved, {} images queued for text recognition. Library now holds {} notes.",
        report.notes_imported,
        report.resources_imported,
        report.bytes_imported,
        report.notebooks,
        started.elapsed(),
        report.notes_updated,
        report.notes_kept_both,
        report.notes_skipped,
        report.notes_failed,
        report.links_resolved,
        report.images_queued,
        library.counts()?.all,
    );
    for warning in &report.warnings {
        println!("  {warning}");
    }
    Ok(())
}
