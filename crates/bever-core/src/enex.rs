//! Streaming ENEX reader, importer, and exporter.
//!
//! The reader yields one note at a time. Attachment bytes never pass through
//! memory as a whole: base64 text is decoded while it is read and handed to a
//! [`BlobSink`], so memory use is bounded by the note's ENML, not by its
//! largest attachment.
use std::{
    collections::HashMap,
    fs::File,
    io::{self, BufRead, BufReader, BufWriter, Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, NaiveDateTime, Utc};
use quick_xml::{
    events::{BytesStart, Event},
    Reader, Writer,
};
use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use crate::{
    blob::StoredBlob,
    db::Library,
    enml::{enml_to_html, escape_cdata, html_to_enml, without_note_link_targets},
    error::{BeverError, Result},
    models::{ImportProgress, ImportReport, Note},
    repository::ImportNoteResult,
};

/// Note attribute that keeps note-level ENEX elements Bever does not
/// model (for example Evernote task blocks) so that export can restore them.
/// The colon makes it an invalid element name, so it is never written as an
/// ordinary attribute.
pub const EXTRA_XML_KEY: &str = "bever:enex-extra";

/// How often the reader reports its position while inside one large note.
const PROGRESS_STEP: u64 = 8 * 1024 * 1024;

const NOTE_CHILDREN: [&str; 8] = [
    "title",
    "content",
    "created",
    "updated",
    "tag",
    "guid",
    "note-attributes",
    "resource",
];

/// Destination for attachment bytes decoded while reading.
pub trait BlobSink {
    fn store(&mut self, reader: &mut dyn Read) -> Result<StoredBlob>;
}

impl BlobSink for &Library {
    fn store(&mut self, mut reader: &mut dyn Read) -> Result<StoredBlob> {
        self.store_blob_reader(&mut reader)
    }
}

/// Keeps decoded attachments in memory. Intended for tests and tools that
/// inspect an export without a library.
#[derive(Debug, Default)]
pub struct MemoryBlobs {
    pub blobs: HashMap<String, Vec<u8>>,
}

impl BlobSink for MemoryBlobs {
    fn store(&mut self, reader: &mut dyn Read) -> Result<StoredBlob> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        let stored = StoredBlob {
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            md5: format!("{:x}", md5::compute(&bytes)),
            size: bytes.len() as u64,
        };
        self.blobs.insert(stored.sha256.clone(), bytes);
        Ok(stored)
    }
}

#[derive(Debug, Clone)]
pub struct EnexResource {
    pub blob: StoredBlob,
    pub alternate: Option<StoredBlob>,
    pub mime: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<u64>,
    pub recognition_xml: Option<String>,
    pub attributes: Value,
}

#[derive(Debug, Clone)]
pub struct EnexNote {
    pub title: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
    pub attributes: Value,
    pub evernote_guid: Option<String>,
    pub resources: Vec<EnexResource>,
}

/// One `<note>` element: either a readable note, or the reason it was not.
#[derive(Debug)]
pub enum EnexItem {
    Note(Box<EnexNote>),
    Skipped { title: String, reason: String },
}

#[derive(Debug, Default)]
struct ResourceBuilder {
    blob: Option<StoredBlob>,
    alternate: Option<StoredBlob>,
    mime: String,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<u64>,
    recognition_xml: Option<String>,
    attributes: Map<String, Value>,
}

impl ResourceBuilder {
    fn build(self) -> std::result::Result<EnexResource, String> {
        let blob = self
            .blob
            .ok_or_else(|| "an attachment has no data".to_owned())?;
        Ok(EnexResource {
            blob,
            alternate: self.alternate,
            mime: if self.mime.is_empty() {
                "application/octet-stream".into()
            } else {
                self.mime
            },
            width: self.width,
            height: self.height,
            duration: self.duration,
            recognition_xml: self.recognition_xml,
            attributes: Value::Object(self.attributes),
        })
    }
}

#[derive(Debug, Default)]
struct NoteBuilder {
    title: String,
    content: String,
    created: String,
    updated: String,
    tags: Vec<String>,
    attributes: Map<String, Value>,
    evernote_guid: Option<String>,
    resources: Vec<EnexResource>,
    extra_xml: Vec<String>,
    /// First problem that makes this note unreadable.
    failure: Option<String>,
}

impl NoteBuilder {
    fn fail(&mut self, reason: impl Into<String>) {
        self.failure.get_or_insert_with(|| reason.into());
    }

    fn build(mut self) -> EnexItem {
        if let Some(reason) = self.failure {
            return EnexItem::Skipped {
                title: self.title,
                reason,
            };
        }
        let created_at =
            parse_enex_date(&self.created).unwrap_or_else(|_| Utc::now().timestamp_millis());
        let updated_at = if self.updated.is_empty() {
            created_at
        } else {
            parse_enex_date(&self.updated).unwrap_or(created_at)
        };
        if !self.extra_xml.is_empty() {
            self.attributes.insert(
                EXTRA_XML_KEY.to_owned(),
                Value::Array(self.extra_xml.into_iter().map(Value::String).collect()),
            );
        }
        EnexItem::Note(Box::new(EnexNote {
            title: self.title,
            content: self.content,
            created_at,
            updated_at,
            tags: self.tags,
            attributes: Value::Object(self.attributes),
            evernote_guid: self.evernote_guid,
            resources: self.resources,
        }))
    }
}

/// Raw XML of a note-level element that is not part of the ENEX model.
struct Capture {
    writer: Writer<Vec<u8>>,
    depth: usize,
}

