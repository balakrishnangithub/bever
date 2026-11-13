use thiserror::Error;

#[derive(Debug, Error)]
pub enum BeverError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
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
        Self::Network(value.without_url().to_string())
    }
}

pub type Result<T> = std::result::Result<T, BeverError>;
