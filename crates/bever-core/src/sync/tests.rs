//! End-to-end synchronization between libraries through an in-memory remote.
use serde_json::json;

use super::{remote::memory::MemoryRemote, sync_with_remote, Cancel, RunOutcome, SyncOptions};
use crate::{
    db::Library,
    error::BeverError,
    models::{Note, NoteFilter, SaveNote, SyncReport},
};

struct Device {
    _directory: tempfile::TempDir,
    library: Library,
}

impl Device {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
        Self {
            _directory: directory,
            library,
        }
    }

    fn sync(&self, remote: &MemoryRemote) -> SyncReport {
        sync_with_remote(&self.library, remote, &SyncOptions::default(), |_| {}).unwrap()
    }

    fn inbox(&self) -> String {
        self.library
            .snapshot()
            .unwrap()
            .notebooks
            .into_iter()
            .find(|notebook| notebook.name == "Inbox")
            .unwrap()
            .id
    }

    fn add(&self, title: &str, body: &str, tags: &[&str]) -> String {
        let note = self.library.create_note(None).unwrap();
        self.edit(&note.id, title, body, tags);
        note.id
    }

    fn edit(&self, id: &str, title: &str, body: &str, tags: &[&str]) {
        let note = self.library.get_note(id).unwrap();
        self.library
            .save_note(&SaveNote {
                id: id.to_owned(),
                notebook_id: note.notebook_id,
                title: title.into(),
                content_html: format!("<p>{body}</p>"),
                attributes: json!({}),
                tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
                base_revision: None,
            })
            .unwrap();
    }

    fn note(&self, id: &str) -> Note {
        self.library.get_note(id).unwrap()
    }

    fn titles(&self) -> Vec<String> {
        let mut titles = self
            .library
            .all_notes()
            .unwrap()
            .into_iter()
            .map(|note| note.title)
            .collect::<Vec<_>>();
        titles.sort();
        titles
    }

    fn notebook_names(&self) -> Vec<String> {
        self.library
            .snapshot()
            .unwrap()
            .notebooks
            .into_iter()
            .map(|notebook| notebook.name)
            .collect()
    }
}

/// What makes two copies of a note the same note, leaving out bookkeeping.
fn essence(note: &Note) -> serde_json::Value {
    json!({
        "id": note.id,
        "notebook": note.notebook_id,
        "title": note.title,
        "html": note.content_html,
        "created": note.created_at,
        "updated": note.updated_at,
        "deleted": note.deleted_at,
        "tags": note.tags,
        "resources": note.resources.iter().map(|resource| json!([resource.sha256, resource.file_name, resource.mime, resource.recognition_text])).collect::<Vec<_>>(),
    })
}

fn note_uploads(remote: &MemoryRemote) -> Vec<String> {
    remote
        .take_uploads()
        .into_iter()
        .filter(|path| path.contains("/items/note-"))
        .collect()
}

#[test]
fn notes_attachments_and_metadata_travel_between_devices() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let stack = first.library.create_stack("Projects").unwrap();
    let work = first
        .library
        .ensure_notebook("Work", Some(&stack.id))
        .unwrap();
    let plan = first.library.create_note(Some(&work)).unwrap().id;
    first.edit(&plan, "Plan", "Ship it", &["urgent", "q3"]);
    let attachment = first
        .library
        .add_resource(&plan, &mut &b"spreadsheet bytes"[..], "budget.xlsx", None)
        .unwrap();
    let memo = first.add("Memo", "Remember", &[]);
    first
        .library
        .toggle_shortcut("note", &memo, "Memo")
        .unwrap();

    let pushed = first.sync(&remote);
    assert_eq!(
        (pushed.pushed, pushed.blobs_uploaded, pushed.pulled),
        (2, 1, 0)
    );
    assert!(pushed.warnings.is_empty());
    let pulled = second.sync(&remote);
    assert_eq!(
        (pulled.pulled, pulled.blobs_downloaded, pulled.conflicts),
        (2, 1, 0)
    );

    for id in [&plan, &memo] {
        assert_eq!(essence(&second.note(id)), essence(&first.note(id)));
    }
    assert_eq!(
        second.library.read_blob(&attachment.sha256).unwrap(),
        b"spreadsheet bytes"
    );
    let snapshot = second.library.snapshot().unwrap();
    assert_eq!(snapshot.stacks[0].name, "Projects");
    let synced_work = snapshot
        .notebooks
        .iter()
        .find(|item| item.id == work)
        .unwrap();
    assert_eq!(synced_work.stack_id.as_deref(), Some(stack.id.as_str()));
    assert_eq!(snapshot.shortcuts.len(), 1);
    assert_eq!(snapshot.tags.len(), 2);
    // Both devices started with their own "Inbox"; there is still only one.
    assert_eq!(second.notebook_names(), ["Inbox", "Work"]);
    assert_eq!(second.note(&memo).notebook_id, first.inbox());
    assert_eq!(second.inbox(), first.inbox());
    // Synchronized content is searchable on the receiving device.
    let found = second
        .library
        .list_notes(&NoteFilter {
            query: "ship tag:urgent".into(),
            ..NoteFilter::default()
        })
        .unwrap();
    assert_eq!(found.total, 1);
}