pub struct EnexReader<R: BufRead> {
    reader: Reader<R>,
    buffer: Vec<u8>,
    /// Names of the currently open elements, outermost first.
    path: Vec<String>,
    /// Text of the innermost open element. Committed when it closes, because
    /// one value can arrive as several text, CDATA, and entity events.
    text: String,
    /// `key` attribute of the open `<application-data>` element.
    key: Option<String>,
    note: Option<NoteBuilder>,
    resource: Option<ResourceBuilder>,
    capture: Option<Capture>,
    finished: bool,
}

impl<R: BufRead> EnexReader<R> {
    pub fn new(reader: R) -> Self {
        let mut reader = Reader::from_reader(reader);
        reader.config_mut().trim_text(false);
        reader.config_mut().check_end_names = true;
        Self {
            reader,
            buffer: Vec::new(),
            path: Vec::new(),
            text: String::new(),
            key: None,
            note: None,
            resource: None,
            capture: None,
            finished: false,
        }
    }

    /// Bytes of the source consumed so far.
    pub fn position(&self) -> u64 {
        self.reader.buffer_position()
    }

    /// Reads the next `<note>`. `on_progress` receives the byte position at
    /// intervals while a large note is being read.
    pub fn next_item(
        &mut self,
        sink: &mut dyn BlobSink,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<Option<EnexItem>> {
        if self.finished {
            return Ok(None);
        }
        // Events borrow the buffer, so it lives outside `self` while reading.
        let mut buffer = std::mem::take(&mut self.buffer);
        let result = self.pump(&mut buffer, sink, on_progress);
        buffer.clear();
        self.buffer = buffer;
        result
    }

    fn pump(
        &mut self,
        buffer: &mut Vec<u8>,
        sink: &mut dyn BlobSink,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<Option<EnexItem>> {
        let mut reported = self.reader.buffer_position();
        loop {
            buffer.clear();
            let position = self.reader.buffer_position();
            if position >= reported + PROGRESS_STEP {
                on_progress(position);
                reported = position;
            }
            let event = self.reader.read_event_into(buffer)?;

            if let Some(capture) = self.capture.as_mut() {
                match &event {
                    Event::Start(_) => capture.depth += 1,
                    Event::End(_) => capture.depth -= 1,
                    Event::Eof => {
                        return Err(BeverError::Invalid("the export ends inside a note".into()))
                    }
                    _ => {}
                }
                capture.writer.write_event(event)?;
                if capture.depth == 0 {
                    self.finish_capture();
                }
                continue;
            }

            match event {
                Event::Start(start) => {
                    let name = xml_name(start.name().as_ref());
                    if self.is_unmodelled_note_child(&name) {
                        let mut writer = Writer::new(Vec::new());
                        writer.write_event(Event::Start(start))?;
                        self.capture = Some(Capture { writer, depth: 1 });
                        continue;
                    }
                    let key = attribute(&start, "key");
                    self.open(name, key);
                    if self.in_resource_child("data") || self.in_resource_child("alternate-data") {
                        self.stream_blob(sink, on_progress)?;
                    }
                }
                Event::Empty(empty) => {
                    let name = xml_name(empty.name().as_ref());
                    if self.is_unmodelled_note_child(&name) {
                        let mut writer = Writer::new(Vec::new());
                        writer.write_event(Event::Empty(empty))?;
                        self.capture = Some(Capture { writer, depth: 0 });
                        self.finish_capture();
                        continue;
                    }
                    let key = attribute(&empty, "key");
                    self.open(name, key);
                    if let Some(item) = self.close(sink)? {
                        return Ok(Some(item));
                    }
                }
                Event::End(_) => {
                    if let Some(item) = self.close(sink)? {
                        return Ok(Some(item));
                    }
                }
                Event::Text(text) => {
                    let raw = String::from_utf8_lossy(text.as_ref());
                    match quick_xml::escape::unescape(&raw) {
                        Ok(decoded) => self.text.push_str(&decoded),
                        Err(_) => self.text.push_str(&raw),
                    }
                }
                Event::CData(data) => self.text.push_str(&String::from_utf8_lossy(data.as_ref())),
                Event::GeneralRef(reference) => {
                    let name = String::from_utf8_lossy(reference.as_ref()).into_owned();
                    self.text.push_str(&resolve_reference(&name));
                }
                Event::Eof => {
                    self.finished = true;
                    if self.note.is_some() {
                        return Err(BeverError::Invalid("the export ends inside a note".into()));
                    }
                    return Ok(None);
                }
                _ => {}
            }
        }
    }

    fn parent(&self) -> &str {
        self.path.last().map_or("", String::as_str)
    }

    /// A direct child of `<note>` that the ENEX model does not describe.
    fn is_unmodelled_note_child(&self, name: &str) -> bool {
        self.note.is_some()
            && self.resource.is_none()
            && self.parent() == "note"
            && !NOTE_CHILDREN.contains(&name)
    }

    /// Whether the innermost open element is `<resource><{name}>`.
    fn in_resource_child(&self, name: &str) -> bool {
        self.resource.is_some()
            && self.path.len() >= 2
            && self.path[self.path.len() - 1] == name
            && self.path[self.path.len() - 2] == "resource"
    }

    fn open(&mut self, name: String, key: Option<String>) {
        if name == "note" && self.note.is_none() {
            self.note = Some(NoteBuilder::default());
        } else if name == "resource" && self.note.is_some() && self.parent() == "note" {
            self.resource = Some(ResourceBuilder::default());
        }
        self.path.push(name);
        self.text.clear();
        self.key = key;
    }

    fn close(&mut self, sink: &mut dyn BlobSink) -> Result<Option<EnexItem>> {
        let Some(name) = self.path.pop() else {
            return Ok(None);
        };
        let text = std::mem::take(&mut self.text);
        let key = self.key.take();
        let parent = self.parent().to_owned();
        let Some(note) = self.note.as_mut() else {
            return Ok(None);
        };

        if let Some(resource) = self.resource.as_mut() {
            match (parent.as_str(), name.as_str()) {
                ("resource", "data" | "alternate-data") => {
                    // Base64 wrapped in CDATA is not seen by the streaming
                    // path and arrives as ordinary text instead.
                    if !text.trim().is_empty() {
                        match decode_base64(&text).and_then(|bytes| sink.store(&mut &bytes[..])) {
                            Ok(blob) if name == "data" => resource.blob = Some(blob),
                            Ok(blob) => resource.alternate = Some(blob),
                            Err(error) => {
                                note.fail(format!("an attachment is unreadable: {error}"))
                            }
                        }
                    }
                }
                ("resource", "mime") => resource.mime = text.trim().to_owned(),
                ("resource", "width") => resource.width = text.trim().parse().ok(),
                ("resource", "height") => resource.height = text.trim().parse().ok(),
                ("resource", "duration") => resource.duration = text.trim().parse().ok(),
                ("resource", "recognition") => resource.recognition_xml = nonempty(text),
                ("resource-attributes", _) => {
                    insert_attribute(&mut resource.attributes, &name, key, text);
                }
                ("note", "resource") => {
                    let resource = self.resource.take().expect("resource is open");
                    match resource.build() {
                        Ok(resource) => note.resources.push(resource),
                        Err(reason) => note.fail(reason),
                    }
                }
                _ => {}
            }
            return Ok(None);
        }

        match (parent.as_str(), name.as_str()) {
            ("note", "title") => note.title = text.trim().to_owned(),
            // The content is a document of its own; the white space the
            // file has around it, and Evernote's spaces after it, are not
            // part of the note.
            ("note", "content") => note.content = text.trim().to_owned(),
            ("note", "created") => note.created = text.trim().to_owned(),
            ("note", "updated") => note.updated = text.trim().to_owned(),
            ("note", "tag") => {
                let tag = text.trim();
                if !tag.is_empty() {
                    note.tags.push(tag.to_owned());
                }
            }
            ("note", "guid") => note.evernote_guid = nonempty(text.trim().to_owned()),
            // Evernote puts a long value, such as an address, on a line of
            // its own; the line break and the indentation are not the value.
            ("note-attributes", _) => {
                insert_attribute(&mut note.attributes, &name, key, text.trim().to_owned());
            }
            (_, "note") => {
                let note = self.note.take().expect("note is open");
                return Ok(Some(note.build()));
            }
            _ => {}
        }
        Ok(None)
    }

    fn finish_capture(&mut self) {
        let Some(capture) = self.capture.take() else {
            return;
        };
        if let (Some(note), Ok(xml)) = (
            self.note.as_mut(),
            String::from_utf8(capture.writer.into_inner()),
        ) {
            note.extra_xml.push(xml);
        }
    }

    /// Decodes the base64 text that follows the just-opened `<data>` element
    /// directly into the sink.
    fn stream_blob(
        &mut self,
        sink: &mut dyn BlobSink,
        on_progress: &mut dyn FnMut(u64),
    ) -> Result<()> {
        let alternate = self.parent() == "alternate-data";
        let base = self.reader.buffer_position();
        let mut text = Base64Text {
            inner: self.reader.stream(),
            done: false,
            base,
            consumed: 0,
            reported: 0,
            on_progress,
        };
        let stored = {
            let mut decoder = base64::read::DecoderReader::new(&mut text, &BASE64);
            sink.store(&mut decoder)
        };
        // Leave the XML reader at the closing tag even when decoding stopped early.
        text.skip_to_tag()?;
        let (Some(note), Some(resource)) = (self.note.as_mut(), self.resource.as_mut()) else {
            return Ok(());
        };
        match stored {
            Ok(blob) if alternate => resource.alternate = Some(blob),
            Ok(blob) => resource.blob = Some(blob),
            // Corrupt base64 affects one note; anything else (a full disk,
            // for example) would affect every following note too.
            Err(BeverError::Io(error)) if error.kind() == io::ErrorKind::InvalidData => {
                note.fail(format!("an attachment is unreadable: {error}"));
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }
}

/// Reads element text up to the next tag, dropping whitespace, so that a
/// base64 decoder can consume it without buffering the whole value.
struct Base64Text<'a, S: BufRead> {
    inner: S,
    done: bool,
    base: u64,
    consumed: u64,
    reported: u64,
    on_progress: &'a mut dyn FnMut(u64),
}

impl<S: BufRead> Base64Text<'_, S> {
    fn skip_to_tag(&mut self) -> io::Result<()> {
        while !self.done {
            let available = self.inner.fill_buf()?;
            if available.is_empty() {
                self.done = true;
                break;
            }
            let length = match available.iter().position(|&byte| byte == b'<') {
                Some(index) => {
                    self.done = true;
                    index
                }
                None => available.len(),
            };
            self.inner.consume(length);
        }
        Ok(())
    }
}

impl<S: BufRead> Read for Base64Text<'_, S> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let mut written = 0;
        while written == 0 && !self.done && !out.is_empty() {
            let available = self.inner.fill_buf()?;
            if available.is_empty() {
                self.done = true;
                break;
            }
            let mut consumed = 0;
            for &byte in available {
                if byte == b'<' {
                    self.done = true;
                    break;
                }
                if written == out.len() {
                    break;
                }
                consumed += 1;
                if !byte.is_ascii_whitespace() {
                    out[written] = byte;
                    written += 1;
                }
            }
            self.inner.consume(consumed);
            self.consumed += consumed as u64;
            if self.consumed >= self.reported + PROGRESS_STEP {
                self.reported = self.consumed;
                (self.on_progress)(self.base + self.consumed);
            }
        }
        Ok(written)
    }
}

