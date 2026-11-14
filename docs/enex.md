# ENEX and ENML compatibility

## Import

Bever reads Evernote `.enex` exports one note at a time. For each note it keeps:

- title, created and updated timestamps, tags, and the Evernote GUID when the export has one;
- note attributes, including `<application-data>` entries with their keys;
- the original ENML content;
- each resource's bytes, MIME type, dimensions, duration, recognition XML, attributes, and alternate data;
- note-level elements it does not know, such as Evernote task blocks, as raw XML that is written back on export;
- text Evernote recognised in images, in the local full-text index.

### How a file is read

- Text is collected for a whole element and stored when the element closes. The XML parser reports each entity (`&amp;`) separately, so a tag such as `Research &amp; Development` is one tag, not three.
- A field is recognised by its parent element as well as its name. A `<title>` or `<created>` nested inside another block does not change the note's title or date.
- Attachment data is base64-decoded as a stream and written straight into the attachment store, which computes its SHA-256 and Evernote MD5 on the way. Memory use does not grow with attachment size.
- A note or attachment that cannot be read is skipped and named in the import summary. The rest of the file is imported.
- Bytes that are not UTF-8 become "�" before the XML parser reads them; it would stop at the first one. The file is imported, without the characters those bytes stood for.
- The import can be cancelled between notes. Notes already imported stay.

### Notebooks and duplicates

Each file is imported into one notebook: a new one, named after the file without Evernote's “(N notes)” suffix unless you change it, or an existing one you choose.

A fingerprint of the imported source, metadata, tags, and resources is recorded for every imported note. A note whose fingerprint is already known is not imported again, so importing a file twice adds nothing, and an earlier import that you have since edited is not overwritten. The GUID is part of the fingerprint when present but is not used alone, so distinct notes that share a GUID are both kept.

### Links between notes

Evernote links (`evernote:///view/…` and `https://www.evernote.com/shard/…`) are rewritten to local `bever://note/…` links after each file:

1. by GUID, when the export contains GUIDs;
2. otherwise by the title the link shows, when exactly one note in the library has that title.

Exports from current Evernote versions contain no GUIDs, so the second rule is the one that usually applies. Links whose target has not been imported yet stay as they are and are connected by a later import that brings the target. Clicking a link that is still unconnected searches for its text.

### Content

