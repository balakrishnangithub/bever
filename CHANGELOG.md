# Changelog

## 1.6.1 — 2026-11-21

Discarding the changes to a note takes off the pictures and files added since it was opened. Until now they stayed on the note, which was then synchronized although nothing in it had changed.

### Fixed

- **A sketch, a drawing on a picture, or a picture or file put into a note stayed on the note when the changes were discarded.** Each of these is stored as an attachment of the note the moment it is made, before the note is saved with it in its text. **Discard changes** put the text back, which no longer showed the attachment, but left the attachment on the note. The note was then not what it had been: the next synchronization sent it to the other devices, with the attachment's file, where discarding a change to the text sends nothing. Discarding now takes off every attachment the note did not have when it was opened, and a note discarded back to what was synchronized is not sent.
- **What was discarded is still kept, attachments included.** The note as it was before discarding is kept under **Note information**, as before; putting that version back puts its attachments on the note again. The same holds for every earlier version there: put back, the note has the attachments it had then, no more and no fewer.
- An attachment taken off a note stays on the device while one of the note's five earlier versions has it. When the last of those goes, it is removed, and its file with it unless another note has the same file.

### Compatibility

- Nothing changes in how notes are kept in pCloud or synchronized. On the device, the library gains two tables, for the attachments an earlier version had and for those taken off a note; versions of Bever before this one leave them alone.
- An earlier version kept by 1.6.0 or before does not say which attachments the note had. Putting it back leaves the note's attachments as they are, as until now.
- An attachment that an earlier discard left on a note stays on it: it has been synchronized as part of the note, and nothing tells it from an attachment that was meant to stay.

### Not changed

- A drawing that is saved, not discarded, still leaves the picture as it was before the drawing on the note, beside the drawn one, and so does a picture deleted from a note's text: an attachment is taken off a note only by putting an earlier version back.

### What was verified

- **In tests of the Rust core:** an attachment added after the note was kept is off the note when that version is put back, out of the search, with its file still on the device; putting the discarded version back puts it on again, as it was; a note discarded back to what was synchronized, after an attachment was added, is not sent, makes no request beyond the two listings, and uploads no file, where the same test fails on 1.6.0; put back again, note and attachment are sent and reach the other device; an attachment is removed with its file when the last version that had it goes, a file another note has stays, and a note deleted for good takes what was taken off it along; a version kept before this release leaves attachments alone.
- **In the built Windows application** (`npm run test:sync`): a picture is pasted into a note that was synchronized, the changes are discarded, and the next run sends no note and no file and makes two requests. The synchronization check passed (17 checks with an empty library, 16 with an export), and so did the general check (`npm run test:native`: 28 and 33).
- **In the browser check:** a picture pasted into a note before anything else is changed makes **Discard changes** appear; discarding takes it out of the note, and putting the discarded version back shows it again.
- Automated: 194 tests of the Rust core and 13 of its round trips through ENEX, 28 of the native shell, 275 of the interface, and the browser check. `cargo audit` and `npm audit` find no vulnerability.
- The Windows program and the Android package were built from the released source.

### Not verified

- **On a phone.** The change is in the core and in the editor, which are the same on Android; it was not run there.
- **A sketch and a drawing on a picture themselves.** The checks put a picture in by pasting. All three reach the note by the same one step in the editor (`attachBlob`), which is what was changed.
- The Windows installers were built, not run.

## 1.6.0 — 2026-11-20

A library is kept in a pCloud folder you choose, so that one pCloud account can hold several libraries that never mix: yours and another person's, each in a folder of its own. A device either starts a new library or joins one that is there.

### Added

- **The folder a library is kept in is chosen.** Until now every library was synchronized with `/Bever`, so two people who shared a pCloud account had their notes merged into one library. After connecting pCloud, Bever now asks where the library is kept:
  - **Start a new library** makes a folder for it where you say, named `Bever` unless you name it otherwise; where that name is taken, `Bever 2` is offered. Every note of the device is uploaded to it. This is for the first device of a library, and for a library that is to stay apart from one already in the account.
  - **Join an existing library** is for another device of a library that is in pCloud already. The folders of the account are shown one level at a time, and a folder that holds a library says so when it is opened. A library at `/Bever` is looked for first and offered, since the device being set up is most often another device of that library.
- **A folder holds one library, and says which.** A folder that holds a library has a small file, `library.json`, that names it. A new library cannot be started in a folder that holds one, nor among other files: it needs a folder that is new or empty. The folder is marked the moment it is chosen, before anything is synchronized, so that a second device cannot start another library in it meanwhile.
- **Changing the folder.** **Change…**, beside the folder's name in Settings, keeps the library in another folder or joins another library. A device that has notes of its own is asked before it joins a library, because the two become one: the notes of each go to the other, a note that both have differently is kept twice (as a conflict copy), and a note the library had deleted that the device still has stays. Nothing is ever removed from the folder that is left.
- **A folder that was moved or renamed in pCloud is found again.** Chosen as an existing library, it is recognised as the library the device synchronizes with, and the next run goes on from where the last one ended: nothing is transferred again.

### Changed

- **A folder that is gone is said to be gone, and is not made again.** When the library's folder had been removed, moved or renamed in pCloud, a run made a new, empty `/Bever` and took it for the library, with all its notes already in it: nothing was uploaded, and nothing said so. A run now stops and says that the folder is not there any more, and what to choose in Settings. It also stops when the folder holds another library than the one the device synchronizes with, instead of merging the two. Nothing is changed on either side by a run that stops this way.
- **A device that is connected but has never synchronized is asked for the folder before its first run.** **Sync now** is unavailable until then.
- The first run in a folder makes one request more, to name the library; the first run of another device makes two more, to read the name. A run with nothing to do still makes two requests: which library the folder holds is read from the listing a run begins with.

