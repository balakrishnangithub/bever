# pCloud synchronization

Bever uses pCloud as file storage. It does not deploy compute, a database, or an API service to pCloud.

## Remote layout

```text
/Bever/
  metadata.json          stacks, notebooks, tags, shortcuts, and their deletions
  items/
    note-<uuid>.json     one note, or the record of its deletion
  blobs/
    <sha256>             one attachment's bytes
```

A note envelope holds the note's ID, a revision that only grows, the update time, the device that wrote it, a deletion flag, and the note itself unless it is deleted. It also describes the notebook the note is in, and that notebook's stack, so that a note can be filed before the notebook list that names its notebook has arrived. Attachment bytes are separate files named by their SHA-256, so an attachment shared by several notes is stored once.

pCloud's listing of a folder gives, for every file, a number that stands for its content. The library keeps the number it last saw for each envelope and for the metadata, so listing the two folders is enough to tell what changed: nothing is downloaded to find out.

Every device that synchronizes a library must run the same version.

## Connection

Desktop OAuth uses pCloud's implicit token grant with `http://127.0.0.1:53682/` as its redirect. The native listener is bound before the browser opens, so a fast authorization cannot arrive before it is ready. A loopback web page converts the URL fragment into a local callback; the native process accepts it only from that page's own origin and only with the expected OAuth state. A request with the wrong state is refused and the sign-in keeps waiting. A sign-in that is not completed can be cancelled, and otherwise ends after five minutes.

The returned API hostname selects the account's region, with `locationid` as a fallback. Once the token is stored, the application shows the connected state immediately; an optional profile request is not required for synchronization. The pCloud console must enable implicit grant for this flow. Manual token entry is available where loopback OAuth is unsuitable, and validates the token with `userinfo` before saving it.

Android uses the native `bever://oauth/pcloud` deep link instead of a loopback server. Do not add this custom-scheme URI to the pCloud console; the supplied application configuration was observed to redirect to the native Android app without that registration, while the console accepted only HTTPS and local HTTP redirects. Implicit grant must remain enabled. Warm and cold callbacks are handled natively, query and fragment parameters are decoded, and the destination and OAuth state are validated. Already-consumed callbacks are ignored.

Only `api.pcloud.com` and `eapi.pcloud.com` are accepted as API hosts. Download hosts must be pCloud subdomains.

The access token is kept in the operating system credential vault (Keystore-backed encrypted preferences on Android), not in the notes database. It is sent in an `Authorization` header. Addresses are removed from network error messages before they are shown or logged, and a token that pCloud rejects produces a request to reconnect.

## What one run does

In this order:

1. **Merge remote metadata.** Stacks, notebooks, and tags merge by ID, the most recent change winning. An item that arrives with the name of a different local item absorbs it, so two devices that each created “Inbox” end up with one. Deletions listed in the remote metadata are recorded.
2. **Apply remote notes.** Envelopes that are not the ones this library last saw are downloaded, together with any attachments this device does not have yet. A note whose notebook this device has not heard of brings the notebook with it; only a note whose notebook was deleted goes to the default notebook.
3. **Carry out recorded deletions** of stacks, notebooks, tags, and shortcuts. This comes after step 2 so that notes another device moved out of a deleted notebook are already in their new place. A note that is still in a deleted notebook exists only here and moves to the default notebook.
4. **Upload local notes** that were edited, that the remote has never seen, or that gained recognised text, each with a new revision. Their missing attachments are uploaded first. Deletions are uploaded as envelopes with the deletion flag.
5. **Upload the merged metadata**, if it differs from what was downloaded.

A run that is interrupted leaves both sides consistent. The next run continues from there: notes and attachments that already arrived are not transferred again.

## Conflicts and deletions

- **Edited on both sides.** The remote version becomes the note. Your version is kept beside it as a separate note titled as a conflict copy. The decision is made in the same database transaction that applies the remote note, so an edit saved while its attachments were downloading is not lost.
- **Deleted on another device, edited here since the last run.** The note is kept and uploaded again, so the edit is not lost.
- **Deleted here, changed on another device since the last run.** The deletion stands and is uploaded. Deleting for good is the later, deliberate act; notes in the trash are ordinary notes and are not affected by this rule.
- **Deleted on both sides, or deleted and untouched.** The note is removed. A deletion record is uploaded once, not on every run.
- **Open in the editor while a run changes it.** Saving reports that the note changed underneath; your text is saved as a conflict copy instead of overwriting the incoming version.
- **Metadata.** A deleted notebook, stack, tag, or shortcut is removed on other devices. A shortcut is identified by what it points to, so two devices that star the same note agree.

Changing a note's date to an earlier one is an edit like any other and is uploaded.

## Transfers

