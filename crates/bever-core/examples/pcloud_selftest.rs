//! Opt-in end-to-end check of synchronization against a real pCloud account.
//!
//! ```sh
//! cargo run --release -p bever-core --example pcloud_selftest
//! cargo run --release -p bever-core --example pcloud_selftest -- --import notes.enex
//! ```
//!
//! It uses the access token the Bever application saved in the system
//! credential store (connect pCloud in the application first), or the token
//! in `BEVER_PCLOUD_TOKEN`. Everything happens in a new remote folder
//! named `/Bever-selftest-<random>`, which is deleted at the end; the
//! application's own `/Bever` folder is never read or written. Local data
//! lives in temporary directories. Neither the token nor any note content is
//! printed.
use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicI64, Ordering},
    time::{Duration, Instant},
};

use bever_core::{
    enex::import_enex,
    models::{Note, SaveNote, SyncReport},
    pcloud::{PCloudClient, PCloudCredentials},
    sync::{sync_with_remote, Listing, RemoteFile, RemoteStore, SyncOptions, TransferMetrics},
    BeverError, Library, Result,
};
use serde_json::json;

const ROOT_PREFIX: &str = "/Bever-selftest-";

fn saved_token() -> Result<String> {
    if let Ok(token) = env::var("BEVER_PCLOUD_TOKEN") {
        if !token.trim().is_empty() {
            return Ok(token.trim().to_owned());
        }
    }
    keyring::Entry::new("io.github.balakrishnangithub.bever", "pcloud")
        .and_then(|entry| entry.get_password())
        .map_err(|error| {
            BeverError::Invalid(format!(
                "no saved pCloud sign-in was found ({error}); connect pCloud in Bever first"
            ))
        })
}

/// The token is valid in one region only; find which.
fn connect(token: &str) -> Result<PCloudCredentials> {
    let mut last_error = None;
    for hostname in ["api.pcloud.com", "eapi.pcloud.com"] {
        let credentials = PCloudCredentials {
            access_token: token.to_owned(),
            hostname: hostname.to_owned(),
        };
        match PCloudClient::new(credentials.clone())?.user_email() {
            Ok(_) => return Ok(credentials),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.expect("two regions were tried"))
}

struct Device {
    _directory: tempfile::TempDir,
    library: Library,
}

impl Device {
    fn new() -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let library = Library::open(directory.path().join("library"))?;
        Ok(Self {
            _directory: directory,
            library,
        })
    }

    fn sync(&self, credentials: &PCloudCredentials, root: &str, label: &str) -> Result<SyncReport> {
        let client = PCloudClient::new(credentials.clone())?;
        let options = SyncOptions {
            remote_root: root.to_owned(),
        };
        let started = Instant::now();
        let report = sync_with_remote(&self.library, &client, &options, |_| {})?;
        println!(
            "  {label}: {:.1?}: {} up, {} down, {} attachments up, {} attachments down, {} requests, {:.1} MiB up, {:.1} MiB down, {} warnings",
            started.elapsed(),
            report.pushed,
            report.pulled,
            report.blobs_uploaded,
            report.blobs_downloaded,
            report.remote_requests,
            report.bytes_uploaded as f64 / 1_048_576.0,
            report.bytes_downloaded as f64 / 1_048_576.0,
            report.warnings.len(),
        );
        Ok(report)
    }

    fn edit(&self, id: &str, title: &str, html: &str, tags: &[&str]) -> Result<()> {
        let note = self.library.get_note(id)?;
        self.library.save_note(&SaveNote {
            id: id.to_owned(),
            notebook_id: note.notebook_id,
            title: title.to_owned(),
            content_html: html.to_owned(),
            attributes: json!({}),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            base_revision: None,
        })?;
        Ok(())
    }
}

/// Deterministic bytes that do not compress, to exercise real transfer sizes.
fn noise(length: usize, mut seed: u64) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(length);
    while bytes.len() < length {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        bytes.extend_from_slice(&seed.to_le_bytes());
    }
    bytes.truncate(length);
    bytes
}

