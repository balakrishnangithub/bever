//! Background text recognition for images in notes.
//!
//! Import, attaching, and synchronization only queue images. One worker
//! thread recognises them afterwards, so those operations stay fast and the
//! work resumes after a restart. Switching the setting off pauses the worker
//! after the image in progress.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use bever_core::{
    ocr::{process_ocr_queue, LocalOcr},
    Library,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{blocking, commands::ocr_enabled, AppState};

#[derive(Default)]
pub(crate) struct OcrWorker {
    running: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OcrStatus {
    enabled: bool,
    /// Images still waiting, including the one in progress.
    pending: u64,
    running: bool,
}

impl OcrWorker {
    /// Starts the worker when there may be work and it is not already going.
    /// Cheap to call after anything that could have queued an image.
    pub(crate) fn wake(self: &Arc<Self>, app: &AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let worker = Arc::clone(self);
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("bever-ocr".into())
            .spawn(move || worker.run(&app));
        if spawned.is_err() {
            self.running.store(false, Ordering::SeqCst);
        }
    }

    fn status(&self, library: &Library) -> OcrStatus {
        OcrStatus {
            enabled: ocr_enabled(library).unwrap_or(false),
            pending: library.ocr_pending().unwrap_or(0),
            running: self.running.load(Ordering::SeqCst),
        }
    }

    fn publish(&self, app: &AppHandle, library: &Library) {
        let _ = app.emit("bever:ocr-status", self.status(library));
    }

    fn run(&self, app: &AppHandle) {
        let state = AppState::of(app);
        let library = &state.library;
        let has_work = |library: &Library| {
            ocr_enabled(library).unwrap_or(false) && library.ocr_pending().unwrap_or(0) > 0
        };
        loop {
            if has_work(library) {
                self.publish(app, library);
                // The models are large; they are loaded only while needed.
                if let Ok(mut engine) = LocalOcr::new() {
                    let mut published = Instant::now();
                    let _ = process_ocr_queue(
                        library,
                        &mut engine,
                        || ocr_enabled(library).unwrap_or(false),
                        |_| {
                            if published.elapsed() >= Duration::from_millis(750) {
                                published = Instant::now();
                                self.publish(app, library);
                            }
                        },
                    );
                } else {
                    // Without the models nothing can be recognised; retrying
                    // in a loop would only burn power.
                    self.running.store(false, Ordering::SeqCst);
                    self.publish(app, library);
                    return;
                }
            }
            self.running.store(false, Ordering::SeqCst);
            self.publish(app, library);
            // An image queued just before the flag was cleared found the
            // worker "running" and did not start another; pick it up here.
            if !has_work(library) || self.running.swap(true, Ordering::SeqCst) {
                return;
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn ocr_status(app: AppHandle) -> Result<OcrStatus, String> {
    blocking(&app, |_, state| Ok(state.ocr.status(&state.library))).await
}
