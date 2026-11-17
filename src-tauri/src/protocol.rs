//! The `bever:` protocol: serves attachment bytes to the WebView.
//!
//! A request names an attachment by the hash its `<en-media>` element carries
//! and nothing else, so the WebView can read attachments of the library and
//! no other file. Requests are answered off the UI thread, and `Range`
//! requests are honoured in bounded pieces so that audio and video can seek
//! without the whole file being loaded. `thumb/<hash>` is a small version
//! of a picture, for the list of notes.
use std::io::{Read, Seek, SeekFrom};

use percent_encoding::percent_decode_str;
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, UriSchemeContext, UriSchemeResponder,
};

use crate::{files::attachment_file_name, AppState};

/// Most bytes returned for one ranged request. The player asks again for
/// what follows.
const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn handle(
    context: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || responder.respond(respond(&app, &request)));
}

fn respond(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let reference = percent_decode_str(request.uri().path().trim_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    let state = AppState::of(app);
    let (reference, small) = match reference.strip_prefix("thumb/") {
        Some(hash) => (hash.to_owned(), true),
        None => (reference, false),
    };
    let Ok(resource) = state.library.resource_location(&reference) else {
        return plain(StatusCode::NOT_FOUND, "attachment not found");
    };
    if small {
        return match state.library.thumbnail(&resource.sha256) {
            Ok(picture) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "image/jpeg")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; sandbox",
                )
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                )
                .body(picture)
                .expect("valid thumbnail response"),
            Err(_) => plain(StatusCode::NOT_FOUND, "no thumbnail for this attachment"),
        };
    }
    let Ok(mut file) = state.library.open_blob(&resource.sha256) else {
        return plain(StatusCode::NOT_FOUND, "attachment file is missing");
    };
    let total = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let requested = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let (status, start, length) = match requested.map(|value| parse_range(value, total)) {
        None => (StatusCode::OK, 0, total),
        Some(Some((start, end))) => (
            StatusCode::PARTIAL_CONTENT,
            start,
            (end - start + 1).min(MAX_RANGE_BYTES),
        ),
        Some(None) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .expect("valid range response");
        }
    };
    let mut bytes = Vec::with_capacity(length as usize);
    let read = file
        .seek(SeekFrom::Start(start))
        .and_then(|_| file.take(length).read_to_end(&mut bytes));
    if read.is_err() {
        return plain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "attachment could not be read",
        );
    }

    let filename = url::form_urlencoded::byte_serialize(attachment_file_name(&resource).as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, resource.mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"attachment\"; filename*=UTF-8''{filename}"),
        )
        // The page reads PDFs with fetch(), which is cross-origin here.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range")
        // An attachment is data: it must never run script or be re-typed.
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; sandbox")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // Content-addressed, so a response never goes stale.
        .header(header::CACHE_CONTROL, "private, max-age=31536000, immutable");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{total}", start + bytes.len() as u64 - 1),
        );
    }
    response.body(bytes).expect("valid attachment response")
}

/// An error the page can read. Without the cross-origin header the page sees
/// every failure as the same network error, whatever the status.
fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .expect("valid error response")
}

/// First and last byte of a `Range` header value for a file of `total`
/// bytes, or `None` when the range cannot be satisfied. Only the first of
/// several ranges is served, which the specification permits.
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let ranges = value.trim().strip_prefix("bytes=")?;
    let first = ranges.split(',').next()?.trim();
    let (start, end) = first.split_once('-')?;
    let last = total.checked_sub(1)?;
    match (start.trim(), end.trim()) {
        // "-500": the final 500 bytes.
        ("", suffix) => {
            let length: u64 = suffix.parse().ok()?;
            (length > 0).then(|| (total.saturating_sub(length), last))
        }
        (start, "") => {
            let start: u64 = start.parse().ok()?;
            (start <= last).then_some((start, last))
        }
        (start, end) => {
            let start: u64 = start.parse().ok()?;
            let end: u64 = end.parse().ok()?;
            (start <= end && start <= last).then(|| (start, end.min(last)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn ranges_are_resolved_against_the_file_size() {
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range(" bytes=10-20, 30-40", 1000), Some((10, 20)));
    }

    #[test]
    fn impossible_or_malformed_ranges_are_refused() {
        for (value, total) in [
            ("bytes=1000-", 1000),
            ("bytes=20-10", 1000),
            ("bytes=-0", 1000),
            ("bytes=0-", 0),
            ("bytes=a-b", 1000),
            ("bytes=", 1000),
            ("items=0-10", 1000),
            ("0-10", 1000),
        ] {
            assert_eq!(parse_range(value, total), None, "{value} of {total}");
        }
    }
}