#[test]
fn a_run_with_nothing_to_do_transfers_nothing() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    first.add("One", "Body", &["tag"]);
    first.sync(&remote);
    second.sync(&remote);
    first.sync(&remote);
    remote.take_uploads();
    remote.take_downloads();

    for device in [&first, &second, &first] {
        let before = remote.requests();
        let report = device.sync(&remote);
        assert_eq!((report.pushed, report.pulled), (0, 0));
        assert_eq!(
            remote.requests() - before,
            2,
            "the library's folder and its notes are listed, and that is all"
        );
    }
    assert!(
        remote.take_uploads().is_empty(),
        "nothing changed, so nothing is uploaded"
    );
    let downloads = remote.take_downloads();
    assert!(
        downloads.is_empty(),
        "what is unchanged is recognised from the listings: {downloads:?}"
    );
}

#[test]
fn an_edit_costs_the_two_listings_and_one_transfer() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Text", "Body", &[]);
    first.sync(&remote);
    second.sync(&remote);
    first.sync(&remote);

    first.edit(&id, "Text", "Edited", &[]);
    let before = remote.requests();
    assert_eq!(first.sync(&remote).pushed, 1);
    assert_eq!(
        remote.requests() - before,
        3,
        "a note of text alone is uploaded without asking about attachments"
    );
    let before = remote.requests();
    assert_eq!(second.sync(&remote).pulled, 1);
    assert_eq!(remote.requests() - before, 3);

    // With an attachment: the attachments are listed, then it and the note
    // are uploaded.
    first
        .library
        .add_resource(&id, &mut &b"attached"[..], "file.bin", None)
        .unwrap();
    let before = remote.requests();
    let report = first.sync(&remote);
    assert_eq!((report.pushed, report.blobs_uploaded), (1, 1));
    assert_eq!(remote.requests() - before, 5);
}

#[test]
fn notes_are_uploaded_together() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    for index in 0..20 {
        first.add(&format!("Note {index:02}"), "Body", &[]);
    }
    let before = remote.requests();
    assert_eq!(first.sync(&remote).pushed, 20);
    assert_eq!(note_uploads(&remote).len(), 20);
    // The folder is looked for and, with the two inside it, made; the notes
    // go in one request; and the notebook list is looked for and uploaded.
    assert_eq!(remote.requests() - before, 7);

    // More notes than are handled at a time take a request for each lot,
    // and deletions travel together too.
    let ids = (0..40)
        .map(|index| first.add(&format!("Later {index:02}"), "Body", &[]))
        .collect::<Vec<_>>();
    let before = remote.requests();
    assert_eq!(first.sync(&remote).pushed, 40);
    assert_eq!(remote.requests() - before, 4);
    for id in &ids {
        first.library.delete_note_permanently(id).unwrap();
    }
    let before = remote.requests();
    assert_eq!(first.sync(&remote).pushed, 40);
    assert_eq!(remote.requests() - before, 4);

    second.sync(&remote);
    assert_eq!(second.titles().len(), 20);
}

#[test]
fn notes_stored_by_a_request_that_failed_are_recognised_as_this_librarys_own() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    for index in 0..6 {
        first.add(&format!("Note {index}"), "Body", &["tag"]);
    }
    // The connection is lost in the middle of the request that carries the
    // notes: three are stored, and the library is told of none.
    remote.fail_uploads_after(3);
    let failed = sync_with_remote(&first.library, &remote, &SyncOptions::default(), |_| {});
    assert!(matches!(failed, Err(BeverError::Network(_))));
    remote.stop_failing();
    assert_eq!(note_uploads(&remote).len(), 3);

    let report = first.sync(&remote);
    assert_eq!(report.conflicts, 0);
    assert_eq!(first.titles().len(), 6, "no conflict copies were made");
    assert_eq!(
        note_uploads(&remote).len(),
        3,
        "only the notes that were not stored are sent"
    );
    second.sync(&remote);
    assert_eq!(second.titles(), first.titles());
    remote.take_uploads();
    first.sync(&remote);
    assert!(remote.take_uploads().is_empty());
}

#[test]
fn edits_made_on_both_devices_are_both_kept() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Shared", "Original", &[]);
    first.sync(&remote);
    second.sync(&remote);

    first.edit(&id, "Shared", "Edited on the first device", &[]);
    second.edit(&id, "Shared", "Edited on the second device", &[]);
    first.sync(&remote);
    let report = second.sync(&remote);
    assert_eq!(report.conflicts, 1);
    assert_eq!(second.titles(), ["Shared", "Shared (conflict copy)"]);
    assert!(second.note(&id).content_html.contains("first device"));

    // The conflict copy is an ordinary note and reaches the other device.
    first.sync(&remote);
    assert_eq!(first.titles(), ["Shared", "Shared (conflict copy)"]);
    let copy = first
        .library
        .all_notes()
        .unwrap()
        .into_iter()
        .find(|note| note.title.ends_with("(conflict copy)"))
        .unwrap();
    assert!(copy.content_html.contains("second device"));
}

#[test]
fn saving_the_same_content_on_both_devices_is_not_a_conflict() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Same", "Original", &[]);
    first.sync(&remote);
    second.sync(&remote);
    first.edit(&id, "Same", "Identical edit", &[]);
    second.edit(&id, "Same", "Identical edit", &[]);
    // Saving stamps the time; make the two saves indistinguishable.
    let stamp = first.note(&id).updated_at;
    let created = first.note(&id).created_at;
    second
        .library
        .update_note_timestamps(&id, created, stamp)
        .unwrap();
    first
        .library
        .update_note_timestamps(&id, created, stamp)
        .unwrap();
    first.sync(&remote);
    let report = second.sync(&remote);
    assert_eq!(report.conflicts, 0);
    assert_eq!(second.titles(), ["Same"]);
}

