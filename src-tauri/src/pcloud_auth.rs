//! Connecting to pCloud: browser sign-in, manual token entry, and status.
//!
//! Desktop sign-in uses pCloud's token flow with a loopback redirect. The
//! browser lands on a page served from `127.0.0.1`, which hands the token to
//! the application; the application accepts it only with the random `state`
//! it issued. Android uses a deep link instead (see `android_oauth.rs`).
use std::collections::HashMap;
#[cfg(not(target_os = "android"))]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[cfg(not(target_os = "android"))]
use bever_core::pcloud::DEFAULT_REDIRECT_URI;
use bever_core::{
    error::{BeverError, Result as BeverResult},
    pcloud::{PCloudClient, PCloudCredentials, DEFAULT_CLIENT_ID},
    Library,
};
use serde::Serialize;
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri::Emitter;
#[cfg(not(target_os = "android"))]
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[cfg(not(target_os = "android"))]
use crate::AppState;
use crate::{
    blocking,
    credentials::{delete_access_token, read_access_token, save_access_token},
};

#[cfg(not(target_os = "android"))]
const LOOPBACK_ADDRESS: &str = "127.0.0.1:53682";
#[cfg(not(target_os = "android"))]
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PCloudStatus {
    connected: bool,
    email: Option<String>,
    hostname: String,
    last_sync_at: Option<i64>,
    authorization_pending: bool,
    /// The folder this library is kept in there, once that is settled.
    folder: Option<String>,
}

#[tauri::command]
pub(crate) async fn pcloud_status(app: AppHandle) -> Result<PCloudStatus, String> {
    blocking(&app, |_, state| pcloud_status_inner(&state.library)).await
}

/// The address of a stand-in for pCloud on this computer, when a test names
/// one in `BEVER_PCLOUD_STAND_IN`. Only a library that is itself named by
/// `BEVER_DATA_DIR` listens to it: the installed application, with the
/// user's own library and sign-in, never does. While a stand-in is used, no
/// sign-in is read, saved, removed or sent anywhere.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn stand_in() -> Option<String> {
    if !crate::erase::is_other_library() {
        return None;
    }
    std::env::var("BEVER_PCLOUD_STAND_IN")
        .ok()
        .filter(|base| !base.is_empty())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn stand_in() -> Option<String> {
    None
}

/// pCloud, by the saved sign-in.
pub(crate) fn client(library: &Library) -> BeverResult<PCloudClient> {
    match stand_in() {
        Some(base) => PCloudClient::stand_in(&base),
        None => PCloudClient::new(load_credentials(library)?),
    }
}

/// Refuses to change the sign-in while a stand-in is used in its place.
fn not_with_a_stand_in() -> BeverResult<()> {
    match stand_in() {
        Some(_) => Err(BeverError::Invalid(
            "a stand-in for pCloud is in use; the sign-in is left alone".into(),
        )),
        None => Ok(()),
    }
}

pub(crate) fn pcloud_status_inner(library: &Library) -> BeverResult<PCloudStatus> {
    if let Some(base) = stand_in() {
        return Ok(PCloudStatus {
            connected: true,
            email: None,
            hostname: base,
            last_sync_at: library
                .setting("last_sync_at")?
                .and_then(|value| value.parse().ok()),
            authorization_pending: false,
            folder: library.sync_folder()?,
        });
    }
    let hostname = library
        .setting("pcloud_hostname")?
        .unwrap_or_else(|| "api.pcloud.com".to_owned());
    Ok(PCloudStatus {
        connected: read_access_token()?.is_some(),
        email: library
            .setting("pcloud_email")?
            .filter(|email| !email.is_empty()),
        last_sync_at: library
            .setting("last_sync_at")?
            .and_then(|value| value.parse().ok()),
        hostname,
        authorization_pending: library
            .setting("pcloud_oauth_state")?
            .is_some_and(|state| !state.is_empty()),
        folder: library.sync_folder()?,
    })
}

pub(crate) fn pcloud_authorization_url(expected_state: &str, redirect_uri: &str) -> Url {
    let mut authorization = Url::parse("https://my.pcloud.com/oauth2/authorize")
        .expect("valid pCloud authorization URL");
    authorization
        .query_pairs_mut()
        .append_pair("client_id", DEFAULT_CLIENT_ID)
        .append_pair("response_type", "token")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", expected_state);
    authorization
}

