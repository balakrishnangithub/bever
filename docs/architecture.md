# Architecture

## Design constraints

Bever is local-first. The application must create, edit, import, render, and search a library with networking disabled. There is no Bever application server and no remote search or database service.

The main boundaries are:

```text
React / TipTap interface (src)
       │ typed Tauri commands; attachments over the bever: protocol
       ▼
Native shell (src-tauri)
       │
       ▼
Reusable Rust core (crates/bever-core)
       ├── SQLite + FTS5: structured data and offline search
       ├── Blob store: content-addressed attachment bytes
       ├── ENEX/ENML: import, export, editable representation
       ├── Text recognition: a queue of images to read
       └── Sync engine: revisions, merging, a storage trait, the pCloud client
```

The browser adapter in `src/lib/browserApi.ts` exists only to exercise the interface during development and in the browser check. It is not the production persistence layer.

## Core modules

- `models.rs`: serialized domain types shared across the IPC boundary.
- `db.rs`: schema, SQLite pragmas, settings, device identity.
- `repository.rs`: notes — create, save, list, copy, trash, delete, import, and the search-index entry of each.
- `organize.rs`: notebooks, stacks, tags, and shortcuts, including the deletion records that synchronization carries.
- `marks.rs`: what is said about a note without being part of it: the picture that stands for it in a list, and that it is pinned to its notebook. Both are kept under the note's `application-data`, so they travel with it; setting one is not an edit.
- `resources.rs`: attachments of a note and the text-recognition queue.
- `search.rs`: parsed query operators, parameterized SQL, and the order of what a search found.
- `versions.rs`: a note as it was before the editor changed it, kept on the device to be put back.
- `blob.rs`: SHA-256 and Evernote MD5 calculation, deduplication, streamed storage, verified reads.
- `enml.rs`: ENML to editable HTML and back, text extraction, link rewriting.
- `enex.rs`: streaming reader, importer, and exporter.
- `tasks.rs`: Evernote's tasks, from an export or from Evernote's files, as checklists in their note.
- `ocr.rs`: reads queued images with the bundled models.
- `pcloud.rs`: client for pCloud's HTTPS API with host allowlisting, retries, and streamed transfers.
- `sync/`: the engine and what stops it (`mod.rs`), notes (`notes.rs`), metadata (`metadata.rs`), the storage trait and its in-memory test implementation (`remote.rs`), bounded parallel transfers (`transfer.rs`), the record a run leaves of itself (`history.rs`), and the way to a storage service over HTTP (`transport.rs`).

## Shell modules

- `lib.rs`: application state, wiring, window close and tray behaviour, and that one application runs for a library.
- `commands.rs`: library commands. Each runs on a blocking thread, never on the UI thread.
- `files.rs`: everything that touches the user's files — native file dialogs, import, export, attaching, saving and opening attachments, opening links.
- `protocol.rs`: the `bever:` protocol.
- `pcloud_auth.rs`, `android_oauth.rs`, `credentials.rs`: sign-in and token storage.
- `ocr_worker.rs`: the background text-recognition worker.
- `sync_controller.rs`, `sync_platform.rs`, `awake.rs`: the single synchronization worker, what stops it, its platform lifetime, and the request to Windows to stay awake while it runs.

## Trust boundary

Note content is untrusted: it comes from imported files and from other devices. The interface that renders it is therefore given as little as possible.

- The WebView holds only `core:default` permissions. It has no file-system, dialog, shell, or opener permission.
- No command accepts a file path. File dialogs are opened by the native side, and the files chosen there are kept in native state and referred to by opaque tokens. Export and save destinations are chosen the same way.
- Opening a link is a native command that accepts `http`, `https`, `mailto`, and `tel` addresses only.
- The `bever:` protocol resolves a known attachment hash to that attachment's bytes and nothing else. Responses carry a restrictive content security policy and `nosniff`, so an attachment is never executed or re-typed.
- The content security policy allows no remote script and no remote connection. Remote images are loaded only when the user asks.
- A web clipping keeps the clipped page's markup, which the editor's document model cannot hold. It is rebuilt from an allowlist of elements and attributes (`clipSanitizer.ts`) and drawn in a sandboxed frame without forms, popups, or navigation.
- Nothing builds note markup in the page except the views that decide what may load. A note is serialized in a document that is never displayed (`serialize.ts`), and inert stand-in views take over whenever the React views are absent, because an `<img>` created in the page is fetched at once, shown or not.
- An attachment opened in another application is copied to the cache directory first; copies are removed at the next start.

## Persistence invariants