fn attribute(element: &BytesStart<'_>, name: &str) -> Option<String> {
    let attribute = element.try_get_attribute(name).ok().flatten()?;
    let raw = String::from_utf8_lossy(&attribute.value);
    Some(match quick_xml::escape::unescape(&raw) {
        Ok(value) => value.into_owned(),
        Err(_) => raw.into_owned(),
    })
}

/// Resolves the name between `&` and `;`. Unknown names stay as written.
fn resolve_reference(name: &str) -> String {
    let code = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
        u32::from_str_radix(hex, 16).ok()
    } else if let Some(decimal) = name.strip_prefix('#') {
        decimal.parse::<u32>().ok()
    } else {
        None
    };
    if let Some(character) = code.and_then(char::from_u32) {
        return character.to_string();
    }
    let written = format!("&{name};");
    html_escape::decode_html_entities(&written).into_owned()
}

fn insert_attribute(
    attributes: &mut Map<String, Value>,
    name: &str,
    key: Option<String>,
    value: String,
) {
    if name.is_empty() {
        return;
    }
    // <application-data key="…"> is a keyed map, not a repeated value.
    if name == "application-data" {
        if let Some(key) = key {
            let entry = attributes
                .entry(name.to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(map) = entry {
                map.insert(key, Value::String(value));
                return;
            }
        }
    }
    match attributes.get_mut(name) {
        Some(Value::Array(values)) => values.push(Value::String(value)),
        Some(existing) => {
            let previous = existing.take();
            *existing = Value::Array(vec![previous, Value::String(value)]);
        }
        None => {
            attributes.insert(name.to_owned(), Value::String(value));
        }
    }
}

fn xml_name(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn nonempty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn decode_base64(value: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(
            value
                .bytes()
                .filter(|byte| !byte.is_ascii_whitespace())
                .collect::<Vec<_>>(),
        )
        .map_err(|error| BeverError::Invalid(format!("invalid base64: {error}")))
}

pub fn parse_enex_date(value: &str) -> Result<i64> {
    let parsed = NaiveDateTime::parse_from_str(value.trim(), "%Y%m%dT%H%M%SZ")
        .map_err(|error| BeverError::Invalid(format!("invalid ENEX date {value:?}: {error}")))?;
    Ok(parsed.and_utc().timestamp_millis())
}

/// Notebook name suggested for an export file: its name without the `.enex`
/// extension and without a trailing note count such as ` (171 notes)`.
pub fn default_notebook_name(file_name: &str) -> String {
    let stem = match file_name.rfind('.') {
        Some(index) if file_name[index..].eq_ignore_ascii_case(".enex") => &file_name[..index],
        _ => file_name,
    };
    let count = Regex::new(r"\s*\(\d+ notes?\)\s*$").expect("valid regex");
    let name = count.replace(stem, "");
    let name = name.trim();
    if name.is_empty() {
        "Imported notes".to_owned()
    } else {
        name.chars().take(255).collect()
    }
}

pub fn import_enex(
    library: &Library,
    path: impl AsRef<Path>,
    notebook_name: Option<&str>,
) -> Result<ImportReport> {
    import_enex_with_progress(library, path, notebook_name, |_| {})
}

pub fn import_enex_with_progress(
    library: &Library,
    path: impl AsRef<Path>,
    notebook_name: Option<&str>,
    progress: impl FnMut(ImportProgress),
) -> Result<ImportReport> {
    let path = path.as_ref();
    let file = File::open(path)?;
    let total_bytes = file.metadata()?.len();
    let fallback = default_notebook_name(
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
    );
    import_enex_reader(
        library,
        BufReader::with_capacity(1024 * 1024, file),
        total_bytes,
        notebook_name.unwrap_or(&fallback),
        &AtomicBool::new(false),
        progress,
    )
}

/// Imports an export from any reader. `cancel` is checked between notes; a
/// cancelled import keeps the notes imported so far and reports
/// `cancelled = true`.
pub fn import_enex_reader(
    library: &Library,
    source: impl BufRead,
    total_bytes: u64,
    notebook_name: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(ImportProgress),
) -> Result<ImportReport> {
    let mut report = ImportReport::default();
    emit_progress(&mut progress, "preparing", &report, 0, None, 0, total_bytes);
    let notebook_id = library.ensure_notebook(notebook_name, None)?;
    report.notebook_id = notebook_id.clone();
    emit_progress(
        &mut progress,
        "notebookReady",
        &report,
        0,
        None,
        0,
        total_bytes,
    );
    let mut reader = EnexReader::new(source);
    let run_mark = library.import_run_mark()?;
    let mut note_index = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        // Blobs are stored while the note is parsed and referenced when it
        // is inserted; cleanup must not run in between.
        let _blobs = library.blob_guard();
        let mut sink = library;
        let next = reader.next_item(&mut sink, &mut |bytes_read| {
            emit_progress(
                &mut progress,
                "reading",
                &report,
                note_index + 1,
                None,
                bytes_read,
                total_bytes,
            );
        })?;
        let Some(item) = next else {
            break;
        };
        note_index += 1;
        match item {
            EnexItem::Note(note) => {
                emit_progress(
                    &mut progress,
                    "processing",
                    &report,
                    note_index,
                    Some(&note.title),
                    reader.position(),
                    total_bytes,
                );
                match library.import_enex_note(*note, &notebook_id, run_mark)? {
                    ImportNoteResult::Imported {
                        note,
                        images_queued,
                        kept_both,
                    } => {
                        report.notes_imported += 1;
                        report.notes_kept_both += u64::from(kept_both);
                        report.resources_imported += note.resources.len() as u64;
                        report.bytes_imported +=
                            note.resources.iter().map(|item| item.size).sum::<u64>();
                        report.images_queued += images_queued;
                    }
                    ImportNoteResult::Updated {
                        note,
                        images_queued,
                    } => {
                        report.notes_updated += 1;
                        report.resources_imported += note.resources.len() as u64;
                        report.bytes_imported +=
                            note.resources.iter().map(|item| item.size).sum::<u64>();
                        report.images_queued += images_queued;
                    }
                    ImportNoteResult::Duplicate(_) => report.notes_skipped += 1,
                }
            }
            EnexItem::Skipped { title, reason } => {
                report.notes_failed += 1;
                let title = if title.is_empty() { "Untitled" } else { &title };
                report
                    .warnings
                    .push(format!("“{title}” was not imported: {reason}."));
            }
        }
        emit_progress(
            &mut progress,
            "noteImported",
            &report,
            note_index,
            None,
            reader.position(),
            total_bytes,
        );
    }
    let position = if report.cancelled {
        reader.position()
    } else {
        total_bytes
    };
    emit_progress(
        &mut progress,
        "finalizing",
        &report,
        note_index,
        None,
        position,
        total_bytes,
    );
    report.links_resolved = library.rewrite_import_links()?;
    library.optimize()?;
    emit_progress(
        &mut progress,
        "complete",
        &report,
        note_index,
        None,
        position,
        total_bytes,
    );
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    progress: &mut impl FnMut(ImportProgress),
    phase: &str,
    report: &ImportReport,
    note_index: u64,
    note_title: Option<&str>,
    bytes_read: u64,
    total_bytes: u64,
) {
    progress(ImportProgress {
        phase: phase.to_owned(),
        notebook_id: report.notebook_id.clone(),
        note_index,
        note_title: note_title.map(str::to_owned),
        notes_imported: report.notes_imported,
        notes_skipped: report.notes_skipped,
        notes_failed: report.notes_failed,
        resources_imported: report.resources_imported,
        bytes_read,
        total_bytes,
    });
}

pub fn export_enex(library: &Library, notes: &[Note], destination: impl AsRef<Path>) -> Result<()> {
    let mut writer = BufWriter::new(File::create(destination)?);
    write_export_header(&mut writer)?;
    for note in notes {
        write_note(&mut writer, library, note)?;
    }
    write_export_footer(&mut writer)
}

/// Exports notes by id, loading one at a time. `progress` receives the number
/// of notes written and the total.
pub fn export_enex_writer(
    library: &Library,
    note_ids: &[String],
    writer: impl Write,
    mut progress: impl FnMut(u64, u64),
) -> Result<u64> {
    let mut writer = BufWriter::new(writer);
    write_export_header(&mut writer)?;
    let total = note_ids.len() as u64;
    for (index, id) in note_ids.iter().enumerate() {
        let note = library.get_note(id)?;
        write_note(&mut writer, library, &note)?;
        progress(index as u64 + 1, total);
    }
    write_export_footer(&mut writer)?;
    Ok(total)
}

// An export is written the way Evernote writes one, line for line: its
// indentation, the order of a note's parts, attachment bytes in lines of 256
// letters. A note that came from an Evernote export and was not changed is
// then, exported again, the same text it was in that export.

fn write_export_header(writer: &mut impl Write) -> Result<()> {
    writer.write_all(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE en-export SYSTEM \"http://xml.evernote.com/pub/evernote-export4.dtd\">\n")?;
    writeln!(
        writer,
        "<en-export export-date=\"{}\" application=\"Bever\" version=\"{}\">",
        format_enex_date(Utc::now().timestamp_millis()),
        env!("CARGO_PKG_VERSION")
    )?;
    Ok(())
}

fn write_export_footer(writer: &mut impl Write) -> Result<()> {
    writer.write_all(b"</en-export>")?;
    writer.flush()?;
    Ok(())
}

fn write_note(writer: &mut impl Write, library: &Library, note: &Note) -> Result<()> {
    writer.write_all(b"  <note>\n")?;
    writeln!(writer, "    <title>{}</title>", xml(&note.title))?;
    writeln!(
        writer,
        "    <created>{}</created>",
        format_enex_date(note.created_at)
    )?;
    writeln!(
        writer,
        "    <updated>{}</updated>",
        format_enex_date(note.updated_at)
    )?;
    for tag in &note.tags {
        writeln!(writer, "    <tag>{}</tag>", xml(tag))?;
    }
    write_attributes(writer, "note-attributes", &note.attributes, "    ")?;
    // The imported source is exported verbatim while the editable copy still
    // corresponds to it; otherwise the editable copy is serialized as ENML.
    // A link to another note that was pointed at that note here is no
    // change: the source's own link says the same to whoever imports it.
    let unchanged = note.original_enml.as_deref().is_some_and(|original| {
        let html = enml_to_html(original);
        html == note.content_html
            || without_note_link_targets(&html) == without_note_link_targets(&note.content_html)
    });
    let enml = match &note.original_enml {
        Some(original) if unchanged => original.clone(),
        _ => html_to_enml(&note.content_html),
    };
    // Six spaces follow the note, as in Evernote's exports; the reader
    // takes them off again.
    write!(
        writer,
        "    <content>\n      <![CDATA[{}      ]]>\n    </content>\n",
        escape_cdata(&enml)
    )?;
    for resource in &note.resources {
        writer.write_all(b"    <resource>\n      <data encoding=\"base64\">\n")?;
        write_blob_base64(writer, library, &resource.sha256)?;
        writer.write_all(b"      </data>\n")?;
        writeln!(writer, "      <mime>{}</mime>", xml(&resource.mime))?;
        if let Some(width) = resource.width {
            writeln!(writer, "      <width>{width}</width>")?;
        }
        if let Some(height) = resource.height {
            writeln!(writer, "      <height>{height}</height>")?;
        }
        if let Some(duration) = resource.duration {
            writeln!(writer, "      <duration>{duration}</duration>")?;
        }
        if let Some(recognition) = &resource.recognition_xml {
            writeln!(
                writer,
                "      <recognition><![CDATA[{}]]></recognition>",
                escape_cdata(recognition)
            )?;
        }
        write_attributes(
            writer,
            "resource-attributes",
            &resource.attributes,
            "      ",
        )?;
        if let Some(alternate) = &resource.alternate_sha256 {
            writer.write_all(b"      <alternate-data encoding=\"base64\">\n")?;
            write_blob_base64(writer, library, alternate)?;
            writer.write_all(b"      </alternate-data>\n")?;
        }
        writer.write_all(b"    </resource>\n")?;
    }
    if let Some(extra) = note.attributes.get(EXTRA_XML_KEY).and_then(Value::as_array) {
        for element in extra.iter().filter_map(Value::as_str) {
            writeln!(writer, "    {element}")?;
        }
    }
    writer.write_all(b"  </note>\n")?;
    Ok(())
}

/// Letters of attachment data on one line of an export.
const BASE64_LINE: usize = 256;

/// Breaks what is written through it into lines of [`BASE64_LINE`] bytes.
struct Lines<'a, W: Write> {
    writer: &'a mut W,
    /// Bytes on the line being written.
    column: usize,
}

