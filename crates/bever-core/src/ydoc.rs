//! Reads a Yjs document from the bytes of its state.
//!
//! Yjs is a library for documents that several people edit at once. The
//! Evernote application keeps the body of every note as such a document, so
//! reading a note from the application's own files means reading this
//! format. Only reading is needed, and only of a whole document (what Yjs
//! calls `encodeStateAsUpdate`, in its first encoding), which keeps this far
//! smaller than the library it follows.
//!
//! A document is a set of *items*, each written by one client at one moment
//! of that client's clock. An item says what it holds (a run of text, an
//! element, a value) and where it belongs: after which item it was inserted
//! and before which, or under which key of a map. Putting the items back in
//! order is Yjs's `integrate`, followed here step by step, because two
//! things depend on the exact order in which items are taken up:
//!
//! - where concurrent insertions at one place end up, and
//! - the order of a map's keys, which is the order in which they were first
//!   set. An element's attributes are such a map, and Evernote writes them
//!   out in that order.
//!
//! Reference: <https://github.com/yjs/yjs> (`src/utils/encoding.js`,
//! `src/structs/Item.js`) and <https://github.com/dmonad/lib0> for the
//! encoding of numbers, strings, and values.

use std::collections::{HashMap, HashSet};

use crate::error::{BeverError, Result};

fn invalid(what: &str) -> BeverError {
    BeverError::Invalid(format!("the document cannot be read: {what}"))
}

/// A value as Yjs stores one. An object keeps the order of its keys.
#[derive(Debug, Clone, PartialEq)]
pub enum Any {
    Undefined,
    Null,
    Int(i64),
    Float(f64),
    Bool(bool),
    String(String),
    Object(Vec<(String, Any)>),
    Array(Vec<Any>),
    Bytes(Vec<u8>),
}

impl Any {
    /// The value under `key` of an object.
    pub fn get(&self, key: &str) -> Option<&Any> {
        match self {
            Any::Object(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Any::String(text) => Some(text),
            _ => None,
        }
    }

    /// The value as JavaScript's `JSON.stringify` writes it, which is how
    /// Evernote writes values into a note.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out, false);
        out
    }

    fn write_json(&self, out: &mut String, in_array: bool) {
        match self {
            // `JSON.stringify` leaves an undefined value out of an object,
            // which the caller sees to, and writes null for one in an array.
            Any::Undefined | Any::Null | Any::Bytes(_) => {
                if in_array || !matches!(self, Any::Undefined) {
                    out.push_str(if matches!(self, Any::Bytes(_)) {
                        "{}"
                    } else {
                        "null"
                    });
                }
            }
            Any::Int(number) => out.push_str(&number.to_string()),
            Any::Float(number) => {
                if !number.is_finite() {
                    out.push_str("null");
                } else if number.fract() == 0.0 && number.abs() < 1e15 {
                    out.push_str(&format!("{number:.0}"));
                } else {
                    out.push_str(&number.to_string());
                }
            }
            Any::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Any::String(text) => write_json_string(out, text),
            Any::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    value.write_json(out, true);
                }
                out.push(']');
            }
            Any::Object(entries) => {
                out.push('{');
                let mut first = true;
                for (key, value) in entries {
                    if matches!(value, Any::Undefined) {
                        continue;
                    }
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    write_json_string(out, key);
                    out.push(':');
                    value.write_json(out, false);
                }
                out.push('}');
            }
        }
    }
}

fn write_json_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// A node of an XML tree in a document.
#[derive(Debug, Clone, PartialEq)]
pub enum XmlNode {
    Element {
        name: String,
        /// In the order they were first set.
        attributes: Vec<(String, String)>,
        children: Vec<XmlNode>,
    },
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Id {
    client: u64,
    clock: u64,
}

#[derive(Debug, Clone)]
enum Parent {
    /// A type at the top of the document, by its name.
    Root(String),
    /// The item that holds the type this one belongs to.
    Item(Id),
}

#[derive(Debug, Clone)]
enum Content {
    /// Nothing is left of it but its place in the clock.
    Gone,
    /// Text, in UTF-16 units as Yjs counts it.
    Text(Vec<u16>),
    /// A type of its own: an element, a text, a map, an array.
    Type(usize),
    /// One or more values.
    Values(Vec<Any>),
    /// Formatting marks, embedded objects, binary data, and sub-documents:
    /// read past, and not used.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Array,
    Map,
    Text,
    XmlElement,
    XmlFragment,
    XmlHook,
    XmlText,
    /// A type at the top of the document: what it is depends on who asks.
    Root,
}

#[derive(Debug)]
struct Branch {
    kind: Kind,
    /// An element's name.
    name: String,
    /// The first of its children.
    start: Option<usize>,
    /// The latest item under each key.
    map: HashMap<String, usize>,
    /// The keys in the order they were first set.
    keys: Vec<String>,
    /// The item that holds it; none for a type at the top.
    item: Option<usize>,
}

#[derive(Debug)]
struct Item {
    id: Id,
    length: u64,
    /// The last id of the item it was inserted after.
    origin: Option<Id>,
    /// The id of the item it was inserted before.
    right_origin: Option<Id>,
    left: Option<usize>,
    right: Option<usize>,
    parent: Option<usize>,
    parent_sub: Option<String>,
    content: Content,
    deleted: bool,
    /// Whether it is only a place in the clock, with no position anywhere.
    gone: bool,
}

/// An item as it is written, before it has a place.
#[derive(Debug)]
struct Written {
    id: Id,
    length: u64,
    skip: bool,
    gone: bool,
    origin: Option<Id>,
    right_origin: Option<Id>,
    parent: Option<Parent>,
    parent_sub: Option<String>,
    content: Content,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8> {
        let byte = *self
            .bytes
            .get(self.at)
            .ok_or_else(|| invalid("it ends too early"))?;
        self.at += 1;
        Ok(byte)
    }