1. A note mutation and its search-index update happen in one SQLite transaction.
2. User search text never becomes SQL; operators become parameterized clauses.
3. Attachments are named by SHA-256. MD5 is retained only for Evernote compatibility, not security.
4. Imported notes retain `original_enml` alongside editable HTML. Export uses original ENML only while the editable representation still corresponds to it.
5. Remote blobs are accepted only when their downloaded bytes hash to the requested SHA-256.
6. Permanently deleted notes, and deleted notebooks, stacks, tags, and shortcuts, leave a record so the deletion can reach other devices.
7. Conflicting local edits are copied before a remote version replaces them. A save from an editor names the revision it started from; if the note has moved on, the text is saved as a conflict copy.
8. An attachment file is removed only when no note refers to it, and never while an import or a download that may be about to refer to it is in progress. A read/write gate (`blob_gate`) enforces this.

9. The search index is derived from the notes and holds nothing they do not. It is made anew when the file has it in another form, or when it does not account for its rows. `note_index` says which row of the index is which note's, so that a note's entry is found without reading the index through; two triggers keep the notebook's name in the index right when a notebook is renamed or a note moved, whatever part of the program does it.
10. Before the first save of each visit to a note, the editor has the note kept as it was (`note_versions`, five to a note). These stay on the device: they are neither synchronized nor exported, and go with the note when it is deleted for good.

SQLite uses WAL mode, `synchronous=NORMAL`, foreign keys, a busy timeout, and targeted indexes. A library made by 1.0.0 is opened as it is: what was added since is in tables of its own, made when they are missing, and the index is made anew. FTS5 uses Unicode tokenization and BM25 ranking. The tokenizer is not a CJK trigram tokenizer; adding one would need benchmarks.

## Editor

TipTap stores an HTML-like editable document. Custom nodes preserve `en-media`, classic `en-todo`, `en-crypt`, and web clippings, which are single blocks carrying their markup verbatim. Evernote checklists, code blocks, and highlights are normalized into the editor's own nodes on import and written back as ENML on export. This is preferable to flattening notes into Markdown, which would lose ENML structure and attachment references.

A note is stored anew only when it was changed, and that is decided in three places, each of which would do alone. The editor reports the stored page itself for as long as its document shows nothing that the stored page does not (`face.ts`): what cannot be seen, such as a space at the end of a line or an empty line the editor adds at the end, is no change, and neither is a word that a keyboard takes up and puts back. The draft is unsaved when it differs from what is stored, which is worked out and not remembered (`draftController.ts`): an edit taken back leaves nothing to save. And the library does not store a note that is given to it as it already has it (`save_note`). So no way of touching a note without changing it can move its date, rewrite its page, or send it to other devices.

Saving is serialized by `draftController.ts`: one save at a time, each carrying the revision it is based on, with a flush when the note is left, the window is hidden, or the application closes. Attaching a file stores it and returns a reference; the editor inserts the node at the cursor, so the stored note never replaces what is on screen.

## Performance boundaries

- Note lists are virtualized and loaded a page at a time; the header shows the real total.
- Search executes in SQLite. Text terms go into a single FTS `MATCH`, which is what makes ranking and snippets available. What was found is ordered by where the words stand: the title, the notebook's name and the tags are read from the index's own row, where they are stored before the note's text; how near the words are to each other in the text is read from the index's record of where each word stands, up to 60,000 places a search, past which the index's own measure orders those notes.
- Changing a note costs the same however many notes there are: its entry in the index is found through `note_index`.
- ENEX attachments are decoded and hashed as a stream. Only one note's ENML is in memory at a time.
- Text recognition runs after an import, on its own worker, and can be paused.
- Attachments are served to the WebView in ranges of at most 4 MiB, so media can seek without loading a whole file.
- Synchronization transfers four items at a time, streams attachments, and decides from flags which notes need uploading, so an idle run loads no note.
- A picture is written out of its canvas as text and the text turned into bytes (`canvasPng.ts`), not as a file by `toBlob`: Android's web view makes such a file when it finds the time, which on a phone was 4 to 13 seconds for a picture that takes 0.2 seconds the direct way.
- The tags the filter offers are counted by the library over the whole listing, in one query with the conditions the listing itself has (`search::listing_tags`): the interface has only the part of a listing that was in view, and cannot count.
- A PDF is shown by `pdfView.ts`, which keeps the arithmetic in `pdfGeometry.ts`. Only the pages in view and within a view's height of it are drawn, one drawing at a time, the page in the middle first; pages more than three views away give their drawings back. The drawing of a whole page has at most 4 million pixels where the pointer is a finger and 9 million elsewhere. A page shown larger than that keeps the drawing it has, stretched, and the part of it in view is drawn over it at the size it is shown, once nothing has moved for a moment. While the size is being changed nothing is drawn: the drawings there are stretched, and one under way is given up.

## Failures

