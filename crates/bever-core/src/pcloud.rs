//! pCloud HTTP API adapter, used only during an explicitly started sync.
//!
//! Here is what is pCloud's own: its addresses, its methods, what its
//! answers mean. How a request is made, stopped, made again and counted is
//! the same for any storage service and is in `sync/transport.rs`.
//!
//! The access token travels in the `Authorization` header, never in a URL,
//! and request URLs are stripped from errors, so a token cannot end up in an
//! error message, a notification, or a screenshot.
use std::{fs::File, io::Cursor, io::Read, path::Path};

use reqwest::blocking::multipart;
use serde_json::Value;

use crate::{
    error::{BeverError, Result},
    sync::{
        transport::{LocalFailure, Transport},
        Cancel, Listing, RemoteFile, RemoteStore, TransferMetrics,
    },
};

pub const DEFAULT_CLIENT_ID: &str = "B0DEaAnitD8";
pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:53682/";
pub const MOBILE_REDIRECT_URI: &str = "bever://oauth/pcloud";

/// pCloud's result code for a folder that does not exist.
const NO_SUCH_FOLDER: i64 = 2005;
/// pCloud's result codes for having been asked too much.
const LIMITED: std::ops::RangeInclusive<i64> = 4000..=4999;

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

pub struct PCloudClient {
    api_base: String,
    /// The address of a stand-in, in place of pCloud. Content is then
    /// fetched from there too, and nowhere else.
    stand_in: Option<String>,
    access_token: String,
    transport: Transport,
}

impl PCloudClient {
    pub fn new(credentials: PCloudCredentials) -> Result<Self> {
        let api_base = credentials.api_base()?;
        Self::build(api_base, None, credentials.access_token)
    }

    /// A client of something on this computer that answers as pCloud does,
    /// for tests that must not reach the real service. `base` is
    /// `http://127.0.0.1:<port>` and nothing else; no sign-in is sent there
    /// but the word "stand-in".
    pub fn stand_in(base: &str) -> Result<Self> {
        let authority = base
            .strip_prefix("http://")
            .filter(|authority| {
                authority
                    .strip_prefix("127.0.0.1:")
                    .is_some_and(|port| port.parse::<u16>().is_ok_and(|port| port != 0))
            })
            .ok_or_else(|| {
                BeverError::Invalid("a stand-in for pCloud is http://127.0.0.1:<port>".into())
            })?;
        Self::build(
            base.to_owned(),
            Some(authority.to_owned()),
            "stand-in".to_owned(),
        )
    }

    fn build(api_base: String, stand_in: Option<String>, access_token: String) -> Result<Self> {
        Ok(Self {
            api_base,
            stand_in,
            access_token,
            transport: Transport::new("pCloud")?,
        })
    }

