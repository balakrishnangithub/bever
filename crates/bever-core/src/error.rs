use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BeverError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("{}", describe_io(.0))]
    Io(#[from] io::Error),
    #[error("XML error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("invalid data: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    /// The storage service answered and refused or failed the request.
    #[error("remote sync error: {0}")]
    Remote(String),
    /// The request did not complete: no connection, a timeout, or a server
    /// fault. Worth retrying, unlike [`BeverError::Remote`].
    #[error("network error: {0}")]
    Network(String),
    /// Whoever started the work asked for it to stop. Not a failure: what
    /// was done stays done.
    #[error("stopped")]
    Cancelled,
}

impl BeverError {
    /// Whether repeating the same request may succeed.
    pub fn is_transient(&self) -> bool {
        matches!(self, Self::Network(_))
    }
}

impl From<serde_json::Error> for BeverError {
    fn from(value: serde_json::Error) -> Self {
        Self::Invalid(value.to_string())
    }
}

impl From<reqwest::Error> for BeverError {
    fn from(value: reqwest::Error) -> Self {
        // A request URL can carry credentials or private paths, and this text
        // is shown in the interface and in notifications.
        let value = value.without_url();
        let what = if value.is_timeout() {
            "the storage service did not answer in time"
        } else if value.is_connect() {
            "no connection to the storage service; this device may be offline"
        } else {
            "the connection to the storage service was interrupted"
        };
        // What the library says of it ("error sending request") tells nobody
        // why; the cause underneath does ("No such host is known").
        let mut cause: &dyn std::error::Error = &value;
        while let Some(deeper) = cause.source() {
            cause = deeper;
        }
        Self::Network(format!("{what} ({cause})"))
    }
}

/// Why the operating system would not let a file be read or written, where
/// that is something a person can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileTrouble {
    /// Security software took the file for harmful and withheld it.
    Blocked,
    /// The file is not there.
    Missing,
    /// No space is left to write to.
    DiskFull,
    /// Access was refused.
    Denied,
    /// Another program holds the file.
    InUse,
}

impl FileTrouble {
    pub fn of(error: &io::Error) -> Option<Self> {
        // Windows says these with codes that have no kind of their own.
        #[cfg(windows)]
        match error.raw_os_error() {
            // ERROR_VIRUS_INFECTED, ERROR_VIRUS_DELETED
            Some(225 | 226) => return Some(Self::Blocked),
            // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
            Some(39 | 112) => return Some(Self::DiskFull),
            // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
            Some(32 | 33) => return Some(Self::InUse),
            _ => {}
        }
        match error.kind() {
            io::ErrorKind::NotFound => Some(Self::Missing),
            io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => Some(Self::DiskFull),
            io::ErrorKind::PermissionDenied => Some(Self::Denied),
            _ => None,
        }
    }

    /// The trouble in words, as a sentence without its full stop.
    pub fn in_words(self) -> &'static str {
        match self {
            Self::Blocked => {
                "the security software on this device (Windows Security or another antivirus) blocked a file because it takes it for harmful"
            }
            Self::Missing => "a file that should be on this device is missing",
            Self::DiskFull => "there is no space left on this device",
            Self::Denied => {
                "access to a file was refused; another program or the security software may be holding it"
            }
            Self::InUse => "a file is in use by another program",
        }
    }
}

/// The operating system's own words, preceded by what they mean where a
/// bare "os error 225" would leave the reader guessing.
fn describe_io(error: &io::Error) -> String {
    match FileTrouble::of(error) {
        Some(trouble) => format!("{}: {error}", trouble.in_words()),
        None => format!("I/O error: {error}"),
    }
}

pub type Result<T> = std::result::Result<T, BeverError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_withheld_by_security_software_is_said_in_words() {
        // What Windows answers when its antivirus stops a file being opened.
        #[cfg(windows)]
        {
            let error = io::Error::from_raw_os_error(225);
            assert_eq!(FileTrouble::of(&error), Some(FileTrouble::Blocked));
            let shown = BeverError::from(error).to_string();
            assert!(shown.contains("antivirus"), "{shown}");
            assert!(shown.contains("os error 225"), "{shown}");
            assert_eq!(
                FileTrouble::of(&io::Error::from_raw_os_error(112)),
                Some(FileTrouble::DiskFull)
            );
            assert_eq!(
                FileTrouble::of(&io::Error::from_raw_os_error(32)),
                Some(FileTrouble::InUse)
            );
        }
        let missing = io::Error::from(io::ErrorKind::NotFound);
        assert_eq!(FileTrouble::of(&missing), Some(FileTrouble::Missing));
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(FileTrouble::of(&denied), Some(FileTrouble::Denied));
        // What has no plain meaning is shown as the system says it.
        let other = io::Error::other("the pipe broke");
        assert_eq!(FileTrouble::of(&other), None);
        assert_eq!(
            BeverError::from(other).to_string(),
            "I/O error: the pipe broke"
        );
    }

    #[test]
    fn a_request_that_cannot_connect_says_so_and_why() {
        // Nothing listens on this port, so the request fails locally.
        let error = reqwest::blocking::Client::new()
            .get("http://127.0.0.1:9/listfolder?path=/Bever")
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .unwrap_err();
        let shown = BeverError::from(error).to_string();
        assert!(shown.contains("no connection"), "{shown}");
        assert!(!shown.contains("127.0.0.1"), "{shown}");
        assert!(!shown.contains("listfolder"), "{shown}");
        // The cause underneath is there, not only "error sending request".
        assert!(!shown.ends_with("(error sending request)"), "{shown}");
    }
}