- One thread at a time has the database connection. A thread that panics while it has it does not take it from the others: what it had begun in a transaction is undone as the transaction is dropped, and the next operation finds the connection as it was (`db.rs`, `Shared`).
- One application runs for one library. Started again, the one that is running comes to the front; two would each show the notes as they last read them and save over each other. A library named by `BEVER_DATA_DIR` is another application and runs beside it.
- A request from the interface that comes before set-up has opened the library waits for it (`startup.rs`). Tauri makes the window before it runs set-up, and on Android the page loads meanwhile, so its first request can be the earlier of the two; asking Tauri for state that is not managed yet is a panic, and a panic ends the application. The state is therefore kept in a place that exists before any window, and `AppState::of` is the one way to it. When a request had to wait, the device's log says so and for how long.
- A part of the interface that fails to draw is replaced by a message (`ErrorBoundary.tsx`): a note that cannot be drawn leaves the lists usable, and a failure of the whole offers to start the interface again. The notes are not touched by either.
- The editor's own guard against a change made by mistake is in "Persistence invariants", 10, and in `draftController.ts`, which has the note kept before its first save.

## Sync worker lifetime

`src-tauri/src/sync_controller.rs` owns the one native worker, its monotonically versioned progress, and its final report. `src/store/useSyncStore.ts` mirrors that snapshot outside Settings and rejects stale responses. `sync_platform.rs` adapts lifetime management without changing the reusable sync engine.

On desktop, closing during a run hides the main window to the tray; opening it cancels the requested exit, while quitting stops the run and leaves. On Android, a native `dataSync` foreground service keeps the process alive and reports notification progress. The maintained Kotlin, manifest, and drawable live in `src-tauri/android/app/src/main`; `scripts/sync-android-source.cjs` copies this small overlay into the ignored generated Tauri Android project during `npm run android:init`, `android:dev`, and `android:build`. Generated projects, native binaries, and icons remain outside source control.

## Going back

Whatever opens over something else is closed by going back, the thing opened last first, one thing for one step. `backStack.ts` keeps the order: the application's layers (the drawer, the open note in the phone layout, the settings, the screens of notebooks and tags; `useAppLayers.ts`) and everything else that opens (`useBackCloses.ts`, one line in the component that opens: dialogs, menus, panels, previews, the editors of pictures and the menus in them, a selection of notes). Each has an entry in the window's history, so that Android's Back, which steps back in that history, lands on what was under it. A thing closed by its own button has its entry taken out by a step of our own. Something new that opens over the page has to use `useBackCloses`, or Back passes it by and closes what is under it.

Entries are made only when the page has been touched since the last step back someone took. Android's web view honours the entries a page makes in answer to a touch or a key, as many as it makes for one. An entry made after Back with no touch in between it takes for a trap: Back then passes every entry of the page by and leaves the application. That was measured on a phone, case by case, and is why a thing that stays open when Back asks it to close (an editor of a picture that is still saving) has no entry until the next touch; Back closes it all the same, as the topmost thing there is. For the same reason nothing asks a question in answer to Back: the editors of pictures save what was drawn and close.

What opens over the whole window takes the focus from the field under it (`leaveField`), or a phone's keyboard stays up over half of it and takes the first Back for itself.

## Android specifics

The system file picker returns `content://` documents, not paths. The shell opens them through `tauri-plugin-fs`, which understands such documents, and asks the Kotlin plugin for a document's display name and size. Opening an attachment in another application goes through the application's `FileProvider`. The on-screen keyboard is accounted for in the window insets.

In the phone layout sideways swipes belong to the drawer, and `useDrawerGestures.ts` takes them as they come. They are not kept from the browser by `touch-action: pan-y`, on the frame or on a list, though that is what such a rule seems made for: the browser decides at the first movement of a touch whether it is an allowed one, and a swipe that begins more sideways than upward, as a thumb's does, is then no scroll for the whole of it, however it goes on. Lists were deaf to such swipes until 1.3.0. Everything that scrolls allows both directions (`pan-x pan-y`), which also keeps two fingers from making the window larger; a sideways flick on a list starts nothing that would swallow the tap after it, which was tried on a phone. And an element is bound by what its ancestors allow, up to the first of them that scrolls in that direction, so that one `pan-y` far up is enough to bring the fault back. A list that scrolls inside something that scrolls is avoided for the same fingers: a swipe goes to one of the two, and at the end of the inner one to neither.

The PDF preview is drawn into `document.body`, not into the note. Inside the note it is inside the frame that makes a note larger (`noteZoom.ts`), which would take two fingers on it for its own.

## Future shells

The interface is laid out by the size of its window and by what points at it, not by the system it runs on: the phone layout is a window up to 760 pixels wide, rows are finger-sized where the pointer is a finger (`pointer: coarse`), and the browser check opens the filter and the PDF preview in windows from a phone on its side to a large monitor. One thing is known to differ on WebKit, which iOS and macOS use: two fingers on a trackpad arrive there as gesture events, not as Ctrl with the wheel, so `noteZoom.ts` and `pdfView.ts`, which answer touches and the wheel, would have to answer those too.

Linux and macOS can use the same Tauri/React shell. iOS will need platform-specific review of file picking, background execution, OAuth callback handling, and secure storage. These are not claimed as working targets until built and tested.
