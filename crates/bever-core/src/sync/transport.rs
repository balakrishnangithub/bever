//! Reaching a storage service over HTTP: what is the same whichever service
//! it is.
//!
//! Services differ in how they name files and in what their answers look
//! like; that is the adapter of each (`pcloud.rs`). How a request is made
//! does not differ, and is here once:
//!
//! - Every request runs apart from whoever asked for it, who only waits for
//!   its answer. So a run that is stopped returns at once, whatever the
//!   request is doing: a transfer under way is cut off at its next piece,
//!   and one that hangs on a connection that carries nothing is left behind
//!   to end by itself.
//! - A request that does not complete is made again, after pauses that
//!   grow, and that is counted.
//! - A local file that cannot be read is told apart from a lost connection.
//! - A download is handed over in pieces as it arrives.
//! - What was transferred is counted.
//!
//! Request addresses never reach an error message: they can carry
//! credentials or private paths, and errors are shown.
use std::{
    io::{self, Cursor, Read},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use reqwest::blocking::{Client, RequestBuilder, Response};

use super::{Cancel, TransferMetrics};
use crate::error::{BeverError, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Time allowed for a small request.
const API_TIMEOUT: Duration = Duration::from_secs(60);
/// A transfer may take this long plus one second per `SLOWEST_BYTES_PER_SECOND`.
const TRANSFER_BASE_TIMEOUT: Duration = Duration::from_secs(120);
/// Slowest connection a transfer is still expected to finish on.
const SLOWEST_BYTES_PER_SECOND: u64 = 16 * 1024;
/// A connection that has gone quiet is probed after this long, so that one
/// whose other end is gone (after the device slept, or changed networks) is
/// found out instead of being waited on.
const KEEPALIVE: Duration = Duration::from_secs(30);
/// How long to wait before asking again, each time a request does not
/// complete. A minute and a half in all: long enough for a connection to
/// come back after a device wakes or a router restarts, so that a run of
/// hours is not lost to a gap of seconds.
const PATIENCE: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(9),
    Duration::from_secs(27),
    Duration::from_secs(60),
];
/// How often someone waiting looks whether the run was stopped.
const GLANCE: Duration = Duration::from_millis(50);
/// Size of the pieces a download is handed over in.
const PIECE: usize = 64 * 1024;

#[derive(Default)]
struct Metrics {
    network_ms: AtomicU64,
    remote_requests: AtomicU64,
    bytes_uploaded: AtomicU64,
    bytes_downloaded: AtomicU64,
    retries: AtomicU64,
    throttled: AtomicU64,
}

/// The way to one storage service.
pub(crate) struct Transport {
    /// The service's name, for what is said when it fails.
    service: &'static str,
    http: Client,
    metrics: Arc<Metrics>,
    cancel: Cancel,
    patience: &'static [Duration],
}

impl Transport {
    pub(crate) fn new(service: &'static str) -> Result<Self> {
        let http = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .tcp_keepalive(KEEPALIVE)
            // Each request sets its own limit; a fixed one would make large
            // attachments impossible to transfer.
            .timeout(None)
            .user_agent(concat!("Bever/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            service,
            http,
            metrics: Arc::new(Metrics::default()),
            cancel: Cancel::new(),
            patience: &PATIENCE,
        })
    }

    /// Makes every request end when `cancel` is set.
    pub(crate) fn stopped_by(&mut self, cancel: Cancel) {
        self.cancel = cancel;
    }

    pub(crate) fn get(&self, url: &str) -> RequestBuilder {
        self.http.get(url)
    }

    pub(crate) fn post(&self, url: &str) -> RequestBuilder {
        self.http.post(url)
    }

    pub(crate) fn metrics(&self) -> TransferMetrics {
        TransferMetrics {
            network_ms: self.metrics.network_ms.load(Ordering::Relaxed),
            remote_requests: self.metrics.remote_requests.load(Ordering::Relaxed),
            bytes_uploaded: self.metrics.bytes_uploaded.load(Ordering::Relaxed),
            bytes_downloaded: self.metrics.bytes_downloaded.load(Ordering::Relaxed),
            retries: self.metrics.retries.load(Ordering::Relaxed),
            throttled: self.metrics.throttled.load(Ordering::Relaxed),
        }
    }

    /// Counts bytes the service has confirmed it holds.
    pub(crate) fn uploaded(&self, bytes: u64) {
        self.metrics
            .bytes_uploaded
            .fetch_add(bytes, Ordering::Relaxed);
    }

    /// Counts an answer in which the service said, in words of its own
    /// instead of HTTP's, that it is being asked too much.
    pub(crate) fn throttled(&self) {
        self.metrics.throttled.fetch_add(1, Ordering::Relaxed);
    }

    /// Makes a small request and returns the body of its answer.
    pub(crate) fn ask(&self, request: RequestBuilder) -> Result<Vec<u8>> {
        let (metrics, service) = (Arc::clone(&self.metrics), self.service);
        let request = request.timeout(API_TIMEOUT);
        let body = self.apart(move || Ok(send(&metrics, service, request)?.bytes()?))?;
        self.metrics
            .bytes_downloaded
            .fetch_add(body.len() as u64, Ordering::Relaxed);
        Ok(body.to_vec())
    }

    /// Sends a request that carries `size` bytes and returns the body of
    /// its answer. What it carries is read through [`Transport::outgoing`];
    /// when one of those could not be read, that is the error, whatever
    /// became of the request.
    pub(crate) fn upload(
        &self,
        request: RequestBuilder,
        size: u64,
        local: &LocalFailure,
    ) -> Result<Vec<u8>> {
        let (metrics, service) = (Arc::clone(&self.metrics), self.service);
        let request = request.timeout(transfer_timeout(size));
        let local = local.clone();
        let body = self.apart(move || {
            let sent = send(&metrics, service, request);
            // A file that cannot be read cuts the request short, which
            // looks like a lost connection. It is not one, and asking again
            // would not help.
            if let Some(error) = local.take() {
                return Err(BeverError::Io(error));
            }
            Ok(sent?.bytes()?)
        })?;
        Ok(body.to_vec())
    }

    /// Fetches what a request answers with, expected to be `size` bytes,
    /// and hands it to `sink` as it arrives. Nothing is handed over of a
    /// request the service refuses.
    pub(crate) fn fetch(
        &self,
        request: RequestBuilder,
        size: u64,
        sink: &mut dyn FnMut(&mut dyn Read) -> Result<()>,
    ) -> Result<()> {
        self.cancel.check()?;
        let request = request.timeout(transfer_timeout(size));
        let (metrics, service) = (Arc::clone(&self.metrics), self.service);
        let cancel = self.cancel.clone();
        let (sender, pieces) = mpsc::sync_channel(4);
        thread::spawn(move || {
            let mut response = match send(&metrics, service, request) {
                Ok(response) => response,
                Err(error) => {
                    let _ = sender.send(Piece::Failed(error));
                    return;
                }
            };
            if sender.send(Piece::Begun).is_err() {
                return;
            }
            while !cancel.is_cancelled() {
                let mut piece = vec![0; PIECE];
                let piece = match response.read(&mut piece) {
                    Ok(0) => return,
                    Ok(read) => {
                        piece.truncate(read);
                        Piece::Content(piece)
                    }
                    Err(error) => Piece::Failed(BeverError::Network(format!(
                        "the connection to {service} was interrupted ({error})"
                    ))),
                };
                let failed = matches!(piece, Piece::Failed(_));
                // Nobody takes the pieces any more when the run was
                // stopped, or when storing them failed.
                if sender.send(piece).is_err() || failed {
                    return;
                }
            }
        });
        let mut incoming = Incoming {
            pieces,
            piece: Cursor::new(Vec::new()),
            cancel: &self.cancel,
            count: &self.metrics.bytes_downloaded,
            failure: None,
        };
        match incoming.next()? {
            Some(Piece::Begun) => {}
            Some(Piece::Failed(error)) => return Err(error),
            Some(Piece::Content(_)) | None => {
                return Err(BeverError::Network(
                    "a request ended without an answer".into(),
                ))
            }
        }
        let stored = sink(&mut incoming);
        match (stored, incoming.failure.take()) {
            (Ok(()), _) => Ok(()),
            // The content stopped coming: that, and not what the sink made
            // of it, is what happened.
            (Err(_), Some(failure)) => Err(failure),
            (Err(error), None) => Err(error),
        }
    }

    /// Wraps what an upload reads from, so that the upload ends when the
    /// run is stopped, and so that a failure to read is kept in `local`.
    pub(crate) fn outgoing<R: Read>(&self, inner: R, local: &LocalFailure) -> Outgoing<R> {
        Outgoing {
            inner,
            cancel: self.cancel.clone(),
            failure: local.clone(),
        }
    }

    /// Makes `attempt` again, after a pause, for as long as it fails in a
    /// way that may pass and patience lasts.
    pub(crate) fn with_retry<T>(&self, mut attempt: impl FnMut() -> Result<T>) -> Result<T> {
        let mut waits = self.patience.iter();
        loop {
            self.cancel.check()?;
            let result = attempt();
            // A transfer cut off by stopping fails like a lost connection.
            self.cancel.check()?;
            match (result, waits.next()) {
                (Err(error), Some(wait)) if error.is_transient() => {
                    self.metrics.retries.fetch_add(1, Ordering::Relaxed);
                    let until = Instant::now() + *wait;
                    while Instant::now() < until {
                        self.cancel.check()?;
                        thread::sleep(GLANCE.min(until.saturating_duration_since(Instant::now())));
                    }
                }
                (result, _) => return result,
            }
        }
    }

    /// Runs a request on a thread of its own and waits for its result, but
    /// no longer than until the run is stopped.
    fn apart<T: Send + 'static>(
        &self,
        request: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.cancel.check()?;
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            // Nobody is waiting any more when the run was stopped.
            let _ = sender.send(request());
        });
        loop {
            match receiver.recv_timeout(GLANCE) {
                Ok(result) => return result,
                Err(RecvTimeoutError::Timeout) => self.cancel.check()?,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(BeverError::Network(
                        "a request ended without an answer".into(),
                    ))
                }
            }
        }
    }

    /// Asks again at once, for tests that would otherwise wait.
    #[cfg(test)]
    pub(crate) fn impatient(&mut self) {
        self.patience = &[Duration::ZERO; PATIENCE.len()];
    }
}