fn essence(note: &Note) -> String {
    serde_json::to_string(&json!({
        "id": note.id,
        "notebook": note.notebook_id,
        "title": note.title,
        "html": note.content_html,
        "created": note.created_at,
        "updated": note.updated_at,
        "deleted": note.deleted_at,
        "tags": note.tags,
        "resources": note.resources.iter().map(|resource| json!([resource.sha256, resource.size, resource.file_name, resource.mime])).collect::<Vec<_>>(),
    }))
    .expect("serializable")
}

fn check(condition: bool, what: &str, failures: &mut Vec<String>) {
    if condition {
        println!("  ok: {what}");
    } else {
        println!("  FAILED: {what}");
        failures.push(what.to_owned());
    }
}

/// Every note and attachment of `left` exists identically in `right`.
fn same_library(left: &Library, right: &Library) -> Result<bool> {
    let (left_notes, right_notes) = (left.all_notes()?, right.all_notes()?);
    if left_notes.len() != right_notes.len() {
        return Ok(false);
    }
    for note in &left_notes {
        let Ok(other) = right.get_note(&note.id) else {
            return Ok(false);
        };
        if essence(note) != essence(&other) {
            return Ok(false);
        }
        for resource in &note.resources {
            let path = right.blob_path(&resource.sha256)?;
            if path.metadata().map(|metadata| metadata.len()).ok() != Some(resource.size) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn synthetic(
    credentials: &PCloudCredentials,
    root: &str,
    failures: &mut Vec<String>,
) -> Result<()> {
    println!("Synthetic round trip between two temporary libraries:");
    let (first, second) = (Device::new()?, Device::new()?);
    let stack = first.library.create_stack("Self-test stack")?;
    let notebook = first
        .library
        .ensure_notebook("Self-test notebook", Some(&stack.id))?;
    let mut ids = Vec::new();
    for index in 0..12 {
        let note = first.library.create_note(Some(&notebook))?;
        first.edit(
            &note.id,
            &format!("Self-test note {index:02} – ünïcödé & <symbols>"),
            &format!("<p>Body {index} with <strong>formatting</strong> &amp; entities.</p>"),
            &["self-test", "R&D"],
        )?;
        ids.push(note.id);
    }
    // One attachment large enough to need a streamed, multi-second transfer.
    let large = noise(6 * 1024 * 1024, 42);
    let large_resource = first
        .library
        .add_resource(&ids[0], &mut &large[..], "large.bin", None)?;
    first
        .library
        .add_resource(&ids[1], &mut &noise(40_000, 7)[..], "small.bin", None)?;
    first.library.add_resource(
        &ids[2],
        &mut &b"plain text attachment"[..],
        "notes.txt",
        None,
    )?;
    first.library.toggle_shortcut("note", &ids[3], "starred")?;

    let pushed = first.sync(credentials, root, "first device, initial upload")?;
    check(
        pushed.pushed == 12 && pushed.blobs_uploaded == 3,
        "12 notes and 3 attachments were uploaded",
        failures,
    );
    let pulled = second.sync(credentials, root, "second device, initial download")?;
    check(
        pulled.pulled == 12 && pulled.blobs_downloaded == 3 && pulled.conflicts == 0,
        "12 notes and 3 attachments were downloaded without conflicts",
        failures,
    );
    check(
        same_library(&first.library, &second.library)?,
        "both libraries hold identical notes and attachment files",
        failures,
    );
    check(
        second.library.read_blob(&large_resource.sha256)? == large,
        "the 6 MiB attachment arrived byte for byte",
        failures,
    );
    let snapshot = second.library.snapshot()?;
    check(
        snapshot.notebooks.len() == 2
            && snapshot.stacks.len() == 1
            && snapshot.shortcuts.len() == 1,
        "notebooks, the stack, and the shortcut arrived, with a single Inbox",
        failures,
    );
    check(
        snapshot.tags.iter().any(|tag| tag.name == "R&D"),
        "a tag containing & arrived intact",
        failures,
    );

    // Changes in the other direction: an edit, a deletion, a rename.
    second.edit(
        &ids[4],
        "Edited on the second device",
        "<p>Changed.</p>",
        &["self-test"],
    )?;
    second.library.delete_note_permanently(&ids[5])?;
    second
        .library
        .rename_notebook(&notebook, "Renamed notebook")?;
    second.library.toggle_shortcut("note", &ids[3], "starred")?;
    second.sync(credentials, root, "second device, changes up")?;
    let back = first.sync(credentials, root, "first device, changes down")?;
    check(
        back.conflicts == 0,
        "the changes applied without conflicts",
        failures,
    );
    check(
        first.library.get_note(&ids[4])?.title == "Edited on the second device",
        "an edit travelled back",
        failures,
    );
    check(
        first.library.get_note(&ids[5]).is_err(),
        "a deletion travelled back",
        failures,
    );
    let snapshot = first.library.snapshot()?;
    check(
        snapshot
            .notebooks
            .iter()
            .any(|item| item.name == "Renamed notebook"),
        "a notebook rename travelled back",
        failures,
    );
    check(
        snapshot.shortcuts.is_empty(),
        "a removed shortcut stayed removed",
        failures,
    );
    check(
        same_library(&first.library, &second.library)?,
        "both libraries are identical again",
        failures,
    );

    let idle_first = first.sync(credentials, root, "first device, nothing to do")?;
    let idle_second = second.sync(credentials, root, "second device, nothing to do")?;
    check(
        idle_first.pushed + idle_first.pulled + idle_second.pushed + idle_second.pulled == 0
            && idle_first.bytes_uploaded + idle_second.bytes_uploaded == 0,
        "a run with nothing to do transfers no notes and uploads nothing",
        failures,
    );
    check(
        idle_first.remote_requests == 2 && idle_second.remote_requests == 2,
        &format!(
            "a run with nothing to do makes two requests ({} and {})",
            idle_first.remote_requests, idle_second.remote_requests
        ),
        failures,
    );

    // What a run costs: the two listings, and a transfer for what changed.
    check(
        pushed.remote_requests == 10,
        &format!(
            "the first upload made 10 requests: 4 to find and make the folders, 3 attachments, the 12 notes in 1, and 2 for the notebook list ({})",
            pushed.remote_requests
        ),
        failures,
    );
    first.edit(
        &ids[6],
        "Edited on the first device",
        "<p>Changed again.</p>",
        &["self-test"],
    )?;
    let edit_up = first.sync(credentials, root, "first device, one edited note up")?;
    check(
        edit_up.pushed == 1 && edit_up.remote_requests == 3,
        &format!(
            "one edited note is uploaded in 3 requests ({})",
            edit_up.remote_requests
        ),
        failures,
    );
    let edit_down = second.sync(credentials, root, "second device, one edited note down")?;
    check(
        edit_down.pulled == 1 && edit_down.remote_requests == 4,
        &format!(
            "and downloaded in 4, pCloud giving a file in two steps ({})",
            edit_down.remote_requests
        ),
        failures,
    );
    check(
        second.library.get_note(&ids[6])?.title == "Edited on the first device",
        "the edit arrived",
        failures,
    );
    let idle_again = first.sync(credentials, root, "first device, nothing to do again")?;
    check(
        idle_again.remote_requests == 2,
        &format!(
            "what a device uploaded itself is not downloaded to it ({})",
            idle_again.remote_requests
        ),
        failures,
    );
    Ok(())
}

fn rejected_token(credentials: &PCloudCredentials, failures: &mut Vec<String>) -> Result<()> {
    println!("A rejected sign-in:");
    let secret = "selftest-invalid-token-0123456789";
    let client = PCloudClient::new(PCloudCredentials {
        access_token: secret.to_owned(),
        hostname: credentials.hostname.clone(),
    })?;
    let started = Instant::now();
    let message = client
        .list("/")
        .err()
        .map(|error| error.to_string())
        .unwrap_or_default();
    check(
        message.contains("connect pCloud again"),
        "is reported as a sign-in problem",
        failures,
    );
    check(
        !message.contains(secret),
        "without revealing the token in the message",
        failures,
    );
    check(
        started.elapsed() < Duration::from_secs(15),
        "without being retried as if it were a network fault",
        failures,
    );
    Ok(())
}

/// pCloud, except that only so many uploads succeed: a device that is closed,
/// or loses its connection, in the middle of a run.
struct Interrupted<'a> {
    remote: &'a PCloudClient,
    uploads_left: AtomicI64,
}

impl Interrupted<'_> {
    fn allow(&self) -> Result<()> {
        if self.uploads_left.fetch_sub(1, Ordering::SeqCst) > 0 {
            Ok(())
        } else {
            Err(BeverError::Network("interrupted for the self-test".into()))
        }
    }
}

impl RemoteStore for Interrupted<'_> {
    fn ensure_folder(&self, path: &str) -> Result<()> {
        self.remote.ensure_folder(path)
    }

    fn list(&self, folder: &str) -> Result<Option<Listing>> {
        self.remote.list(folder)
    }

    fn download(&self, path: &str) -> Result<Vec<u8>> {
        self.remote.download(path)
    }

    fn download_to(
        &self,
        path: &str,
        expected_size: u64,
        sink: &mut dyn FnMut(&mut dyn Read) -> Result<()>,
    ) -> Result<()> {
        self.remote.download_to(path, expected_size, sink)
    }

    fn upload_all(&self, folder: &str, files: &[(String, Vec<u8>)]) -> Result<Vec<RemoteFile>> {
        for _ in files {
            self.allow()?;
        }
        self.remote.upload_all(folder, files)
    }

    fn upload_file(&self, path: &str, source: &Path, size: u64) -> Result<()> {
        self.allow()?;
        self.remote.upload_file(path, source, size)
    }

    fn metrics(&self) -> TransferMetrics {
        self.remote.metrics()
    }
}