/// Opens the browser for sign-in and waits for pCloud to return. Ends early
/// when [`cancel_pcloud_connect`] is called.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) async fn connect_pcloud(app: AppHandle) -> Result<PCloudStatus, String> {
    let cancelled = Arc::clone(&AppState::of(&app).oauth_cancelled);
    let status = blocking(&app, move |app, state| {
        cancelled.store(false, Ordering::SeqCst);
        let server = bind_loopback()?;
        let expected_state = uuid::Uuid::new_v4().to_string();
        let authorization = pcloud_authorization_url(&expected_state, DEFAULT_REDIRECT_URI);
        app.opener()
            .open_url(authorization.as_str(), None::<&str>)
            .map_err(|error| {
                BeverError::Invalid(format!(
                    "cannot open the browser for pCloud sign-in: {error}"
                ))
            })?;
        let credentials = receive_loopback_credentials(
            &server,
            &expected_state,
            &cancelled,
            Instant::now() + SIGN_IN_TIMEOUT,
        )?;
        // pCloud has already authorized this token. Completing the connection
        // must not depend on a further, optional profile request.
        save_credentials(&state.library, &credentials, None)?;
        status_for_saved_credentials(&state.library, &credentials, None)
    })
    .await?;
    let _ = app.emit("bever:pcloud-status", &status);
    Ok(status)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub(crate) async fn connect_pcloud(app: AppHandle) -> Result<PCloudStatus, String> {
    blocking(&app, |app, state| {
        crate::android_oauth::begin(app, &state.library)
    })
    .await
}

/// Abandons a browser sign-in that is still waiting.
#[tauri::command]
pub(crate) async fn cancel_pcloud_connect(app: AppHandle) -> Result<PCloudStatus, String> {
    blocking(&app, |_, state| {
        #[cfg(not(target_os = "android"))]
        state.oauth_cancelled.store(true, Ordering::SeqCst);
        state.library.set_setting("pcloud_oauth_state", "")?;
        pcloud_status_inner(&state.library)
    })
    .await
}

#[tauri::command]
pub(crate) async fn connect_pcloud_token(
    app: AppHandle,
    access_token: String,
    hostname: String,
) -> Result<PCloudStatus, String> {
    blocking(&app, move |_, state| {
        not_with_a_stand_in()?;
        let credentials = PCloudCredentials {
            access_token: access_token.trim().to_owned(),
            hostname,
        };
        if credentials.access_token.is_empty() {
            return Err(BeverError::Invalid("enter a pCloud access token".into()));
        }
        // Proves the token works in this region before it is stored.
        let email = PCloudClient::new(credentials.clone())?.user_email()?;
        save_credentials(&state.library, &credentials, email.as_deref())?;
        status_for_saved_credentials(&state.library, &credentials, email)
    })
    .await
}

#[tauri::command]
pub(crate) async fn disconnect_pcloud(app: AppHandle) -> Result<PCloudStatus, String> {
    blocking(&app, |_, state| {
        not_with_a_stand_in()?;
        delete_access_token()?;
        state.library.set_setting("pcloud_email", "")?;
        state.library.set_setting("pcloud_oauth_state", "")?;
        pcloud_status_inner(&state.library)
    })
    .await
}

pub(crate) fn save_credentials(
    library: &Library,
    credentials: &PCloudCredentials,
    email: Option<&str>,
) -> BeverResult<()> {
    credentials.api_base()?;
    not_with_a_stand_in()?;
    if credentials.access_token.trim().is_empty() {
        return Err(BeverError::Invalid(
            "pCloud returned an empty access token".into(),
        ));
    }
    save_access_token(&credentials.access_token)?;
    if read_access_token()?.as_deref() != Some(credentials.access_token.as_str()) {
        return Err(BeverError::Invalid(
            "secure credential storage could not retain the pCloud access token; check your system credential manager and reconnect".into(),
        ));
    }
    library.set_setting("pcloud_hostname", &credentials.hostname)?;
    library.set_setting("pcloud_email", email.unwrap_or(""))?;
    library.set_setting("pcloud_oauth_state", "")?;
    Ok(())
}

