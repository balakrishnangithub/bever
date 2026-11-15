//! Process-wide ownership of the single pCloud synchronization worker.
//!
//! The worker deliberately stays in this process: closing a window never owns
//! or cancels the engine. This controller serializes runs and snapshots, and
//! holds what stops the run that is going.
use std::sync::Mutex;

use bever_core::{
    models::{SyncProgress, SyncReport},
    sync::Cancel,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    pub(crate) revision: u64,
    pub(crate) run_id: u64,
    pub(crate) running: bool,
    /// The run was asked to stop and has not ended yet.
    pub(crate) stopping: bool,
    pub(crate) progress: SyncProgress,
    pub(crate) last_report: Option<SyncReport>,
    pub(crate) error: Option<String>,
    /// The last run ended because it was asked to stop.
    pub(crate) stopped: bool,
}

/// How a run ended.
#[derive(Debug)]
pub(crate) enum RunEnd {
    Complete(SyncReport),
    /// Stopped on request: not a failure, and nothing to report.
    Stopped,
    Failed(String),
}

fn progress(phase: &str, message: &str) -> SyncProgress {
    SyncProgress {
        phase: phase.into(),
        message: message.into(),
        current: 0,
        total: 0,
        elapsed_ms: 0,
        network_ms: 0,
        remote_requests: 0,
        bytes_uploaded: 0,
        bytes_downloaded: 0,
        retries: 0,
    }
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            revision: 0,
            run_id: 0,
            running: false,
            stopping: false,
            progress: progress("idle", "Synchronize when you are ready"),
            last_report: None,
            error: None,
            stopped: false,
        }
    }
}

#[derive(Debug, Default)]
struct Run {
    status: SyncStatus,
    /// Stops the run that is going. A new run takes a new one.
    cancel: Cancel,
}

#[derive(Debug, Default)]
pub(crate) struct SyncController {
    run: Mutex<Run>,
}

impl SyncController {
    pub(crate) fn status(&self) -> SyncStatus {
        self.run.lock().expect("sync mutex poisoned").status.clone()
    }

    pub(crate) fn is_running(&self) -> bool {
        self.status().running
    }

    /// Atomically reserves a run and returns its id and what stops it, or
    /// `None` when a run is already in progress. Whoever receives an id
    /// starts the one worker and must eventually call
    /// [`SyncController::finish`] with it.
    pub(crate) fn begin(&self) -> Option<(u64, Cancel)> {
        let mut run = self.run.lock().expect("sync mutex poisoned");
        if run.status.running {
            return None;
        }
        let run_id = run.status.run_id.saturating_add(1).max(1);
        run.status = SyncStatus {
            revision: run.status.revision.saturating_add(1),
            run_id,
            running: true,
            stopping: false,
            progress: progress("preparing", "Preparing synchronization…"),
            last_report: None,
            error: None,
            stopped: false,
        };
        run.cancel = Cancel::new();
        Some((run_id, run.cancel.clone()))
    }

    /// Asks the run that is going to stop. Returns the status to publish,
    /// or `None` when no run is going or it was already asked.
    pub(crate) fn stop(&self) -> Option<SyncStatus> {
        let mut run = self.run.lock().expect("sync mutex poisoned");
        if !run.status.running || run.status.stopping {
            return None;
        }
        run.cancel.cancel();
        run.status.stopping = true;
        run.status.progress.message = "Stopping synchronization…".into();
        run.status.revision = run.status.revision.saturating_add(1);
        Some(run.status.clone())
    }

    pub(crate) fn update(&self, run_id: u64, progress: SyncProgress) -> Option<SyncStatus> {
        let mut run = self.run.lock().expect("sync mutex poisoned");
        let status = &mut run.status;
        if status.run_id != run_id || !status.running {
            return None;
        }
        // What a transfer that was under way still reports does not take
        // back that the run is stopping.
        let message = status
            .stopping
            .then(|| std::mem::take(&mut status.progress.message));
        status.progress = progress;
        if let Some(message) = message {
            status.progress.message = message;
        }
        status.revision = status.revision.saturating_add(1);
        Some(status.clone())
    }

