//! The record a run leaves of itself in the library.
//!
//! A run may go on for hours with nobody watching, and end while nobody is
//! there: stopped by a failure, by the application being closed, by the
//! device going to sleep or off. What is on the screen afterwards is then
//! all there is to go by, and an error alone does not say when the run
//! began, how far it came, or when it ended. This record does. It is written
//! when a run begins, as it goes, and when it ends, so that a run that never
//! got to say how it ended is still there, with the last time it was seen at
//! work.
//!
//! The record is kept on this device only and is never synchronized.
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::remote::TransferMetrics;
use crate::{
    db::Library,
    error::{BeverError, Result},
    models::SyncReport,
};

/// The setting that holds the runs, newest first.
const KEY: &str = "sync.runs";
/// How many runs are kept.
const KEPT: usize = 20;
/// How often, at most, a run that is going writes how far it has come.
const EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunOutcome {
    /// The run is going; or it never got to say how it ended, because the
    /// application was closed or the device went off under it.
    #[default]
    Running,
    Complete,
    /// Stopped on request.
    Stopped,
    Failed,
}

/// One run, as it is remembered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncRun {
    pub started_at: i64,
    /// When the run was last seen at work.
    pub active_at: i64,
    pub ended_at: Option<i64>,
    pub outcome: RunOutcome,
    /// Why the run failed.
    pub message: Option<String>,
    pub pushed: u64,
    pub pulled: u64,
    pub blobs_uploaded: u64,
    pub blobs_downloaded: u64,
    pub bytes_uploaded: u64,
    pub bytes_downloaded: u64,
    /// Notes that were held back, each with a reason in the run's report.
    pub held_back: u64,
    /// Requests that were made again because they did not complete.
    pub retries: u64,
    /// Times the storage service said it was being asked too much.
    pub throttled: u64,
}

impl Library {
    /// The latest runs, newest first. One that is [`RunOutcome::Running`]
    /// while no run is going never got to say how it ended.
    pub fn sync_runs(&self) -> Result<Vec<SyncRun>> {
        Ok(self
            .setting(KEY)?
            .and_then(|runs| serde_json::from_str(&runs).ok())
            .unwrap_or_default())
    }
}

/// Writes the record of one run. Keeping the record is never a reason for a
/// run to fail: what cannot be written is left unwritten.
pub(crate) struct Recorder<'a> {
    library: &'a Library,
    run: SyncRun,
    written: Instant,
}

impl<'a> Recorder<'a> {
    pub(crate) fn begin(library: &'a Library) -> Self {
        let now = Utc::now().timestamp_millis();
        let run = SyncRun {
            started_at: now,
            active_at: now,
            ..SyncRun::default()
        };
        let mut runs = library.sync_runs().unwrap_or_default();
        runs.insert(0, run.clone());
        runs.truncate(KEPT);
        let recorder = Self {
            library,
            run,
            written: Instant::now(),
        };
        recorder.write(runs);
        recorder
    }

    /// Notes how far the run has come. Called often; written now and then.
    pub(crate) fn seen(&mut self, report: &SyncReport, metrics: TransferMetrics) {
        self.take(report, metrics);
        if self.written.elapsed() >= EVERY {
            self.save();
        }
    }

    pub(crate) fn end(
        &mut self,
        result: &Result<()>,
        report: &SyncReport,
        metrics: TransferMetrics,
    ) {
        self.take(report, metrics);
        self.run.ended_at = Some(self.run.active_at);
        (self.run.outcome, self.run.message) = match result {
            Ok(()) => (RunOutcome::Complete, None),
            Err(BeverError::Cancelled) => (RunOutcome::Stopped, None),
            Err(error) => (RunOutcome::Failed, Some(error.to_string())),
        };
        self.save();
    }

    fn take(&mut self, report: &SyncReport, metrics: TransferMetrics) {
        self.run.active_at = Utc::now().timestamp_millis();
        self.run.pushed = report.pushed;
        self.run.pulled = report.pulled;
        self.run.blobs_uploaded = report.blobs_uploaded;
        self.run.blobs_downloaded = report.blobs_downloaded;
        self.run.held_back = report.warnings.len() as u64;
        self.run.bytes_uploaded = metrics.bytes_uploaded;
        self.run.bytes_downloaded = metrics.bytes_downloaded;
        self.run.retries = metrics.retries;
        self.run.throttled = metrics.throttled;
    }

    fn save(&mut self) {
        let mut runs = self.library.sync_runs().unwrap_or_default();
        match runs
            .iter_mut()
            .find(|run| run.started_at == self.run.started_at)
        {
            Some(run) => *run = self.run.clone(),
            None => runs.insert(0, self.run.clone()),
        }
        self.write(runs);
        self.written = Instant::now();
    }

    fn write(&self, runs: Vec<SyncRun>) {
        if let Ok(runs) = serde_json::to_string(&runs) {
            let _ = self.library.set_setting(KEY, &runs);
        }
    }
}
