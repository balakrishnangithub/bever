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
- A request that does not complete is made again: when the connection is lost, when pCloud does not answer in time, when it answers that it is being asked too much (HTTP 429, or a result code from 4000 to 4999), or with a fault of its own. It is made up to five more times, after 1, 3, 9, 27 and 60 seconds. That is a minute and a half in all: long enough for a connection to come back after a device wakes or a router restarts, so that a run of hours is not lost to a gap of seconds. Errors that asking again cannot fix, such as a rejected token or a full account, stop the run with a message.
- A connection that has carried nothing for 30 seconds is probed, so that one whose other end is gone is found out instead of being waited on.
- A note whose attachment cannot be read on this device is held back, and the other notes go. The file may be missing; another program may hold it; or the security software of the device may withhold it. The run says which note and which attachment, and why, and the next run tries again. See [When a file cannot be read](#when-a-file-cannot-be-read).
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

## When a run does not go smoothly

A first run of a large library is hours of work, usually with nobody watching. What can go wrong in that time is told apart, and said in words.

### When a file cannot be read

Uploading an attachment means reading its file, and the device may not allow that. Windows answers error 225, "the file contains a virus or potentially unwanted software", when its antivirus takes a file for harmful, and then moves the file to quarantine. This happened to a first run of 4,832 notes: one attachment was withheld seventeen minutes into the run. Up to 1.1.2 that ended the run, with the error and nothing else, and 5 GB of other attachments were not sent.

Such a file now costs its note and nothing more:

- The note is held back, together with any other note that has the same file. Everything else is synchronized.
- The run ends as complete and says what it held back: “_Title_” was not uploaded: the security software on this device (Windows Security or another antivirus) blocked its attachment “_name_” because it takes it for harmful. A file that is missing, or that another program holds, is said in the same place in its own words.
- Nothing is sent of a note that is held back, so that no other device receives a note whose attachment it cannot get.
- The next run tries again. If the file was allowed or restored meanwhile, the note goes.

A judgement of this kind is the security software's own. Bever does not ask for exceptions and does not work around it. A file that the software has removed from the library is missing from then on; importing the note again brings it back, and the software may judge it again.

### When the connection or pCloud fails

A failure is named for what it is: no connection (with the system's reason, such as a name that cannot be found), no answer in time, a connection that broke off, pCloud asking for fewer requests, pCloud failing inside, a sign-in it no longer accepts, a full account. Addresses are never part of the words.

While a run goes, and when it ends, the application says how many requests had to be made again, and how many of those because pCloud asked for fewer. A run that ends in spite of asking again says so with the last reason.

### When the device goes to sleep

While a run goes, Windows is asked to keep the system awake; the screen turns off as usual. This is a request. Windows grants it on mains power, and on battery only for as long as its own rules for standby allow. A run that is cut off by sleep loses nothing: its requests are made again when the connection is back, and what a run does not finish, the next one does.

## Stopping a run

A run can be stopped at any moment, in Settings where it was started. It ends at once:

- A transfer that is under way is cut off at its next piece. pCloud keeps nothing of an upload that did not arrive whole.
- A request that hangs on a connection that carries nothing is not waited for. Every request runs apart from the run, which only waits for its answer and stops waiting when it is stopped.
- A pause between two attempts ends.

Stopping is not a failure. What was transferred stays on both sides, and the next run goes on from there.

## The record of runs

The library keeps a record of its latest twenty runs: when each began and ended, how it ended (complete, stopped, failed and why), what it moved, how many notes it held back, and how many requests it made again. It is written when a run begins, every few seconds as it goes, and when it ends. A run that never got to say how it ended is therefore still in it, with the time it was last seen at work: the application was closed, or the device slept or went off, under it.

Settings shows the record under **Recent runs**, and opens it by itself when the latest run did not end well. The record stays on the device and is not synchronized.

## Worker lifetime and visibility

Only one synchronization worker can run in an application process. Its run ID and revision guard against duplicate launches and stale updates. The application shell, not Settings, owns the live status, and completed reports and errors remain available for that process; the record of runs outlives it.

On Windows, closing the main window while a run is in progress hides Bever to its tray, and the tray says that Bever is synchronizing. The worker continues; **Open Bever** restores the window and cancels the pending exit. **Quit**, which then reads **Stop synchronizing and quit**, stops the run and leaves: the run ends within moments, and after three seconds the application leaves whether it has or not. Quitting is never made to wait for a run to finish. There is no independent desktop daemon.

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

## One engine, and what a storage service adds to it

pCloud is the one storage service Bever synchronizes with. What is not pCloud's own is kept apart from it, so that another service means writing what is that service's and nothing twice:

- **The engine** (`sync/mod.rs`, `notes.rs`, `metadata.rs`, `transfer.rs`, `history.rs`) knows a storage only as the `RemoteStore` trait: make a folder, list one, download a file, upload files. Revisions, conflicts, deletions, the order of a run, holding back a note whose file cannot be read, stopping, and the record of runs are all here.
- **The transport** (`sync/transport.rs`) is how any service is reached over HTTP: each request runs apart from the run so that stopping is immediate, a request that does not complete is made again after growing pauses, a local file that cannot be read is told apart from a lost connection, a download arrives in pieces, addresses are kept out of errors, and everything is counted.
- **The adapter** (`pcloud.rs`) is what is pCloud's: its hosts, its methods, the form of an upload, what its result codes mean, where content may be fetched from. The sign-in (`pcloud_auth.rs` in the shell) is pCloud's too.
- **The shell** chooses the storage in one place (`remote_store` in `src-tauri/src/lib.rs`) and hands the engine a `RemoteStore`. The worker, its status, stopping, quitting and staying awake do not know which service it is.

## Testing

The engine talks to storage through the `RemoteStore` trait. Tests run two libraries against an in-memory implementation with failure injection and cover push, pull, conflict copies, note and metadata deletion, name merges, an interrupted run that is resumed, a device that joins while another is still uploading, a notebook list changed by another device during a run, a deletion record uploaded once, a missing attachment, an attachment that cannot be read, a run that is stopped and finished by the next, the record of runs, a request cut off after some of its notes were stored, and the number of requests each kind of run makes.

The transport is tested against a server on the same computer: an upload and a download that are stopped while nothing moves return within moments, a pause between attempts ends when the run is stopped, a request that is turned away is made again and counted, one that is refused is not, a download that breaks off is asked for again, a local file that cannot be read is not taken for a lost connection, and a full disk is not taken for one either. The pCloud adapter is tested against such a server answering as pCloud does: files go up and come down, content is fetched only from where the service is, and pCloud's own word for being asked too much is counted.

`tests/native-sync.mjs` drives the built Windows application through a whole first synchronization against such a stand-in, which the test itself runs:

```sh
npm run tauri -- build --no-bundle
cargo build --release -p bever-core --example import_enex
npm run test:sync
```

It stops a run while it goes, holds a file so that it cannot be read, closes the window during a run, stops that run and sees the application leave, kills the application during a run, and reads the record of runs after each restart. The application is told where the stand-in listens in `BEVER_PCLOUD_STAND_IN`, which must be `http://127.0.0.1:<port>` and is listened to only by a library that is itself named by `BEVER_DATA_DIR`. The installed application never does. While a stand-in is used no sign-in is read, saved, removed or sent, and nothing goes anywhere but to this computer. `BEVER_SYNC_ENEX` adds the notes of an export to the run.

`pcloud_selftest` runs the same engine against a real account, including a run that is cut off after its notes and joined by a second device, and checks the request counts in the table above against pCloud itself. It works only inside a folder it creates, `/Bever-selftest-<random>`, and removes that folder afterwards; it never reads or writes `/Bever`.

```sh
cargo run --release -p bever-core --example pcloud_selftest
```

It uses the token saved by the desktop application, or the one in `BEVER_PCLOUD_TOKEN`, and prints neither the token nor note content. Passing these tests is not a guarantee for every account, network, or device.
