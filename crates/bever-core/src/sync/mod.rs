//! Revisioned, conflict-preserving synchronization with no application server.
//!
//! One run does, in order: merge remote notebooks, tags and shortcuts; apply
//! remote notes; carry out deletions recorded by other devices; upload local
//! notes and deletions; upload the merged metadata. A run that is interrupted
//! leaves both sides consistent and the next run continues from there.
//!
//! A run asks the remote for as little as it can. Two listings tell it what
//! changed there, because a listing gives every file's version; a run with
//! nothing to do makes those two requests and no others.
//!
//! A run can be stopped at any moment ([`Cancel`]), and it keeps a record of
//! itself in the library ([`SyncRun`]), so that what happened to a run that
//! nobody watched can be read afterwards.
pub mod folder;
mod history;
mod metadata;
mod notes;
pub mod remote;
#[cfg(test)]
mod tests;
mod transfer;
pub(crate) mod transport;

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use chrono::Utc;

pub use history::{RunOutcome, SyncRun};
pub(crate) use notes::mark_needs_push;
pub use remote::{Listing, RemoteFile, RemoteStore, TransferMetrics};

use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{SyncProgress, SyncReport},
    pcloud::{PCloudClient, PCloudCredentials},
};

/// Folder a library synchronizes with unless told otherwise.
pub const DEFAULT_REMOTE_ROOT: &str = "/Bever";

/// A request to stop a run, shared by the run and by whoever may stop it.
/// Stopping is not undone: a new run takes a new one.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Asks the run to stop. It returns [`BeverError::Cancelled`] as soon
    /// as it notices, which is at once for a transfer under way.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(BeverError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone)]
pub struct SyncOptions {
    /// Absolute remote folder holding this library, without a trailing slash.
    pub remote_root: String,
    /// Stops the run when set.
    pub cancel: Cancel,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            remote_root: DEFAULT_REMOTE_ROOT.to_owned(),
            cancel: Cancel::new(),
        }
    }
}

/// Remote paths of one synchronized library.
pub(crate) struct Layout {
    pub(crate) root: String,
}

impl Layout {
    fn new(root: &str) -> Result<Self> {
        if !folder::is_folder_path(root) {
            return Err(BeverError::Invalid(format!(
                "invalid remote folder: {root}"
            )));
        }
        Ok(Self {
            root: root.to_owned(),
        })
    }

    pub(crate) fn items(&self) -> String {
        format!("{}/{ITEMS}", self.root)
    }

    pub(crate) fn blobs(&self) -> String {
        format!("{}/{BLOBS}", self.root)
    }

    pub(crate) fn metadata(&self) -> String {
        format!("{}/{METADATA}", self.root)
    }

    pub(crate) fn blob(&self, sha256: &str) -> String {
        format!("{}/{BLOBS}/{sha256}", self.root)
    }
}

const ITEMS: &str = "items";
const BLOBS: &str = "blobs";
const METADATA: &str = "metadata.json";

/// The name of a note's file in the items folder.
pub(crate) fn note_file(id: &str) -> String {
    format!("note-{id}.json")
}

/// What a run tells of itself as it goes: to whoever watches it, and to the
/// record it leaves in the library.
pub(crate) struct Progress<'a> {
    callback: &'a mut dyn FnMut(SyncProgress),
    remote: &'a dyn RemoteStore,
    started: Instant,
    cancel: &'a Cancel,
    record: history::Recorder<'a>,
}

impl Progress<'_> {
    pub(crate) fn emit(
        &mut self,
        phase: &str,
        message: impl Into<String>,
        current: u64,
        total: u64,
    ) {
        let metrics = self.remote.metrics();
        (self.callback)(SyncProgress {
            phase: phase.to_owned(),
            message: message.into(),
            current,
            total,
            elapsed_ms: elapsed_ms(self.started),
            network_ms: metrics.network_ms,
            remote_requests: metrics.remote_requests,
            bytes_uploaded: metrics.bytes_uploaded,
            bytes_downloaded: metrics.bytes_downloaded,
            retries: metrics.retries,
        });
    }

    /// The request to stop this run, for work that is handed to other
    /// threads.
    pub(crate) fn cancel(&self) -> Cancel {
        self.cancel.clone()
    }

    /// Ends the run here when it was asked to stop.
    pub(crate) fn check(&self) -> Result<()> {
        self.cancel.check()
    }

    /// Notes how far the run has come, for the record.
    pub(crate) fn seen(&mut self, report: &SyncReport) {
        self.record.seen(report, self.remote.metrics());
    }
}