    /// A whole number, seven bits to a byte, lowest first.
    fn uint(&mut self) -> Result<u64> {
        let mut number = 0u64;
        let mut shift = 0;
        loop {
            let byte = self.byte()?;
            if shift >= 64 {
                return Err(invalid("a number is too large"));
            }
            number |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok(number);
            }
            shift += 7;
        }
    }

    /// A whole number with a sign: six bits in the first byte.
    fn int(&mut self) -> Result<i64> {
        let first = self.byte()?;
        let negative = first & 0x40 != 0;
        let mut number = i64::from(first & 0x3f);
        let mut shift = 6;
        let mut byte = first;
        while byte & 0x80 != 0 {
            byte = self.byte()?;
            if shift >= 63 {
                return Err(invalid("a number is too large"));
            }
            number |= i64::from(byte & 0x7f) << shift;
            shift += 7;
        }
        Ok(if negative { -number } else { number })
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| invalid("it ends too early"))?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn string(&mut self) -> Result<String> {
        let length = self.uint()? as usize;
        Ok(String::from_utf8_lossy(self.take(length)?).into_owned())
    }

    fn id(&mut self) -> Result<Id> {
        Ok(Id {
            client: self.uint()?,
            clock: self.uint()?,
        })
    }

    fn any(&mut self, depth: usize) -> Result<Any> {
        if depth > 64 {
            return Err(invalid("a value is nested too deeply"));
        }
        Ok(match self.byte()? {
            127 => Any::Undefined,
            126 => Any::Null,
            125 => Any::Int(self.int()?),
            124 => {
                let bytes: [u8; 4] = self.take(4)?.try_into().expect("four bytes");
                Any::Float(f64::from(f32::from_be_bytes(bytes)))
            }
            123 => {
                let bytes: [u8; 8] = self.take(8)?.try_into().expect("eight bytes");
                Any::Float(f64::from_be_bytes(bytes))
            }
            122 => {
                let bytes: [u8; 8] = self.take(8)?.try_into().expect("eight bytes");
                Any::Int(i64::from_be_bytes(bytes))
            }
            121 => Any::Bool(false),
            120 => Any::Bool(true),
            119 => Any::String(self.string()?),
            118 => {
                let count = self.uint()?;
                let mut entries = Vec::new();
                for _ in 0..count {
                    let key = self.string()?;
                    entries.push((key, self.any(depth + 1)?));
                }
                Any::Object(entries)
            }
            117 => {
                let count = self.uint()?;
                let mut values = Vec::new();
                for _ in 0..count {
                    values.push(self.any(depth + 1)?);
                }
                Any::Array(values)
            }
            116 => {
                let length = self.uint()? as usize;
                Any::Bytes(self.take(length)?.to_vec())
            }
            _ => return Err(invalid("a value of an unknown kind")),
        })
    }
}

/// A Yjs document, read and put in order.
#[derive(Debug, Default)]
pub struct YDoc {
    items: Vec<Item>,
    branches: Vec<Branch>,
    roots: HashMap<String, usize>,
    /// The items of each client, in the order of its clock.
    clients: HashMap<u64, Vec<usize>>,
}

impl YDoc {
    /// Reads a whole document from its state.
    pub fn from_state(bytes: &[u8]) -> Result<Self> {
        let mut reader = Reader { bytes, at: 0 };
        let mut document = Self::default();
        let written = document.read_items(&mut reader)?;
        document.integrate_all(written)?;
        document.read_deletions(&mut reader)?;
        Ok(document)
    }

    fn root(&mut self, name: &str) -> usize {
        if let Some(index) = self.roots.get(name) {
            return *index;
        }
        self.branches.push(Branch {
            kind: Kind::Root,
            name: String::new(),
            start: None,
            map: HashMap::new(),
            keys: Vec::new(),
            item: None,
        });
        let index = self.branches.len() - 1;
        self.roots.insert(name.to_owned(), index);
        index
    }

