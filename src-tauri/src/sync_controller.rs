//! Process-wide ownership of the single pCloud synchronization worker.
//!
//! The worker deliberately stays in this process: closing a window never owns
//! or cancels the engine. This controller only serializes runs and snapshots.
use std::sync::Mutex;

use bever_core::models::{SyncProgress, SyncReport};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncStatus {
    pub(crate) revision: u64,
    pub(crate) run_id: u64,
    pub(crate) running: bool,
    pub(crate) progress: SyncProgress,
    pub(crate) last_report: Option<SyncReport>,
    pub(crate) error: Option<String>,
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
    }
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            revision: 0,
            run_id: 0,
            running: false,
            progress: progress("idle", "Synchronize when you are ready"),
            last_report: None,
            error: None,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct SyncController {
    status: Mutex<SyncStatus>,
}

impl SyncController {
    pub(crate) fn status(&self) -> SyncStatus {
        self.status.lock().expect("sync mutex poisoned").clone()
    }

    pub(crate) fn is_running(&self) -> bool {
        self.status().running
    }

    /// Atomically reserves a run and returns its id, or `None` when a run is
    /// already in progress. Whoever receives an id starts the one worker and
    /// must eventually call [`SyncController::finish`] with it.
    pub(crate) fn begin(&self) -> Option<u64> {
        let mut status = self.status.lock().expect("sync mutex poisoned");
        if status.running {
            return None;
        }
        let run_id = status.run_id.saturating_add(1).max(1);
        *status = SyncStatus {
            revision: status.revision.saturating_add(1),
            run_id,
            running: true,
            progress: progress("preparing", "Preparing synchronization…"),
            last_report: None,
            error: None,
        };
        Some(run_id)
    }

    pub(crate) fn update(&self, run_id: u64, progress: SyncProgress) -> Option<SyncStatus> {
        let mut status = self.status.lock().expect("sync mutex poisoned");
        if status.run_id != run_id || !status.running {
            return None;
        }
        status.progress = progress;
        status.revision = status.revision.saturating_add(1);
        Some(status.clone())
    }

    pub(crate) fn finish(
        &self,
        run_id: u64,
        result: Result<SyncReport, String>,
    ) -> Option<SyncStatus> {
        let mut status = self.status.lock().expect("sync mutex poisoned");
        if status.run_id != run_id || !status.running {
            return None;
        }
        match result {
            Ok(report) => status.last_report = Some(report),
            Err(error) => status.error = Some(error),
        }
        status.running = false;
        status.revision = status.revision.saturating_add(1);
        Some(status.clone())
    }
}

#[cfg(test)]
mod tests {
    use bever_core::models::SyncReport;

    use super::SyncController;

    #[test]
    fn only_one_run_can_be_reserved_at_a_time() {
        let controller = SyncController::default();
        let first = controller.begin().unwrap();
        assert!(controller.begin().is_none());
        assert!(controller.status().running);
        assert_eq!(controller.status().run_id, first);
        controller.finish(first, Ok(SyncReport::default())).unwrap();

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
        let first = controller.begin().unwrap();
        let report = SyncReport {
            pushed: 3,
            ..SyncReport::default()
        };
        controller.finish(first, Ok(report.clone())).unwrap();
        assert!(!controller.status().running);
        assert_eq!(controller.status().last_report, Some(report));
        let second = controller.begin().unwrap();
        assert_ne!(first, second);
        assert!(controller.status().running);
        assert_eq!(controller.status().last_report, None);
        assert_eq!(controller.status().error, None);
        controller
            .finish(second, Err("network unavailable".into()))
            .unwrap();
        assert_eq!(
            controller.status().error.as_deref(),
            Some("network unavailable")
        );
    }

    #[test]
    fn stale_completion_and_progress_cannot_overwrite_a_new_run() {
        let controller = SyncController::default();
        let first = controller.begin().unwrap();
        controller.finish(first, Err("first failure".into()));
        let second = controller.begin().unwrap();
        assert!(controller
            .finish(first, Ok(SyncReport::default()))
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
        let run = controller.begin().unwrap();
        controller
            .finish(run, Err("foreground service unavailable".into()))
            .unwrap();
        assert!(!controller.status().running);
        assert!(controller.begin().is_some());
    }
}
