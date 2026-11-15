# Changelog

## 1.1.3 — 2026-11-15

A first synchronization of 4,832 notes ended seventeen minutes in, on one file that Windows would not let be read, with nothing to say what had happened but "os error 225". Started again, it could not be stopped, and Bever could not be quit while it ran. A run now goes on past such a file and names it, can be stopped at any moment, and leaves a record of itself; and quitting quits.

### What had happened

Windows' own antivirus took one attachment for harmful as Bever read it to upload it, and withheld it: that is error 225. It was a judgement of the moment, from its online service: the same file was read and sent again later without objection. Bever treated the one unreadable file as the end of the run. Neither pCloud nor the computer going to sleep had a part in it: pCloud had taken 1.2 GB in those seventeen minutes at a steady pace, and took more as soon as the run was started again; and the run had gone on for eleven minutes after the screen turned off.

### Fixed

- **One file that cannot be read no longer ends a run.** Its note is held back, with any other note that has the same file, and everything else is synchronized. The run ends as complete and says which note and which attachment it held back, and why: the security software of the device withheld the file, the file is missing, or another program holds it. Nothing of a held-back note is sent, so no other device receives a note whose attachment it cannot get. The next run tries again.
- **A run can be stopped.** While a run goes, Settings has **Stop** beside it. The run ends at once: a transfer under way is cut off at its next piece, a request that hangs on a dead connection is not waited for, and a pause between attempts ends. What was transferred stays, and the next run goes on from there.
- **Quit quits.** With a run going, **Quit** in the tray hid the window and waited for the run to finish, which could be hours, and said nothing. It now reads **Stop synchronizing and quit**, stops the run and leaves; after three seconds Bever leaves whether the run has ended or not. Closing the window still keeps a run going in the tray, which now says that Bever is synchronizing.
- **A failure says what it is.** An error of the system that has a plain meaning is given it: security software withheld a file, the disk is full, another program holds a file. A failed request says whether there was no connection (with the system's reason), no answer in time, or a connection that broke off, where it said "error sending request" before. pCloud asking for fewer requests, and pCloud failing inside, are told apart.
- **A lost connection is waited out.** A request that does not complete is made again after 1, 3, 9, 27 and 60 seconds, a minute and a half in all, where it was given up after four seconds. A connection whose other end is gone is found out by probing it after 30 quiet seconds. Storing a download on a full disk is no longer taken for a lost connection and asked for again.

### Added

- **Recent runs.** The library keeps a record of its latest twenty runs: when each began and ended, how it ended and why, what it moved, how many notes it held back, and how many requests had to be made again. It is written as a run goes, so a run that never got to say how it ended is in it too, with the time it was last seen at work: Bever was closed, or the device slept or went off, under it. Settings shows the record, and opens it by itself when the latest run did not end well.
- **How many requests were made again** is shown while a run goes and when it ends, and how many of them because the storage service asked for fewer. A service that limits a run is seen to do so.
- **Windows is asked to stay awake while a run goes.** The screen turns off as usual. Windows grants this on mains power, and on battery for as long as its rules for standby allow.
- `npm run test:sync` drives the built Windows application through a whole first synchronization against a stand-in for pCloud that the test runs on the same computer.

### Changed

- What is the same for every storage service is no longer part of the pCloud adapter. Making a request, stopping it, making it again, counting, and telling an unreadable file from a lost connection are in `sync/transport.rs`; `pcloud.rs` holds what is pCloud's. The shell chooses the storage in one place. `docs/sync.md` says what a further service would have to bring.

### Compatibility

- 1.1.3 works on the library of 1.0.0 and later as it is, and synchronizes with 1.1.0, 1.1.1 and 1.1.2: nothing changes in what is kept in pCloud. The record of runs is a setting of its own in the library, which earlier versions leave alone.
- For those building on `bever-core`: `BeverError` has `Cancelled`, and its text for an error of the system begins with what the error means where that is known (`FileTrouble`); `SyncOptions` has `cancel` (`sync::Cancel`); `PCloudClient` has `stopped_by` and `stand_in`; `TransferMetrics`, `SyncReport` and `SyncProgress` count requests made again; `Library::sync_runs` gives the record (`sync::SyncRun`); `RemoteStore::upload_file` fails with `BeverError::Io` when it is the local file that cannot be read.

### What was verified

- Automated: 175 tests of the Rust core and 12 of its round trips through ENEX, 25 of the native shell, 166 of the interface, and the browser check, which now starts a run that only pretends, stops it, and reads the record of runs, on a desktop and at a phone's size. `cargo audit` and `npm audit` find no vulnerability.
- New among the core's tests: an attachment that cannot be read holds back its note and the note that shares it, and nothing else, and both go once it can be read; a run stopped as its notes go up ends as stopped, and the next one sends the rest and nothing twice; a run stopped before it began asks nothing of the remote; every run leaves its record, whether it completed, failed with its reason, or never got to end; what Windows answers when its antivirus withholds a file (error 225) is said in words.
- The transport, against a server on the same computer: an upload of 32 MB that the server does not take, and a download that stops arriving, each return within three seconds of being stopped; a pause between attempts ends when the run is stopped; a request that is turned away (HTTP 429, 503) is made again and counted, and one that is refused is not; a download cut short is asked for again; a file that fails while it is read is an error of the file and is not asked for again, and neither is a full disk.
- The built Windows application was driven through a first synchronization of 120 notes with 86 MB of attachments against a stand-in for pCloud (`npm run test:sync`, 13 checks). Stop ended a run 0.13 seconds after it was clicked, with four transfers cut off and nothing arriving afterwards. A file held open by another program held back its one note while the other 119 were synchronized, and the note went with the next run. A run that was refused because the account was full said so. With the window closed during a run the application stayed, and stopping that run ended the application 0.1 seconds later. The record of runs was there after a restart. The application killed in the middle of a run left "Did not finish" in the record, and the next run finished what was left.
- The same with the 171 notes and 390 attachments (134 MB) of a real export in the library too, among them the file that Windows had withheld on the night this began. This time Windows let it be read, and it was sent.
- The request to stay awake reaches Windows: while it is held, Windows reports the system as required (`CallNtPowerInformation`).
- The general check of the built application (`npm run test:native`) passes as before: 23 checks with an empty library, 27 with an imported one of 171 notes.
- The Windows program and the Android package were built from the released source.

### Not verified

- **pCloud itself was not reached with this version.** No sign-in was saved on the development machine. The stand-in answers as pCloud answered 1.1.2 and as its documentation says. The requests are made as 1.1.2 made them; what changed is how they are waited for, stopped and made again.
- **The antivirus could not be made to withhold the file again.** Windows read the same file without objection on every later attempt. What Bever does when a file is withheld was tested with a file held open by another program (error 32), and in the core's tests with the code Windows gave that night (225).
- **Quit in the tray was not clicked by a test.** What it does, stopping the run and then leaving, was tested through the window's close button followed by stopping the run. The three seconds after which Bever leaves regardless were not exercised.
- That Windows keeps a computer awake through a night was not waited for. The request is made and Windows knows of it; what it grants on battery is its own decision.
- A connection lost in the middle of a run was not tried in the built application. The transport's tests cover a server that stops taking or sending, and a connection that breaks off.
- Nothing in this release was run on an Android device; the Android package was built. Stop is in Settings there as well; the notification has no Stop of its own.

## 1.1.2 — 2026-11-15

An import from the Evernote application gave some notes another title than Evernote shows, and left tasks out without saying so. Both are put right, in a library that was imported before as well: import again, and the notes that are there are corrected where they stand.

### Fixed

- **A note without a title has the title Evernote shows.** Evernote shows a note that was given no title under words of its text. Bever called every such note “Untitled Note”, as an Evernote export does. In one account of 4,832 notes that was the wrong name for 123 notes, and two of them were among the shortcuts.
- **Tasks come with their notes.** Evernote keeps tasks apart from a note's text, and a note that had tasks showed an empty box in their place: 140 tasks in 12 notes of that account. Each group of tasks is now a checklist where it stood, in Evernote's order, finished tasks ticked, with the day or time each is due and when it reminds. The same is done with the tasks of an ENEX file.
- **Importing again from Evernote corrects what is here, and adds nothing twice.** A note that was not changed in Bever is brought to what Evernote has now, in place, also where Evernote changed it without making it later: a tag put on a note used to bring a second copy of the note.
- **Tags that no note has** come when every notebook is imported: 23 were left behind in that account.
- A shortcut to a note follows the note's title when an import changes it.

### Added

- **The import's summary says what it did not bring**: how many notes lie in Evernote's trash, how many of Evernote's shortcuts lead to something it has no more, and which notes name an attachment that Evernote itself has lost. It also says how many tasks came as checklists.
- **Shortcuts, notebooks and tags are three boxes in the sidebar that fold alike.** Each has an arrow that folds it away and says how many it holds; the shortcuts could not be folded before. What is in a stack or in a tag stands further in, under the name of what holds it, where before it began under its picture.
- `cargo run --release -p bever-core --example audit_evernote_local -- <library folder>` compares a library with what Evernote has on the computer, note by note, without going through the importer, and prints what differs.

### How the import was checked

A library of 4,832 notes, imported from Evernote 11 with this version, was compared with Evernote's own data by that program:

- every note is there once, with the title Evernote shows, its times, notebook, stack, tags, author and source;
- all 7,840 attachments agree in hash, size, type, name and order, and each of their 7,786 files in the library (6.7 GB) was read and has the hash it is kept under;
- the text of every note is, letter for letter, the text Evernote keeps for its own search, which is another reading of the note than Bever's: 3,477 notes with 3.3 million characters, and 1,343 notes that have no text in either;
- all 140 tasks are in their notes, and all 602 tags are there, nested as in Evernote;
- tables, rows, cells, lists, links, headings and rules are as many in the page Bever keeps of each note as in the note's markup.

The same library as 1.1.1 had imported it, imported again with this version: 135 notes brought up to what Evernote has, none added, and the same result, but for one note that had been changed in Bever.

### Compatibility

- **Import again to correct a library that 1.1.1 or earlier imported from Evernote.** Notes you changed in Bever keep what you wrote; of those only a title that is still “Untitled Note” is put right.
- **A note with tasks is no longer what its export holds**: it has checklists where its tasks were, and is exported so. Who a task is assigned to, its flag, priority and recurrence, and muted reminders are not brought.
- 1.1.2, 1.1.1 and 1.1.0 work on the same library and synchronize with each other.
- For those building on `bever-core`: `EnexNote` has `earlier` and `tasks`; `Library::import_local_note` is how a note from Evernote's files is imported; `Library::add_shortcuts_as` returns two counts; `LocalImportReport` and `ImportReport` have more counts.

### Not verified

- Nothing in this release was run on an Android device; the Android package was built, and the sidebar was looked at in a browser of a phone's size.
- Tasks in an ENEX file are read as Evernote's published format has them (`evernote-export4.dtd`). No export with tasks was at hand to try it on.
- How tasks look in Evernote was not compared by eye: their words, order, state and times are taken from Evernote's data.
- The check against Evernote was made on one account, with Evernote 11 on Windows.
- Synchronization was not run against pCloud, since no sign-in was saved on the development machine. Its tests against a stand-in for pCloud pass.

## 1.1.1 — 2026-11-14

Two of the libraries Bever is built from are brought up to versions with no known vulnerability. Nothing else changes.

### Security

The Rust dependencies were checked against the RustSec advisory database (`cargo audit`), which 1.1.0 had not been able to do. The check named three advisories, and now names none.

- **SQLite 3.54.1** in place of 3.50.2. SQLite before 3.54.0 can give back stale memory of the program when it opens a database together with a write-ahead log made for the purpose (CVE-2026-119375, RUSTSEC-2026-0459). Bever opens its own library and, for an import from Evernote on the same computer, Evernote's files. Both are in the user's own folders, so making use of this took access that already gave more.
- **The XML reader `quick-xml` 0.42** in place of 0.38. Two advisories stand against the older version (RUSTSEC-2026-0194, RUSTSEC-2026-0195): a start tag with very many attributes or namespace declarations could take a long time or much memory. Bever's reading of ENEX did not get to either. It does not resolve namespaces, and 1.1.0 reads an export that has 300,000 attributes on one tag in a tenth of a second.

The check still warns of six crates as unmaintained or unsound, none with a known vulnerability. Five belong to the Linux desktop and are not in the Windows or the Android application. The sixth, `fxhash`, is used by the HTML parser.

### Compatibility

- **1.1.1 and 1.1.0 work on the same library and synchronize with each other.** The library, the synchronized folder and the settings are as 1.1.0 left them; nothing is converted.
- **Exports are read as before,** also one with bytes that are not UTF-8, which is imported with "�" where they were. The newer XML reader stops at such bytes, so they are replaced before it reads them.
- For those building on `bever-core`: it depends on `quick-xml` 0.42 and `rusqlite` 0.42, and `BeverError::Xml` carries the error of the newer `quick-xml`.

### Not verified

- Nothing in this release was run on an Android device; the Android package was built.
- Synchronization was not run against pCloud this time, since no sign-in was saved on the development machine. Its tests against a stand-in for pCloud pass.
- The comparisons of speed are from one computer.

## 1.1.0 — 2026-11-14

### Added

- **Back and forward** among the notes and the lists you have been at, as in a browser: the arrows beside the name in the sidebar, Alt+Left and Alt+Right, or the side buttons of a mouse. A search that is typed counts as one place, and the screens of notebooks and of tags are places too.
- **A guard against changing a note by mistake.** Notes still save by themselves. The padlock in a note's header makes it read-only until it is unlocked. Once a note has been changed, **Discard changes** puts it back as it was when you opened it: its text, title, tags, details, and the date it was last changed. Before the first change of each visit Bever keeps the note as it was; the last five such versions are listed under **Note information** and any of them can be put back. Under **Settings & sync**, notes can be made to open read-only. The versions stay on the device and are not synchronized.
- **A search can be a shortcut.** The star in the search field keeps the words typed among the shortcuts, which also show what each one leads to: a note, a notebook, a stack, a tag, or a search.
- **Shortcuts come along from Evernote.** Importing from Evernote on this computer adds its shortcuts to notes, notebooks, stacks, tags, and saved searches, in its order, where what they point to is in the library. One that was removed here is not brought back.

### Changed

- **What a search found is ordered by where the words are:** in the title first, then in the notebook's name, then in the tags, then in the text. Within each, notes that have every word whole come before those in which a word only begins so, and then the words in the order typed and close together come first: “my apple” finds “my apple” before “my friend's apple” before “apple of my eye”. The name of a notebook now answers a search for the notes in it.
- **The order chosen for a list is remembered on the device:** of the list of notes, through a search and in every notebook, and of the notebooks and the tags on their screens.
- **A note that is put out of sight stops playing.** A video or a recording went on playing after going back to the list on a phone, or behind the screens of notebooks and tags, with nothing to stop it by.
- **Changing a note costs the same however many notes there are.** The search index was read from end to end to find a note's entry, so saving grew slower with the library and an import slower with every note it had brought. On a library of 4,833 notes the index is made anew in 1.4 seconds instead of 33.
- **A library made by 1.0.0 is opened as it is.** What is new is kept in tables of its own, and the search index is made anew from the notes the first time, which takes a moment.

### Fixed

- **One Bever runs for one library.** Started a second time, for instance while a synchronization kept it running without its window, it opened a second window on the same notes, each saving over what the other wrote. The one that is running now comes to the front.
- **A note that cannot be drawn says so** and leaves the lists to go on from, instead of an empty window.
- **A failure inside one operation no longer stops the library** until the application is started again.

### Compatibility

- **Every device that synchronizes a library should run 1.1.0.** A search kept as a shortcut reaches the other devices with the other shortcuts; 1.0.0 does not know what it is and shows it as a tag that has no notes.
- **Going back to 1.0.0 is not supported.** It was not tried. A library that 1.0.0 has changed in between has its search index made anew when 1.1.0 opens it again.
- **A search finds more than it did,** since the name of a notebook answers it, and what it finds is in another order.
- **Alt+Left and Alt+Right** now go back and forward in every part of the window.
- **Importing from Evernote again adds its shortcuts** to a library that was imported before.
- For those building on `bever-core`: the search index has a `notebook` column and its columns are in another order; `Library::toggle_shortcut` takes `"search"`; `LocalImportReport` has `shortcuts_added`.

### Not verified

- Nothing in this release was run on an Android device: the padlock, discarding changes, and media stopping on going back were tried in a phone-sized browser and in the Windows application.
- The Rust dependencies were not checked for known vulnerabilities on the development machine, where the tool for it is not installed; a weekly check on GitHub is added for both the Rust and the JavaScript dependencies. The JavaScript ones were checked: none known.
- The figures for speed are from a copy of one library's database on one computer.

## 1.0.0 — 2026-11-14

The first release of Bever, for Windows and Android.

### Library

- Notes, notebooks, notebook stacks, tags, shortcuts, and a trash that can be restored from or emptied. Several notes can be moved, copied, tagged, trashed, restored, deleted, and exported at once.
- Tags nest inside tags, as deep as you like, and a notebook belongs to a stack. Names are listed with their numbers read as numbers: `note-2` before `note-10`.
- **Notebooks** and **Tags** each have a screen of their own, reached from their heading in the sidebar: find one by name, see how many notes it has, order them by name or by number of notes, and rename, move, export, or delete one.
- The list of notes has a place for every note from the start, so its scroll bar is that of the whole list, and only what is looked at is loaded. On a phone a handle at its edge can be dragged to any part of it.
- The list shows each note by its largest picture, or by the one chosen for it from a picture's menu.
- Everything is kept on the device: the notes, their attachments, and the search index. There is no account and no application server.

### Editing

- Rich text, tables, checklists, code blocks, links between notes, and attachments from a file picker, the clipboard, or drag and drop. Pictures, audio, video, and PDF pages are shown in the note.
- Pictures can be sized, aligned, and annotated with arrows, shapes, text, stamps, pen, and highlighter; the marks stay separate things that can be changed later.
- Sketches open stroke by stroke: pen, highlighter, eraser, shapes snapped from hand-drawn lines, and a selection that can be moved, resized by a corner, and given another colour or pen size.
- Web clippings, and laid-out HTML pasted into a note, are shown with their own layout and can be made editable.
- Notes save by themselves. A note that changed underneath an open editor is kept beside yours as a conflict copy.

### Search

- Offline full-text search over titles, text, tags, notebooks, attachment names, and the text recognised in pictures, with operators such as `tag:`, `notebook:`, `created:`, and `intitle:`.
- What was typed is looked for in titles first: a note named so comes before notes that only mention the words. The passage that answers the search is shown under the title.
- A search that finds nothing as typed is made again with the words of the library that are spelt nearly so (a letter missing, too many, or wrong, or two letters swapped), and says which spelling it took.
- A note opened from a search shows what the search found, in its text and in its pictures, and the marks can be switched off. Find in a note steps through its text and the text of its pictures.
- Text in PNG, JPEG, and WebP pictures can be recognised on the device, in the background, with the place of every word.

### Bringing notes along

- ENEX files are imported several at once, each into a notebook you choose, and exported again without loss: the original markup, metadata, attachments, and recognised text are kept. A note that came from an Evernote export and was not changed is exported as the same text, byte for byte.
- On Windows, notes can be read straight from the files the Evernote application keeps on the same computer, every notebook at once, with its stacks and the nesting of its tags. Nothing is signed in to and nothing is sent anywhere.
- A note of which Evernote does not hold every attachment is named, with what is missing of it, and can be imported without it.
- Importing again brings notes up to date instead of adding them a second time.

### Synchronization

- Optional synchronization through your own pCloud storage, started by you: revisions, conflict copies, and deletions that reach your other devices. The remote copy is not end-to-end encrypted.
- A run asks pCloud for as little as it can: two requests when nothing has changed, three to send one edited note. The count is shown after each run.

### Not in this release

- End-to-end encryption of the remote copy, scheduled synchronization, and other storage services than pCloud.
- Linux, macOS, and iOS builds; signed installers.
- The Android build is compiled and packaged, but was not run on a device as part of the release checks.