/// What went wrong with a local file while it was being sent, if anything.
#[derive(Clone, Default)]
pub(crate) struct LocalFailure(Arc<Mutex<Option<io::Error>>>);

impl LocalFailure {
    fn take(&self) -> Option<io::Error> {
        self.0.lock().expect("local failure poisoned").take()
    }

    fn keep(&self, error: &io::Error) {
        // An `io::Error` cannot be copied; its code, or its kind and words,
        // make the same error again.
        let copy = match error.raw_os_error() {
            Some(code) => io::Error::from_raw_os_error(code),
            None => io::Error::new(error.kind(), error.to_string()),
        };
        *self.0.lock().expect("local failure poisoned") = Some(copy);
    }
}

/// Something on its way out. It ends when the run is stopped, and says so
/// in `failure` when what it reads from cannot be read.
pub(crate) struct Outgoing<R> {
    inner: R,
    cancel: Cancel,
    failure: LocalFailure,
}

impl<R: Read> Read for Outgoing<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(io::Error::other("stopped"));
        }
        self.inner
            .read(buffer)
            .inspect_err(|error| self.failure.keep(error))
    }
}

/// What the thread that reads a download hands to the one that stores it.
enum Piece {
    /// The service answered and content follows.
    Begun,
    Content(Vec<u8>),
    Failed(BeverError),
}