    /// Makes every request of this client end when `cancel` is set.
    #[must_use]
    pub fn stopped_by(mut self, cancel: Cancel) -> Self {
        self.transport.stopped_by(cancel);
        self
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
        self.transport.with_retry(|| {
            let request = self
                .transport
                .get(&url)
                .bearer_auth(&self.access_token)
                .query(parameters);
            let value: Value = serde_json::from_slice(&self.transport.ask(request)?)?;
            if absent.is_some() && value.get("result").and_then(Value::as_i64) == absent {
                return Ok(None);
            }
            self.checked(value).map(Some)
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
        let valid_host = match &self.stand_in {
            Some(authority) => host == authority,
            None => {
                host.ends_with(".pcloud.com")
                    && host
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
            }
        };
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
        let scheme = if self.stand_in.is_some() {
            "http"
        } else {
            "https"
        };
        Ok(format!("{scheme}://{host}{remote_path}"))
    }

    /// Uploads into `folder` the parts that `parts` makes, anew for each
    /// attempt, `size` bytes in all. Returns pCloud's answer.
    fn upload_parts(
        &self,
        folder: &str,
        size: u64,
        named: Option<&str>,
        parts: impl Fn(&LocalFailure) -> Result<Vec<multipart::Part>>,
    ) -> Result<Value> {
        let url = format!("{}/uploadfile", self.api_base);
        // Without `nopartial` an interrupted upload would leave a truncated
        // file behind.
        let mut query = vec![("path", folder), ("nopartial", "1")];
        if let Some(filename) = named {
            query.push(("filename", filename));
        }
        let answer = self.transport.with_retry(|| {
            let local = LocalFailure::default();
            let mut form = multipart::Form::new();
            for part in parts(&local)? {
                form = form.part("file", part);
            }
            let request = self
                .transport
                .post(&url)
                .bearer_auth(&self.access_token)
                .query(&query)
                .multipart(form);
            let answer = self.transport.upload(request, size, &local)?;
            self.checked(serde_json::from_slice(&answer)?)
        })?;
        self.transport.uploaded(size);
        Ok(answer)
    }

    /// Turns pCloud's `result` code into success or a classified error.
    fn checked(&self, value: Value) -> Result<Value> {
        let result = value.get("result").and_then(Value::as_i64);
        if result.is_some_and(|result| LIMITED.contains(&result)) {
            self.transport.throttled();
        }
        check_result(value)
    }

    /// One file of an upload: what `content` gives, `size` bytes of it.
    fn part(
        &self,
        content: impl Read + Send + 'static,
        size: u64,
        name: &str,
        local: &LocalFailure,
    ) -> Result<multipart::Part> {
        Ok(
            multipart::Part::reader_with_length(self.transport.outgoing(content, local), size)
                .file_name(name.to_owned())
                .mime_str("application/octet-stream")?,
        )
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
        self.transport.with_retry(|| {
            // The link itself authorizes the download; the token stays home.
            let url = self.content_url(path)?;
            self.transport
                .fetch(self.transport.get(&url), expected_size, sink)
        })
    }

    /// One request carries every file: pCloud's upload takes as many as the
    /// form holds, each under the name of its part.
    fn upload_all(&self, folder: &str, files: &[(String, Vec<u8>)]) -> Result<Vec<RemoteFile>> {
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let size = files.iter().map(|(_, bytes)| bytes.len() as u64).sum();
        let answer = self.upload_parts(folder, size, None, |local| {
            files
                .iter()
                .map(|(name, bytes)| {
                    self.part(Cursor::new(bytes.clone()), bytes.len() as u64, name, local)
                })
                .collect()
        })?;
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
        let (directory, filename) = path
            .rsplit_once('/')
            .filter(|(_, filename)| !filename.is_empty())
            .ok_or_else(|| BeverError::Invalid("invalid remote file path".into()))?;
        let directory = if directory.is_empty() { "/" } else { directory };
        self.upload_parts(directory, size, Some(filename), |local| {
            Ok(vec![self.part(
                File::open(source)?,
                size,
                filename,
                local,
            )?])
        })
        .map(|_| ())
    }

    fn metrics(&self) -> TransferMetrics {
        self.transport.metrics()
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
        // 4xxx: limits on how much may be asked. They pass.
        result if LIMITED.contains(&result) => Err(BeverError::Network(format!(
            "pCloud takes no more requests from this device for now ({message}, code {result})"
        ))),
        // 5xxx: faults inside pCloud. They pass too.
        5000..=5999 => Err(BeverError::Network(format!(
            "pCloud could not carry out the request ({message}, code {result})"
        ))),
        _ => Err(BeverError::Remote(format!("pCloud {result}: {message}"))),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use serde_json::json;

    use super::*;
    use crate::sync::transport::testing::{body, respond, serve};

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
        // A sign-in never names this computer: only a test does, apart.
        let local = PCloudCredentials {
            access_token: "token".into(),
            hostname: "127.0.0.1:8080".into(),
        };
        assert!(PCloudClient::new(local).is_err());
    }

    #[test]
    fn a_stand_in_is_on_this_computer_and_nowhere_else() {
        assert!(PCloudClient::stand_in("http://127.0.0.1:8080").is_ok());
        for elsewhere in [
            "http://example.com:8080",
            "https://127.0.0.1:8080",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:8080/path",
            "http://127.0.0.1:8080@example.com",
            "http://localhost:8080",
        ] {
            assert!(PCloudClient::stand_in(elsewhere).is_err(), "{elsewhere}");
        }
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
        let limited =
            check_result(json!({ "result": 4000, "error": "Too many login tries." })).unwrap_err();
        assert!(limited.is_transient());
        assert!(
            limited.to_string().contains("no more requests")
                && limited.to_string().contains("Too many login tries")
                && limited.to_string().contains("4000"),
            "{limited}"
        );
        assert!(
            !check_result(json!({ "result": 2009, "error": "File not found." }))
                .unwrap_err()
                .is_transient()
        );
        assert!(check_result(json!({})).is_err());
    }

    /// A client of `base` that does not wait between attempts.
    fn impatient(base: &str) -> PCloudClient {
        let mut client = PCloudClient::stand_in(base).unwrap();
        client.transport.impatient();
        client
    }

    #[test]
    fn files_go_up_and_come_down_through_a_stand_in() {
        let stored = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&stored);
        let base = serve(move |asked, stream| {
            if asked.path.starts_with("/uploadfile") {
                let sent = body(asked, stream);
                // The content is between the part's headers and the closing
                // boundary; a test may look for it there.
                assert!(String::from_utf8_lossy(&sent).contains("hello"));
                *kept.lock().unwrap() = b"hello".to_vec();
                respond(
                    stream,
                    200,
                    br#"{"result":0,"metadata":[{"name":"note-1.json","size":5,"hash":77}]}"#,
                );
            } else if asked.path.starts_with("/getfilelink") {
                let host = stream.local_addr().unwrap().to_string();
                let answer = json!({ "result": 0, "hosts": [host], "path": "/content/one" });
                respond(stream, 200, answer.to_string().as_bytes());
            } else if asked.path == "/content/one" {
                let content = kept.lock().unwrap().clone();
                respond(stream, 200, &content);
            } else {
                respond(stream, 404, b"");
            }
        });
        let client = impatient(&base);
        let files = client
            .upload_all("/Bever/items", &[("note-1.json".into(), b"hello".to_vec())])
            .unwrap();
        assert_eq!(
            (
                files[0].name.as_str(),
                files[0].size,
                files[0].version.as_str()
            ),
            ("note-1.json", 5, "77")
        );
        assert_eq!(
            client.download("/Bever/items/note-1.json").unwrap(),
            b"hello"
        );
        let metrics = client.metrics();
        assert_eq!((metrics.bytes_uploaded, metrics.retries), (5, 0));
        assert!(metrics.bytes_downloaded >= 5);
    }

    #[test]
    fn content_is_fetched_only_from_where_the_service_is() {
        let base = serve(|_, stream| {
            let answer =
                json!({ "result": 0, "hosts": ["elsewhere.example.com"], "path": "/content" });
            respond(stream, 200, answer.to_string().as_bytes());
        });
        let error = impatient(&base).download("/Bever/items/a").unwrap_err();
        assert!(
            error.to_string().contains("invalid download host"),
            "{error}"
        );
    }

    #[test]
    fn being_asked_too_much_in_pclouds_own_words_is_counted_and_asked_again() {
        let asked_times = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&asked_times);
        let base = serve(
            move |_, stream| match count.fetch_add(1, Ordering::SeqCst) {
                0 => respond(
                    stream,
                    200,
                    br#"{"result":4000,"error":"Too many requests."}"#,
                ),
                _ => respond(
                    stream,
                    200,
                    br#"{"result":0,"email":"someone@example.com"}"#,
                ),
            },
        );
        let client = impatient(&base);
        assert_eq!(
            client.user_email().unwrap().as_deref(),
            Some("someone@example.com")
        );
        let metrics = client.metrics();
        assert_eq!((metrics.retries, metrics.throttled), (1, 1));
    }