#[test]
fn a_changed_timestamp_travels_even_when_it_moves_backwards() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Backdated", "Body", &[]);
    first.sync(&remote);
    second.sync(&remote);
    first
        .library
        .update_note_timestamps(&id, 1_000_000, 2_000_000)
        .unwrap();
    first.sync(&remote);
    second.sync(&remote);
    assert_eq!(second.note(&id).created_at, 1_000_000);
    assert_eq!(second.note(&id).updated_at, 2_000_000);
    // And it is not sent back.
    remote.take_uploads();
    second.sync(&remote);
    assert!(note_uploads(&remote).is_empty());
}

#[test]
fn deleting_a_note_reaches_other_devices_and_is_uploaded_once() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Doomed", "Body", &[]);
    let attachment = first
        .library
        .add_resource(&id, &mut &b"attached"[..], "file.bin", None)
        .unwrap();
    let kept = first.add("Kept", "Body", &[]);
    first.sync(&remote);
    second.sync(&remote);
    assert!(second
        .library
        .blob_path(&attachment.sha256)
        .unwrap()
        .exists());

    first.library.delete_note_permanently(&id).unwrap();
    remote.take_uploads();
    let report = first.sync(&remote);
    assert_eq!(report.pushed, 1);
    assert_eq!(note_uploads(&remote).len(), 1);
    // The deletion is not uploaded again on later runs.
    first.sync(&remote);
    first.sync(&remote);
    assert!(note_uploads(&remote).is_empty());

    second.sync(&remote);
    assert!(second.library.get_note(&id).is_err());
    assert_eq!(second.titles(), ["Kept"]);
    assert!(
        !second
            .library
            .blob_path(&attachment.sha256)
            .unwrap()
            .exists(),
        "the attachment file is freed on the receiving device too"
    );
    // The receiving device does not echo the deletion back.
    remote.take_uploads();
    second.sync(&remote);
    assert!(note_uploads(&remote).is_empty());
    assert_eq!(first.note(&kept).title, "Kept");
}

#[test]
fn a_note_that_was_never_uploaded_leaves_no_remote_trace_when_deleted() {
    let remote = MemoryRemote::new();
    let first = Device::new();
    let id = first.add("Draft", "Body", &[]);
    first.library.delete_note_permanently(&id).unwrap();
    first.sync(&remote);
    assert!(remote.paths().iter().all(|path| !path.contains(&id)));
}

#[test]
fn an_edit_outlives_a_deletion_made_on_another_device() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Contested", "Original", &[]);
    first.sync(&remote);
    second.sync(&remote);

    first.library.delete_note_permanently(&id).unwrap();
    first.sync(&remote);
    second.edit(&id, "Contested", "Edited after the deletion", &[]);
    second.sync(&remote);
    assert!(second.note(&id).content_html.contains("Edited after"));

    first.sync(&remote);
    assert!(first.note(&id).content_html.contains("Edited after"));
}

#[test]
fn a_local_deletion_is_not_undone_by_an_older_remote_edit() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Going", "Original", &[]);
    first.sync(&remote);
    second.sync(&remote);

    first.edit(&id, "Going", "Edited elsewhere", &[]);
    first.sync(&remote);
    second.library.delete_note_permanently(&id).unwrap();
    second.sync(&remote);
    assert!(second.library.get_note(&id).is_err());
    first.sync(&remote);
    assert!(first.library.get_note(&id).is_err());
}

#[test]
fn trashing_and_restoring_travel_as_ordinary_changes() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Binned", "Body", &[]);
    first.sync(&remote);
    second.sync(&remote);
    first.library.set_note_trashed(&id, true).unwrap();
    first.sync(&remote);
    second.sync(&remote);
    assert!(second.note(&id).deleted_at.is_some());
    second.library.set_note_trashed(&id, false).unwrap();
    second.sync(&remote);
    first.sync(&remote);
    assert!(first.note(&id).deleted_at.is_none());
}