/// A download as it arrives from the thread that reads it. The end of the
/// pieces is the end of the content.
struct Incoming<'a> {
    pieces: mpsc::Receiver<Piece>,
    piece: Cursor<Vec<u8>>,
    cancel: &'a Cancel,
    count: &'a AtomicU64,
    /// Why the content stopped coming, when it did before its end.
    failure: Option<BeverError>,
}

impl Incoming<'_> {
    fn next(&mut self) -> Result<Option<Piece>> {
        loop {
            match self.pieces.recv_timeout(GLANCE) {
                Ok(piece) => return Ok(Some(piece)),
                Err(RecvTimeoutError::Timeout) => self.cancel.check()?,
                Err(RecvTimeoutError::Disconnected) => return Ok(None),
            }
        }
    }
}

impl Read for Incoming<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let read = self.piece.read(buffer)?;
            if read > 0 || buffer.is_empty() {
                self.count.fetch_add(read as u64, Ordering::Relaxed);
                return Ok(read);
            }
            let failure = match self.next() {
                Ok(Some(Piece::Content(bytes))) => {
                    self.piece = Cursor::new(bytes);
                    continue;
                }
                Ok(Some(Piece::Begun)) => continue,
                Ok(None) => return Ok(0),
                Ok(Some(Piece::Failed(error))) | Err(error) => error,
            };
            let words = failure.to_string();
            self.failure = Some(failure);
            return Err(io::Error::other(words));
        }
    }
}