    fn read_items(&mut self, reader: &mut Reader<'_>) -> Result<HashMap<u64, Vec<Written>>> {
        let mut all: HashMap<u64, Vec<Written>> = HashMap::new();
        let clients = reader.uint()?;
        for _ in 0..clients {
            let count = reader.uint()?;
            let client = reader.uint()?;
            let mut clock = reader.uint()?;
            let list = all.entry(client).or_default();
            for _ in 0..count {
                let info = reader.byte()?;
                let id = Id { client, clock };
                let mut written = Written {
                    id,
                    length: 1,
                    skip: false,
                    gone: false,
                    origin: None,
                    right_origin: None,
                    parent: None,
                    parent_sub: None,
                    content: Content::Other,
                };
                match info & 0x1f {
                    // Garbage collected: only its length is left.
                    0 => {
                        written.length = reader.uint()?;
                        written.gone = true;
                        written.content = Content::Gone;
                    }
                    // A gap that another update fills.
                    10 => {
                        written.length = reader.uint()?;
                        written.skip = true;
                    }
                    kind => {
                        if info & 0x80 != 0 {
                            written.origin = Some(reader.id()?);
                        }
                        if info & 0x40 != 0 {
                            written.right_origin = Some(reader.id()?);
                        }
                        // The parent is written only when no neighbour says it.
                        if info & 0xc0 == 0 {
                            written.parent = Some(if reader.uint()? == 1 {
                                Parent::Root(reader.string()?)
                            } else {
                                Parent::Item(reader.id()?)
                            });
                            if info & 0x20 != 0 {
                                written.parent_sub = Some(reader.string()?);
                            }
                        }
                        written.content = self.read_content(reader, kind, &mut written.length)?;
                    }
                }
                if written.length == 0 {
                    return Err(invalid("an item of no length"));
                }
                clock = clock
                    .checked_add(written.length)
                    .ok_or_else(|| invalid("a clock runs over"))?;
                list.push(written);
            }
        }
        Ok(all)
    }

    fn read_content(
        &mut self,
        reader: &mut Reader<'_>,
        kind: u8,
        length: &mut u64,
    ) -> Result<Content> {
        Ok(match kind {
            // Deleted content: its length.
            1 => {
                *length = reader.uint()?;
                Content::Other
            }
            // Values written as JSON text, as old versions of Yjs did.
            2 => {
                let count = reader.uint()?;
                let mut values = Vec::new();
                for _ in 0..count {
                    let text = reader.string()?;
                    values.push(match serde_json::from_str::<serde_json::Value>(&text) {
                        Ok(value) => any_from_json(&value),
                        Err(_) => Any::Undefined,
                    });
                }
                *length = count;
                Content::Values(values)
            }
            3 => {
                let size = reader.uint()? as usize;
                reader.take(size)?;
                Content::Other
            }
            4 => {
                let units: Vec<u16> = reader.string()?.encode_utf16().collect();
                *length = units.len() as u64;
                Content::Text(units)
            }
            // An embedded object, as JSON text.
            5 => {
                reader.string()?;
                Content::Other
            }
            // A formatting mark: its name, and its value as JSON text.
            6 => {
                reader.string()?;
                reader.string()?;
                Content::Other
            }
            7 => {
                let (kind, name) = match reader.uint()? {
                    0 => (Kind::Array, String::new()),
                    1 => (Kind::Map, String::new()),
                    2 => (Kind::Text, String::new()),
                    3 => (Kind::XmlElement, reader.string()?),
                    4 => (Kind::XmlFragment, String::new()),
                    5 => (Kind::XmlHook, reader.string()?),
                    6 => (Kind::XmlText, String::new()),
                    _ => return Err(invalid("a type of an unknown kind")),
                };
                self.branches.push(Branch {
                    kind,
                    name,
                    start: None,
                    map: HashMap::new(),
                    keys: Vec::new(),
                    item: None,
                });
                Content::Type(self.branches.len() - 1)
            }
            8 => {
                let count = reader.uint()?;
                let mut values = Vec::new();
                for _ in 0..count {
                    values.push(reader.any(0)?);
                }
                *length = count;
                Content::Values(values)
            }
            // A sub-document: its name and its options.
            9 => {
                reader.string()?;
                reader.any(0)?;
                Content::Other
            }
            _ => return Err(invalid("content of an unknown kind")),
        })
    }

    /// The next clock of `client`: one past everything taken up from it.
    fn state(&self, client: u64) -> u64 {
        self.clients
            .get(&client)
            .and_then(|list| list.last())
            .map_or(0, |index| {
                self.items[*index].id.clock + self.items[*index].length
            })
    }

    /// Which other client's items `written` waits for, if any.
    fn missing(&self, written: &Written) -> Option<u64> {
        if written.gone {
            return None;
        }
        let waits = |id: &Id| id.client != written.id.client && id.clock >= self.state(id.client);
        if let Some(origin) = &written.origin {
            if waits(origin) {
                return Some(origin.client);
            }
        }
        if let Some(right) = &written.right_origin {
            if waits(right) {
                return Some(right.client);
            }
        }
        if let Some(Parent::Item(parent)) = &written.parent {
            if waits(parent) {
                return Some(parent.client);
            }
        }
        None
    }

