# Importing from the Evernote application

Evernote exports one notebook at a time. Its desktop application, once it has synchronized, keeps the whole account on the computer, and Bever can read it there: every notebook at once, with its stack, without an export, a sign-in, or the network. This page says what is read, how, and how it was checked to give the same notes as an ENEX export.

Bever is not affiliated with Evernote, and this is done for one purpose: so that people can take the notes they wrote to another program. It reads the copy of the user's own notes that is on the user's own computer, changes nothing, uses none of Evernote's program code, keys, or services, and gets around no protection: the files are an ordinary SQLite database and ordinary files. What is written below was worked out by looking at such files and comparing them with exports of the same notes.

It is not a connection to Evernote's servers. Evernote's developer API is marked deprecated and new keys for it are not issued, so there is no supported way for another application to sign in to an account.

## What is read

Evernote 10 and later keep their data in one folder, `%APPDATA%\Evernote` on Windows:

```text
conduit-storage/<site>/UDB-User<id>+RemoteGraph.sql    an SQLite database
conduit-fs/<site>/<name>/rte/Note/internal_rteDoc/<abc>/<xyz>/<note id>.dat
                                                       the body of each note
resource-cache/<n>/<note id>/<md5 of the file>         each attachment
```

From the database:

| Table                   | Used for                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Nodes_Notebook`        | notebooks: `label`, and the stack in `personal_Stack_id`, which is `Stack:` and the stack's name                                                                                                                                         |
| `Nodes_Note`            | notes: `label`, `created`, `updated`, `deleted`, `isUntitled`, `parent_Notebook_id`, and the attributes `editor_author`, `source`, `source_URL`, `source_application`, `attributes_subjectDate`, `attributes_contentClass`, `reminder_*` |
| `Nodes_Tag`, `NoteTag`  | tags and which notes have them                                                                                                                                                                                                           |
| `Attachment`            | attachments: `filename`, `mime`, `width`, `height`, `dataHash` (MD5), `dataSize`, `isActive`, `shardId`, `applicationDataKeys`, `applicationData`                                                                                        |
| `AttachmentRecognition` | the text Evernote recognised in a picture: the XML's bytes in hexadecimal                                                                                                                                                                |

The files are opened for reading only, and nothing else in the folder is looked at; in particular not what Evernote keeps for signing in.

## A note's body

The body is a [Yjs](https://github.com/yjs/yjs) document, the format of a library for documents that several people edit at once. `crates/bever-core/src/ydoc.rs` reads it: the items each writer made, put back in order the way the library does it. The order matters twice: for text typed at one place by two writers, and for an element's attributes, which Evernote writes out in the order in which they were first set.

The document's `content` is the note's markup as a tree, `en-note` at its top. `customNoteStyles` holds the note's heading styles.

## The same notes as an export

A note read here is turned into exactly what the ENEX reader makes of the note's export (`EnexNote`), and goes through the same import. For that the markup is written the way Evernote's export writes it:

- the XML declaration and the `en-note` doctype, then `<en-note>` with its attributes;
- when the heading styles carry an `isEmpty` flag, a hidden block first: `<div style="display:none;--en-chs:&quot;…&quot;">`, holding the styles as JSON in base64, with one hair space (U+200A) inside;
- an empty `br`, `hr`, `en-media`, `img`, `en-todo`, `col`, `area`, `input`, or `en-crypt` closes in its own tag, with a space before `/>` when it has attributes; any other empty element has an end tag;
- in text `&` and `<` are escaped; in attribute values `&`, `<`, `>`, and `"`.

And the rest as an export has it:

- a note without a title is called `Untitled Note`, whatever Evernote shows for it;
- times are cut to the second;
- every attachment has a `file-name`, empty when it has none, and as `source-url` its address in Evernote's cache, `en-cache://tokenKey%3D%22AuthToken%3AUser%3A<user>%22+<note id>+<md5>+https%3A%2F%2Fpublic.www.evernote.com%2Fresources%2F<shard>%2F<attachment id>`;
- a key of an attachment's application data that Evernote lists without a value is written with an empty one;
- an attachment that was taken out of the note (`isActive` 0) is not part of it.