/// Sends a request and sorts its answer by what HTTP says of it: an answer
/// to work with, a refusal, or something that may pass.
fn send(metrics: &Metrics, service: &str, request: RequestBuilder) -> Result<Response> {
    let started = Instant::now();
    let response = request.send();
    metrics.remote_requests.fetch_add(1, Ordering::Relaxed);
    metrics.network_ms.fetch_add(
        u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        Ordering::Relaxed,
    );
    let response = response?;
    let status = response.status();
    if status.as_u16() == 429 {
        metrics.throttled.fetch_add(1, Ordering::Relaxed);
        return Err(BeverError::Network(format!(
            "{service} takes no more requests from this device for now (HTTP 429, too many requests)"
        )));
    }
    if status.is_server_error() {
        return Err(BeverError::Network(format!(
            "{service} could not answer (HTTP {})",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        return Err(BeverError::Remote(format!(
            "{service} refused the request (HTTP {})",
            status.as_u16()
        )));
    }
    Ok(response)
}

fn transfer_timeout(bytes: u64) -> Duration {
    TRANSFER_BASE_TIMEOUT + Duration::from_secs(bytes / SLOWEST_BYTES_PER_SECOND)
}

/// Something on this computer that answers requests, for tests of a
/// transport and of the adapters that use one.
#[cfg(test)]
pub(crate) mod testing {
    use std::{
        io::{Read as _, Write as _},
        net::{TcpListener, TcpStream},
        sync::Arc,
        thread,
    };

    /// The first line's path of a request, and the length of its body.
    pub(crate) struct Asked {
        pub(crate) path: String,
        pub(crate) length: u64,
    }

    /// Answers every request as `answer` says. Returns the address, as
    /// `http://127.0.0.1:<port>`. It lives as long as the tests run.
    pub(crate) fn serve(answer: impl Fn(&Asked, &mut TcpStream) + Send + Sync + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let answer = Arc::new(answer);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let answer = Arc::clone(&answer);
                thread::spawn(move || {
                    if let Some(asked) = head(&mut stream) {
                        answer(&asked, &mut stream);
                    }
                });
            }
        });
        base
    }

    fn head(stream: &mut TcpStream) -> Option<Asked> {
        let mut head = Vec::new();
        let mut byte = [0];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).ok()? == 0 {
                return None;
            }
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head).into_owned();
        let path = head.lines().next()?.split(' ').nth(1)?.to_owned();
        let length = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse().ok())
            .unwrap_or(0);
        Some(Asked { path, length })
    }

    /// Takes the body of a request and returns it.
    pub(crate) fn body(asked: &Asked, stream: &mut TcpStream) -> Vec<u8> {
        let mut body = Vec::new();
        let _ = stream.take(asked.length).read_to_end(&mut body);
        body
    }

    pub(crate) fn respond(stream: &mut TcpStream, status: u16, content: &[u8]) {
        let _ = write!(
            stream,
            "HTTP/1.1 {status} Answer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            content.len()
        );
        let _ = stream.write_all(content);
    }
}