    /// Takes up every item, in the order Yjs does: the client with the
    /// highest number first, each in the order of its clock, and whenever an
    /// item waits for another client's, that client's next item before it.
    fn integrate_all(&mut self, written: HashMap<u64, Vec<Written>>) -> Result<()> {
        let mut queues: HashMap<u64, std::collections::VecDeque<Written>> = written
            .into_iter()
            .map(|(client, list)| (client, list.into()))
            .collect();
        let mut order: Vec<u64> = queues.keys().copied().collect();
        order.sort_unstable();
        let next_target =
            |order: &mut Vec<u64>, queues: &HashMap<u64, std::collections::VecDeque<Written>>| {
                while let Some(client) = order.last() {
                    if queues.get(client).is_some_and(|queue| !queue.is_empty()) {
                        return Some(*client);
                    }
                    order.pop();
                }
                None
            };
        let mut stack: Vec<Written> = Vec::new();
        let Some(mut target) = next_target(&mut order, &queues) else {
            return Ok(());
        };
        let mut head = queues
            .get_mut(&target)
            .and_then(|queue| queue.pop_front())
            .expect("a target has items");
        loop {
            if !head.skip {
                let known = self.state(head.id.client);
                if known < head.id.clock {
                    return Err(invalid("items of one client are missing"));
                }
                if let Some(client) = self.missing(&head) {
                    let waiting = queues.get_mut(&client).and_then(|queue| queue.pop_front());
                    let Some(next) = waiting else {
                        return Err(invalid("it refers to items that are not in it"));
                    };
                    stack.push(head);
                    head = next;
                    continue;
                }
                if known == head.id.clock {
                    self.integrate(head);
                }
            }
            if let Some(waiting) = stack.pop() {
                head = waiting;
            } else if let Some(next) = queues.get_mut(&target).and_then(|queue| queue.pop_front()) {
                head = next;
            } else {
                match next_target(&mut order, &queues) {
                    Some(client) => {
                        target = client;
                        head = queues
                            .get_mut(&target)
                            .and_then(|queue| queue.pop_front())
                            .expect("a target has items");
                    }
                    None => return Ok(()),
                }
            }
        }
    }

    /// The place of the item that holds `id`, among its client's items.
    fn position(&self, id: Id) -> Option<usize> {
        let list = self.clients.get(&id.client)?;
        let at = list.partition_point(|index| self.items[*index].id.clock <= id.clock);
        if at == 0 {
            return None;
        }
        let item = &self.items[list[at - 1]];
        (id.clock < item.id.clock + item.length).then_some(at - 1)
    }

    fn find(&self, id: Id) -> Option<usize> {
        let at = self.position(id)?;
        Some(self.clients[&id.client][at])
    }

    /// Cuts `index` in two after `count` units and returns the second part.
    fn split(&mut self, index: usize, count: u64) -> usize {
        let item = &mut self.items[index];
        let rest = match &mut item.content {
            Content::Text(units) => Content::Text(units.split_off(count as usize)),
            Content::Values(values) => Content::Values(values.split_off(count as usize)),
            Content::Gone => Content::Gone,
            Content::Other => Content::Other,
            // A type is one unit long and is never cut.
            Content::Type(branch) => Content::Type(*branch),
        };
        let second = Item {
            id: Id {
                client: item.id.client,
                clock: item.id.clock + count,
            },
            length: item.length - count,
            origin: Some(Id {
                client: item.id.client,
                clock: item.id.clock + count - 1,
            }),
            right_origin: item.right_origin,
            left: Some(index),
            right: item.right,
            parent: item.parent,
            parent_sub: item.parent_sub.clone(),
            content: rest,
            deleted: item.deleted,
            gone: item.gone,
        };
        item.length = count;
        let (client, right, parent, key) = (
            second.id.client,
            second.right,
            second.parent,
            second.parent_sub.clone(),
        );
        self.items.push(second);
        let new = self.items.len() - 1;
        self.items[index].right = Some(new);
        match right {
            Some(right) => self.items[right].left = Some(new),
            None => {
                if let (Some(parent), Some(key)) = (parent, key) {
                    self.branches[parent].map.insert(key, new);
                }
            }
        }
        let list = self.clients.get_mut(&client).expect("a client with items");
        let at = list
            .iter()
            .position(|other| *other == index)
            .expect("the item is its client's");
        list.insert(at + 1, new);
        new
    }

    /// The item that begins at `id`, cut free of what came before it.
    fn clean_start(&mut self, id: Id) -> Option<usize> {
        let index = self.find(id)?;
        let item = &self.items[index];
        if item.id.clock < id.clock && !item.gone {
            let count = id.clock - item.id.clock;
            return Some(self.split(index, count));
        }
        Some(index)
    }

    /// The item that ends at `id`, cut free of what comes after it.
    fn clean_end(&mut self, id: Id) -> Option<usize> {
        let index = self.find(id)?;
        let item = &self.items[index];
        if id.clock != item.id.clock + item.length - 1 && !item.gone {
            let count = id.clock - item.id.clock + 1;
            self.split(index, count);
        }
        Some(index)
    }

    fn add(&mut self, item: Item) -> usize {
        let client = item.id.client;
        self.items.push(item);
        let index = self.items.len() - 1;
        self.clients.entry(client).or_default().push(index);
        index
    }