pub(crate) fn status_for_saved_credentials(
    library: &Library,
    credentials: &PCloudCredentials,
    email: Option<String>,
) -> BeverResult<PCloudStatus> {
    Ok(PCloudStatus {
        connected: true,
        email,
        hostname: credentials.hostname.clone(),
        last_sync_at: library
            .setting("last_sync_at")?
            .and_then(|value| value.parse().ok()),
        authorization_pending: false,
        folder: library.sync_folder()?,
    })
}

pub(crate) fn load_credentials(library: &Library) -> BeverResult<PCloudCredentials> {
    let access_token = read_access_token()?
        .ok_or_else(|| BeverError::Invalid("connect pCloud before synchronizing".into()))?;
    let hostname = library
        .setting("pcloud_hostname")?
        .unwrap_or_else(|| "api.pcloud.com".to_owned());
    Ok(PCloudCredentials {
        access_token,
        hostname,
    })
}

#[cfg(any(target_os = "android", test))]
pub(crate) fn pcloud_callback_parameters(url: &Url) -> BeverResult<HashMap<String, String>> {
    if url.scheme() != "bever" || url.host_str() != Some("oauth") || url.path() != "/pcloud" {
        return Err(BeverError::Invalid(
            "unexpected pCloud callback destination".into(),
        ));
    }
    let mut parameters = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
    parameters
        .extend(url::form_urlencoded::parse(url.fragment().unwrap_or("").as_bytes()).into_owned());
    Ok(parameters)
}

/// The previous attempt releases the port within a second of being
/// cancelled, so a new attempt waits briefly before giving up.
#[cfg(not(target_os = "android"))]
fn bind_loopback() -> BeverResult<tiny_http::Server> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match tiny_http::Server::http(LOOPBACK_ADDRESS) {
            Ok(server) => return Ok(server),
            Err(error) if Instant::now() >= deadline => {
                return Err(BeverError::Invalid(format!(
                    "cannot listen for the pCloud sign-in on {LOOPBACK_ADDRESS}; another sign-in or another program is using that port: {error}"
                )));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    }
}

#[cfg(not(target_os = "android"))]
const LANDING_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connecting Bever</title><p>Completing pCloud connection…</p><script>const message=document.querySelector('p');if(location.hash){const body=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'','/');fetch('/callback',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}).then(async response=>{message.textContent=await response.text()}).catch(()=>{message.textContent='Authorization could not reach Bever. Return to the app and retry.'})}else{message.textContent='Return to Bever to continue.'}</script>"#;

#[cfg(not(target_os = "android"))]
fn text_response(status: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes("Cache-Control", "no-store")
                .expect("valid static response header"),
        )
}