/// A run uploads its notes before its notebook list. A device that
/// synchronizes in between must still file the notes in their notebook.
fn joined_midway(
    credentials: &PCloudCredentials,
    root: &str,
    failures: &mut Vec<String>,
) -> Result<()> {
    println!("A second device that synchronizes while the first is still uploading:");
    let (first, second, third) = (Device::new()?, Device::new()?, Device::new()?);
    let stack = first.library.create_stack("Self-test reading")?;
    let feeds = first
        .library
        .ensure_notebook("Self-test feeds", Some(&stack.id))?;
    let mut ids = Vec::new();
    for index in 0..8 {
        let note = first.library.create_note(Some(&feeds))?;
        first.edit(
            &note.id,
            &format!("Clip {index}"),
            "<p>Body</p>",
            &["selftest"],
        )?;
        ids.push(note.id);
    }
    let filed = |device: &Device| -> Result<bool> {
        let snapshot = device.library.snapshot()?;
        let named = snapshot.notebooks.iter().any(|notebook| {
            notebook.id == feeds
                && notebook.name == "Self-test feeds"
                && notebook.stack_id.as_deref() == Some(stack.id.as_str())
        });
        let stacked = snapshot
            .stacks
            .iter()
            .any(|known| known.id == stack.id && known.name == "Self-test reading");
        let inboxes = snapshot
            .notebooks
            .iter()
            .filter(|notebook| notebook.name == "Inbox")
            .count();
        let placed = ids.iter().all(|id| {
            device
                .library
                .get_note(id)
                .is_ok_and(|note| note.notebook_id == feeds)
        });
        Ok(named && stacked && placed && inboxes == 1)
    };

    let client = PCloudClient::new(credentials.clone())?;
    let interrupted = Interrupted {
        remote: &client,
        uploads_left: AtomicI64::new(ids.len() as i64),
    };
    let options = SyncOptions {
        remote_root: root.to_owned(),
    };
    let stopped = sync_with_remote(&first.library, &interrupted, &options, |_| {}).is_err();
    let listed = client.list(root)?.unwrap_or_default();
    check(
        stopped && listed.file("metadata.json").is_none(),
        "the first device was stopped after its notes, before its notebook list",
        failures,
    );

    let joined = second.sync(credentials, root, "second device, joining midway")?;
    check(
        joined.pulled == ids.len() as u64 && joined.pushed == 0,
        "the second device received the notes and uploaded nothing about them",
        failures,
    );
    check(
        filed(&second)?,
        "its notes are in their notebook and stack, not in Inbox",
        failures,
    );

    first.sync(credentials, root, "first device, finishing")?;
    third.sync(credentials, root, "third device, added afterwards")?;
    check(
        filed(&third)?,
        "a device added afterwards files them correctly too",
        failures,
    );
    second.sync(credentials, root, "second device, again")?;
    first.sync(credentials, root, "first device, again")?;
    check(
        filed(&first)? && filed(&second)?,
        "the first two devices still agree, with a single Inbox each",
        failures,
    );
    check(
        same_library(&first.library, &second.library)?
            && same_library(&first.library, &third.library)?,
        "all three libraries hold identical notes",
        failures,
    );
    Ok(())
}