    fn delete(&mut self, index: usize) {
        self.items[index].deleted = true;
    }

    /// Gives one item its place: Yjs's `Item.integrate`.
    fn integrate(&mut self, written: Written) {
        let placeless = |written: &Written| Item {
            id: written.id,
            length: written.length,
            origin: None,
            right_origin: None,
            left: None,
            right: None,
            parent: None,
            parent_sub: None,
            content: Content::Gone,
            deleted: true,
            gone: true,
        };
        if written.gone {
            self.add(placeless(&written));
            return;
        }
        let mut left = written.origin.and_then(|id| self.clean_end(id));
        let right = written.right_origin.and_then(|id| self.clean_start(id));
        let lost = (written.origin.is_some() && left.is_none())
            || (written.right_origin.is_some() && right.is_none());
        let beside_nothing = left.is_some_and(|index| self.items[index].gone)
            || right.is_some_and(|index| self.items[index].gone);
        let mut parent_sub = written.parent_sub.clone();
        let parent = if lost || beside_nothing {
            None
        } else {
            match &written.parent {
                Some(Parent::Root(name)) => Some(self.root(name)),
                Some(Parent::Item(id)) => {
                    self.find(*id)
                        .and_then(|index| match self.items[index].content {
                            Content::Type(branch) if !self.items[index].gone => Some(branch),
                            _ => None,
                        })
                }
                // Its neighbours say where it belongs.
                None => {
                    let mut parent = None;
                    for neighbour in [left, right].into_iter().flatten() {
                        parent = self.items[neighbour].parent;
                        parent_sub = self.items[neighbour].parent_sub.clone();
                    }
                    parent
                }
            }
        };
        let Some(parent) = parent else {
            self.add(placeless(&written));
            return;
        };
        let origin = left.map(|index| {
            let item = &self.items[index];
            Id {
                client: item.id.client,
                clock: item.id.clock + item.length - 1,
            }
        });
        let right_origin = right.map(|index| self.items[index].id);

        // Where others were inserted at the same place, the order is settled
        // by who was there first and, failing that, by the client's number.
        let contested = match left {
            None => right.is_none_or(|index| self.items[index].left.is_some()),
            Some(index) => self.items[index].right != right,
        };
        if contested {
            let mut other = match left {
                Some(index) => self.items[index].right,
                None => match &parent_sub {
                    Some(key) => {
                        let mut first = self.branches[parent].map.get(key).copied();
                        while let Some(before) = first.and_then(|index| self.items[index].left) {
                            first = Some(before);
                        }
                        first
                    }
                    None => self.branches[parent].start,
                },
            };
            let mut conflicting: HashSet<usize> = HashSet::new();
            let mut before_origin: HashSet<usize> = HashSet::new();
            while let Some(index) = other {
                if Some(index) == right {
                    break;
                }
                before_origin.insert(index);
                conflicting.insert(index);
                let item = &self.items[index];
                if origin == item.origin {
                    if item.id.client < written.id.client {
                        left = Some(index);
                        conflicting.clear();
                    } else if right_origin == item.right_origin {
                        break;
                    }
                } else {
                    match item.origin.and_then(|id| self.find(id)) {
                        Some(theirs) if before_origin.contains(&theirs) => {
                            if !conflicting.contains(&theirs) {
                                left = Some(index);
                                conflicting.clear();
                            }
                        }
                        _ => break,
                    }
                }
                other = self.items[index].right;
            }
        }

        let index = self.add(Item {
            id: written.id,
            length: written.length,
            origin,
            right_origin,
            left,
            right: None,
            parent: Some(parent),
            parent_sub: parent_sub.clone(),
            content: written.content,
            deleted: false,
            gone: false,
        });
        let after = match left {
            Some(before) => {
                let after = self.items[before].right;
                self.items[before].right = Some(index);
                after
            }
            None => match &parent_sub {
                Some(key) => {
                    let mut first = self.branches[parent].map.get(key).copied();
                    while let Some(before) = first.and_then(|other| self.items[other].left) {
                        first = Some(before);
                    }
                    first
                }
                None => {
                    let first = self.branches[parent].start;
                    self.branches[parent].start = Some(index);
                    first
                }
            },
        };
        self.items[index].right = after;
        match after {
            Some(after) => self.items[after].left = Some(index),
            None => {
                if let Some(key) = &parent_sub {
                    // The newest value of a key; the one before it is no more.
                    let branch = &mut self.branches[parent];
                    if branch.map.insert(key.clone(), index).is_none() {
                        branch.keys.push(key.clone());
                    }
                    if let Some(before) = left {
                        self.delete(before);
                    }
                }
            }
        }
        if let Content::Type(branch) = self.items[index].content {
            self.branches[branch].item = Some(index);
        }
        let parent_deleted = self.branches[parent]
            .item
            .is_some_and(|holder| self.items[holder].deleted);
        if parent_deleted || (parent_sub.is_some() && after.is_some()) {
            self.delete(index);
        }
    }