impl<W: Write> Write for Lines<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut rest = bytes;
        while !rest.is_empty() {
            if self.column == BASE64_LINE {
                self.writer.write_all(b"\n")?;
                self.column = 0;
            }
            let take = rest.len().min(BASE64_LINE - self.column);
            self.writer.write_all(&rest[..take])?;
            self.column += take;
            rest = &rest[take..];
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

fn write_blob_base64(writer: &mut impl Write, library: &Library, sha256: &str) -> Result<()> {
    let mut blob = library.open_blob(sha256)?;
    let mut lines = Lines { writer, column: 0 };
    let mut encoder = base64::write::EncoderWriter::new(&mut lines, &BASE64);
    io::copy(&mut blob, &mut encoder)?;
    encoder.finish()?;
    drop(encoder);
    if lines.column > 0 {
        lines.writer.write_all(b"\n")?;
    }
    Ok(())
}

/// Writes `attributes` as the element `container`, each line after `indent`.
/// Nothing is written when there is nothing to say.
fn write_attributes(
    writer: &mut impl Write,
    container: &str,
    attributes: &Value,
    indent: &str,
) -> Result<()> {
    let Some(values) = attributes.as_object() else {
        return Ok(());
    };
    // Each as its opening tag, its text, and its name.
    let mut elements = Vec::new();
    for (key, value) in values {
        if !valid_xml_name(key) {
            continue;
        }
        match value {
            Value::Object(entries) if key == "application-data" => {
                for (name, item) in entries {
                    elements.push((
                        format!("<application-data key=\"{}\">", xml_attribute(name)),
                        xml(&value_text(item)),
                        "application-data",
                    ));
                }
            }
            Value::Array(items) => {
                for item in items {
                    elements.push((format!("<{key}>"), xml(&value_text(item)), key.as_str()));
                }
            }
            _ => elements.push((format!("<{key}>"), xml(&value_text(value)), key.as_str())),
        }
    }
    if elements.is_empty() {
        return Ok(());
    }
    writeln!(writer, "{indent}<{container}>")?;
    for (opening, text, name) in elements {
        if text.len() > OWN_LINE {
            writeln!(
                writer,
                "{indent}  {opening}\n{indent}    {text}\n{indent}  </{name}>"
            )?;
        } else {
            writeln!(writer, "{indent}  {opening}{text}</{name}>")?;
        }
    }
    writeln!(writer, "{indent}</{container}>")?;
    Ok(())
}

/// A value longer than this is written on a line of its own, between its
/// tags. Evernote does so with very long ones: in the exports looked at, a
/// value of 287 letters stood on its tags' line and one of 695 did not.
/// Where between those it draws the line is not known; this is a guess.
const OWN_LINE: usize = 500;

fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn valid_xml_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Escapes element text and removes characters XML 1.0 cannot represent.
/// Quotation marks are written as entities too, which text does not need
/// and Evernote's exports do all the same.
fn xml(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars().filter(|&c| is_xml_char(c)) {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

fn xml_attribute(value: &str) -> String {
    let cleaned: String = value.chars().filter(|&c| is_xml_char(c)).collect();
    html_escape::encode_double_quoted_attribute(&cleaned).into_owned()
}

pub(crate) fn is_xml_char(character: char) -> bool {
    matches!(character, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
}

fn format_enex_date(timestamp: i64) -> String {
    DateTime::from_timestamp_millis(timestamp)
        .unwrap_or_else(Utc::now)
        .format("%Y%m%dT%H%M%SZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0"?><en-export><note><title>A &amp; B</title><created>20240102T030405Z</created><updated>20240103T030405Z</updated><tag>one</tag><note-attributes><author>Me</author><source-url>https://example.com</source-url></note-attributes><content><![CDATA[<?xml version="1.0"?><en-note><div>Hello <en-todo/>world</div></en-note>]]></content><resource><data encoding="base64">aGVsbG8=</data><mime>text/plain</mime><recognition><![CDATA[<recoIndex><item>recognized text</item></recoIndex>]]></recognition><resource-attributes><file-name>hello.txt</file-name></resource-attributes></resource></note></en-export>"#;

    fn read_all(source: &str) -> (Vec<EnexItem>, MemoryBlobs) {
        let mut blobs = MemoryBlobs::default();
        let mut reader = EnexReader::new(Cursor::new(source.to_owned()));
        let mut items = Vec::new();
        while let Some(item) = reader.next_item(&mut blobs, &mut |_| {}).unwrap() {
            items.push(item);
        }
        (items, blobs)
    }

    fn only_note(source: &str) -> (EnexNote, MemoryBlobs) {
        let (mut items, blobs) = read_all(source);
        assert_eq!(items.len(), 1);
        match items.remove(0) {
            EnexItem::Note(note) => (*note, blobs),
            EnexItem::Skipped { reason, .. } => panic!("note was skipped: {reason}"),
        }
    }

    #[test]
    fn parses_notes_metadata_and_resources() {
        let (note, blobs) = only_note(SAMPLE);
        assert_eq!(note.title, "A & B");
        assert_eq!(note.tags, ["one"]);
        assert_eq!(blobs.blobs[&note.resources[0].blob.sha256], b"hello");
        assert_eq!(
            note.resources[0].blob.md5,
            "5d41402abc4b2a76b9719d911017c592"
        );
        assert_eq!(note.attributes["author"], "Me");
    }

    #[test]
    fn values_containing_entities_stay_whole() {
        let (note, _) = only_note(
            r#"<en-export><note><title>R&amp;D &lt;plan&gt; &#169; &#x263A;</title><created>20240102T030405Z</created><tag>Math &amp; Logic</tag><tag>Q&amp;A</tag><note-attributes><source-url>https://example.com/?a=1&amp;b=2&amp;c=3</source-url><author>Tom &amp; Jerry</author></note-attributes><content><![CDATA[<en-note/>]]></content></note></en-export>"#,
        );
        assert_eq!(note.title, "R&D <plan> © ☺");
        assert_eq!(note.tags, ["Math & Logic", "Q&A"]);
        assert_eq!(
            note.attributes["source-url"],
            "https://example.com/?a=1&b=2&c=3"
        );
        assert_eq!(note.attributes["author"], "Tom & Jerry");
    }

    #[test]
    fn nested_elements_do_not_leak_into_note_fields() {
        let (note, _) = only_note(
            r#"<en-export><note><title>Real title</title><created>20240102T030405Z</created><content><![CDATA[<en-note/>]]></content><task><title>Buy milk</title><created>20250101T000000Z</created><taskStatus>open</taskStatus></task><reminder/></note></en-export>"#,
        );
        assert_eq!(note.title, "Real title");
        assert_eq!(
            note.created_at,
            parse_enex_date("20240102T030405Z").unwrap()
        );
        let extra = note.attributes[EXTRA_XML_KEY].as_array().unwrap();
        assert_eq!(extra.len(), 2);
        assert_eq!(
            extra[0],
            "<task><title>Buy milk</title><created>20250101T000000Z</created><taskStatus>open</taskStatus></task>"
        );
        assert_eq!(extra[1], "<reminder/>");
    }

    #[test]
    fn application_data_keeps_its_keys_and_repeated_elements_keep_every_value() {
        let (note, _) = only_note(
            r#"<en-export><note><title>Keys</title><created>20240102T030405Z</created><note-attributes><application-data key="a.b">1</application-data><application-data key="markup">x &amp; y</application-data><classifications>one</classifications><classifications>two</classifications></note-attributes><content><![CDATA[<en-note/>]]></content></note></en-export>"#,
        );
        assert_eq!(note.attributes["application-data"]["a.b"], "1");
        assert_eq!(note.attributes["application-data"]["markup"], "x & y");
        assert_eq!(
            note.attributes["classifications"],
            serde_json::json!(["one", "two"])
        );
    }

    #[test]
    fn attachments_are_decoded_across_line_breaks_and_buffer_boundaries() {
        let payload: Vec<u8> = (0..200_000u32).map(|index| (index % 251) as u8).collect();
        let encoded = BASE64.encode(&payload);
        let wrapped = encoded
            .as_bytes()
            .chunks(76)
            .map(|line| std::str::from_utf8(line).unwrap())
            .collect::<Vec<_>>()
            .join("\r\n");
        let source = format!(
            r#"<en-export><note><title>Big</title><created>20240102T030405Z</created><content><![CDATA[<en-note/>]]></content><resource><data encoding="base64">
{wrapped}
</data><mime>application/octet-stream</mime><alternate-data encoding="base64">YWx0</alternate-data></resource></note></en-export>"#
        );
        // A tiny buffer forces the text to arrive in many pieces.
        let mut blobs = MemoryBlobs::default();
        let mut reader = EnexReader::new(BufReader::with_capacity(7, Cursor::new(source)));
        let Some(EnexItem::Note(note)) = reader.next_item(&mut blobs, &mut |_| {}).unwrap() else {
            panic!("expected a note");
        };
        let resource = &note.resources[0];
        assert_eq!(resource.blob.size, payload.len() as u64);
        assert_eq!(blobs.blobs[&resource.blob.sha256], payload);
        assert_eq!(resource.mime, "application/octet-stream");
        let alternate = resource.alternate.as_ref().unwrap();
        assert_eq!(blobs.blobs[&alternate.sha256], b"alt");
    }

    #[test]
    fn base64_inside_cdata_is_still_decoded() {
        let (note, blobs) = only_note(
            r#"<en-export><note><title>CDATA</title><created>20240102T030405Z</created><content><![CDATA[<en-note/>]]></content><resource><data encoding="base64"><![CDATA[aGVsbG8=]]></data><mime>text/plain</mime></resource></note></en-export>"#,
        );
        assert_eq!(blobs.blobs[&note.resources[0].blob.sha256], b"hello");
    }

    #[test]
    fn a_corrupt_attachment_skips_only_its_note() {
        let (items, _) = read_all(
            r#"<en-export><note><title>Broken</title><created>20240102T030405Z</created><content><![CDATA[<en-note/>]]></content><resource><data encoding="base64">!!!not base64!!!</data><mime>image/png</mime></resource></note><note><title>Fine</title><created>20240102T030405Z</created><content><![CDATA[<en-note>ok</en-note>]]></content></note></en-export>"#,
        );
        assert_eq!(items.len(), 2);
        assert!(matches!(&items[0], EnexItem::Skipped { title, .. } if title == "Broken"));
        assert!(matches!(&items[1], EnexItem::Note(note) if note.title == "Fine"));
    }

    #[test]
    fn truncated_exports_are_reported_instead_of_silently_accepted() {
        let mut blobs = MemoryBlobs::default();
        let mut reader = EnexReader::new(Cursor::new(
            "<en-export><note><title>Cut off</title><content><![CDATA[<en-note>",
        ));
        assert!(reader.next_item(&mut blobs, &mut |_| {}).is_err());
    }

    #[test]
    fn notebook_names_come_from_the_file_name_without_the_note_count() {
        assert_eq!(default_notebook_name("Recipes (171 notes).enex"), "Recipes");
        assert_eq!(default_notebook_name("One (1 note).ENEX"), "One");
        assert_eq!(
            default_notebook_name("Course notes vol..enex"),
            "Course notes vol."
        );
        assert_eq!(default_notebook_name("Plans (2024).enex"), "Plans (2024)");
        assert_eq!(default_notebook_name(".enex"), "Imported notes");
        assert_eq!(default_notebook_name(""), "Imported notes");
    }

    #[test]
    fn imported_note_can_round_trip_without_edits() {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
        let source = directory.path().join("sample.enex");
        std::fs::write(&source, SAMPLE).unwrap();
        let report = import_enex(&library, &source, Some("Test")).unwrap();
        assert_eq!(report.notes_imported, 1);
        let filter = crate::models::NoteFilter::default();
        let summaries = library.list_notes(&filter).unwrap().notes;
        let note = library.get_note(&summaries[0].id).unwrap();
        assert_eq!(note.plain_text, "Hello world");
        assert_eq!(
            note.resources[0].recognition_text.as_deref(),
            Some("recognized text")
        );
        let output = directory.path().join("output.enex");
        export_enex(&library, std::slice::from_ref(&note), &output).unwrap();
        let (exported, blobs) = only_note(&std::fs::read_to_string(output).unwrap());
        assert_eq!(exported.content, note.original_enml.unwrap());
        assert_eq!(blobs.blobs[&exported.resources[0].blob.sha256], b"hello");
    }

    #[test]
    fn export_restores_keys_entities_and_unmodelled_elements() {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
        let source = directory.path().join("lossless.enex");
        std::fs::write(
            &source,
            r#"<en-export><note><title>Lossless &amp; whole</title><created>20240102T030405Z</created><tag>Math &amp; Logic</tag><note-attributes><source-url>https://example.com/?a=1&amp;b=2</source-url><application-data key="evernote.caption">A &lt;caption&gt;</application-data></note-attributes><content><![CDATA[<en-note><div>Body</div></en-note>]]></content><task><title>Buy milk</title></task></note></en-export>"#,
        )
        .unwrap();
        import_enex(&library, &source, None).unwrap();
        let note = library.all_notes().unwrap().remove(0);
        let output = directory.path().join("output.enex");
        export_enex(&library, std::slice::from_ref(&note), &output).unwrap();
        let (exported, _) = only_note(&std::fs::read_to_string(output).unwrap());
        assert_eq!(exported.title, "Lossless & whole");
        assert_eq!(exported.tags, ["Math & Logic"]);
        assert_eq!(exported.attributes, note.attributes);
        assert_eq!(
            exported.attributes["application-data"]["evernote.caption"],
            "A <caption>"
        );
        assert_eq!(
            exported.attributes[EXTRA_XML_KEY],
            serde_json::json!(["<task><title>Buy milk</title></task>"])
        );
    }

    #[test]
    fn cancelling_keeps_the_notes_imported_so_far() {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
        let source = r#"<en-export><note><title>One</title><created>20240102T030405Z</created><content><![CDATA[<en-note>1</en-note>]]></content></note><note><title>Two</title><created>20240102T030405Z</created><content><![CDATA[<en-note>2</en-note>]]></content></note></en-export>"#;
        let cancel = AtomicBool::new(false);
        let report = import_enex_reader(
            &library,
            Cursor::new(source),
            source.len() as u64,
            "Cancelled",
            &cancel,
            |progress| {
                if progress.phase == "noteImported" {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap();
        assert!(report.cancelled);
        assert_eq!(report.notes_imported, 1);
        assert_eq!(library.all_notes().unwrap().len(), 1);
    }
}
