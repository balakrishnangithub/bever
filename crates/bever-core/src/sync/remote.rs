//! The storage a library synchronizes with, reduced to what sync needs.
//!
//! Keeping this behind a trait lets the engine run against pCloud in the
//! application and against an in-memory store in tests.
//!
//! Every method that reaches the store costs requests, and a run is judged by
//! how few it needs. So a listing says enough to tell that a file has not
//! changed, a missing folder is an answer rather than an error, and several
//! small files travel in one upload.
use std::{io::Read, path::Path};

use crate::error::{BeverError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    pub name: String,
    pub size: u64,
    /// Stands for the file's content: it is different whenever the content
    /// is, and the same for the same content. Empty when the store cannot
    /// say, which the engine treats as "may have changed".
    pub version: String,
}

/// What a folder holds directly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listing {
    pub files: Vec<RemoteFile>,
    /// Names of the folders directly inside.
    pub folders: Vec<String>,
}

impl Listing {
    pub fn file(&self, name: &str) -> Option<&RemoteFile> {
        self.files.iter().find(|file| file.name == name)
    }

    pub fn has_folder(&self, name: &str) -> bool {
        self.folders.iter().any(|folder| folder == name)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TransferMetrics {
    /// Time spent in requests, added up across parallel transfers.
    pub network_ms: u64,
    pub remote_requests: u64,
    pub bytes_uploaded: u64,
    pub bytes_downloaded: u64,
    /// Requests that were made again because they did not complete.
    pub retries: u64,
    /// Times the store said it was being asked too much.
    pub throttled: u64,
}

/// Paths use `/` and are absolute within the remote account.
pub trait RemoteStore: Sync {
    /// Creates a folder when it is missing. Its parent must exist.
    fn ensure_folder(&self, path: &str) -> Result<()>;

    /// What is directly inside a folder, or `None` when there is no such
    /// folder.
    fn list(&self, folder: &str) -> Result<Option<Listing>>;

    fn download(&self, path: &str) -> Result<Vec<u8>>;

    /// Streams a file to `sink`. `sink` may be called again from the start
    /// when a transfer is retried, so it must not keep partial results.
    fn download_to(
        &self,
        path: &str,
        expected_size: u64,
        sink: &mut dyn FnMut(&mut dyn Read) -> Result<()>,
    ) -> Result<()>;

    /// Creates or replaces files, given by name, in one folder, in as few
    /// requests as the store allows. Returns the files as the store now holds
    /// them, in the order they were given. When this fails, some of the files
    /// may have been stored all the same.
    fn upload_all(&self, folder: &str, files: &[(String, Vec<u8>)]) -> Result<Vec<RemoteFile>>;

    /// Creates or replaces one file.
    fn upload(&self, path: &str, bytes: Vec<u8>) -> Result<RemoteFile> {
        let (folder, name) = path
            .rsplit_once('/')
            .filter(|(_, name)| !name.is_empty())
            .ok_or_else(|| BeverError::Invalid("invalid remote file path".into()))?;
        let folder = if folder.is_empty() { "/" } else { folder };
        self.upload_all(folder, &[(name.to_owned(), bytes)])?
            .pop()
            .ok_or_else(|| BeverError::Remote(format!("the upload of {name} was not confirmed")))
    }

    /// Creates or replaces a file from a local file without loading it.
    /// Fails with [`BeverError::Io`] when it is the local file that cannot
    /// be read, which says nothing about the store or the way to it.
    fn upload_file(&self, path: &str, source: &Path, size: u64) -> Result<()>;

    fn metrics(&self) -> TransferMetrics;
}

#[cfg(test)]
pub(crate) mod memory {
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::{
            atomic::{AtomicI64, AtomicU64, Ordering},
            Mutex,
        },
    };

    use sha2::{Digest as _, Sha256};

    use super::*;

    /// An in-memory remote that records what was written and can be told to
    /// start failing, to imitate an interrupted synchronization.
    #[derive(Default)]
    pub(crate) struct MemoryRemote {
        files: Mutex<BTreeMap<String, Vec<u8>>>,
        folders: Mutex<BTreeSet<String>>,
        uploads: Mutex<Vec<String>>,
        downloads: Mutex<Vec<String>>,
        requests: AtomicU64,
        /// Files that may still be stored before storing fails; negative =
        /// no limit.
        uploads_allowed: AtomicI64,
    }

    impl MemoryRemote {
        pub(crate) fn new() -> Self {
            let remote = Self::default();
            remote.uploads_allowed.store(-1, Ordering::SeqCst);
            remote
        }

        /// Lets `count` more files be stored, then fails the rest. A request
        /// that carries several files stores those that still fit and then
        /// fails, like a connection lost in the middle of it.
        pub(crate) fn fail_uploads_after(&self, count: i64) {
            self.uploads_allowed.store(count, Ordering::SeqCst);
        }

        pub(crate) fn stop_failing(&self) {
            self.uploads_allowed.store(-1, Ordering::SeqCst);
        }

        /// Paths uploaded since the last call, in completion order.
        pub(crate) fn take_uploads(&self) -> Vec<String> {
            std::mem::take(&mut self.uploads.lock().unwrap())
        }

        /// Paths downloaded since the last call.
        pub(crate) fn take_downloads(&self) -> Vec<String> {
            std::mem::take(&mut self.downloads.lock().unwrap())
        }

        pub(crate) fn paths(&self) -> Vec<String> {
            self.files.lock().unwrap().keys().cloned().collect()
        }

        pub(crate) fn file(&self, path: &str) -> Option<Vec<u8>> {
            self.files.lock().unwrap().get(path).cloned()
        }

        /// Removes a file, as somebody with the account may.
        pub(crate) fn remove(&self, path: &str) {
            self.files.lock().unwrap().remove(path);
        }

        /// Removes a folder and all that is in it.
        pub(crate) fn remove_folder(&self, folder: &str) {
            let inside = format!("{folder}/");
            let within = |path: &String| path == folder || path.starts_with(&inside);
            self.files.lock().unwrap().retain(|path, _| !within(path));
            self.folders.lock().unwrap().retain(|path| !within(path));
        }

        /// Moves a folder, with all that is in it, to another name.
        pub(crate) fn rename(&self, from: &str, to: &str) {
            let inside = format!("{from}/");
            let moved = |path: &str| {
                (path == from || path.starts_with(&inside))
                    .then(|| format!("{to}{}", &path[from.len()..]))
            };
            let mut files = self.files.lock().unwrap();
            *files = std::mem::take(&mut *files)
                .into_iter()
                .map(|(path, bytes)| (moved(&path).unwrap_or(path), bytes))
                .collect();
            let mut folders = self.folders.lock().unwrap();
            *folders = std::mem::take(&mut *folders)
                .into_iter()
                .map(|path| moved(&path).unwrap_or(path))
                .collect();
        }

        /// Requests made so far.
        pub(crate) fn requests(&self) -> u64 {
            self.requests.load(Ordering::SeqCst)
        }

        fn store(&self, path: &str, bytes: Vec<u8>) -> Result<()> {
            // Taken in one step: uploads run on several threads, and two that
            // both saw the last allowance would take the count below zero,
            // which means "no limit".
            let mut left = self.uploads_allowed.load(Ordering::SeqCst);
            loop {
                if left == 0 {
                    return Err(BeverError::Network("simulated connection loss".into()));
                }
                if left < 0 {
                    break;
                }
                match self.uploads_allowed.compare_exchange(
                    left,
                    left - 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(now) => left = now,
                }
            }
            let (folder, _) = path.rsplit_once('/').expect("absolute path");
            assert!(
                self.folders.lock().unwrap().contains(folder),
                "upload into a folder that was never created: {folder}"
            );
            self.files.lock().unwrap().insert(path.to_owned(), bytes);
            self.uploads.lock().unwrap().push(path.to_owned());
            Ok(())
        }
    }

    /// As pCloud's is, a version here is a short digest of the content.
    fn version_of(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))[..16].to_owned()
    }

    impl RemoteStore for MemoryRemote {
        fn ensure_folder(&self, path: &str) -> Result<()> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            self.folders.lock().unwrap().insert(path.to_owned());
            Ok(())
        }

        fn list(&self, folder: &str) -> Result<Option<Listing>> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            let folders = self.folders.lock().unwrap();
            // The top is always there, and is the one folder whose name
            // ends as the names inside it begin.
            let top = folder == "/";
            if !top && !folders.contains(folder) {
                return Ok(None);
            }
            let prefix = if top {
                "/".to_owned()
            } else {
                format!("{folder}/")
            };
            let directly_inside = |path: &str| {
                path.strip_prefix(&prefix)
                    .filter(|name| !name.contains('/'))
                    .map(str::to_owned)
            };
            Ok(Some(Listing {
                files: self
                    .files
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|(path, bytes)| {
                        Some(RemoteFile {
                            name: directly_inside(path)?,
                            size: bytes.len() as u64,
                            version: version_of(bytes),
                        })
                    })
                    .collect(),
                folders: folders
                    .iter()
                    .filter_map(|path| directly_inside(path))
                    .collect(),
            }))
        }

        fn download(&self, path: &str) -> Result<Vec<u8>> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            self.downloads.lock().unwrap().push(path.to_owned());
            self.file(path)
                .ok_or_else(|| BeverError::Remote(format!("no remote file {path}")))
        }

        fn download_to(
            &self,
            path: &str,
            _expected_size: u64,
            sink: &mut dyn FnMut(&mut dyn Read) -> Result<()>,
        ) -> Result<()> {
            let bytes = self.download(path)?;
            sink(&mut &bytes[..])
        }

        fn upload_all(&self, folder: &str, files: &[(String, Vec<u8>)]) -> Result<Vec<RemoteFile>> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            files
                .iter()
                .map(|(name, bytes)| {
                    self.store(&format!("{folder}/{name}"), bytes.clone())?;
                    Ok(RemoteFile {
                        name: name.clone(),
                        size: bytes.len() as u64,
                        version: version_of(bytes),
                    })
                })
                .collect()
        }

        fn upload_file(&self, path: &str, source: &Path, size: u64) -> Result<()> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            let bytes = std::fs::read(source)?;
            assert_eq!(
                bytes.len() as u64,
                size,
                "declared size must match the file"
            );
            self.store(path, bytes)
        }

        fn metrics(&self) -> TransferMetrics {
            TransferMetrics {
                remote_requests: self.requests(),
                ..TransferMetrics::default()
            }
        }
    }
}