- Up to four transfers run at a time. Database writes and progress stay on one thread.
- Attachments are uploaded from, and downloaded into, the attachment store as streams. A downloaded attachment is accepted only if its bytes hash to the SHA-256 it was requested by.
- Each request has its own time limit, scaled to the size of the transfer, so a large attachment is not cut off.
- A request that fails in transport, or that pCloud answers with a rate limit or an internal fault, is tried up to three times with a pause between attempts. Errors that retrying cannot fix, such as a rejected token or a full account, stop the run with a message.
- A note whose attachment file is missing locally is skipped and reported as a warning. Other notes continue.
- Note bodies are handled 32 at a time, which bounds memory however large the library is.

## Requests

pCloud limits how often it is asked, and every request costs a round trip, so a run makes as few as it can. The application shows the count after each run.

| What a run does                                     | Requests |
| --------------------------------------------------- | -------- |
| Nothing: no change on either side                   | 2        |
| Uploads one edited note of text                     | 3        |
| Downloads one changed note                          | 4        |
| Uploads a note with a new attachment                | 5        |
| A change to notebooks, tags, or shortcuts, uploaded | 2 more   |
| The same, downloaded                                | 2 more   |

- **Two listings open every run**: of the library's folder, which shows whether the metadata changed, and of the notes, which shows which notes did. A run with nothing to do ends there, without loading a note.
- **Folders are made only when the listing shows them missing**, which is the first run.
- **Notes are uploaded together**: the 32 of a batch go in one request, or in a few when they are very long (8 MiB a request). Deletions travel the same way. A request that fails midway may have stored some of its notes; the next run finds them, sees they are its own, and sends only the rest.
- **Attachments are uploaded one in a request**, and the list of those the remote holds is asked for only when a note with an attachment is uploaded.
- **A download takes two requests a file**: pCloud first gives the address of a file's content and then the content. A new device therefore makes about two requests for every note and attachment it receives.
- **Before the metadata is uploaded, the folder is listed once more**, to see whether another device uploaded its own in the meantime.

The application also shows the current operation, elapsed time, network time, and bytes transferred. These describe activity; they are not a benchmark.

## Worker lifetime and visibility

Only one synchronization worker can run in an application process. Its run ID and revision guard against duplicate launches and stale updates. The application shell, not Settings, owns the live status, and completed reports and errors remain available for that process.

On Windows, closing the main window while a run is in progress hides Bever to its tray. The worker continues; **Open Bever** restores the window and cancels the pending exit, while **Quit** waits for the worker before exiting. There is no independent desktop daemon.

On Android, a small native `dataSync` foreground service keeps the Rust process alive while the Activity is in the background or swiped away. It shows a low-importance progress notification, updated at most once per second, and a final notification on completion or failure. Notification permission is requested only after an explicit **Sync now**; denial does not block synchronization, but notification visibility depends on Android and OEM policy. The service is `START_NOT_STICKY` and cannot silently start another run after the OS restarts the process. No boot recovery, microphone, camera, phone, or battery-exemption permission is used.

This is best-effort completion of a run you started, not scheduled synchronization. Force-stop, reboot, OS process termination, Android 14+ foreground `dataSync` limits, and OEM battery restrictions can interrupt it. An interrupted run must be started again by you.

## Current limitations

This is a simple revision-based format, not a CRDT or an end-to-end encrypted vault:

- A run happens only when requested; there is no scheduler or push notification.
- A run is not a multi-device transaction. Two devices may synchronize at the same moment: each files what it receives correctly and merges the other's notebook list, but what the other device uploads during the run arrives with the next run, so run both once more afterwards. If both edit the same note in that moment, one edit can be replaced by the other without a conflict copy.
- A conflict is resolved per note, not per paragraph: both versions are kept and you merge them.
- Remote JSON and attachments are not encrypted by the application. HTTPS protects transport, not access by the storage provider.
- Attachment files that no note uses any more are removed from the device but stay in pCloud.
- The same Evernote export imported separately on two devices is synchronized as two sets of notes.
- The earlier versions of a note that are kept before it is changed stay on the device that kept them.
- Synchronization is not a substitute for independent backups or ENEX exports.

## Testing

The engine talks to storage through the `RemoteStore` trait. Tests run two libraries against an in-memory implementation with failure injection and cover push, pull, conflict copies, note and metadata deletion, name merges, an interrupted run that is resumed, a device that joins while another is still uploading, a notebook list changed by another device during a run, a deletion record uploaded once, a missing attachment, a request cut off after some of its notes were stored, and the number of requests each kind of run makes.

`pcloud_selftest` runs the same engine against a real account, including a run that is cut off after its notes and joined by a second device, and checks the request counts in the table above against pCloud itself. It works only inside a folder it creates, `/Bever-selftest-<random>`, and removes that folder afterwards; it never reads or writes `/Bever`.

```sh
cargo run --release -p bever-core --example pcloud_selftest
```

It uses the token saved by the desktop application, or the one in `BEVER_PCLOUD_TOKEN`, and prints neither the token nor note content. Passing these tests is not a guarantee for every account, network, or device.