fn real_volume(
    credentials: &PCloudCredentials,
    root: &str,
    export: &PathBuf,
    failures: &mut Vec<String>,
) -> Result<()> {
    println!("Real-volume round trip of an imported export:");
    let (first, second) = (Device::new()?, Device::new()?);
    let report = import_enex(&first.library, export, Some("Self-test import"))?;
    println!(
        "  imported {} notes and {} attachments ({:.1} MiB)",
        report.notes_imported,
        report.resources_imported,
        report.bytes_imported as f64 / 1_048_576.0
    );
    let pushed = first.sync(credentials, root, "upload")?;
    check(
        pushed.pushed == report.notes_imported && pushed.warnings.is_empty(),
        "every imported note was uploaded",
        failures,
    );
    let pulled = second.sync(credentials, root, "download into an empty library")?;
    check(
        pulled.pulled == report.notes_imported,
        "every note was downloaded",
        failures,
    );
    check(
        same_library(&first.library, &second.library)?,
        "both libraries hold identical notes and attachment files",
        failures,
    );
    Ok(())
}

fn main() -> Result<()> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let export = arguments
        .iter()
        .position(|argument| argument == "--import")
        .and_then(|index| arguments.get(index + 1))
        .map(PathBuf::from);

    let credentials = connect(&saved_token()?)?;
    let root = format!(
        "{ROOT_PREFIX}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..10]
    );
    println!(
        "Connected to pCloud ({}). Working only in {root}.",
        credentials.hostname
    );

    let mut failures = Vec::new();
    let outcome = synthetic(&credentials, &root, &mut failures)
        .and_then(|()| joined_midway(&credentials, &format!("{root}/midway"), &mut failures))
        .and_then(|()| rejected_token(&credentials, &mut failures))
        .and_then(|()| match &export {
            Some(export) => real_volume(
                &credentials,
                &format!("{root}/volume"),
                export,
                &mut failures,
            ),
            None => Ok(()),
        });

    // Clean up whatever happened above. The prefix check is a last line of
    // defence against ever deleting anything but this run's own folder.
    assert!(root.starts_with(ROOT_PREFIX) && root.len() > ROOT_PREFIX.len());
    match PCloudClient::new(credentials)?.delete_folder_recursive(&root) {
        Ok(()) => println!("Removed {root} from pCloud."),
        Err(error) => println!("COULD NOT REMOVE {root} from pCloud: {error}"),
    }

    outcome?;
    if failures.is_empty() {
        println!("PASS: live synchronization works end to end.");
        Ok(())
    } else {
        Err(BeverError::Invalid(format!(
            "{} checks failed: {}",
            failures.len(),
            failures.join("; ")
        )))
    }
}