#[test]
fn deleted_notebooks_tags_stacks_and_shortcuts_stay_deleted() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let stack = first.library.create_stack("Stack").unwrap();
    let archive = first
        .library
        .ensure_notebook("Archive", Some(&stack.id))
        .unwrap();
    let old = first.library.create_note(Some(&archive)).unwrap().id;
    first.edit(&old, "Old", "Body", &["obsolete", "keep"]);
    first
        .library
        .toggle_shortcut("notebook", &archive, "Archive")
        .unwrap();
    let starred = first.add("Starred", "Body", &[]);
    first
        .library
        .toggle_shortcut("note", &starred, "Starred")
        .unwrap();
    first.sync(&remote);
    second.sync(&remote);
    assert_eq!(second.library.snapshot().unwrap().shortcuts.len(), 2);

    // A note that exists only on the second device, in the same notebook.
    let local_only = second.library.create_note(Some(&archive)).unwrap().id;
    second.edit(&local_only, "Second only", "Body", &["obsolete"]);

    let obsolete = first
        .library
        .snapshot()
        .unwrap()
        .tags
        .into_iter()
        .find(|tag| tag.name == "obsolete")
        .unwrap();
    first.library.delete_tag(&obsolete.id).unwrap();
    first.library.delete_notebook(&archive).unwrap();
    first.library.delete_stack(&stack.id).unwrap();
    first
        .library
        .toggle_shortcut("note", &starred, "Starred")
        .unwrap();
    first.sync(&remote);

    second.sync(&remote);
    let snapshot = second.library.snapshot().unwrap();
    assert_eq!(second.notebook_names(), ["Inbox"]);
    assert!(snapshot.stacks.is_empty());
    assert_eq!(
        snapshot
            .tags
            .iter()
            .map(|tag| tag.name.as_str())
            .collect::<Vec<_>>(),
        ["keep"]
    );
    assert!(snapshot.shortcuts.is_empty(), "{:?}", snapshot.shortcuts);
    // The first device's note went to the trash with its notebook.
    assert!(second.note(&old).deleted_at.is_some());
    assert_eq!(second.note(&old).tags, ["keep"]);
    // The note the first device never saw is kept, out of the trash.
    let survivor = second.note(&local_only);
    assert!(survivor.deleted_at.is_none());
    assert_eq!(survivor.notebook_id, second.inbox());
    assert!(survivor.tags.is_empty());

    // Nothing comes back, in either direction.
    first.sync(&remote);
    second.sync(&remote);
    first.sync(&remote);
    for device in [&first, &second] {
        let snapshot = device.library.snapshot().unwrap();
        assert_eq!(device.notebook_names(), ["Inbox"]);
        assert!(snapshot.stacks.is_empty());
        assert_eq!(snapshot.tags.len(), 1);
        assert!(snapshot.shortcuts.is_empty());
        assert_eq!(device.titles(), ["Old", "Second only", "Starred"]);
    }
    assert_eq!(first.note(&local_only).notebook_id, first.inbox());
}

#[test]
fn renames_reach_other_devices() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let work = first.library.ensure_notebook("Work", None).unwrap();
    let id = first.library.create_note(Some(&work)).unwrap().id;
    first.edit(&id, "Note", "Body", &["draft"]);
    first.sync(&remote);
    second.sync(&remote);

    let draft = first.library.snapshot().unwrap().tags.remove(0);
    first.library.rename_tag(&draft.id, "final").unwrap();
    first.library.rename_notebook(&work, "Projects").unwrap();
    first.sync(&remote);
    let report = second.sync(&remote);
    assert_eq!(report.conflicts, 0);
    assert_eq!(second.notebook_names(), ["Inbox", "Projects"]);
    assert_eq!(second.note(&id).tags, ["final"]);
    let tags = second.library.snapshot().unwrap().tags;
    assert_eq!(tags.len(), 1, "the old name is not left behind: {tags:?}");
    assert_eq!(tags[0].id, draft.id);
}

#[test]
fn notebooks_and_tags_created_separately_under_one_name_become_one() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let first_trips = first.library.ensure_notebook("Trips", None).unwrap();
    let first_note = first.library.create_note(Some(&first_trips)).unwrap().id;
    first.edit(&first_note, "Paris", "Body", &["travel"]);
    let second_trips = second.library.ensure_notebook("trips", None).unwrap();
    let second_note = second.library.create_note(Some(&second_trips)).unwrap().id;
    second.edit(&second_note, "Rome", "Body", &["Travel"]);
    second
        .library
        .toggle_shortcut("notebook", &second_trips, "trips")
        .unwrap();

    first.sync(&remote);
    second.sync(&remote);
    first.sync(&remote);
    second.sync(&remote);

    for device in [&first, &second] {
        assert_eq!(device.notebook_names(), ["Inbox", "Trips"]);
        assert_eq!(device.titles(), ["Paris", "Rome"]);
        let snapshot = device.library.snapshot().unwrap();
        assert_eq!(snapshot.tags.len(), 1);
        assert_eq!(snapshot.shortcuts.len(), 1);
        assert_eq!(snapshot.shortcuts[0].target_id, first_trips);
        for id in [&first_note, &second_note] {
            assert_eq!(device.note(id).notebook_id, first_trips);
            assert_eq!(device.note(id).tags.len(), 1);
        }
    }
    assert_eq!(
        first.library.snapshot().unwrap().tags[0].id,
        second.library.snapshot().unwrap().tags[0].id
    );
}

#[test]
fn an_interrupted_run_is_completed_by_the_next_one() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let mut ids = Vec::new();
    for index in 0..40 {
        let id = first.add(&format!("Note {index:02}"), "Body", &[]);
        first
            .library
            .add_resource(
                &id,
                &mut format!("attachment {index}").as_bytes(),
                "a.txt",
                None,
            )
            .unwrap();
        ids.push(id);
    }
    remote.fail_uploads_after(25);
    let failed = sync_with_remote(&first.library, &remote, &SyncOptions::default(), |_| {});
    assert!(matches!(failed, Err(BeverError::Network(_))));

    remote.stop_failing();
    remote.take_uploads();
    let report = first.sync(&remote);
    assert!(report.pushed > 0 && report.pushed <= 40);
    let uploads = remote.take_uploads();
    let blob_uploads = uploads
        .iter()
        .filter(|path| path.contains("/blobs/"))
        .count();
    assert!(
        blob_uploads < 40,
        "attachments uploaded before the failure are not sent again"
    );

    second.sync(&remote);
    assert_eq!(second.titles().len(), 40);
    for id in &ids {
        assert_eq!(essence(&second.note(id)), essence(&first.note(id)));
        let sha = &second.note(id).resources[0].sha256;
        assert!(second.library.blob_path(sha).unwrap().exists());
    }
    // And the remote is now complete: another run changes nothing.
    remote.take_uploads();
    first.sync(&remote);
    assert!(remote.take_uploads().is_empty());
}