    pub(crate) fn finish(&self, run_id: u64, end: RunEnd) -> Option<SyncStatus> {
        let mut run = self.run.lock().expect("sync mutex poisoned");
        let status = &mut run.status;
        if status.run_id != run_id || !status.running {
            return None;
        }
        match end {
            RunEnd::Complete(report) => status.last_report = Some(report),
            RunEnd::Stopped => status.stopped = true,
            RunEnd::Failed(error) => status.error = Some(error),
        }
        status.running = false;
        status.stopping = false;
        status.revision = status.revision.saturating_add(1);
        Some(status.clone())
    }
}

#[cfg(test)]
mod tests {
    use bever_core::models::SyncReport;

    use super::{RunEnd, SyncController};

    #[test]
    fn only_one_run_can_be_reserved_at_a_time() {
        let controller = SyncController::default();
        let (first, _) = controller.begin().unwrap();
        assert!(controller.begin().is_none());
        assert!(controller.status().running);
        assert_eq!(controller.status().run_id, first);
        controller
            .finish(first, RunEnd::Complete(SyncReport::default()))
            .unwrap();

        // Many callers racing for the next run: exactly one wins.
        let winners = std::thread::scope(|scope| {
            let handles = (0..16)
                .map(|_| scope.spawn(|| controller.begin().is_some()))
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|won| *won)
                .count()
        });
        assert_eq!(winners, 1);
    }

    #[test]
    fn terminal_state_survives_worker_exit_and_next_run_resets_it() {
        let controller = SyncController::default();
        let (first, _) = controller.begin().unwrap();
        let report = SyncReport {
            pushed: 3,
            ..SyncReport::default()
        };
        controller
            .finish(first, RunEnd::Complete(report.clone()))
            .unwrap();
        assert!(!controller.status().running);
        assert_eq!(controller.status().last_report, Some(report));
        let (second, _) = controller.begin().unwrap();
        assert_ne!(first, second);
        assert!(controller.status().running);
        assert_eq!(controller.status().last_report, None);
        assert_eq!(controller.status().error, None);
        controller
            .finish(second, RunEnd::Failed("network unavailable".into()))
            .unwrap();
        assert_eq!(
            controller.status().error.as_deref(),
            Some("network unavailable")
        );
    }

    #[test]
    fn stale_completion_and_progress_cannot_overwrite_a_new_run() {
        let controller = SyncController::default();
        let (first, _) = controller.begin().unwrap();
        controller.finish(first, RunEnd::Failed("first failure".into()));
        let (second, _) = controller.begin().unwrap();
        assert!(controller
            .finish(first, RunEnd::Complete(SyncReport::default()))
            .is_none());
        assert!(controller
            .update(first, controller.status().progress)
            .is_none());
        assert!(controller.status().running);
        assert_eq!(controller.status().run_id, second);
        assert_eq!(controller.status().last_report, None);
        assert_eq!(controller.status().error, None);
    }

    #[test]
    fn failed_platform_start_releases_the_run() {
        let controller = SyncController::default();
        let (run, _) = controller.begin().unwrap();
        controller
            .finish(run, RunEnd::Failed("foreground service unavailable".into()))
            .unwrap();
        assert!(!controller.status().running);
        assert!(controller.begin().is_some());
    }

    #[test]
    fn stopping_reaches_the_run_that_is_going_and_no_other() {
        let controller = SyncController::default();
        // Nothing to stop.
        assert!(controller.stop().is_none());

        let (first, cancel) = controller.begin().unwrap();
        assert!(!cancel.is_cancelled());
        let stopping = controller.stop().unwrap();
        assert!(cancel.is_cancelled());
        assert!(stopping.running && stopping.stopping);
        // Asked twice, it is stopped once.
        assert!(controller.stop().is_none());
        // A transfer that was under way may still report; the run is
        // stopping all the same, and says so.
        let mut late = controller.status().progress;
        late.message = "Uploading attachments (12): picture.png".into();
        late.bytes_uploaded = 7;
        let shown = controller.update(first, late).unwrap();
        assert_eq!(shown.progress.message, "Stopping synchronization…");
        assert_eq!(shown.progress.bytes_uploaded, 7);

        let ended = controller.finish(first, RunEnd::Stopped).unwrap();
        assert!(!ended.running && !ended.stopping && ended.stopped);
        assert_eq!((ended.error, ended.last_report), (None, None));

        // The next run is a run of its own: not stopped, and not stopping.
        let (_, next) = controller.begin().unwrap();
        assert!(!next.is_cancelled());
        let status = controller.status();
        assert!(status.running && !status.stopping && !status.stopped);
    }
}