- Checklists in both shapes — `<ul style="--en-todo:true;">` with `--en-checked` items, and classic `<en-todo>` — become editable checklists.
- Evernote code blocks and highlight spans become code blocks and highlights.
- Tasks, which an export has as `<task>` elements beside a note's content, become checklists in the note, each group where the note's markup has its place: see [Importing from the Evernote application](evernote-local.md#where-a-note-is-read-as-evernote-shows-it). Anything else that stands beside a note is kept as it is and written out again by an export.
- `en-media` elements become attachments shown in place. A picture is shown at the width its `width` attribute gives, in pixels or percent, and centred or on the right when its style says `--en-imageAlignment`. Its height follows from its proportions, which `--en-naturalWidth` and `--en-naturalHeight` give before the picture has loaded. A size or alignment chosen in Bever is written back in the same form. `en-crypt` blocks are kept and shown as encrypted; Bever does not decrypt them.

## Annotated pictures

Evernote stores an annotated picture as one PNG file. Its image data is the finished picture, which is all that other programs see. Two further chunks, after the image data, hold what is needed to change the annotations:

- `skRf`: sixteen bytes that name a picture, followed by a whole PNG file, the picture as it was before it was annotated.
- `skMf`: a JSON document. It gives the size of the drawing, a background layer whose bitmap refers to the `skRf` picture, and layers with the marks: `Vector` objects with an SVG-like path (strokes, lines, arrows, rectangles, ellipses), `Text`, and `Stamp`. Positions are pixels of the drawing.

Import and export do not look inside attachments, so these chunks travel with the picture unchanged. The annotation editor (`src/editor/pngChunks.ts`, `src/editor/skitch.ts`, `src/editor/ImageAnnotator.tsx`) reads them, draws the marks over the original, and on **Save** writes a new PNG in the same form: the finished picture, the original, and the document with the marks as they now are. Parts of the document that Bever does not use are written back as they were read. A picture that has never been annotated becomes the original of a new document; a JPEG or another format is converted to PNG for that.

The new file is added to the note as an attachment and takes the place of the old one in the note's text, with the same size and alignment. The old file stays attached.

Files from Evernote's phone applications name their original differently in the two chunks; the original is then taken by its place. Text in some files is percent-encoded several times over and is decoded for display. Evernote's sketches are a different format, described next.

## Sketches

A sketch drawn in Evernote is also one PNG file among the note's attachments, named `Sketch` with its date; newer versions add the attribute `evernote.handwriting`. The note refers to it like any picture. Its image data is a picture of the strokes, and two further chunks, after the image data, hold the strokes:

- `enIs`: a short JSON text, `{"name": "<id>", "width": 742, "height": 805}`.
- `enIz`: InkML (W3C) with attributes of Evernote's own, compressed with gzip.

```xml
<ink xmlns="http://www.w3.org/2003/InkML" xmlns:enink="http://www.evernote.com/2013/InkNote">
  <context enink:name="<id>" enink:version="3" enink:sizeWidth="74200" enink:sizeHeight="80500"
           enink:backColor="#ffffff" enink:pattern="3" enink:savePattern="false" enink:blankdate="…">
    <inkSource xml:id="Evernote-Neutron">
      <traceFormat>channels X, Y, W, all decimal</traceFormat>
      <activeArea width="742.0" height="805.0"/>
    </inkSource>
  </context>
  <traceGroup>
    <trace enink:strokeType="0" enink:color="-16777216" enink:fixWidth="1.5"
           enink:cmdsPattern="1358954501">8640 14340 224 8653 14433 224 …</trace>
  </traceGroup>
</ink>
```

What the parts mean, as read from 421 sketches:

- **Points.** Each point of a trace is three whole numbers: x, y, and the width of the line there, in hundredths of a pixel. A pen's width changes along the stroke; a highlighter's and a shape's does not.
- **The canvas has no edges.** Coordinates are places on an unbounded canvas and are often negative or far from zero. The picture shows the part the strokes cover, with a few pixels around it; `sizeWidth`, `sizeHeight`, and `activeArea` give the picture's size, not a page. Where the picture's corner lies on the canvas is not stored.
- **`strokeType`.** 0 is the pen, 11 the highlighter, and 5, 3, 2, and 7 are a line, rectangle, triangle, and ellipse made by Snap to shape. A highlighter is drawn over the ink at 59/255 opacity, with flat ends.
- **`color`.** Alpha, red, green, and blue in one signed 32-bit number.
- **`fixWidth`.** The size of the pen, in pixels. The widths in the points are what is drawn.
- **`shapePoints`.** On a snapped shape: its outline as 32-bit floats in pixels, little-endian, base64, with a line feed at the end. A rectangle has its four corners, beginning at the lower right; an ellipse has sixteen points, the ends and control points of eight quadratic curves. The trace of an ellipse has seventeen points: the ends of those curves and the middle of each.
- **`cmdsPattern`.** How the points form a path. The high byte names the form and the rest counts its repeated part: `0xA1` for two points, `0xA9` with the count of points less three for a polygon, `0x51` with the count less five for a free stroke of six or more points, `0x6E` for an ellipse. Evernote's files use more forms than these; Bever keeps them as they are and writes only the ones named here.
- **The paper.** `backColor` is its colour. `pattern` is 0 for none, 1 for dots, 2 for a grid, 3 for lines, all 32 pixels apart and drawn in black at 15% opacity; 4 to 6 are taken to be the same three, 64 pixels apart. With `savePattern` the pattern is part of the picture. Older sketches have none of the three attributes.
- **Sketches from Evernote's phone applications** name their source `evernote-android`, and their size is a page's, not the picture's.

Import and export do not look inside attachments, so the chunks travel with the picture unchanged. The sketch editor (`src/editor/ink.ts`, `src/editor/SketchEditor.tsx`, and the chunk reader in `src/editor/pngChunks.ts`) reads the strokes, draws them, and on **Done** writes a new PNG in the same form: a picture of the strokes as they now are, `enIs`, and `enIz`. A stroke that was not changed is written back as the text that was read, and so is everything around the strokes; only attributes whose values changed are rewritten. The new file takes the old one's place in the note, as an annotated picture does.

- Images embedded as `data:` URLs are kept. Images that live on other websites are not requested until you ask, or always when **Images from the web** is on in Settings.

### Web clippings

Evernote stores a clipped page as the page's own elements with inline styles, inside a `div` marked `--en-clipped-content` (`fullPage`, `article`, `simplified`, `selection`, …), and shows it as one object that is not edited in place. Bever does the same:

- The clipping is one block of the note. Its markup is kept exactly as imported, so it is exported unchanged even after you edit the note around it.
- It is drawn in a frame of its own, on white, with the page's layout. Its text can be selected and copied, and its links work.
- Before it is drawn, the markup is rebuilt from known elements and attributes only. Scripts, forms, embedded pages, and event attributes are left out; styles that would cover the application or fetch something from the web are removed.
- **Make editable** replaces the clipping with ordinary note content. Text, links, images, lists, and tables stay; the page's layout does not.
- Find in note does not look inside a clipping. Library search does.

### HTML content

Evernote shows laid-out HTML that was pasted into a note as an “HTML content” block. Mathematics copied from a web page is the usual case: the page drew it with hundreds of small boxes, each placed by an inline style. An export carries no mark for such a block, so Bever recognises it by what it contains:

- an element counts when its style lays it out in a way the editor cannot hold: `display` as `inline-block`, a table part, `flex`, or `grid`; `position: absolute`; or a `float`;
- a block (`div` or `p`) with three or more such elements is kept as it is, unless a block inside it already qualifies. The smallest such block is kept, and the text around it stays ordinary text.

`display: inline` and `float: none`, which a browser puts on every span of copied text, do not count, and one or two laid-out elements are taken for decoration. A kept block behaves like a web clipping in every other respect, including **Make editable**, which also leaves out what the page had hidden, such as the spoken form that rendered mathematics carries beside the visible one.

### Text recognition

Recognition is not part of the import. Images without Evernote recognition data are queued, and a background worker reads them afterwards with the bundled Ocrs models. The queue survives a restart, can be paused in Settings, and also covers images you attach later and images that arrive through synchronization. Recognised text is added to the search index; images and ENML are not changed.

It is on by default on desktop and off by default on Android. PNG, JPEG, and WebP images up to 40 MB are read, downscaled to at most 2200 pixels per side. The models suit printed Latin-alphabet text; handwriting and other scripts may be inaccurate. They are CC BY-SA 4.0 licensed, with attribution in `crates/bever-core/models/README.md`.

## Editing and export

An imported note has two representations:

1. `original_enml`, the imported source;
2. `content_html`, the editable document.

While the editable document still corresponds to the source, export writes the original ENML unchanged. After an edit, export converts the editable document to ENML:

- only elements and attributes that ENML allows are written; `id`, `class`, `data-*`, and event attributes are dropped;
- empty elements are closed (`<br/>`), and text is XML-escaped;
- checklists are written as `--en-todo` lists with `--en-checked` items, highlights as Evernote highlight spans, and table column widths as CSS widths;
- links to other notes are written as they are stored locally.

The result is well-formed ENML, but not every edit can be represented exactly as Evernote would have written it.

Attachment data is base64-encoded from the attachment store as a stream. The export header carries the Bever version that wrote it.

### The same text as Evernote's

An export is written the way Evernote 11 writes one, line for line: two spaces of indentation; a note's title, dates, tags, attributes, content, and attachments in that order; tags and attributes in the order the note has them, which for an imported note is the order of its export; quotation marks and apostrophes in titles and values as entities; attachment data in lines of 256 letters; six spaces after a note's content. Notes are written in the order they came into the library.

A note that came from an Evernote export and was not changed in Bever is therefore, exported again, the text it was in that export. A link to another note that Bever pointed at that note does not count as a change: the export writes the link as the source has it.

This was checked on six exports from Evernote 11, of 2, 2, 3, 121, 171, and 705 notes (the last 921 MiB): imported into an empty library and exported, every note of every file was the same bytes as in Evernote's file. The line that names the application and the date differs, as it must.

What still differs from an export Evernote would make of the same notes:

- a note changed in Bever is written anew from the editable document, as described above;
- a note that had tasks is written with the checklists they became, without `<task>` elements;
- a note imported from Evernote's own files carries the text Evernote recognised in its pictures (`<recognition>`), which Evernote 11 leaves out of its exports;
- Evernote puts a very long value, such as a source address of several hundred letters, on a line of its own. In the exports looked at, a value of 287 letters was on its tags' line and one of 695 was not; Bever draws the line at 500, which is a guess;
- a note's identifier is not written. It is not part of the format, and Evernote 11 does not write it. A note exported and imported again is recognised by its creation time and title.

## Known boundaries

- A single note's ENML is held in memory while that note is imported. Attachments are not.
- Encrypted-block decryption is not implemented.
- Title-based link matching cannot connect a link whose target was renamed after the link was made, or whose title is shared by several notes.
- The same export imported separately on two devices produces two sets of notes after synchronization. Import on one device and synchronize.
- PDF and Office attachments are not indexed for search; only their file names are.

## Regression strategy

Unit tests cover entities, CDATA, nested elements, `application-data` keys, damaged attachments, streamed attachment hashes, duplicate GUIDs, both checklist shapes, link resolution by GUID and by title, and ENML export that parses as XML and survives a round trip.

The `verify_enex` example imports a real file, exports every note, imports the result again, and compares source ENML, metadata, tags, and attachment hashes. It prints counts only, never note text.

```sh
cargo run --release -p bever-core --example verify_enex -- path/to/input.enex path/to/new-empty-work-directory
```

Private ENEX samples belong in ignored `test-data/`; never commit them.