#[test]
fn a_missing_attachment_file_holds_back_one_note_not_the_whole_run() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let broken = first.add("Broken", "Body", &[]);
    let attachment = first
        .library
        .add_resource(&broken, &mut &b"lost bytes"[..], "lost.bin", None)
        .unwrap();
    first.add("Fine", "Body", &[]);
    std::fs::remove_file(first.library.blob_path(&attachment.sha256).unwrap()).unwrap();

    let report = first.sync(&remote);
    assert_eq!(report.pushed, 1);
    assert_eq!(report.warnings.len(), 1);
    assert!(report.warnings[0].contains("Broken"));
    second.sync(&remote);
    assert_eq!(second.titles(), ["Fine"]);
}

#[test]
fn recognised_text_is_shared_without_looking_like_an_edit() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Receipt", "Scan", &[]);
    // Not a decodable image, which does not matter: only the queue is used.
    let image = first
        .library
        .add_resource(
            &id,
            &mut &b"pretend image"[..],
            "scan.png",
            Some("image/png"),
        )
        .unwrap();
    first.sync(&remote);
    second.sync(&remote);
    // The second device queues the image too; it recognises it first.
    assert_eq!(second.library.ocr_pending().unwrap(), 1);
    second
        .library
        .finish_ocr(
            &image.sha256,
            Some(&crate::ocr::Recognized {
                text: "total 42".into(),
                xml: "<recoIndex><item x=\"1\" y=\"1\" w=\"9\" h=\"9\"><t w=\"80\">total</t></item></recoIndex>".into(),
            }),
            true,
        )
        .unwrap();

    // Meanwhile the first device edits the note.
    first.edit(&id, "Receipt", "Scan, filed", &[]);
    first.sync(&remote);
    let report = second.sync(&remote);
    assert_eq!(report.conflicts, 0, "recognition is not a user edit");
    let merged = second.note(&id);
    assert!(merged.content_html.contains("filed"));
    assert_eq!(
        merged.resources[0].recognition_text.as_deref(),
        Some("total 42")
    );

    // The text reaches the first device, which then has nothing left to do.
    first.sync(&remote);
    assert_eq!(
        first.note(&id).resources[0].recognition_text.as_deref(),
        Some("total 42")
    );
    assert_eq!(first.library.ocr_pending().unwrap(), 0);
    remote.take_uploads();
    first.sync(&remote);
    second.sync(&remote);
    assert!(note_uploads(&remote).is_empty());
}

#[test]
fn reimporting_after_a_sync_does_not_duplicate_notes() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("export.enex");
    std::fs::write(
        &source,
        r#"<en-export><note><title>Imported</title><created>20240102T030405Z</created><content><![CDATA[<en-note><div>Body</div></en-note>]]></content></note></en-export>"#,
    )
    .unwrap();
    crate::enex::import_enex(&first.library, &source, None).unwrap();
    let id = first.library.all_notes().unwrap().remove(0).id;
    first.sync(&remote);
    second.sync(&remote);
    second.edit(&id, "Imported", "Edited elsewhere", &[]);
    second.sync(&remote);
    first.sync(&remote);
    assert!(first.note(&id).content_html.contains("Edited elsewhere"));

    let again = crate::enex::import_enex(&first.library, &source, None).unwrap();
    assert_eq!((again.notes_imported, again.notes_skipped), (0, 1));
    assert_eq!(first.titles(), ["Imported"]);
}

#[test]
fn a_custom_remote_folder_keeps_libraries_apart() {
    let remote = MemoryRemote::new();
    let first = Device::new();
    first.add("Elsewhere", "Body", &[]);
    let options = SyncOptions {
        remote_root: "/Bever-selftest-1".into(),
        ..SyncOptions::default()
    };
    sync_with_remote(&first.library, &remote, &options, |_| {}).unwrap();
    assert!(!remote.paths().is_empty());
    assert!(remote
        .paths()
        .iter()
        .all(|path| path.starts_with("/Bever-selftest-1/")));
    for invalid in ["", "/", "Bever", "/Bever/", "/a/../b", "/a//b"] {
        let options = SyncOptions {
            remote_root: invalid.into(),
            ..SyncOptions::default()
        };
        assert!(
            sync_with_remote(&first.library, &remote, &options, |_| {}).is_err(),
            "{invalid:?}"
        );
    }
}

#[test]
fn progress_reports_every_phase_in_order() {
    let remote = MemoryRemote::new();
    let first = Device::new();
    let id = first.add("Tracked", "Body", &[]);
    first
        .library
        .add_resource(&id, &mut &b"bytes"[..], "a.bin", None)
        .unwrap();
    let mut phases = Vec::new();
    sync_with_remote(
        &first.library,
        &remote,
        &SyncOptions::default(),
        |progress| {
            if phases.last() != Some(&progress.phase) {
                phases.push(progress.phase);
            }
        },
    )
    .unwrap();
    assert_eq!(phases.first().map(String::as_str), Some("preparing"));
    assert_eq!(phases.last().map(String::as_str), Some("complete"));
    for phase in ["metadata", "attachments", "pushing", "finalizing"] {
        assert!(
            phases.iter().any(|seen| seen == phase),
            "{phase} in {phases:?}"
        );
    }
}

