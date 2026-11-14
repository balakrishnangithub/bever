# Changelog

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