    /// What was deleted: for each client, ranges of its clock.
    fn read_deletions(&mut self, reader: &mut Reader<'_>) -> Result<()> {
        let clients = reader.uint()?;
        for _ in 0..clients {
            let client = reader.uint()?;
            let ranges = reader.uint()?;
            for _ in 0..ranges {
                let clock = reader.uint()?;
                let end = clock.saturating_add(reader.uint()?);
                if clock >= self.state(client) {
                    continue;
                }
                let Some(mut at) = self.position(Id { client, clock }) else {
                    continue;
                };
                let first = self.clients[&client][at];
                if !self.items[first].deleted && self.items[first].id.clock < clock {
                    let count = clock - self.items[first].id.clock;
                    self.split(first, count);
                    at += 1;
                }
                while let Some(index) = self.clients[&client].get(at).copied() {
                    at += 1;
                    if self.items[index].id.clock >= end {
                        break;
                    }
                    if !self.items[index].deleted {
                        if end < self.items[index].id.clock + self.items[index].length {
                            let count = end - self.items[index].id.clock;
                            self.split(index, count);
                        }
                        self.delete(index);
                    }
                }
            }
        }
        Ok(())
    }

    /// The children of a type, left to right, without what was deleted.
    fn children(&self, branch: usize) -> impl Iterator<Item = &Item> {
        let mut next = self.branches[branch].start;
        std::iter::from_fn(move || {
            while let Some(index) = next {
                let item = &self.items[index];
                next = item.right;
                if !item.deleted {
                    return Some(item);
                }
            }
            None
        })
    }

    /// The value under each key of a type, in the order the keys were set.
    fn entries(&self, branch: usize) -> Vec<(&str, &Item)> {
        self.branches[branch]
            .keys
            .iter()
            .filter_map(|key| {
                let item = &self.items[*self.branches[branch].map.get(key)?];
                (!item.deleted).then_some((key.as_str(), item))
            })
            .collect()
    }

    fn units(&self, branch: usize, out: &mut Vec<u16>) {
        for item in self.children(branch) {
            if let Content::Text(units) = &item.content {
                out.extend_from_slice(units);
            }
        }
    }

    fn nodes(&self, branch: usize, depth: usize) -> Vec<XmlNode> {
        let mut nodes = Vec::new();
        // Text is gathered across items: a character outside the basic plane
        // is two units, and they may lie in two items.
        let mut pending: Vec<u16> = Vec::new();
        let flush = |pending: &mut Vec<u16>, nodes: &mut Vec<XmlNode>| {
            if !pending.is_empty() {
                nodes.push(XmlNode::Text(String::from_utf16_lossy(pending)));
                pending.clear();
            }
        };
        if depth > 512 {
            return nodes;
        }
        for item in self.children(branch) {
            match &item.content {
                Content::Text(units) => pending.extend_from_slice(units),
                Content::Type(child) => match self.branches[*child].kind {
                    Kind::XmlText | Kind::Text => self.units(*child, &mut pending),
                    Kind::XmlElement => {
                        flush(&mut pending, &mut nodes);
                        nodes.push(XmlNode::Element {
                            name: self.branches[*child].name.clone(),
                            attributes: self.attributes(*child),
                            children: self.nodes(*child, depth + 1),
                        });
                    }
                    Kind::XmlFragment => {
                        flush(&mut pending, &mut nodes);
                        nodes.extend(self.nodes(*child, depth + 1));
                    }
                    Kind::Array | Kind::Map | Kind::XmlHook | Kind::Root => {}
                },
                Content::Values(_) | Content::Gone | Content::Other => {}
            }
        }
        flush(&mut pending, &mut nodes);
        nodes
    }

    fn attributes(&self, branch: usize) -> Vec<(String, String)> {
        self.entries(branch)
            .into_iter()
            .filter_map(|(key, item)| {
                let value = match &item.content {
                    Content::Values(values) => match values.last()? {
                        Any::String(text) => text.clone(),
                        Any::Int(number) => number.to_string(),
                        Any::Float(_) | Any::Bool(_) => values.last()?.to_json(),
                        Any::Null => "null".to_owned(),
                        Any::Undefined => "undefined".to_owned(),
                        Any::Object(_) | Any::Array(_) | Any::Bytes(_) => return None,
                    },
                    _ => return None,
                };
                Some((key.to_owned(), value))
            })
            .collect()
    }

    fn value(&self, item: &Item, depth: usize) -> Any {
        match &item.content {
            Content::Values(values) => values.last().cloned().unwrap_or(Any::Undefined),
            Content::Type(branch) if depth < 64 => match self.branches[*branch].kind {
                Kind::Map => self.object(*branch, depth + 1),
                Kind::Array => Any::Array(self.list(*branch, depth + 1)),
                Kind::Text | Kind::XmlText => {
                    let mut units = Vec::new();
                    self.units(*branch, &mut units);
                    Any::String(String::from_utf16_lossy(&units))
                }
                _ => Any::Undefined,
            },
            _ => Any::Undefined,
        }
    }

