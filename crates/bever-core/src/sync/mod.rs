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
mod metadata;
mod notes;
pub mod remote;
#[cfg(test)]
mod tests;
mod transfer;

use std::time::Instant;

use chrono::Utc;

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

#[derive(Debug, Clone)]
pub struct SyncOptions {
    /// Absolute remote folder holding this library, without a trailing slash.
    pub remote_root: String,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            remote_root: DEFAULT_REMOTE_ROOT.to_owned(),
        }
    }
}

/// Remote paths of one synchronized library.
pub(crate) struct Layout {
    pub(crate) root: String,
}

impl Layout {
    fn new(root: &str) -> Result<Self> {
        let valid = root.starts_with('/')
            && root.len() > 1
            && !root.ends_with('/')
            && !root.contains("//")
            && !root.split('/').any(|part| part == "." || part == "..");
        if !valid {
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

pub(crate) struct Progress<'a> {
    callback: &'a mut dyn FnMut(SyncProgress),
    remote: &'a dyn RemoteStore,
    started: Instant,
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
        });
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
    };
    progress.emit("preparing", "Connecting and preparing sync folders", 0, 0);
    // The folders are there on every run but the first, and the listing that
    // a run needs anyway says so. Only a missing one is made.
    let root = match remote.list(&layout.root)? {
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

    let mut report = SyncReport::default();
    let remote_metadata =
        metadata::pull(library, remote, &layout, root.file(METADATA), &mut progress)?;
    let mut session = notes::Session::open(library, remote, &layout, folders, &mut progress)?;
    session.pull(&mut report, &mut progress)?;
    metadata::apply_tombstones(library)?;
    session.push(&mut report, &mut progress)?;
    metadata::push(library, remote, &layout, remote_metadata, &mut progress)?;

    progress.emit("finalizing", "Finishing synchronization", 0, 0);
    library.optimize()?;
    report.synced_at = Utc::now().timestamp_millis();
    library.set_setting("last_sync_at", &report.synced_at.to_string())?;
    let metrics = remote.metrics();
    report.duration_ms = elapsed_ms(progress.started);
    report.network_ms = metrics.network_ms;
    report.remote_requests = metrics.remote_requests;
    report.bytes_uploaded = metrics.bytes_uploaded;
    report.bytes_downloaded = metrics.bytes_downloaded;
    progress.emit("complete", "Synchronization complete", 0, 0);
    Ok(report)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