/// Six notes in a "Feeds" notebook inside a "Reading" stack, on `device`.
fn feeds_library(device: &Device) -> (String, Vec<String>) {
    let stack = device.library.create_stack("Reading").unwrap();
    let feeds = device
        .library
        .ensure_notebook("Feeds", Some(&stack.id))
        .unwrap();
    let ids = (0..6)
        .map(|index| {
            let id = device.library.create_note(Some(&feeds)).unwrap().id;
            device.edit(&id, &format!("Clip {index}"), "Body", &["clipped"]);
            id
        })
        .collect();
    (feeds, ids)
}

/// Runs a synchronization that loses its connection after the notes are
/// uploaded and before the notebook list is, which a run uploads last.
fn upload_notes_only(device: &Device, remote: &MemoryRemote, notes: i64) {
    remote.fail_uploads_after(notes);
    let failed = sync_with_remote(&device.library, remote, &SyncOptions::default(), |_| {});
    assert!(matches!(failed, Err(BeverError::Network(_))));
    assert!(remote.file("/Bever/metadata.json").is_none());
    remote.stop_failing();
    remote.take_uploads();
}

#[test]
fn a_device_that_joins_while_another_is_still_uploading_keeps_notes_in_their_notebooks() {
    let remote = MemoryRemote::new();
    let (first, second, third) = (Device::new(), Device::new(), Device::new());
    let (feeds, ids) = feeds_library(&first);
    upload_notes_only(&first, &remote, 6);

    // The second device sees notes whose notebook is in no notebook list yet.
    second.sync(&remote);
    for id in &ids {
        assert_eq!(second.note(id).notebook_id, feeds, "filed under Inbox");
    }
    let snapshot = second.library.snapshot().unwrap();
    let notebook = snapshot
        .notebooks
        .iter()
        .find(|notebook| notebook.id == feeds);
    assert_eq!(
        notebook.map(|notebook| notebook.name.as_str()),
        Some("Feeds")
    );
    let stack = notebook
        .and_then(|notebook| notebook.stack_id.clone())
        .unwrap();
    assert!(snapshot
        .stacks
        .iter()
        .any(|known| known.id == stack && known.name == "Reading"));
    assert!(
        note_uploads(&remote).is_empty(),
        "a device that only received the notes has nothing to upload about them"
    );

    // The first device finishes; a third, new device then sees it all.
    first.sync(&remote);
    third.sync(&remote);
    second.sync(&remote);
    first.sync(&remote);
    for device in [&first, &second, &third] {
        let mut names = device.notebook_names();
        names.sort();
        assert_eq!(names, ["Feeds", "Inbox"]);
        assert_eq!(device.library.snapshot().unwrap().stacks.len(), 1);
        for id in &ids {
            assert_eq!(essence(&device.note(id)), essence(&first.note(id)));
            assert_eq!(device.note(id).notebook_id, feeds);
        }
    }
}

#[test]
fn a_note_arriving_for_a_notebook_deleted_here_goes_to_the_default_notebook() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let (feeds, ids) = feeds_library(&first);
    first.sync(&remote);
    second.sync(&remote);

    second.library.delete_notebook(&feeds).unwrap();
    let fresh = first.library.create_note(Some(&feeds)).unwrap().id;
    first.edit(&fresh, "Written meanwhile", "Body", &[]);
    first.sync(&remote);
    second.sync(&remote);
    assert_eq!(second.notebook_names(), ["Inbox"]);
    assert_eq!(second.note(&fresh).notebook_id, second.inbox());
    assert!(second.note(&fresh).deleted_at.is_none());

    first.sync(&remote);
    assert_eq!(first.notebook_names(), ["Inbox"]);
    assert_eq!(first.note(&fresh).notebook_id, first.inbox());
    assert!(first.note(&ids[0]).deleted_at.is_some());
}

#[test]
fn a_notebook_list_uploaded_meanwhile_by_another_device_is_merged_not_replaced() {
    let remote = MemoryRemote::new();
    let (first, second, third) = (Device::new(), Device::new(), Device::new());
    first.sync(&remote);
    second.sync(&remote);

    // The first device begins a run and reads the notebook list…
    let layout = super::Layout::new(super::DEFAULT_REMOTE_ROOT).unwrap();
    let mut ignore = |_| {};
    let cancel = Cancel::new();
    let mut progress = super::Progress {
        callback: &mut ignore,
        remote: &remote,
        started: std::time::Instant::now(),
        cancel: &cancel,
        record: super::history::Recorder::begin(&first.library),
    };
    first.library.ensure_notebook("Mine", None).unwrap();
    let listed = super::RemoteStore::list(&remote, &layout.root)
        .unwrap()
        .unwrap();
    let seen = super::metadata::pull(
        &first.library,
        &remote,
        &layout,
        listed.file("metadata.json"),
        &mut progress,
    )
    .unwrap();
    // …and while it is transferring notes, the second completes a run.
    second.library.ensure_notebook("Theirs", None).unwrap();
    second.sync(&remote);
    super::metadata::push(&first.library, &remote, &layout, seen, &mut progress).unwrap();

    third.sync(&remote);
    let mut names = third.notebook_names();
    names.sort();
    assert_eq!(names, ["Inbox", "Mine", "Theirs"]);
    assert!(first.notebook_names().contains(&"Theirs".to_owned()));
}