    fn object(&self, branch: usize, depth: usize) -> Any {
        Any::Object(
            self.entries(branch)
                .into_iter()
                .map(|(key, item)| (key.to_owned(), self.value(item, depth)))
                .collect(),
        )
    }

    fn list(&self, branch: usize, depth: usize) -> Vec<Any> {
        let mut values = Vec::new();
        for item in self.children(branch) {
            match &item.content {
                Content::Values(inner) => values.extend(inner.iter().cloned()),
                Content::Type(_) => values.push(self.value(item, depth)),
                _ => {}
            }
        }
        values
    }

    /// The XML tree kept under `name` at the top of the document.
    pub fn xml(&self, name: &str) -> Vec<XmlNode> {
        self.roots
            .get(name)
            .map(|branch| self.nodes(*branch, 0))
            .unwrap_or_default()
    }

    /// The text kept under `name` at the top of the document.
    pub fn text(&self, name: &str) -> String {
        let mut units = Vec::new();
        if let Some(branch) = self.roots.get(name) {
            self.units(*branch, &mut units);
        }
        String::from_utf16_lossy(&units)
    }

    /// The map kept under `name` at the top of the document, as an object.
    pub fn map(&self, name: &str) -> Any {
        self.roots
            .get(name)
            .map_or_else(|| Any::Object(Vec::new()), |branch| self.object(*branch, 0))
    }
}