Two things are added that an export from a current Evernote leaves out: the note's identifier, by which links between notes are resolved, and the recognised text of pictures, which makes them searchable at once and spares recognising them again. Neither is part of the key by which a note imported twice is recognised, so a note that was imported from an export is not imported again from Evernote's files, nor the other way about.

## How it was checked

- **The document reader against Yjs itself.** For all 4,831 notes of one account, the markup written from this reader's result and from the Yjs library's result had the same MD5. The unit tests use documents made with the library: several writers at one place, text inserted into the middle of another writer's, overwritten and removed attributes, deletions, nested maps.
- **Against exports.** `cargo run --release -p bever-core --example compare_evernote_local -- <export.enex>` reads an export and the same notebook from Evernote's files and compares every field of every note. For three notebooks exported by Evernote 11, 993 of 997 notes and their 2,477 attachments were the same in every field; the other four had been changed in Evernote after the export.
- **Through the importer.** After importing a whole account from Evernote's files (4,829 notes, 7,834 attachments, 6.8 GB, in three and a half minutes), importing the three exports into the same library found those 993 notes already present. The other way about, a notebook of 171 notes imported from its export and then from Evernote's files had 170 notes passed over and the one that had changed since the export brought up to date, with 171 notes in the library afterwards.

## Importing again

An import can be repeated, with exports or from Evernote's files, in any order. For each note that arrives:

1. **The same content was imported before:** the note is skipped. Every version of a note that was ever imported is on record, so an older export does not bring an older version back.
2. **An earlier version of the note is here, untouched since it was imported, and this one is later:** it takes the earlier one's place. The note keeps its identity in the library and the notebook it is in; its text, title, tags, attributes, and attachments become those of the newer version, and synchronization sends it on as a change.
3. **An earlier version is here and was changed here:** both are kept. Nothing written in Bever is overwritten by an import.
4. **Otherwise** it is a new note.

"The note" is found by Evernote's identifier where both versions have one, which notes from Evernote's files do. An export from a current Evernote has none, so a note from an export is found by its title and its time of creation, neither of which changes when the note's text does; a note retitled in Evernote is then a new note. "Touched here" means that the note is no longer what was imported: its text, title, tags, or attributes were changed, or it was moved to another notebook. Putting it in the trash is not a change of the note: it is brought up to date where it lies.

Two notes of one import are never taken for two versions of one note, whatever they share: some exports give several notes one identifier.

A note deleted in Evernote is not removed here. Importing is not synchronization with Evernote: nothing ever goes back to it.

## Limits

- **A computer only.** Evernote's desktop application has to be installed, signed in, and synchronized. Windows was tried; the folder on macOS (`~/Library/Application Support/Evernote`) is looked in but was not.
- **What Evernote does not have on the computer cannot be read.** A note whose text or attachment is not there is named in the dialog, with its notebook and what is missing, and left out whole. Letting Evernote synchronize longer does not always bring it: Evernote 11 was seen to be refused an attachment by its service once (`status code 401`), to log "skipping and setting as downloaded", and never to ask again. Opening the note itself in Evernote while online fetched it, and the next import took the note.
- **A note can be taken without the attachments that are missing**, when asked for in the dialog. Its text still names them, and a picture among them is shown as missing. Such a form is imported only where the library has none of the note, or in place of an earlier one that has no attachment it lacks; it is never put beside a note that was changed here. The whole note, imported later, takes its place although Evernote gives both the same time of change; a form changed here in the meantime is kept, and the whole one added beside it. A note without its text cannot be imported.
- **Evernote's own format.** None of this is published. It is what Evernote 11.41 writes. Data in another form is reported as unknown and nothing is imported from it.
- **As with ENEX:** notes in the trash, tasks, and shortcuts are not imported.

## Tags inside tags

An export gives a note's tags by name and says nothing of which tag is inside which. Evernote's own files do (`Nodes_Tag.parent_Tag_id`), and an import from them nests the tags of the library the same way when it has brought the notes:

- a tag goes under the tag it is under in Evernote; a tag that only holds others, and is on no note, is made for the ones it holds;
- only a tag that is at the top and was never renamed or placed in Bever is moved. What was arranged here stays as it is, and a tag is placed once: moving it in Evernote afterwards does not move it here;
- every tag of the library is looked at, not only those of the notebooks chosen, so importing any one notebook nests the tags of the whole library.

Notes are not changed by this, and are not synchronized again for it.