#[test]
fn nesting_tags_reaches_other_devices_without_sending_their_notes_again() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Lesson", "Body", &["Lesson 1", "Algebra"]);
    first.sync(&remote);
    second.sync(&remote);
    first.sync(&remote);
    remote.take_uploads();

    let tag = |device: &Device, name: &str| {
        device
            .library
            .snapshot()
            .unwrap()
            .tags
            .into_iter()
            .find(|tag| tag.name == name)
            .unwrap_or_else(|| panic!("no tag named {name}"))
    };
    let courses = first.library.create_tag("Courses", None).unwrap();
    let algebra = tag(&first, "Algebra");
    first
        .library
        .set_tag_parent(&algebra.id, Some(&courses.id))
        .unwrap();
    first
        .library
        .set_tag_parent(&tag(&first, "Lesson 1").id, Some(&algebra.id))
        .unwrap();
    first.sync(&remote);
    second.sync(&remote);
    assert_eq!(
        tag(&second, "Lesson 1").parent_id.as_deref(),
        Some(algebra.id.as_str())
    );
    assert_eq!(
        tag(&second, "Algebra").parent_id.as_deref(),
        Some(courses.id.as_str())
    );
    // Where a tag is does not concern the notes that have it.
    first.sync(&remote);
    assert!(note_uploads(&remote).is_empty());
    assert_eq!(second.note(&id).tags, ["Lesson 1", "Algebra"]);

    // Deleted on one device, a tag leaves what it held in place on the other.
    first.library.delete_tag(&algebra.id).unwrap();
    first.sync(&remote);
    second.sync(&remote);
    for device in [&first, &second] {
        assert_eq!(
            tag(device, "Lesson 1").parent_id.as_deref(),
            Some(courses.id.as_str())
        );
        assert_eq!(device.note(&id).tags, ["Lesson 1"]);
    }
}

/// Puts a folder where an attachment's file is: the file is there to be
/// seen and cannot be read, as one that security software withholds.
fn make_unreadable(device: &Device, sha256: &str) -> Vec<u8> {
    let path = device.library.blob_path(sha256).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    bytes
}

#[test]
fn an_attachment_that_cannot_be_read_holds_back_its_notes_and_the_run_goes_on() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let blocked = first.add("Blocked", "Body", &[]);
    let withheld = first
        .library
        .add_resource(&blocked, &mut &b"withheld bytes"[..], "game.apk", None)
        .unwrap();
    // The same file in a second note: one file here, and one reason.
    let sharing = first.add("Shares it", "Body", &[]);
    first
        .library
        .add_resource(&sharing, &mut &b"withheld bytes"[..], "copy.apk", None)
        .unwrap();
    let fine = first.add("Fine", "Body", &[]);
    let readable = first
        .library
        .add_resource(&fine, &mut &b"readable bytes"[..], "notes.pdf", None)
        .unwrap();
    first.add("Plain", "Body", &[]);
    let bytes = make_unreadable(&first, &withheld.sha256);

    let report = first.sync(&remote);
    assert_eq!((report.pushed, report.blobs_uploaded), (2, 1));
    assert_eq!(report.warnings.len(), 2, "{:?}", report.warnings);
    let held = report.warnings.join("\n");
    assert!(held.contains("“Blocked” was not uploaded"), "{held}");
    assert!(held.contains("“Shares it” was not uploaded"), "{held}");
    // Each says which attachment, by the name it has in a note.
    assert!(
        held.contains("“game.apk”") || held.contains("“copy.apk”"),
        "{held}"
    );
    let paths = remote.paths();
    assert!(paths.iter().any(|path| path.ends_with(&readable.sha256)));
    assert!(!paths.iter().any(|path| path.ends_with(&withheld.sha256)));
    second.sync(&remote);
    assert_eq!(second.titles(), ["Fine", "Plain"]);
    let run = &first.library.sync_runs().unwrap()[0];
    assert_eq!(
        (run.outcome, run.held_back, run.pushed),
        (RunOutcome::Complete, 2, 2)
    );

    // Nothing is asked of the remote for them meanwhile but the listings…
    remote.take_uploads();
    let again = first.sync(&remote);
    assert_eq!((again.pushed, again.warnings.len()), (0, 2));
    assert!(remote.take_uploads().is_empty());

    // …and once the file can be read, they go.
    let path = first.library.blob_path(&withheld.sha256).unwrap();
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, bytes).unwrap();
    let later = first.sync(&remote);
    assert_eq!((later.pushed, later.blobs_uploaded), (2, 1));
    assert!(later.warnings.is_empty(), "{:?}", later.warnings);
    second.sync(&remote);
    assert_eq!(second.titles(), ["Blocked", "Fine", "Plain", "Shares it"]);
    assert_eq!(second.note(&blocked).resources[0].sha256, withheld.sha256);
}