fn any_from_json(value: &serde_json::Value) -> Any {
    match value {
        serde_json::Value::Null => Any::Null,
        serde_json::Value::Bool(flag) => Any::Bool(*flag),
        serde_json::Value::Number(number) => number
            .as_i64()
            .map(Any::Int)
            .or_else(|| number.as_f64().map(Any::Float))
            .unwrap_or(Any::Null),
        serde_json::Value::String(text) => Any::String(text.clone()),
        serde_json::Value::Array(values) => Any::Array(values.iter().map(any_from_json).collect()),
        serde_json::Value::Object(entries) => Any::Object(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), any_from_json(value)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    //! The documents here were made with the Yjs library itself
    //! (`Y.encodeStateAsUpdate`), and what is expected of each is what the
    //! library reads from it.
    use base64::{engine::general_purpose::STANDARD, Engine};

    use super::*;
    use crate::evernote_local::markup;

    fn read(state: &str) -> YDoc {
        YDoc::from_state(&STANDARD.decode(state).unwrap()).unwrap()
    }

    #[test]
    fn reads_elements_attributes_and_text_of_one_writer() {
        let document = read("AQ0KAAcBB2NvbnRlbnQDB2VuLW5vdGUHAAoAAwNkaXYHAAoBBgQACgImSGVsbG8gJiA8d2VsY29tZT4g4oCUIMO8bsOvY8O2ZMOpIPCfmYIoAAoBBXN0eWxlAXcLY29sb3I6IHJlZDsoAAoBBXRpdGxlAXcZYSAicXVvdGVkIiA8dGl0bGU+ICYgbW9yZYcKAQMIZW4tbWVkaWEoAAojBXN0eWxlAXcNaGVpZ2h0OiBhdXRvOygACiMEaGFzaAF3A2FiYygACiMEdHlwZQF3CWltYWdlL3BuZ4cKIwMDZGl2BwAKJwMCYnIEAQV0aXRsZQdBIHRpdGxlAA==");
        assert_eq!(
            markup(&document.xml("content")),
            "<en-note><div style=\"color: red;\" title=\"a &quot;quoted&quot; &lt;title&gt; &amp; more\">Hello &amp; &lt;welcome> — ünïcödé 🙂</div><en-media style=\"height: auto;\" hash=\"abc\" type=\"image/png\" /><div><br/></div></en-note>"
        );
        assert_eq!(document.text("title"), "A title");
        assert_eq!(document.text("no such text"), "");
        assert!(document.xml("no such tree").is_empty());
    }

    #[test]
    fn orders_what_several_writers_typed_at_one_place_as_yjs_does() {
        // Three writers insert at the same place at once; then one types
        // into the middle of another's text, and one deletes.
        let document = read("AwEJAIQFCARCQkJCBgUABwEHY29udGVudAMHZW4tbm90ZQcABQADA2RpdgcABQEGAQAFAgOEBQUDcnQghAUIBEFBQUEDAgCEBQgCQ0OEAgECQ0PEAgECAgVbbWlkXQEFAQMD");
        assert_eq!(
            markup(&document.xml("content")),
            "<en-note><div>rt CC[mid]CCAAAABBBB</div></en-note>"
        );
    }

    #[test]
    fn keeps_attributes_in_the_order_yjs_first_sees_them() {
        // The writer with the higher number is read first, so the attribute
        // it added later comes before those the element was made with; one
        // it overwrote keeps the newer value, and one it removed is gone.
        let document = read("AgK8BQAoAAMBBXdpZHRoAXcFMjUwcHioAwIBdwFiDAMABwEHY29udGVudAMHZW4tbm90ZQcAAwADCGVuLW1lZGlhIQADAQVzdHlsZQEhAAMBBGhhc2gBKAADAQR0eXBlAXcJaW1hZ2UvcG5nIQADAQNhbHQBhwMBAwNkaXYoAAMGAXoBdwExKAADBgFhAXcBMigAAwYBbQF3ATMoAAMABGxhbmcBdwJlbqgDAwF3AmgyAQMCAgIFAQ==");
        assert_eq!(
            markup(&document.xml("content")),
            "<en-note lang=\"en\"><en-media width=\"250px\" style=\"b\" hash=\"h2\" type=\"image/png\" /><div z=\"1\" a=\"2\" m=\"3\"></div></en-note>"
        );
    }

    #[test]
    fn leaves_out_what_was_deleted() {
        // An element with its children, the middle of a text, and text that
        // one writer typed into an element another had deleted.
        let document = read("AgEpAAAFCygABwEHY29udGVudAMHZW4tbm90ZQcAKAADA2RpdgcAKAEGBAAoAglrZWVwIHRoaXOBKAEBABKHKAwDA2RpdgcAKB8GBAAoIAIwMYEoIgWEKCcDNzg5AikBAAUoAgwTIwU=");
        assert_eq!(
            markup(&document.xml("content")),
            "<en-note><div>keep this</div><div>01789</div></en-note>"
        );
    }

    #[test]
    fn reads_maps_with_their_keys_in_order() {
        let document = read("AQtNACgBEGN1c3RvbU5vdGVTdHlsZXMNaGVhZGluZ1N0eWxlcwF2Awdpc0VtcHR5eQJoMXYCCGZvbnRTaXpldwQzMHB4BWNvbG9ydwdpbmhlcml0AmgydgEIZm9udFNpemV3BDI0cHgoAQRtZXRhDXNjaGVtYVZlcnNpb24BfQEoAQRtZXRhCXJlc291cmNlcwF1AncBYncBYScBBG1ldGEGbmVzdGVkASEATQMEemV0YQEoAE0DBWFscGhhAXioTQQBfQIoAE0DB25vdGhpbmcBficBBG1ldGEEbGlzdAAIAE0IA3cBeH0HdgEBa3cBdgcBB2NvbnRlbnQDB2VuLW5vdGUBTQEEAQ==");
        let styles = document.map("customNoteStyles");
        assert_eq!(
            styles.to_json(),
            r#"{"headingStyles":{"isEmpty":false,"h1":{"fontSize":"30px","color":"inherit"},"h2":{"fontSize":"24px"}}}"#
        );
        assert_eq!(
            styles
                .get("headingStyles")
                .and_then(|headings| headings.get("isEmpty")),
            Some(&Any::Bool(false))
        );
        // A nested map, an overwritten key, a null, and an array.
        assert_eq!(
            document.map("meta").to_json(),
            r#"{"schemaVersion":1,"resources":["b","a"],"nested":{"zeta":2,"alpha":true,"nothing":null},"list":["x",7,{"k":"v"}]}"#
        );
        assert_eq!(document.map("no such map").to_json(), "{}");
    }

    #[test]
    fn joins_text_typed_a_character_at_a_time_by_two_writers() {
        // Among the characters is one that is two units of UTF-16.
        let document = read("AgfoBwAHAQdjb250ZW50Awdlbi1ub3RlBwDoBwADA2RpdgcA6AcBBgQA6AcCAVSEAQABcoQBAQFzhAECBPCfmYIEAQCE6AcDAXWE6AcEAW6E6AcFASCE6AcHASEA");
        assert_eq!(
            markup(&document.xml("content")),
            "<en-note><div>Turns 🙂!</div></en-note>"
        );
    }

    #[test]
    fn refuses_what_is_not_a_document() {
        assert!(YDoc::from_state(&[]).is_err());
        assert!(YDoc::from_state(&[1, 200]).is_err());
        assert!(YDoc::from_state(b"not a document at all").is_err());
        // A document cut short.
        let whole = STANDARD
            .decode("AgEpAAAFCygABwEHY29udGVudAMHZW4tbm90ZQcAKAADA2RpdgcAKAEGBAAoAglrZWVwIHRoaXOBKAEBABKHKAwDA2RpdgcAKB8GBAAoIAIwMYEoIgWEKCcDNzg5AikBAAUoAgwTIwU=")
            .unwrap();
        assert!(YDoc::from_state(&whole[..whole.len() / 2]).is_err());
        // An empty document is one.
        assert!(YDoc::from_state(&[0, 0]).unwrap().xml("content").is_empty());
    }

    #[test]
    fn writes_values_as_javascript_does() {
        let value = Any::Object(vec![
            ("text".into(), Any::String("a \"b\" \\ \n \u{1} é".into())),
            ("whole".into(), Any::Float(30.0)),
            ("part".into(), Any::Float(1.5)),
            ("left out".into(), Any::Undefined),
            (
                "list".into(),
                Any::Array(vec![Any::Undefined, Any::Null, Any::Int(-4)]),
            ),
        ]);
        assert_eq!(
            value.to_json(),
            r#"{"text":"a \"b\" \\ \n \u0001 é","whole":30,"part":1.5,"list":[null,null,-4]}"#
        );
    }
}