    #[test]
    fn a_file_that_cannot_be_read_is_an_error_of_the_file() {
        let asked_times = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&asked_times);
        let base = serve(move |asked, stream| {
            count.fetch_add(1, Ordering::SeqCst);
            body(asked, stream);
            respond(stream, 200, br#"{"result":0,"metadata":[]}"#);
        });
        let client = impatient(&base);
        // A folder where a file should be: it opens, or reads, with an
        // error of the file system, whichever the system does.
        let directory = tempfile::tempdir().unwrap();
        let result = client.upload_file("/Bever/blobs/odd", directory.path(), 10);
        assert!(matches!(result, Err(BeverError::Io(_))), "{result:?}");
        // It was not asked again and again, as a lost connection would be.
        assert_eq!(client.metrics().retries, 0);
        assert!(asked_times.load(Ordering::SeqCst) <= 1);

        let missing = client.upload_file("/Bever/blobs/none", &directory.path().join("none"), 10);
        assert!(matches!(missing, Err(BeverError::Io(_))), "{missing:?}");
    }

    #[test]
    fn a_stopped_client_asks_nothing() {
        let asked_times = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&asked_times);
        let base = serve(move |_, stream| {
            count.fetch_add(1, Ordering::SeqCst);
            respond(stream, 200, br#"{"result":0}"#);
        });
        let cancel = Cancel::new();
        let client = impatient(&base).stopped_by(cancel.clone());
        assert!(client.ensure_folder("/Bever").is_ok());
        cancel.cancel();
        assert!(matches!(
            client.ensure_folder("/Bever/items"),
            Err(BeverError::Cancelled)
        ));
        assert!(matches!(client.list("/Bever"), Err(BeverError::Cancelled)));
        assert_eq!(asked_times.load(Ordering::SeqCst), 1);
    }
}