#[test]
fn a_run_that_is_stopped_ends_at_once_and_the_next_one_finishes_it() {
    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    for number in 0..100 {
        first.add(&format!("Note {number:03}"), "Body", &[]);
    }
    let options = SyncOptions::default();
    let stopped = sync_with_remote(&first.library, &remote, &options, |progress| {
        // Stopped by whoever watches, as soon as notes begin to go up.
        if progress.phase == "pushing" {
            options.cancel.cancel();
        }
    });
    assert!(matches!(stopped, Err(BeverError::Cancelled)), "{stopped:?}");
    let uploaded = note_uploads(&remote).len();
    assert!((1..100).contains(&uploaded), "{uploaded} notes went up");
    let run = &first.library.sync_runs().unwrap()[0];
    assert_eq!(run.outcome, RunOutcome::Stopped);
    assert_eq!(run.message, None);
    assert_eq!(run.pushed as usize, uploaded);
    assert!(run.ended_at.is_some());

    // What went up stays up, and is not sent again.
    let finished = first.sync(&remote);
    assert_eq!(finished.pushed as usize, 100 - uploaded);
    assert_eq!(note_uploads(&remote).len(), 100 - uploaded);
    second.sync(&remote);
    assert_eq!(second.titles().len(), 100);
    assert_eq!(second.titles(), first.titles());
}

#[test]
fn a_run_stopped_before_it_began_asks_nothing_of_the_remote() {
    let remote = MemoryRemote::new();
    let first = Device::new();
    first.add("Waiting", "Body", &[]);
    let options = SyncOptions::default();
    options.cancel.cancel();
    let stopped = sync_with_remote(&first.library, &remote, &options, |_| {});
    assert!(matches!(stopped, Err(BeverError::Cancelled)));
    assert_eq!(remote.requests(), 0);
}

#[test]
fn every_run_leaves_a_record_of_when_and_how_it_ended() {
    let remote = MemoryRemote::new();
    let first = Device::new();
    assert!(first.library.sync_runs().unwrap().is_empty());
    let id = first.add("Recorded", "Body", &[]);
    first
        .library
        .add_resource(&id, &mut &b"bytes"[..], "a.bin", None)
        .unwrap();
    first.sync(&remote);
    let runs = first.library.sync_runs().unwrap();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(run.outcome, RunOutcome::Complete);
    assert_eq!((run.pushed, run.blobs_uploaded, run.held_back), (1, 1, 0));
    assert!(run.started_at > 0 && run.ended_at.is_some_and(|ended| ended >= run.started_at));

    // A run that fails says why, and how far it came.
    first.add("Second", "Body", &[]);
    first.add("Third", "Body", &[]);
    remote.fail_uploads_after(0);
    let failed = sync_with_remote(&first.library, &remote, &SyncOptions::default(), |_| {});
    assert!(failed.is_err());
    remote.stop_failing();
    let runs = first.library.sync_runs().unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].outcome, RunOutcome::Failed);
    assert!(runs[0]
        .message
        .as_deref()
        .is_some_and(|message| message.contains("simulated connection loss")));
    assert_eq!(runs[1].outcome, RunOutcome::Complete);

    // One that never got to say how it ended stays as it was last seen:
    // the application was closed, or the device went off, under it.
    drop(super::history::Recorder::begin(&first.library));
    let runs = first.library.sync_runs().unwrap();
    assert_eq!(runs[0].outcome, RunOutcome::Running);
    assert_eq!(runs[0].ended_at, None);

    // The record is of the latest runs, not of all there ever were.
    for _ in 0..30 {
        first.sync(&remote);
    }
    let runs = first.library.sync_runs().unwrap();
    assert_eq!(runs.len(), 20);
    assert!(runs
        .windows(2)
        .all(|pair| pair[0].started_at >= pair[1].started_at));
    assert_eq!(runs[0].outcome, RunOutcome::Complete);
}

#[test]
fn a_pin_and_a_thumbnail_choice_reach_the_other_device_without_moving_the_date() {
    use crate::models::ThumbnailChoice;

    let remote = MemoryRemote::new();
    let (first, second) = (Device::new(), Device::new());
    let id = first.add("Marked", "Body", &[]);
    first.add("Plain", "Body", &[]);
    first.sync(&remote);
    second.sync(&remote);
    let before = second.note(&id);

    first
        .library
        .set_pinned(std::slice::from_ref(&id), true)
        .unwrap();
    first
        .library
        .set_thumbnail(&id, &ThumbnailChoice::None)
        .unwrap();
    // Only the marked note is sent, and it is sent as changed.
    let sent = first.sync(&remote);
    assert_eq!(sent.pushed, 1);
    let received = second.sync(&remote);
    assert_eq!((received.pulled, received.conflicts), (1, 0));

    let after = second.note(&id);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(after.content_html, before.content_html);
    assert_eq!(
        after.attributes["application-data"]["bever.thumbnail"],
        "none"
    );
    let listed = second
        .library
        .list_notes(&NoteFilter {
            notebook_id: Some(second.inbox()),
            ..NoteFilter::default()
        })
        .unwrap()
        .notes;
    // Pinned there as here: first in its notebook.
    assert_eq!(listed[0].title, "Marked");
    assert!(listed[0].pinned);
    assert!(!listed[1].pinned);

    // Taken down on the second device, it is taken down on the first.
    second
        .library
        .set_pinned(std::slice::from_ref(&id), false)
        .unwrap();
    second.sync(&remote);
    first.sync(&remote);
    assert!(first.note(&id).attributes["application-data"]
        .get("bever.pinned")
        .is_none());
}
