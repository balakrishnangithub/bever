//! pCloud HTTP API adapter, used only during an explicitly started sync.
//!
//! The access token travels in the `Authorization` header, never in a URL,
//! and request URLs are stripped from errors, so a token cannot end up in an
//! error message, a notification, or a screenshot.
use std::{
    fs::File,
    io::Read,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

use reqwest::blocking::{multipart, Client, RequestBuilder, Response};
use serde_json::Value;

use crate::{
    error::{BeverError, Result},
    sync::{Listing, RemoteFile, RemoteStore, TransferMetrics},
};

pub const DEFAULT_CLIENT_ID: &str = "B0DEaAnitD8";
pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:53682/";
pub const MOBILE_REDIRECT_URI: &str = "bever://oauth/pcloud";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Time allowed for a small JSON request.
const API_TIMEOUT: Duration = Duration::from_secs(60);
/// A transfer may take this long plus one second per `SLOWEST_BYTES_PER_SECOND`.
const TRANSFER_BASE_TIMEOUT: Duration = Duration::from_secs(120);
/// Slowest connection a transfer is still expected to finish on.
const SLOWEST_BYTES_PER_SECOND: u64 = 16 * 1024;
const ATTEMPTS: u32 = 3;
/// pCloud's result code for a folder that does not exist.
const NO_SUCH_FOLDER: i64 = 2005;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PCloudCredentials {
    pub access_token: String,
    pub hostname: String,
}

impl PCloudCredentials {
    pub fn api_base(&self) -> Result<String> {
        if !matches!(self.hostname.as_str(), "api.pcloud.com" | "eapi.pcloud.com") {
            return Err(BeverError::Invalid(
                "unsupported pCloud API hostname".into(),
            ));
        }
        Ok(format!("https://{}", self.hostname))
    }
}

#[derive(Default)]
struct Metrics {
    network_ms: AtomicU64,
    remote_requests: AtomicU64,
    bytes_uploaded: AtomicU64,
    bytes_downloaded: AtomicU64,
}

pub struct PCloudClient {
    api_base: String,
    access_token: String,
    http: Client,
    metrics: Metrics,
}

impl PCloudClient {
    pub fn new(credentials: PCloudCredentials) -> Result<Self> {
        let api_base = credentials.api_base()?;
        let http = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            // Each request sets its own limit; a fixed one would make large
            // attachments impossible to transfer.
            .timeout(None)
            .user_agent(concat!("Bever/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            api_base,
            access_token: credentials.access_token,
            http,
            metrics: Metrics::default(),
        })
    }

    pub fn user_email(&self) -> Result<Option<String>> {
        let value = self.api("userinfo", &[])?;
        Ok(value
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    /// Deletes a folder and everything in it. Not used by synchronization;
    /// it exists so that tests can remove the folder they created.
    pub fn delete_folder_recursive(&self, path: &str) -> Result<()> {
        self.api("deletefolderrecursive", &[("path", path)])
            .map(|_| ())
    }

    fn api(&self, method: &str, parameters: &[(&str, &str)]) -> Result<Value> {
        self.call(method, parameters, None)?
            .ok_or_else(|| BeverError::Remote(format!("pCloud gave no answer to {method}")))
    }

    /// Calls a method of the API. `absent` is a result code that is an
    /// answer, not a failure: what was asked about is not there. It is
    /// returned as `None`.
    fn call(
        &self,
        method: &str,
        parameters: &[(&str, &str)],
        absent: Option<i64>,
    ) -> Result<Option<Value>> {
        let url = format!("{}/{method}", self.api_base);
        self.with_retry(|| {
            let request = self
                .http
                .get(&url)
                .bearer_auth(&self.access_token)
                .query(parameters)
                .timeout(API_TIMEOUT);
            let bytes = self.send(request)?.bytes()?;
            self.metrics
                .bytes_downloaded
                .fetch_add(bytes.len() as u64, Ordering::Relaxed);
            let value: Value = serde_json::from_slice(&bytes)?;
            if absent.is_some() && value.get("result").and_then(Value::as_i64) == absent {
                return Ok(None);
            }
            check_result(value).map(Some)
        })
    }

    /// Address of a file's content. Links are short-lived, so one is
    /// requested for each attempt.
    fn content_url(&self, path: &str) -> Result<String> {
        let value = self.api("getfilelink", &[("path", path)])?;
        let host = value
            .get("hosts")
            .and_then(Value::as_array)
            .and_then(|hosts| hosts.first())
            .and_then(Value::as_str)
            .ok_or_else(|| BeverError::Remote("pCloud returned no download host".into()))?;
        let valid_host = host.ends_with(".pcloud.com")
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
        if !valid_host {
            return Err(BeverError::Remote(
                "pCloud returned an invalid download host".into(),
            ));
        }
        let remote_path = value
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| path.starts_with('/'))
            .ok_or_else(|| BeverError::Remote("pCloud returned no download path".into()))?;
        Ok(format!("https://{host}{remote_path}"))
    }

    fn upload_part(
        &self,
        path: &str,
        size: u64,
        part: impl Fn() -> Result<multipart::Part>,
    ) -> Result<()> {
        let (directory, filename) = path
            .rsplit_once('/')
            .filter(|(_, filename)| !filename.is_empty())
            .ok_or_else(|| BeverError::Invalid("invalid remote file path".into()))?;
        let directory = if directory.is_empty() { "/" } else { directory };
        let url = format!("{}/uploadfile", self.api_base);
        self.with_retry(|| {
            let part = part()?
                .file_name(filename.to_owned())
                .mime_str("application/octet-stream")?;
            let request = self
                .http
                .post(&url)
                .bearer_auth(&self.access_token)
                // Without `nopartial` an interrupted upload would leave a
                // truncated file behind.
                .query(&[("path", directory), ("filename", filename), ("nopartial", "1")])
                .multipart(multipart::Form::new().part("file", part))
                .timeout(transfer_timeout(size));
            let bytes = self.send(request)?.bytes()?;
            check_result(serde_json::from_slice(&bytes)?)?;
            self.metrics
                .bytes_uploaded
                .fetch_add(size, Ordering::Relaxed);
            Ok(())
        })
    }

    fn send(&self, request: RequestBuilder) -> Result<Response> {
        let started = Instant::now();
        let response = request.send();
        self.metrics.remote_requests.fetch_add(1, Ordering::Relaxed);
        self.metrics.network_ms.fetch_add(
            u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        let response = response?;
        let status = response.status();
        if status.is_server_error() || status.as_u16() == 429 {
            return Err(BeverError::Network(format!(
                "pCloud is temporarily unavailable (HTTP {})",
                status.as_u16()
            )));
        }
        if !status.is_success() {
            return Err(BeverError::Remote(format!(
                "pCloud refused the request (HTTP {})",
                status.as_u16()
            )));
        }
        Ok(response)
    }

    fn with_retry<T>(&self, mut attempt: impl FnMut() -> Result<T>) -> Result<T> {
        let mut delay = Duration::from_secs(1);
        let mut tries = 1;
        loop {
            match attempt() {
                Err(error) if error.is_transient() && tries < ATTEMPTS => {
                    thread::sleep(delay);
                    delay *= 3;
                    tries += 1;
                }
                result => return result,
            }
        }
    }
}

impl RemoteStore for PCloudClient {
    fn ensure_folder(&self, path: &str) -> Result<()> {
        self.api("createfolderifnotexists", &[("path", path)])
            .map(|_| ())
    }

    fn list(&self, folder: &str) -> Result<Option<Listing>> {
        let Some(value) = self.call("listfolder", &[("path", folder)], Some(NO_SUCH_FOLDER))?
        else {
            return Ok(None);
        };
        let mut listing = Listing::default();
        let contents = value
            .get("metadata")
            .and_then(|metadata| metadata.get("contents"))
            .and_then(Value::as_array);
        for entry in contents.into_iter().flatten() {
            if entry.get("isfolder").and_then(Value::as_bool) == Some(true) {
                if let Some(name) = entry.get("name").and_then(Value::as_str) {
                    listing.folders.push(name.to_owned());
                }
            } else if let Some(file) = remote_file(entry) {
                listing.files.push(file);
            }
        }
        Ok(Some(listing))
    }

    fn download(&self, path: &str) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.download_to(path, 0, &mut |reader| {
            bytes.clear();
            reader.read_to_end(&mut bytes)?;
            Ok(())
        })?;
        Ok(bytes)
    }

    fn download_to(
        &self,
        path: &str,
        expected_size: u64,
        sink: &mut dyn FnMut(&mut dyn Read) -> Result<()>,
    ) -> Result<()> {
        self.with_retry(|| {
            let url = self.content_url(path)?;
            // The link itself authorizes the download; the token stays home.
            let request = self.http.get(url).timeout(transfer_timeout(expected_size));
            let mut response = CountingReader {
                inner: self.send(request)?,
                count: &self.metrics.bytes_downloaded,
            };
            sink(&mut response).map_err(|error| match error {
                // A connection that drops mid-body surfaces as an I/O error.
                BeverError::Io(error) => BeverError::Network(error.to_string()),
                other => other,
            })
        })
    }

    /// One request carries every file: pCloud's upload takes as many as the
    /// form holds, each under the name of its part.
    fn upload_all(&self, folder: &str, files: &[(String, Vec<u8>)]) -> Result<Vec<RemoteFile>> {
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let size = files.iter().map(|(_, bytes)| bytes.len() as u64).sum();
        let url = format!("{}/uploadfile", self.api_base);
        let answer = self.with_retry(|| {
            let mut form = multipart::Form::new();
            for (name, bytes) in files {
                let part = multipart::Part::bytes(bytes.clone())
                    .file_name(name.clone())
                    .mime_str("application/octet-stream")?;
                form = form.part("file", part);
            }
            let request = self
                .http
                .post(&url)
                .bearer_auth(&self.access_token)
                // Without `nopartial` an interrupted upload would leave a
                // truncated file behind.
                .query(&[("path", folder), ("nopartial", "1")])
                .multipart(form)
                .timeout(transfer_timeout(size));
            let bytes = self.send(request)?.bytes()?;
            check_result(serde_json::from_slice(&bytes)?)
        })?;
        self.metrics
            .bytes_uploaded
            .fetch_add(size, Ordering::Relaxed);
        let stored = answer
            .get("metadata")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().filter_map(remote_file).collect::<Vec<_>>())
            .unwrap_or_default();
        files
            .iter()
            .map(|(name, bytes)| {
                stored
                    .iter()
                    .find(|file| file.name == *name && file.size == bytes.len() as u64)
                    .cloned()
                    .ok_or_else(|| {
                        BeverError::Remote(format!("pCloud did not confirm the upload of {name}"))
                    })
            })
            .collect()
    }

    fn upload_file(&self, path: &str, source: &Path, size: u64) -> Result<()> {
        self.upload_part(path, size, || {
            Ok(multipart::Part::reader_with_length(
                File::open(source)?,
                size,
            ))
        })
    }

    fn metrics(&self) -> TransferMetrics {
        TransferMetrics {
            network_ms: self.metrics.network_ms.load(Ordering::Relaxed),
            remote_requests: self.metrics.remote_requests.load(Ordering::Relaxed),
            bytes_uploaded: self.metrics.bytes_uploaded.load(Ordering::Relaxed),
            bytes_downloaded: self.metrics.bytes_downloaded.load(Ordering::Relaxed),
        }
    }
}

struct CountingReader<'a, R> {
    inner: R,
    count: &'a AtomicU64,
}