pub fn sync_with_pcloud(library: &Library, credentials: PCloudCredentials) -> Result<SyncReport> {
    sync_with_pcloud_progress(library, credentials, |_| {})
}

pub fn sync_with_pcloud_progress(
    library: &Library,
    credentials: PCloudCredentials,
    progress: impl FnMut(SyncProgress),
) -> Result<SyncReport> {
    let client = PCloudClient::new(credentials)?;
    sync_with_remote(library, &client, &SyncOptions::default(), progress)
}

pub fn sync_with_remote(
    library: &Library,
    remote: &dyn RemoteStore,
    options: &SyncOptions,
    progress: impl FnMut(SyncProgress),
) -> Result<SyncReport> {
    let layout = Layout::new(&options.remote_root)?;
    let mut callback = progress;
    let mut progress = Progress {
        callback: &mut callback,
        remote,
        started: Instant::now(),
        cancel: &options.cancel,
        record: history::Recorder::begin(library),
    };
    let mut report = SyncReport::default();
    let result = run(library, remote, &layout, &mut report, &mut progress);
    // A transfer that was cut off by stopping fails in a way of its own.
    // What happened is that the run was stopped.
    let result = match result {
        Err(_) if options.cancel.is_cancelled() => Err(BeverError::Cancelled),
        other => other,
    };
    let metrics = remote.metrics();
    report.duration_ms = elapsed_ms(progress.started);
    report.network_ms = metrics.network_ms;
    report.remote_requests = metrics.remote_requests;
    report.bytes_uploaded = metrics.bytes_uploaded;
    report.bytes_downloaded = metrics.bytes_downloaded;
    report.retries = metrics.retries;
    report.throttled = metrics.throttled;
    progress.record.end(&result, &report, metrics);
    result?;
    progress.emit("complete", "Synchronization complete", 0, 0);
    Ok(report)
}

fn run(
    library: &Library,
    remote: &dyn RemoteStore,
    layout: &Layout,
    report: &mut SyncReport,
    progress: &mut Progress<'_>,
) -> Result<()> {
    progress.check()?;
    progress.emit("preparing", "Connecting and preparing sync folders", 0, 0);
    // The folders are there on every run but the first, and the listing that
    // a run needs anyway says so. Only a missing one is made. The same
    // listing says which library the folder holds, and a run goes on only
    // when that is this one.
    let listed = remote.list(&layout.root)?;
    let unmarked = folder::recognise(library, remote, layout, listed.as_ref())?;
    let root = match listed {
        Some(listing) => listing,
        None => {
            remote.ensure_folder(&layout.root)?;
            Listing::default()
        }
    };
    let folders = notes::Folders {
        items: root.has_folder(ITEMS),
        blobs: root.has_folder(BLOBS),
    };
    if !folders.items {
        remote.ensure_folder(&layout.items())?;
    }
    if !folders.blobs {
        remote.ensure_folder(&layout.blobs())?;
    }

    progress.check()?;
    let remote_metadata = metadata::pull(library, remote, layout, root.file(METADATA), progress)?;
    progress.check()?;
    let mut session = notes::Session::open(library, remote, layout, folders, progress)?;
    session.pull(report, progress)?;
    metadata::apply_tombstones(library)?;
    session.push(report, progress)?;
    progress.check()?;
    metadata::push(library, remote, layout, remote_metadata, progress)?;
    if unmarked {
        // Last, when the folder holds what the library has.
        folder::mark(library, remote, layout)?;
    }

    progress.emit("finalizing", "Finishing synchronization", 0, 0);
    library.optimize()?;
    report.synced_at = Utc::now().timestamp_millis();
    library.set_setting("last_sync_at", &report.synced_at.to_string())?;
    Ok(())
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