#[cfg(test)]
mod tests {
    use std::{fs::File, io::Write as _, sync::atomic::AtomicUsize};

    use super::{
        testing::{body, respond, serve},
        *,
    };

    fn transport() -> Transport {
        let mut transport = Transport::new("the service").unwrap();
        transport.impatient();
        transport
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
    fn nothing_is_counted_before_anything_is_asked() {
        assert_eq!(transport().metrics(), TransferMetrics::default());
    }

    #[test]
    fn transport_errors_never_reveal_the_request_url() {
        // Nothing listens on this port, so the request fails locally.
        let error = transport()
            .ask(
                Client::new()
                    .get("http://127.0.0.1:9/listfolder?access_token=SECRET-TOKEN&path=/Bever"),
            )
            .unwrap_err();
        let message = error.to_string();
        assert!(!message.contains("SECRET-TOKEN"), "{message}");
        assert!(!message.contains("127.0.0.1"), "{message}");
    }

    #[test]
    fn a_service_that_turns_requests_away_is_asked_again_and_that_is_counted() {
        let asked_times = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&asked_times);
        let base = serve(
            move |_, stream| match count.fetch_add(1, Ordering::SeqCst) {
                0 => respond(stream, 429, b""),
                1 => respond(stream, 503, b""),
                _ => respond(stream, 200, b"answer"),
            },
        );
        let transport = transport();
        let answer = transport
            .with_retry(|| transport.ask(transport.get(&base)))
            .unwrap();
        assert_eq!(answer, b"answer");
        let metrics = transport.metrics();
        assert_eq!((metrics.retries, metrics.throttled), (2, 1));
        assert_eq!(metrics.remote_requests, 3);
        assert_eq!(asked_times.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_service_that_keeps_turning_requests_away_is_given_up_on_in_plain_words() {
        let base = serve(|_, stream| respond(stream, 429, b""));
        let transport = transport();
        let error = transport
            .with_retry(|| transport.ask(transport.get(&base)))
            .unwrap_err();
        assert!(error.is_transient());
        let words = error.to_string();
        assert!(
            words.contains("the service takes no more requests") && words.contains("too many"),
            "{words}"
        );
        assert_eq!(transport.metrics().retries, PATIENCE.len() as u64);
    }

    #[test]
    fn what_a_service_refuses_is_not_asked_again() {
        let base = serve(|_, stream| respond(stream, 403, b""));
        let transport = transport();
        let error = transport
            .with_retry(|| transport.ask(transport.get(&base)))
            .unwrap_err();
        assert!(matches!(error, BeverError::Remote(_)), "{error:?}");
        assert_eq!(transport.metrics().retries, 0);
    }

    /// Stops `cancel` a moment from now, from another thread.
    fn stop_soon(cancel: &Cancel) {
        let cancel = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            cancel.cancel();
        });
    }

    #[test]
    fn a_stopped_upload_returns_at_once_though_the_service_takes_nothing() {
        // The request is accepted and its body never read: a connection
        // that carries nothing, as after a network is lost without notice.
        let base = serve(|_, _stream| thread::sleep(Duration::from_secs(60)));
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("large.bin");
        let size = 32 * 1024 * 1024;
        std::fs::write(&source, vec![7; size]).unwrap();
        let cancel = Cancel::new();
        let mut transport = transport();
        transport.stopped_by(cancel.clone());
        stop_soon(&cancel);
        let started = Instant::now();
        let result = transport.with_retry(|| {
            let local = LocalFailure::default();
            let file = transport.outgoing(File::open(&source)?, &local);
            let body = reqwest::blocking::Body::sized(file, size as u64);
            transport.upload(transport.post(&base).body(body), size as u64, &local)
        });
        assert!(matches!(result, Err(BeverError::Cancelled)), "{result:?}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "stopping took {:?}",
            started.elapsed()
        );
        // And nothing is asked any more once stopped.
        assert!(matches!(
            transport.ask(transport.get(&base)),
            Err(BeverError::Cancelled)
        ));
    }