impl<R: Read> Read for CountingReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.count.fetch_add(read as u64, Ordering::Relaxed);
        Ok(read)
    }
}

/// A file as pCloud describes one, in a listing or in the answer to an
/// upload. Its `hash` stands for its content, and is the version.
fn remote_file(entry: &Value) -> Option<RemoteFile> {
    let version = match entry.get("hash") {
        Some(Value::Number(hash)) => hash.to_string(),
        Some(Value::String(hash)) => hash.clone(),
        _ => String::new(),
    };
    Some(RemoteFile {
        name: entry.get("name")?.as_str()?.to_owned(),
        size: entry.get("size").and_then(Value::as_u64).unwrap_or(0),
        version,
    })
}

fn transfer_timeout(bytes: u64) -> Duration {
    TRANSFER_BASE_TIMEOUT + Duration::from_secs(bytes / SLOWEST_BYTES_PER_SECOND)
}

/// Turns pCloud's `result` code into success or a classified error.
fn check_result(value: Value) -> Result<Value> {
    let result = value.get("result").and_then(Value::as_i64).unwrap_or(-1);
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown pCloud error");
    match result {
        // 2004: the folder to create already exists.
        0 | 2004 => Ok(value),
        1000 | 2000 | 2094 | 2095 => Err(BeverError::Remote(
            "pCloud no longer accepts the saved sign-in. Disconnect and connect pCloud again."
                .into(),
        )),
        2008 => Err(BeverError::Remote(
            "your pCloud storage is full; free some space and synchronize again".into(),
        )),
        // 4xxx: rate limits; 5xxx: faults inside pCloud. Both pass.
        4000..=5999 => Err(BeverError::Network(format!("pCloud {result}: {message}"))),
        _ => Err(BeverError::Remote(format!("pCloud {result}: {message}"))),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_official_api_hosts_are_accepted() {
        let credentials = PCloudCredentials {
            access_token: "token".into(),
            hostname: "eapi.pcloud.com".into(),
        };
        assert_eq!(credentials.api_base().unwrap(), "https://eapi.pcloud.com");
        let invalid = PCloudCredentials {
            access_token: "token".into(),
            hostname: "example.com".into(),
        };
        assert!(invalid.api_base().is_err());
        assert!(PCloudClient::new(invalid).is_err());
    }

    #[test]
    fn request_metrics_start_at_zero_without_network_access() {
        let client = PCloudClient::new(PCloudCredentials {
            access_token: "test-token".into(),
            hostname: "api.pcloud.com".into(),
        })
        .unwrap();
        assert_eq!(client.metrics(), TransferMetrics::default());
    }

    #[test]
    fn large_transfers_get_proportionally_more_time() {
        assert_eq!(transfer_timeout(0), TRANSFER_BASE_TIMEOUT);
        // 1 GiB at the slowest supported speed, plus the base allowance.
        assert_eq!(
            transfer_timeout(1024 * 1024 * 1024),
            TRANSFER_BASE_TIMEOUT + Duration::from_secs(65_536)
        );
    }

    #[test]
    fn api_results_are_classified() {
        assert!(check_result(json!({ "result": 0 })).is_ok());
        assert!(check_result(json!({ "result": 2004, "error": "exists" })).is_ok());
        let rejected =
            check_result(json!({ "result": 2094, "error": "Invalid 'access_token' provided." }))
                .unwrap_err();
        assert!(!rejected.is_transient());
        assert!(rejected.to_string().contains("connect pCloud again"));
        assert!(
            check_result(json!({ "result": 5000, "error": "Internal error" }))
                .unwrap_err()
                .is_transient()
        );
        assert!(
            !check_result(json!({ "result": 2009, "error": "File not found." }))
                .unwrap_err()
                .is_transient()
        );
        assert!(check_result(json!({})).is_err());
    }

    #[test]
    fn transport_errors_never_reveal_the_request_url() {
        // Nothing listens on this port, so the request fails locally.
        let error = Client::new()
            .get("http://127.0.0.1:9/listfolder?access_token=SECRET-TOKEN&path=/Bever")
            .timeout(Duration::from_secs(5))
            .send()
            .unwrap_err();
        let message = BeverError::from(error).to_string();
        assert!(!message.contains("SECRET-TOKEN"), "{message}");
        assert!(!message.contains("127.0.0.1"), "{message}");
    }
}
