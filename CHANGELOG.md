# Changelog

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