/// Serves the landing page and waits for the token. A request with the wrong
/// `state` is refused and the wait continues, so a stray or hostile request
/// cannot end a genuine sign-in.
#[cfg(not(target_os = "android"))]
fn receive_loopback_credentials(
    server: &tiny_http::Server,
    expected_state: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> BeverResult<PCloudCredentials> {
    let origin = format!("http://{LOOPBACK_ADDRESS}");
    while Instant::now() < deadline {
        if cancelled.load(Ordering::SeqCst) {
            return Err(BeverError::Invalid("pCloud sign-in was cancelled".into()));
        }
        let Some(mut request) = server
            .recv_timeout(Duration::from_millis(500))
            .map_err(BeverError::Io)?
        else {
            continue;
        };
        let url = Url::parse(&format!("{origin}{}", request.url()))
            .map_err(|error| BeverError::Invalid(error.to_string()))?;
        match url.path() {
            "/" => {
                let page = tiny_http::Response::from_string(LANDING_PAGE)
                    .with_header(
                        tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8")
                            .expect("valid static response header"),
                    )
                    .with_header(
                        tiny_http::Header::from_bytes("Cache-Control", "no-store")
                            .expect("valid static response header"),
                    );
                let _ = request.respond(page);
            }
            "/callback" => {
                // Only the landing page served above may deliver the token.
                let foreign = request
                    .headers()
                    .iter()
                    .any(|header| header.field.equiv("Origin") && header.value.as_str() != origin);
                let parameters = if foreign {
                    HashMap::new()
                } else if request.method() == &tiny_http::Method::Post {
                    let mut body = String::new();
                    let _ = std::io::Read::read_to_string(
                        &mut std::io::Read::take(request.as_reader(), 64 * 1024),
                        &mut body,
                    );
                    url::form_urlencoded::parse(body.as_bytes())
                        .into_owned()
                        .collect()
                } else {
                    url.query_pairs().into_owned().collect()
                };
                match parse_loopback_credentials(&parameters, expected_state) {
                    Ok(credentials) => {
                        let _ = request.respond(text_response(
                            200,
                            "pCloud is connected. You can close this tab and return to Bever.",
                        ));
                        return Ok(credentials);
                    }
                    Err(_) => {
                        let _ = request.respond(text_response(
                            400,
                            "Bever could not verify this sign-in. Return to the app and try again.",
                        ));
                    }
                }
            }
            _ => {
                let _ = request.respond(text_response(404, "Not found"));
            }
        }
    }
    Err(BeverError::Invalid(
        "pCloud sign-in timed out; check that implicit grant is allowed for the pCloud app, or use an access token".into(),
    ))
}

pub(crate) fn parse_loopback_credentials(
    parameters: &HashMap<String, String>,
    expected_state: &str,
) -> BeverResult<PCloudCredentials> {
    if parameters.get("state").map(String::as_str) != Some(expected_state) {
        return Err(BeverError::Invalid(
            "pCloud OAuth state did not match".into(),
        ));
    }
    let access_token = parameters
        .get("access_token")
        .filter(|token| !token.is_empty())
        .cloned()
        .ok_or_else(|| BeverError::Invalid("pCloud did not return an access token; enable implicit grant in the pCloud console".into()))?;
    let hostname = parameters
        .get("hostname")
        .map(String::as_str)
        .or_else(|| match parameters.get("locationid").map(String::as_str) {
            Some("1") => Some("api.pcloud.com"),
            Some("2") => Some("eapi.pcloud.com"),
            _ => None,
        })
        .unwrap_or("api.pcloud.com")
        .to_owned();
    let credentials = PCloudCredentials {
        access_token,
        hostname,
    };
    credentials.api_base()?;
    Ok(credentials)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::TcpStream,
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };

    use super::*;

    fn callback_parameters() -> HashMap<String, String> {
        HashMap::from([
            ("access_token".into(), "test-token".into()),
            ("state".into(), "expected-state".into()),
        ])
    }

    #[test]
    fn oauth_callback_uses_the_returned_api_region() {
        let mut parameters = callback_parameters();
        parameters.insert("hostname".into(), "eapi.pcloud.com".into());
        let credentials = parse_loopback_credentials(&parameters, "expected-state").unwrap();
        assert_eq!(credentials.hostname, "eapi.pcloud.com");
        assert_eq!(credentials.access_token, "test-token");

        parameters.remove("hostname");
        parameters.insert("locationid".into(), "2".into());
        let credentials = parse_loopback_credentials(&parameters, "expected-state").unwrap();
        assert_eq!(credentials.hostname, "eapi.pcloud.com");
    }

    #[test]
    fn oauth_callback_rejects_invalid_state_and_api_hosts() {
        let mut parameters = callback_parameters();
        assert!(parse_loopback_credentials(&parameters, "different-state").is_err());
        parameters.insert("hostname".into(), "example.com".into());
        assert!(parse_loopback_credentials(&parameters, "expected-state").is_err());
    }

    #[test]
    fn oauth_authorization_url_carries_the_mobile_redirect_and_state() {
        let authorization =
            pcloud_authorization_url("expected-state", bever_core::pcloud::MOBILE_REDIRECT_URI);
        let parameters = authorization
            .query_pairs()
            .into_owned()
            .collect::<HashMap<_, _>>();
        assert_eq!(
            parameters.get("response_type").map(String::as_str),
            Some("token")
        );
        assert_eq!(
            parameters.get("redirect_uri").map(String::as_str),
            Some("bever://oauth/pcloud")
        );
        assert_eq!(
            parameters.get("state").map(String::as_str),
            Some("expected-state")
        );
        assert_eq!(
            parameters.get("client_id").map(String::as_str),
            Some(bever_core::pcloud::DEFAULT_CLIENT_ID)
        );
    }

    #[test]
    fn android_callback_reads_fragment_credentials_and_region() {
        let url = Url::parse(
            "bever://oauth/pcloud#access_token=test-token&state=expected-state&hostname=eapi.pcloud.com",
        )
        .unwrap();
        let parameters = pcloud_callback_parameters(&url).unwrap();
        let credentials = parse_loopback_credentials(&parameters, "expected-state").unwrap();
        assert_eq!(credentials.access_token, "test-token");
        assert_eq!(credentials.hostname, "eapi.pcloud.com");
    }

    #[test]
    fn android_callback_rejects_wrong_destinations_and_state() {
        for callback in [
            "bever://not-oauth/pcloud#access_token=test-token&state=expected-state",
            "bever://oauth/not-pcloud#access_token=test-token&state=expected-state",
            "https://oauth/pcloud#access_token=test-token&state=expected-state",
        ] {
            let url = Url::parse(callback).unwrap();
            assert!(pcloud_callback_parameters(&url).is_err());
        }
        let url =
            Url::parse("bever://oauth/pcloud#access_token=test-token&state=wrong-state").unwrap();
        let parameters = pcloud_callback_parameters(&url).unwrap();
        assert!(parse_loopback_credentials(&parameters, "expected-state").is_err());
    }

    fn post_callback(address: &str, body: &str, origin: Option<&str>) -> String {
        let origin = origin.map_or(String::new(), |origin| format!("Origin: {origin}\r\n"));
        let request = format!(
            "POST /callback HTTP/1.1\r\nHost: 127.0.0.1\r\n{origin}Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let mut stream = TcpStream::connect(address).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn listen(
        cancelled: &'static AtomicBool,
        timeout: Duration,
    ) -> (
        String,
        std::thread::JoinHandle<BeverResult<PCloudCredentials>>,
    ) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_string();
        let receiver = std::thread::spawn(move || {
            receive_loopback_credentials(
                &server,
                "expected-state",
                cancelled,
                Instant::now() + timeout,
            )
        });
        (address, receiver)
    }

    #[test]
    fn a_wrong_state_is_refused_and_the_real_sign_in_still_completes() {
        static CANCELLED: AtomicBool = AtomicBool::new(false);
        let (address, receiver) = listen(&CANCELLED, Duration::from_secs(20));
        let forged = post_callback(&address, "access_token=evil&state=guessed", None);
        assert!(forged.starts_with("HTTP/1.1 400"), "{forged}");
        let cross_site = post_callback(
            &address,
            "access_token=evil&state=expected-state",
            Some("https://attacker.example"),
        );
        assert!(cross_site.starts_with("HTTP/1.1 400"), "{cross_site}");
        let missing = {
            let mut stream = TcpStream::connect(&address).unwrap();
            stream
                .write_all(b"GET /other HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        assert!(missing.starts_with("HTTP/1.1 404"), "{missing}");

        let genuine = post_callback(
            &address,
            "access_token=test-token&state=expected-state&hostname=eapi.pcloud.com",
            Some("http://127.0.0.1:53682"),
        );
        assert!(genuine.contains("pCloud is connected"), "{genuine}");
        let credentials = receiver.join().unwrap().unwrap();
        assert_eq!(credentials.access_token, "test-token");
        assert_eq!(credentials.hostname, "eapi.pcloud.com");
    }

    #[test]
    fn a_waiting_sign_in_can_be_cancelled() {
        static CANCELLED: AtomicBool = AtomicBool::new(false);
        let (_address, receiver) = listen(&CANCELLED, Duration::from_secs(60));
        let started = Instant::now();
        CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
        let error = receiver.join().unwrap().unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn an_unanswered_sign_in_times_out() {
        static CANCELLED: AtomicBool = AtomicBool::new(false);
        let (_address, receiver) = listen(&CANCELLED, Duration::from_millis(600));
        let error = receiver.join().unwrap().unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
}
