//! Minimal adapter for what only the platform can do.
//!
//! On Android this is a small Kotlin plugin: a foreground service that keeps
//! synchronization alive, and access to picked files and other applications.
//! Desktop needs none of it: the tray keeps the process alive, and files and
//! applications are reached directly. Future platforms extend this adapter
//! without changing the shared engine.
#[cfg(target_os = "android")]
use bever_core::{
    error::{BeverError, Result as BeverResult},
    models::SyncProgress,
};
#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::plugin::{PluginApi, PluginHandle};

#[cfg(target_os = "android")]
pub(crate) struct SyncPlatform {
    handle: PluginHandle<tauri::Wry>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceMessage {
    message: String,
    current: u64,
    total: u64,
}

/// What Android knows about a file the user picked.
#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedFileInfo {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) size: u64,
    #[serde(default)]
    pub(crate) mime: Option<String>,
}

#[cfg(target_os = "android")]
impl SyncPlatform {
    pub(crate) fn register<C: serde::de::DeserializeOwned>(
        api: PluginApi<tauri::Wry, C>,
    ) -> BeverResult<Self> {
        let handle = api
            .register_android_plugin("io.github.balakrishnangithub.bever", "SyncPlugin")
            .map_err(|error| BeverError::Invalid(error.to_string()))?;
        Ok(Self { handle })
    }

    pub(crate) fn start(&self) -> BeverResult<()> {
        self.handle
            .run_mobile_plugin::<()>(
                "start",
                ServiceMessage {
                    message: "Preparing synchronization…".into(),
                    current: 0,
                    total: 0,
                },
            )
            .map_err(|error| {
                BeverError::Invalid(format!("cannot start Android background sync: {error}"))
            })
    }

    pub(crate) fn progress(&self, progress: &SyncProgress) {
        let _ = self.handle.run_mobile_plugin::<()>(
            "progress",
            ServiceMessage {
                message: progress.message.clone(),
                current: progress.current,
                total: progress.total,
            },
        );
    }

    pub(crate) fn finish(&self, message: &str) {
        let _ = self.handle.run_mobile_plugin::<()>(
            "finish",
            ServiceMessage {
                message: message.into(),
                current: 0,
                total: 0,
            },
        );
    }

    /// Display name, size, and type of a `content://` URI, when the provider
    /// behind it reports them.
    pub(crate) fn file_info(&self, uri: &str) -> Option<PickedFileInfo> {
        self.handle
            .run_mobile_plugin::<PickedFileInfo>("fileInfo", serde_json::json!({ "uri": uri }))
            .ok()
            .filter(|info| !info.name.is_empty())
    }

    /// Opens a file from the application's cache in another application.
    pub(crate) fn open_file(&self, path: &str, mime: &str) -> BeverResult<()> {
        self.handle
            .run_mobile_plugin::<()>(
                "openFile",
                serde_json::json!({ "path": path, "mime": mime }),
            )
            .map_err(|error| {
                BeverError::Invalid(format!("no application could open the attachment: {error}"))
            })
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) struct SyncPlatform;

#[cfg(not(target_os = "android"))]
impl SyncPlatform {
    pub(crate) fn start(&self) -> bever_core::Result<()> {
        Ok(())
    }

    pub(crate) fn progress(&self, _progress: &bever_core::models::SyncProgress) {}

    pub(crate) fn finish(&self, _message: &str) {}
}