### Fixed

- **Two fingers on a PDF could stop being followed in the middle of their movement.** A page of a PDF is drawn again, sharper, whenever its size has changed and the fingers rest for a moment, and the old drawing is taken away. The fingers had been put on that drawing, and a browser sends the rest of a finger's movement to what the finger was put on and nowhere else: so the page stopped growing, and was not told when the fingers lifted. Fingers are now on the page itself, which stays. It showed where drawing is slow and the fingers pause, and was found because the computer the checks run on was slow enough on the day of this release; 1.5.0 has it too.
- Fingers lifted from a PDF before the screen had drawn their last movement left the page at the size before that movement. The last movement is now shown as the fingers lift.

### Compatibility

- **A library that has been synchronized stays where it is.** It is kept in `/Bever`, is asked nothing, and its next run transfers nothing but what changed and one small file, `library.json`. Versions from 1.0.0 to 1.5.0 ignore that file, so a device that still runs one of them goes on synchronizing with the same folder.
- Nothing changes in how notes are kept on the device or in pCloud. The folder and the name of its library are settings of the device and are not synchronized.

### What was verified

- **Against pCloud itself** (`pcloud_selftest`, inside a folder it makes and removes): two libraries started side by side in folders of their own; a folder that is taken is refused to the second; neither library receives anything of the other, and each folder holds its own notes; a third device joins one of them and receives that library's notes and no others; a folder that is removed is missed in words, is not made again, and the notes on the device are as they were; started anew, the library is uploaded whole. It made 38 checks in all, the numbers of requests in `docs/sync.md` among them, and removed its folder.
- **In tests of the Rust core, against a storage in memory:** the same, and a library from before folders were chosen that goes on where it was, names its folder once, and is recognised by its other devices; a folder that was moved, missed, and found again without a transfer; another library put in the folder, which is not taken for this one; two libraries joined, with a note that both had differently kept twice, a note deleted in one kept, and the folder that was left unchanged.
- **In the built Windows application** (`npm run test:sync`, against a stand-in for pCloud that also holds a folder of other things and somebody else's library): a library that was never synchronized cannot be synchronized until a folder is chosen; the chooser refuses a folder that has other things in it and makes the one it is told; the folder in use is told from the folder of the other library, and looking at either changes nothing; at the end the library's folder is removed, the run says so and does not make it again, and the library, started anew, is uploaded whole. The synchronization check passed (16 checks with an empty library, 15 with an export), and so did the general check (`npm run test:native`: 28 and 33).
- **In the browser check,** wide and in a phone's window with touches: the chooser offers the library that is there; Escape, and Back on the phone, close the chooser and leave Settings open; a new library is offered beside the other under a name that is free; a folder further in that holds a library says so and nothing is started inside it; a folder with other things in it and a name with a slash are refused in words; the folder chosen is shown in Settings and can be changed, and joining another library is asked about first and can be declined.
- **The two fingers on a PDF,** in the browser check: the check of 1.5.0 failed on the unchanged source of 1.5.0 on the day of this release, the page having received the fingers' first movements and then nothing, not even their lifting. With the fingers on the page it passes, also with a rest in the middle of the movement long enough for the pages to be drawn again under them, which the check now has; and it checks that what is under a finger is the page and not a drawing. That the last movement is shown as the fingers lift is by reading the code: no check lifts them before a picture is drawn.
- Automated: 190 tests of the Rust core and 13 of its round trips through ENEX, 28 of the native shell, 273 of the interface, and the browser check. `cargo audit` and `npm audit` find no vulnerability.
- The Windows program and the Android package were built from the released source.

### Not verified

- **On a phone.** The chooser was not run on a phone. It is the same interface as on Windows, in a window of a phone's size with touches; what the phone adds is its own Back, which closes the chooser by the same means as every other dialog.
- **Two real people.** The two libraries of the tests were two temporary libraries on one computer, in one pCloud account.
- The Windows installers were built, not run.

## 1.5.0 — 2026-11-19

Back goes back to where you were: out of a search to the notebook, out of the notebook to where it was chosen, and out of Bever only when there is nowhere left to go back to. A link that says nothing but the address of a note is shown by the note's title, as Evernote shows it. A stack or a tag found on the screens of notebooks and tags can be unfolded.

### Changed

- **Back goes back to where you were.** Android's Back knew only of what was open over the list: with a notebook chosen and a search typed in it, Back left Bever. Now it first closes what is open, as it did, and then goes back through the places you have been, one for each press: from a note to the list it was opened from, or to the note whose link led to it; from a search to the listing as it was before the search; from a notebook, a tag or the trash to where it was chosen, which is the screen of notebooks if that is where it was chosen; and from the first place, out of Bever. These are the places the arrows beside the name, Alt+Left and the side button of a mouse have always gone through, so that all of them, on a phone and on a computer, now go the same way.
- **A search is a step.** The first letter typed into the search of a list makes the step and the letters after it change it, so that Back from a search, however long, is the list whole again; clearing the search is the same step back. A filter chosen in the panel of filters is such a step as well, and so is a search on the screens of notebooks and of tags. Until now a search changed the place one was at, and going back from it went to wherever one had been before the notebook.
- **The arrow in a note leads to the list.** In a narrow window the arrow at the top of a note went back one layer. It now leads to the list the note was opened from in one step, also when links led through several notes on the way; Back goes through those one at a time.
- **A screen is found as it was left.** Going back to the screen of notebooks or of tags finds its search as it was and the same stacks and tags unfolded.
- **A note that is deleted leaves no empty step behind.** Going back from the list after deleting the note that was open took one press that showed nothing.
- In a wide window made narrow, the note that was open beside the list is in front of it.

### Added

- **A link that says only an address is shown by the title of its note.** Evernote writes some links to notes with the link's own address for their text (`evernote:///view/…`) and, when it shows the note, puts the title of the linked note there, which it looks up. Imported, such a link led to the right note and showed the address. It is now shown by the title the linked note has, looked up each time the note is opened, so that a note renamed since is shown by its new name. The note itself goes on saying the address: it is not stored anew for being shown, and when it is written in, the link is stored as it was. Changing the link's text by hand makes that text the link's own.
- **What a search of the notebooks or of the tags finds can be unfolded.** A stack that is found has its arrow, and unfolds to the notebooks in it; a tag that is found unfolds to the tags inside it, and those in their turn. What is found is listed as before, each with where it is.

### Fixed

- **A link to a note that has been deleted** answered with an error that named the note by its identifier. It now says that the note is no longer in the library.
- **An Evernote link that says only an address, to a note that was never imported,** searched the titles of all notes for the address and listed nothing. It now says that the note is not in the library, and stays where it is.

### Compatibility

- Nothing changes in how notes are kept or synchronized, and nothing that worked is taken away. A library of 1.0.0 or later is opened as it is.

### What was verified

- **The links of the library that was reported from,** by their kinds and numbers only: of 285 links between notes, 283 lead to their note, and 5 of those say only an address and are the ones now shown by a title; 2 are Evernote's links to notes that are not in the library. Their forms are the two that Evernote writes (`evernote:///view/…` and `https://www.evernote.com/shard/…/nl/…`).
- **Every kind of link, in a test of the Rust core** (`every_kind_of_link_to_a_note_finds_its_note_or_stays`): Evernote's two forms and the form of a shared note, an identifier in capitals, a link known only by the title it says, a short link, a link that says only its address, and links with nothing to go by, which stay as they are; none loses its text, and a second import changes none.
- **In the browser check,** wide and in a phone's window with touches, a note with nine links: to a note by words and by its address only, to itself, to a note in the trash, to a note that is gone, Evernote's links to notes never imported (by words, by an address, from the web), and to the web. Each is followed, by a touch in a note that is only read and by the bubble and Ctrl in one that is written in, and gone back from; the web view is never sent anywhere. The note written in keeps showing the title, and a linked note renamed is shown by its new name.
- **Going back, in the browser check, in a phone's window:** the walk that was reported (all notes, the screen of notebooks, a stack found and unfolded, a notebook in it, a search, a note) and back out of it step by step to all notes with nothing left behind; the same by the drawer; a search cleared by its button; notes ticked and one of them opened; a filter chosen in its panel; the arrow in a note after links through three notes. Everything that was checked of Back before is checked still.
- **In the built Windows application:** the note that was reported, opened on a copy of the database of its library: both of its links to notes are shown by titles and nothing in it says an address; it is stored as it was after being shown; a link followed opens the note whose title it showed, and Back returns from it. In the check with an export imported (`npm run test:native`), a note of the check's own whose link says only an address is shown by its note's title, is not stored anew for that, and written in is stored with the address as it was; and the side button of a mouse goes back one place, not two. The general check passed (28 checks with an empty library, 33 with an export that holds PDFs), and so did the synchronization check against a stand-in for pCloud (`npm run test:sync`: 13 and 12).
- Automated: 185 tests of the Rust core and 13 of its round trips through ENEX, 28 of the native shell, 266 of the interface, and the browser check. `cargo audit` and `npm audit` find no vulnerability.
- The Windows program and the Android package were built from the released source.

### Not verified

- **On a phone.** None of this was run on a phone, which was not at hand, and Back is what a phone has. The steps back are made the way the things Back closes have been made since 1.3.0, which was measured on a phone then: entries in the web view's history, made in answer to a touch. What is new is that there are more of them, and that some are made a moment after the touch, when the note has been read from the library; the measurements of 1.3.0 had such a case, and it was honoured. That is reasoning from them, not a trial of this release.
- The Windows installers were built, not run.

## 1.4.0 — 2026-11-19

Books, texts and archives are read where they are, as PDFs are. Scanned pages of a PDF are drawn with their pictures. A mark on a picture takes the size and the colour chosen while it is selected. A link to another note works in a note that is only read. A change that was discarded is not sent by the next synchronization.

### Added

- **An EPUB book is read in a preview.** _Read book_ on the attachment opens it over the window: a chapter at a time, in the order the book has them and under the names its table of contents gives them, with the pictures of the book. The chapters are chosen from a list or stepped through with the buttons, the arrow keys, or the button at a chapter's end; a link from one chapter to another goes there. The text is made larger and smaller with the buttons or + and −. A book is printed on white, whichever theme the application has. Only the chapter being read is unpacked, so a book of a hundred megabytes opens as fast as a small one.
- **A text written in Markdown is shown as it reads**, with its headings, lists, tables and code, and as it is written at the press of a button.
- **Plain texts and source code are read in a preview**: files that say they are text, and files that say nothing but have the name of one (`.py`, `.json`, `.css`, `.sql` and some ninety other endings). The first two megabytes of a longer one are shown.
- **A table of text (CSV, TSV) is shown as a table**, its first row as the headings; the divider is found from the file, and quoted values may hold commas and line breaks.
- **A ZIP archive lists what it holds**: the names and sizes of its files, without unpacking any.
- **A picture stored as a file of no particular kind is shown as a picture.** A picture saved from the web often says only that it is a file. With a picture's name (`.jpg`, `.png`, `.svg`, `.webp`, `.avif`, `.gif`) it is now drawn in the note, and the application tells the page what picture it is from how the file begins.

All of these are read on the device. A book, a Markdown text and an archive are as little trusted as a note: scripts and style sheets in them are left out, nothing they name on the web is fetched (pictures on the web only where the setting for them allows it), and an archive is believed in nothing it says about its own sizes.

### Changed

- **A selected mark on a picture takes the size and the colour chosen for it.** The slider and the colours of the picture editor were for what is drawn next, and a mark that was already there kept what it had, selected or not. Now, with a mark selected, the slider shows the size that mark has and changes it: a line or a shape is drawn thicker or thinner, an arrow gets the head and shaft of a thicker one between the same two ends, a text's letters are higher from the same corner, a stamp is larger about its middle. A colour chosen then is the mark's. Moving the slider is one step to undo, however far it went.
- **A stamp is as large as the slider says**, as everything else drawn on a picture is; at the slider's middle it is the size it always was.

### Fixed

- **Pages of a PDF drawn without their pictures.** Scanned documents are pictures in formats (JBIG2, JPEG 2000) whose decoders pdf.js fetches when a document needs them, as it fetches the fonts a PDF names without carrying them and the character maps of East Asian text. None of these came with the application, so such a page was drawn with what was left: often a blank sheet with a line or two. They come with it now, each with its licence, 3.7 megabytes in all.
- **A link to another note, touched in a note that is only read.** In a note open for reading a link is an ordinary link to the web view. Bever followed it at once, which took the note off the page while the touch was still under way, and the web view, left with a link that was in no page, went to its address: `bever://note/…`, which is no page. The link's own effect is now prevented, and the link followed when the touch is over. With a mouse, and in a note being written, links worked. It was found in a phone-sized browser window with touches, which is where a phone with notes set to open read-only would meet it.
- **A discarded change was sent by the next synchronization.** A note changed by mistake and put back with _Discard changes_ is, date and all, the note the other devices have; it was uploaded all the same, because it had been saved twice since. Such a note is now recognised by its content and not sent. Where the change itself was synchronized before it was discarded, what was put back is sent, as it must be.

### Compatibility

- Nothing changes in how notes are kept or synchronized, and nothing that worked is taken away. A library of 1.0.0 or later is opened as it is.

### What was verified

- **The PDF that was reported,** a scanned book of 267 pages: in a browser and in the built Windows application, pages 16 to 18 were about one hundredth drawn before (0.9 to 2.3% of the page not white) and are a fifth to a quarter drawn now (16 to 27%), and pdf.js, which had warned of every picture it left out, says nothing. Of the 234 PDFs of the library it came from, at least 9 hold pictures of these two kinds.
- **Nine real EPUB books,** of 15 to 812 chapters, in the built Windows application: each opened in 0.1 to 1.1 seconds; of the first eight chapters of each, every one was read and every picture drawn (72 chapters, 72 pictures); nothing was reported by the page.
- **In the built Windows application** (`npm run test:native`): a Markdown text pasted into a note is fetched from the attachment store by ranges and shown as it reads, with the script in it left out; a drawing pasted as an unknown file is served as `image/svg+xml` and drawn. The general check passed (28 checks with an empty library, 32 with an export that holds PDFs), and so did the synchronization check against a stand-in for pCloud (`npm run test:sync`: 13 and 12).
- **In the browser check,** wide and in a phone's window with touches: the five previews (a Markdown text, a script, a table, a book with a picture and a link between its chapters, an archive), each closed by its button or by Back, with nothing asked of the web and no script of a file run; a link to another note followed from a note that is only read, without the web view being sent anywhere; a selected stroke made twice as thick and given another colour, each one step to undo; what pdf.js fetches being served.
- **Synchronization:** a test of two libraries through a stand-in (`a_change_that_was_discarded_is_not_sent`): a discarded change costs the two listings and no transfer; a later change goes both ways; a change synchronized before it was discarded is followed by what was put back.
- Automated: 185 tests of the Rust core and 12 of its round trips through ENEX, 28 of the native shell, 241 of the interface, and the browser check. `cargo audit` and `npm audit` find no vulnerability.
- **That nothing else about PDFs changed,** in the built Windows application: every PDF of 33 Evernote exports, 140 documents of 1 to 178 pages, 2,593 pages in all, was opened, scrolled to its end and made larger. All were shown, none with a page that could not be drawn or an error in the page.
- The Windows program and the Android package were built from the released source.

### Not verified

- **On a phone.** None of this was run on a phone, which was not at hand: the previews, the link in a read-only note and the PDF decoders were tried in a phone-sized browser window with touches, and in the Windows application. On Android the decoders may run in their slower form if the web view refuses the fast one; the pages are drawn either way.
- **Office documents** (Word, Excel, PowerPoint, OpenDocument) have no preview: showing them as they look takes far more than this, and showing only their text was not asked for. Old binary formats, RAR and 7z archives have none either.
- The Windows installers were built, not run.

## 1.3.1 — 2026-11-18

A note opened from a search was sometimes stored anew, with today's date, though nothing had been written in it. Also a note opened for reading only. It no longer is.

### Fixed

- **A note opened from a search got a new date.** A note that ends in a list, a table, a rule or anything else that is not a line of text was stored anew when it was opened from a search: its date of change became the moment it was opened, _Discard changes_ was offered though nothing had been written, and the next synchronization sent the note to the other devices. Opened from its notebook, the same note was left alone. The cause: the editor wants an empty line after such an ending, to write in, and adds it the first time anything is asked of it. Opened from a search, the first thing asked is to mark what the search found, and that came before the editor had taken down what the note looked like as it was stored; with nothing to measure the empty line against, it was taken for writing. The note is now taken down before anything is asked of the editor. It has been so since 1.0.0.
- **A note open for reading only could be stored.** The padlock, and the setting that opens every note read-only, kept the writer from changing a note, and not the editor: the fault above stored such a note as well. Now nothing the editor does to a note that is only read is taken for a change of it.

### Compatibility

- Nothing changes in how notes are kept or synchronized. A library of 1.0.0 or later is opened as it is.
- Notes that got a new date this way keep it. Where the note was not written in since, _Note information_ lists the forms that were kept of it, the latest few, each with its date, and puts one back.

### What was verified

- The fault was reproduced in the browser check with the released 1.3.0 before it was repaired: a note that is a list to its end, opened from its notebook, stayed as it was; opened from a search that marks a word in it, from a search that found only its title, and read-only from a search, it was stored anew each time. With the repair, none of the four stores it, its date in the list stays, and nothing is offered to discard; a letter typed into it afterwards is stored as before. Those steps are part of the browser check now.
- A test of the editor by itself (`RichEditor.test.tsx`) fails on the code of 1.3.0 in three of its four cases and passes now.
- Automated: 184 tests of the Rust core and 12 of its round trips through ENEX, 27 of the native shell, 219 of the interface, and the browser check. `cargo audit` finds no vulnerability. `npm audit` finds none in what the application is made of (`npm audit --omit=dev`); among the tools that build and test it, it reports a fault published since 1.3.0 in `picomatch`, which matches file names for them, in every version there is: no repaired one exists yet, and nothing of it is in the application.
- In the built Windows application (`npm run test:native`), with a note that is a list to its end, read from the library's file before and after: opened from a search in 1.3.0, its page was rewritten, its revision went from 1 to 2 and its date from 2024 to the moment of opening; in 1.3.1 it is the same to the letter. That check is part of the run with an export from now on. The general check passed (27 checks with an empty library, 31 with an export that holds PDFs), and so did the synchronization check against a stand-in for pCloud (`npm run test:sync`: 13 and 12).
- The Windows program and the Android package were built from the released source.

### Not verified

- On a phone. The fault is in the part of Bever that is the same on Windows and Android, and was reported on both; the repair was tried in a browser and in the built Windows application, not on a phone, which was not at hand.
- The Windows installers were built, not run.

## 1.3.0 — 2026-11-17

Going back closes what was opened last, and nothing else. Lists take a swipe whichever way it begins. The filter offers the tags of the notes listed and finds a tag as its name is typed. A PDF is read page under page and made larger where it is looked at, sharp at every size. Saving a marked picture on a phone takes half a second, where it took fourteen.

### Changed

- **The filter offers the tags of the notes listed.** With hundreds of tags, a list of all of them was of no use: a tag late in the alphabet was at the end of a long scroll. What is offered now is what the notes listed have, each tag with the number of those notes that have it, which is how many are left when it is chosen. The chosen tags stay at the top, and each one chosen shortens the rest to what its notes also have. The other tags are there when asked for (_Show all tags_); one that none of the listed notes has is shown faint, with a nought, since choosing it leaves nothing. The numbers are counted by the library over the whole listing, not over the part of it that is loaded.
- **A tag is found by typing some of its name**, without regard to capitals or accents. Names that begin with what was typed come first, then those in which a later word begins with it, then the rest. When tags of that name exist that none of the listed notes has, the panel says how many. The place to type in stays at the top of the panel while the tags move under it, and in a short window (a phone on its side, or with its keyboard up) the panel has the height there is.
- **A PDF is scrolled through, page under page.** It was one page at a time, with buttons to the next. Every page is as wide as the view, the upright ones and those on their side. The number of the page in view is shown, and a number typed there goes to that page. Only the pages in view and near it are drawn, and those left behind give their memory back, so a long document costs what a few of its pages do. The preview is as tall as the window allows, and on a phone it has the whole screen.
- **A PDF is made larger about the place looked at, and stays sharp.** Two fingers spread on it, Ctrl with the wheel (which is what a touchpad sends for two fingers), a double tap or double click, the buttons, or the keys + and −: from half the width of the view to eight times it. What is under the fingers, or under the pointer, stays there. One finger moves a larger page in every direction, and so does the mouse held down. A PDF is drawings and letters, not pixels, so a page made larger is drawn again at its new size once the fingers rest; where a whole page at that size would be more than a device has memory for, the part in view is drawn at the full size, over the page as it was.
- **Going back out of the editor of a picture or a sketch keeps what was drawn.** It is saved, as the button saves it, and the editor closes; nothing is asked. _Cancel_ still leaves without saving.

### Fixed

- **Back passed by what was open, on Android.** With a PDF preview open, Back went back in the application under the preview, and after a few more it closed the application with the preview still showing; with the filter open, it left the list of notes. Only the drawer, the open note, the settings and the screens of notebooks and tags knew of Back. Now everything that opens over something else does, and Back closes the thing opened last, one thing for one step: the filter, a selection of notes, a dialog and a question, a menu, the PDF preview, the note's information, find in the note, the colours and the table chooser, the bubble of a link, the editors of pictures and sketches and the menus in them, the import. With nothing open, Back leaves Bever, as it does everywhere. The same holds for whatever else goes back in the window's history, a mouse's button for it among them, also in a wide window, where the settings and the screens of notebooks and tags are now closed by it too.
- **Swipes that did nothing, on Android.** A swipe that began more sideways than upward, as a thumb's does, moved nothing, however straight it went on: not in the list of notes, a note, the lists of the drawer, the screens of notebooks and tags, the settings, or the filter. The phone layout gave sideways swipes to the drawer by a rule that the browser applies at the first movement of a touch, for the whole of the touch. Every one of these now takes a swipe whichever way it begins. In the filter there was a second cause: the list of tags scrolled by itself inside the panel, which scrolled too, so a swipe was taken for one or the other, and at the end of the list for neither; the panel is now the one thing that scrolls. And in the open drawer a swipe begun on a slant was taken for the beginning of closing it; when it goes on upward, the drawer now lets go and its list moves.
- **Saving a marked picture or a sketch took fourteen seconds on a phone.** Nearly all of it was the picture being written as a PNG file, which Android's web view does when it finds the time, and it found it late. The picture is now written the direct way: half a second for a picture of four million pixels, seven tenths for one of six.
- **The keyboard stayed up under a sketch.** A sketch, the editor of a picture or the PDF preview opened while a field of the note was being typed into left the keyboard up, over half of what was opened, and the first Back went to the keyboard. What opens over the whole window now puts the keyboard away.
- **Two fingers on a PDF preview made the note larger.** The preview was drawn inside the note it was opened from, so the note took the fingers for its own, and it grew from its corner with the preview in it. The preview now lies over the window, and what happens in it is its own.
- **An error in the page's record for every link clicked with a target.** A part of the application that is not allowed to open links asked to, was refused, and reported it; the link was opened, or not, by the part that is. The asking is gone.

### Compatibility

- Nothing changes in how notes are kept or synchronized, and nothing that worked is taken away. A library of 1.0.0 or later is opened as it is.

### What was verified

- **On a phone** (a Samsung phone with Android 17, with a library of several thousand notes and some six hundred tags on it), with real taps, the real Back key, and touches made by the phone's own input; what the page then showed was read through the web view's debugging port.
  - _Swipes._ Before the change, a swipe that began 55 degrees off upright moved the list of notes by nothing, where a straight one moved it by 342 pixels: the cause, seen where it was reported. After it, such a swipe moved the list of notes, a long note, the settings, the screen of all tags, the filter (to either side, and at 65 degrees) and the drawer's list by 320 pixels or more each. A sideways swipe in the middle of the list opened nothing; from the edge of the screen it opened the drawer, and one that stayed sideways closed it. A sideways flick on the pages of a PDF, which have no guard against it, did not swallow the tap after it, three times of three.
  - _Back._ 36 steps of opening and going back, all as expected: the drawer; the filter; a note, and over it the PDF preview, the note's information, find, and a menu, each closed by itself with the note left open; the preview and then the note by two Backs; a selection of notes with a dialog over it; a menu in the drawer with the drawer left open; the settings; the screen of all tags; and with nothing open, out of Bever. Which entries of the window's history Android's Back honours was measured first, in nine cases: those a page makes in answer to a touch, also several for one touch; one made after Back with no touch in between makes Back leave the application, which is why Bever makes none then.
  - _The rest of what Bever does,_ 54 steps, all as expected (four that the first pass asked for in the wrong place were asked again, properly): a note written with a title, text, a tag and a checklist; added to the shortcuts and pinned; made larger by two fingers and put back; a sketch drawn, saved by Back, opened again; a picture marked, cancelled, marked and saved by Back, and the mark removed; the keyboard shortening the window with the field typed into in view, and gone when a sketch opens; search for the note, another order of the list; the note to the trash, restored, and deleted for good; a notebook made, renamed and deleted; the phone on its side and upright again; the settings; the import, which opens the phone's file picker. The library had as many notes afterwards as before.
  - _PDFs,_ eight documents of the library, of 1 to 34 pages: the first page there within half a second; two fingers spread made a page 3.4 times as wide with the point between them staying within a pixel, the note under it keeping its size; sharp again a fifth of a second later; one finger then moved it sideways, a double tap put it back to the width of the screen; the last page of each reached and drawn.
  - _Saving a marked picture,_ timed in the page from the press on Save to the editor closing: 13.9 seconds before for a picture of 4 million pixels and 14.1 for one of 6, of which 13.2 was the writing of the PNG; after, 0.5 and 0.64 to 0.71 seconds.
  - _One synchronization with pCloud,_ started on the phone: 26 seconds, 2 notes and 3 attachments sent, nothing received, no trouble; the phone's service for it ran and stopped. Started from nothing twelve times, this version ran twelve times.
- **In windows of every size,** in the browser check: a small phone, a phone upright, on its side and with its keyboard up, a tablet upright and on its side, a small window, a laptop and a large monitor, from 360 by 640 to 2560 by 1440. In each the filter and the PDF preview are inside the window, their buttons in reach, a tag's name typed is answered with tags in view, and nothing is wider than its place.
- **In the browser check besides:** going back through everything named above, the editor of a picture with a menu, a text being written and a mark made among it; the filter among 600 tags with emulated fingers; a PDF of forty pages, every fifth on its side, scrolled through, gone to by number, made larger by wheel, mouse and two fingers, with no drawing of more pixels than it may have.
- **The PDF preview in the built Windows application, with real documents,** on an earlier build of this version: every PDF of 34 Evernote exports, 145 documents of 1 to 178 pages, 2,645 pages in all, nine of them with pages of more than one shape. All were shown and none refused; the first page was there after 0.8 seconds for the middle one and 5.2 for the slowest; made 3.3 times larger, each was sharp again after 0.3 seconds for the middle one and 2.7 for the slowest; the last page of each was reached and drawn.
- Automated: 184 tests of the Rust core and 12 of its round trips through ENEX, 27 of the native shell, 215 of the interface, and the browser check. `cargo audit` and `npm audit` find no vulnerability.
- The built Windows application passed its general check (`npm run test:native`: 27 checks with an empty library, 30 with an export that holds PDFs) and the synchronization check against a stand-in for pCloud (`npm run test:sync`: 13 and 12). Counting the tags of a listing took about a hundredth of a second on a real library of several thousand notes and some six hundred tags.
- The Windows program and the Android package were built from the released source.

### Not verified

- **Two fingers of a hand.** On the phone, one finger was the phone's own input; two were made in its web view, by the debugger, since the phone's input makes only one. The phone's owner tried the preview by hand and found the fault with Back that is fixed here.
- One phone. No tablet and no other phone was used: the other sizes are windows in a browser on a computer. Bever is not built for iOS, macOS or Linux; nothing in this version is particular to Android or Windows, but none of it was run on those.
- pCloud itself was reached by the one run on the phone, not from Windows. The Windows installers were built, not run.

## 1.2.1 — 2026-11-17

On Android, Bever sometimes closed a moment after it was opened, most often the first time after the device had been restarted, and Android said nothing about it. It no longer does.

### Fixed

- **Bever closing as it starts, on Android.** The window is made before the library is opened, and on Android its page loads meanwhile, on other threads. When the page was ready first, its first request found no library to ask, and that ended the application: two or three seconds after it was opened, with the loading screen showing. Android says nothing about an application that ends this way once. It happened when opening the library took longest, which is after the device was restarted, and now and then otherwise. A request that comes early now waits for the library, some tenths of a second, and is answered. Windows was not affected: there the page cannot load before the library is open.

### Compatibility

- Nothing changes in how notes are kept or synchronized. A library of 1.0.0 or later is opened as it is.

### What was verified

- **On the phone where it happened** (a Samsung phone with Android 17, with a library on it). Android's own record of 1.2.0 ending had the same reason each of five times, two to three seconds after the start: the state was asked for before it was there. Started from nothing twelve times, 1.2.0 ended once. The corrected program stayed in 30 of 30 such starts, and this version as released in 15 of 15. The first start after the phone was restarted is the one that counts: a request came 434 ms before the library was open, waited, and was answered, and Bever stayed open. No report of a crash was added in any of these.
- Automated: 183 tests of the Rust core and 12 of its round trips through ENEX, 27 of the native shell, two of them for a request that comes before set-up is done, 180 of the interface, and the browser check. `cargo audit` and `npm audit` find no vulnerability.
- The built Windows application passed its general check (`npm run test:native`: 26 checks with an empty library, 30 with an export of 171 notes) and the synchronization check against a stand-in for pCloud (`npm run test:sync`: 13 and 12).
- The Windows program and the Android package were built from the released source.

### Not verified

- One phone. No other Android device and no emulator was tried.
- pCloud itself was not reached with this version; nothing in how Bever synchronizes was changed.

## 1.2.0 — 2026-11-16

A note was stored anew, and given a new date, when no more was done to it than placing the cursor in it. A note is now stored only when what can be seen of it has changed. Besides that, a note can be made larger to look at, pinned to the top of its notebook, and shown in lists without a picture; and an import from Evernote brings the pins and the thumbnail choices Evernote has.

### Fixed

- **A note that is only touched is not changed.** The editor used to store a note whenever it said that something had happened to its document, and it says so for reasons that are not the writer's: a keyboard on a screen takes up the word under the cursor and puts it back, sometimes with a space after it; an empty line is added at the end of a note so that there is somewhere to write. The note was then written anew in the editor's own markup, got the present as its date, moved up in the list, and was sent to the other devices. Three things now each prevent that:
  - The editor compares what can be seen. For as long as its document shows nothing that the stored note does not, the note is the stored note. Spaces at the end of a line and empty lines at the end of the note cannot be seen and are no change; a letter typed and taken away again is none either.
  - What is unsaved is worked out, not remembered. A title typed again as it was, a tag added and removed, a move to another notebook and back leave nothing to save.
  - The library does not store a note that is given to it as it already has it.
- **An imported note stays as Evernote wrote it until it is changed.** Its markup is kept to the letter while it is only read, which is also what makes it comparable with Evernote afterwards.
- **Choosing a thumbnail does not change the note's date.** It is said about the note, not written in it.

### Added

- **Zoom.** A note is made larger to look at with two fingers spread on it, or with Ctrl and the wheel, which is also what a touchpad sends for the same gesture. It is the zoom of a page of a PDF: the lines stay as they are, nothing is wrapped anew, and what does not fit is reached by moving the note. What was under the fingers stays under them. The title, the toolbar and the rest of the window keep their size. A small label says how large the note is and brings it back to its own size; the next note opens at its own size.
- **Pin to notebook.** A note is pinned to the top of its notebook from its header, from its information, or, for several notes at once, from the list. The one pinned last stands first. A pinned note carries a pin wherever it is listed. Moved to another notebook it is not pinned there. Pinning is not an edit: the note keeps its date.
- **No thumbnail.** In a note's information, the picture that stands for it in the list of notes can be taken away, and brought back. A picture's own menu still chooses that picture.
- **Evernote's pins and thumbnail choices are imported.** An import from Evernote on this computer pins the notes that are pinned to their notebooks there, and gives each note the thumbnail it has there: the one chosen, or none where it was removed. The summary says how many. An export carries the thumbnail choice too, as `<thumbnail>` among a note's attributes, and the list of notes now goes by it; an export has no pins.
- `audit_evernote_local` compares the thumbnail chosen for each note and the notes pinned with Evernote.

### Compatibility

- **To get the pins and thumbnail choices into a library that was imported before, import again from Evernote on this computer.** Nothing is added. A note that was changed in Bever gets them like any other, and keeps what was written in it.
- A library of 1.0.0 or later is opened as it is. Nothing changes in how notes are kept or synchronized: a pin and a thumbnail choice are among the note's details, under `application-data`, and travel with the note. A device with an earlier version keeps them, shows a pinned note where its date puts it, and shows a note whose thumbnail was taken away by its largest picture.
- Each of Evernote's pins and thumbnail choices is offered once. One that is changed or taken away in Bever afterwards is not brought back by importing again.
- For those building on `bever-core`: `Library::set_thumbnail` (`models::ThumbnailChoice`), `Library::set_pinned` and `Library::offer_marks` (`marks::ForeignMarks`) are new; `NoteSummary` has `pinned`; `LocalImportReport` has `thumbnails_brought` and `pins_brought`; `Library::save_note` returns the stored note unchanged, with its revision, when it is given the note as it is stored; a note's import key no longer includes its marks.

### What was verified

- Automated: 183 tests of the Rust core and 12 of its round trips through ENEX, 25 of the native shell, 180 of the interface, and the browser check. `cargo audit` and `npm audit` find no vulnerability.
- **A note that is only touched.** In the built Windows application, a note imported from files in Evernote's form was opened, the cursor was placed and moved in it, a letter was typed and taken away, and a space was typed at the end of a line: its stored page was the same to the letter afterwards, with the same date and revision. A letter that stayed was stored. In the browser check the same was done with a count of how often the note was stored, which stayed at nothing, also for a title typed again as it was. Unit tests cover a word written over itself, as a keyboard does it, a space put after it at the end of its line, an empty line added at the end of a note that ends in a rule, and everything that can be seen being taken for a change.
- **Zoom.** In the browser check, on a screen of a phone's size that takes touches, two fingers moved from 60 to 180 pixels apart made the note three times as large. A paragraph's box grew by that much in both directions, so no line was wrapped anew; the note could be moved sideways; what was between the fingers stayed between them to 4 pixels; the title and the window kept their size. The label brought the note back to its own size, and fingers brought together did not make it smaller than that. Ctrl and the wheel did the same on a desktop.
- **Pins and thumbnails.** Core tests: a pinned note is first in its notebook and where its date puts it elsewhere, keeps its date, is not pinned in a notebook it is moved to, and reaches a second device pinned; a thumbnail can be a chosen picture, none, or the one found, and an export that says which is believed and writes it back. In the browser check and in the built application a note was pinned from its header, from its information and from a selection, and a thumbnail was taken away and brought back.
- **The import, against one account.** A copy of a library of 4,834 notes as 1.1.3 had imported it differed from Evernote in 10 pins and 4 thumbnail choices. Imported again with this version: no note added, 2 brought up to what Evernote has now, 10 pinned, 4 given their choice (three removed, one chosen); after that the audit differed from Evernote only in 4 notes whose attachments Evernote itself does not have on the computer. The whole account imported anew: 4,829 notes with 7,805 attachments, 140 tasks, 10 pins and 4 thumbnail choices; the audit, with all 7,751 files read and hashed (6.6 GB), found nothing that differs but the 5 notes Evernote does not have whole, which the import names.
- The 160 exports of the same account (8.6 GB) were read for what they say: `<thumbnail>` is in 4 notes, empty in 3 of them; nothing in any export says that a note is pinned.
- The built Windows application passed its general check (`npm run test:native`: 26 checks with an empty library, 30 with an export of 171 notes) and the synchronization check against a stand-in for pCloud (`npm run test:sync`: 13 and 12).
- The Windows program and the Android package were built from the released source.

### Not verified

- **What set the editor off in the reported case was not found.** The note's kept earlier versions showed what had happened: its page written anew with the same text, twice with a space after a link at the end of a line. The same note, in a copy of that library and in the application, was touched in 27 ways (clicks in every line, the keys, a selection, taps, a word taken up as text being composed) without 1.1.3 changing it. The fix does not depend on the cause: whatever makes the editor change its document without anything to be seen changing is no longer a change of the note.
- **Zoom was tried with touches made by a program, in the engine of a desktop browser.** It was not tried with fingers on an Android device or on a touch screen under Windows, and how smoothly a very long note follows the fingers was not measured.
- Nothing in this release was run on an Android device; the Android package was built.
- Which picture Evernote shows for a note where none is chosen was not compared with the one Bever finds.
- pCloud itself was not reached with this version. That a pin and a thumbnail choice reach a second device is tested with the stand-in the core's tests use.

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