    #[test]
    fn a_stopped_download_returns_at_once_though_nothing_arrives() {
        let base = serve(|_, stream| {
            // A long file is promised and only its beginning sent.
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nstart"
            );
            thread::sleep(Duration::from_secs(60));
        });
        let cancel = Cancel::new();
        let mut transport = transport();
        transport.stopped_by(cancel.clone());
        stop_soon(&cancel);
        let started = Instant::now();
        let mut received = Vec::new();
        let result = transport.with_retry(|| {
            transport.fetch(transport.get(&base), 1_000_000, &mut |reader| {
                reader.read_to_end(&mut received)?;
                Ok(())
            })
        });
        assert!(matches!(result, Err(BeverError::Cancelled)), "{result:?}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "stopping took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_stopped_pause_between_attempts_ends() {
        let base = serve(|_, stream| respond(stream, 503, b""));
        let cancel = Cancel::new();
        // With the patience a run has: a second, then three, and so on.
        let mut transport = Transport::new("the service").unwrap();
        transport.stopped_by(cancel.clone());
        stop_soon(&cancel);
        let started = Instant::now();
        let result = transport.with_retry(|| transport.ask(transport.get(&base)));
        assert!(matches!(result, Err(BeverError::Cancelled)), "{result:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_file_that_cannot_be_read_is_not_taken_for_a_lost_connection() {
        let asked_times = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&asked_times);
        let base = serve(move |asked, stream| {
            count.fetch_add(1, Ordering::SeqCst);
            body(asked, stream);
            respond(stream, 200, b"stored");
        });
        let transport = transport();
        // What is read fails part-way, as a file does that the system
        // withholds after it was opened.
        struct Withheld(usize);
        impl Read for Withheld {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.0 == 0 {
                    return Err(io::Error::from(io::ErrorKind::PermissionDenied));
                }
                self.0 -= 1;
                buffer.fill(1);
                Ok(buffer.len())
            }
        }
        let result = transport.with_retry(|| {
            let local = LocalFailure::default();
            let file = transport.outgoing(Withheld(3), &local);
            let body = reqwest::blocking::Body::sized(file, 64 * 1024 * 1024);
            transport.upload(transport.post(&base).body(body), 64 * 1024 * 1024, &local)
        });
        let Err(BeverError::Io(error)) = result else {
            panic!("{result:?}");
        };
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        // It was not asked again and again, as a lost connection would be.
        assert_eq!(transport.metrics().retries, 0);
        assert!(asked_times.load(Ordering::SeqCst) <= 1);
    }

    #[test]
    fn a_download_cut_short_is_a_lost_connection_and_is_asked_for_again() {
        let asked_times = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&asked_times);
        let base = serve(move |_, stream| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                // Ten bytes are promised, four come, and the line drops.
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhalf");
            } else {
                respond(stream, 200, b"whole file");
            }
        });
        let transport = transport();
        let mut received = Vec::new();
        transport
            .with_retry(|| {
                transport.fetch(transport.get(&base), 10, &mut |reader| {
                    received.clear();
                    reader.read_to_end(&mut received)?;
                    Ok(())
                })
            })
            .unwrap();
        assert_eq!(received, b"whole file");
        let metrics = transport.metrics();
        assert_eq!(metrics.retries, 1);
        assert!(metrics.bytes_downloaded >= 10);
    }

    #[test]
    fn what_the_sink_cannot_store_is_its_own_failure_and_not_the_connections() {
        let base = serve(|_, stream| respond(stream, 200, b"content"));
        let transport = transport();
        let result = transport.with_retry(|| {
            transport.fetch(transport.get(&base), 7, &mut |_| {
                Err(BeverError::Io(io::Error::from(io::ErrorKind::StorageFull)))
            })
        });
        // No space on the device is not a reason to ask the service again.
        assert!(matches!(result, Err(BeverError::Io(_))), "{result:?}");
        assert_eq!(transport.metrics().retries, 0);
    }
}
