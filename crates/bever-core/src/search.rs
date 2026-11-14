//! Offline search: Evernote-style query operators compiled to parameterized
//! SQL over the notes table and its FTS5 index.
use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Duration, Local, Months, NaiveDate, NaiveDateTime, TimeZone};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};

use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{NoteFilter, NotePage, NoteSort, NoteSummary, THUMBNAIL_KEY},
    natural,
};

/// Marks the start and end of a matched term inside a snippet. Private-use
/// characters cannot be confused with note text or with markup, so the
/// interface can highlight matches without ever treating a snippet as HTML.
pub const SNIPPET_MATCH_START: char = '\u{E000}';
pub const SNIPPET_MATCH_END: char = '\u{E001}';

const FTS_SUBQUERY: &str = "n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?)";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Term {
    label: Option<String>,
    value: String,
    negated: bool,
    quoted: bool,
    /// Words to look for in place of `value`, which no note has: the
    /// words of the library that are spelt nearly so.
    alternatives: Vec<String>,
}

impl Term {
    /// The term as it is looked for: its first other spelling, if it has any.
    fn understood(&self) -> &str {
        self.alternatives
            .first()
            .map_or(self.value.as_str(), String::as_str)
    }
}

#[derive(Debug, Default)]
struct Compiled {
    predicates: Vec<String>,
    parameters: Vec<SqlValue>,
    /// Full-text expression every result matches. When present the query is
    /// driven by the FTS index, which is what makes `bm25()` and `snippet()`
    /// meaningful; they return constants for a row reached any other way.
    fts: Option<String>,
    /// The words typed, for ordering what was found by how well it answers
    /// them. Only a search for all of some plain words has this.
    ranking: Option<Ranking>,
    /// The plain words searched for, to mark them in what is shown.
    words: Vec<SearchWord>,
}

/// The plain words of a search, in the forms ordering by relevance asks the
/// index about.
#[derive(Debug)]
struct Ranking {
    /// The words as they were typed, to compare with a title.
    text: String,
    /// Every word, whole, as a question for the index.
    whole: String,
    /// The words standing together in their order, when there are several.
    phrase: Option<String>,
    /// The words one by one, in the order typed.
    words: Vec<SearchWord>,
}

impl Compiled {
    fn push(&mut self, sql: String, parameters: impl IntoIterator<Item = SqlValue>) {
        self.predicates.push(format!("({sql})"));
        self.parameters.extend(parameters);
    }
}

pub(crate) fn search_notes(library: &Library, filter: &NoteFilter) -> Result<NotePage> {
    let terms = tokenize(&filter.query);
    let page = search_terms(library, filter, &terms)?;
    if page.total > 0 {
        return Ok(page);
    }
    // Nothing answers the search as typed. A word that no note has may be
    // misspelt: the search is made again with the words of the library that
    // are spelt nearly so. A search that finds something never comes here,
    // and costs what it did before.
    let Some(respelt) = respelled(library, &terms)? else {
        return Ok(page);
    };
    let mut other = search_terms(library, filter, &respelt)?;
    if other.total == 0 {
        return Ok(page);
    }
    other.corrected = Some(
        respelt
            .iter()
            .map(Term::written)
            .collect::<Vec<_>>()
            .join(" "),
    );
    Ok(other)
}

/// Fewest letters of a word for which other spellings are looked for; a
/// shorter one is too little to tell a slip from another word.
const RESPELL_FROM: usize = 4;
/// From this many letters, two slips are allowed instead of one.
const RESPELL_TWICE_FROM: usize = 8;
/// Most other spellings looked for in place of one word.
const RESPELLINGS: usize = 3;

/// `terms` with each plain word that no note has given the words of the
/// library spelt nearly so, or `None` when there is no such word.
///
/// A word counts as known when some word of the library begins with it,
/// which is how the search itself takes an unquoted word. Other spellings
/// are looked for among the words that begin with the same letter: that is
/// where slips of the hand rarely fall, and it keeps the looking short.
fn respelled(library: &Library, terms: &[Term]) -> Result<Option<Vec<Term>>> {
    let connection = library.connection.lock();
    let mut respelt = terms.to_vec();
    let mut changed = false;
    for term in &mut respelt {
        if term.label.is_some() || term.negated || term.quoted {
            continue;
        }
        let value = term.value.trim_end_matches('*').to_lowercase();
        let mut words = words_of(&value);
        let (Some((start, end)), None) = (words.next(), words.next()) else {
            continue;
        };
        let word = value[start..end].chars().collect::<Vec<_>>();
        if word.len() < RESPELL_FROM {
            continue;
        }
        let most = if word.len() >= RESPELL_TWICE_FROM {
            2
        } else {
            1
        };
        let typed = word.iter().collect::<String>();
        let after = |text: &str| format!("{text}\u{10FFFF}");
        let known = connection
            .prepare_cached("SELECT 1 FROM notes_fts_terms WHERE term >= ?1 AND term < ?2 LIMIT 1")?
            .exists([&typed, &after(&typed)])?;
        if known {
            continue;
        }
        // (slips, whether only its beginning is like the word, notes, word)
        let mut near: Vec<(usize, bool, u64, String)> = Vec::new();
        let first = word[0].to_string();
        let mut statement = connection.prepare_cached(
            "SELECT term, doc FROM notes_fts_terms WHERE term >= ?1 AND term < ?2",
        )?;
        let mut rows = statement.query([&first, &after(&first)])?;
        while let Some(row) = rows.next()? {
            let candidate: String = row.get(0)?;
            let letters = candidate.chars().collect::<Vec<_>>();
            if letters.len() + most < word.len() {
                continue;
            }
            // As a whole word, or as the beginning of a longer one, which
            // is what a word still being typed is.
            let whole = slips(&word, &letters, most);
            let beginning = (letters.len() > word.len())
                .then(|| slips(&word, &letters[..word.len()], most))
                .flatten();
            let found = match (whole, beginning) {
                (Some(whole), _) => Some((whole, false)),
                (None, Some(beginning)) => Some((beginning, true)),
                (None, None) => None,
            };
            if let Some((count, partly)) = found {
                near.push((count, partly, row.get(1)?, candidate));
            }
        }
        // The nearest first: fewest slips, whole words before beginnings,
        // and of those the word most notes have.
        near.sort_by(|a, b| {
            (a.0, a.1)
                .cmp(&(b.0, b.1))
                .then(b.2.cmp(&a.2))
                .then_with(|| a.3.cmp(&b.3))
        });
        near.truncate(RESPELLINGS);
        if !near.is_empty() {
            term.alternatives = near.into_iter().map(|(_, _, _, word)| word).collect();
            changed = true;
        }
    }
    Ok(changed.then_some(respelt))
}

/// How many slips of the hand turn `typed` into `word`: a letter too many,
/// too few, or another, or two letters in each other's place. `None` when
/// more than `most`.
fn slips(typed: &[char], word: &[char], most: usize) -> Option<usize> {
    if typed.len().abs_diff(word.len()) > most {
        return None;
    }
    let mut before: Vec<usize> = Vec::new();
    let mut previous: Vec<usize> = (0..=word.len()).collect();
    for (row, letter) in typed.iter().enumerate() {
        let mut current = vec![row + 1];
        for (column, other) in word.iter().enumerate() {
            let mut count = (previous[column] + usize::from(letter != other))
                .min(previous[column + 1] + 1)
                .min(current[column] + 1);
            if row > 0 && column > 0 && *letter == word[column - 1] && typed[row - 1] == *other {
                count = count.min(before[column - 1] + 1);
            }
            current.push(count);
        }
        // Once every way is past the allowance, no later letter mends it.
        if current.iter().all(|count| *count > most) {
            return None;
        }
        before = std::mem::replace(&mut previous, current);
    }
    Some(previous[word.len()]).filter(|count| *count <= most)
}

fn search_terms(library: &Library, filter: &NoteFilter, terms: &[Term]) -> Result<NotePage> {
    let mut compiled = compile_terms(terms)?;
    add_filter_predicates(&mut compiled, filter);

    let mut parameters = Vec::new();
    let mut conditions = Vec::new();
    let from = if let Some(expression) = compiled.fts.take() {
        conditions.push("notes_fts MATCH ?".to_owned());
        parameters.push(SqlValue::Text(expression));
        "notes_fts JOIN notes n ON n.id = notes_fts.note_id"
    } else {
        "notes n"
    };
    let ranked = !parameters.is_empty();
    conditions.append(&mut compiled.predicates);
    parameters.append(&mut compiled.parameters);
    let where_sql = if conditions.is_empty() {
        "1 = 1".to_owned()
    } else {
        conditions.join(" AND ")
    };
    let limit = filter.limit.clamp(1, 500) as usize;
    let offset = filter.offset as usize;

    let connection = library.connection.lock();
    // Which notes are on the page is found first, from what ordering needs
    // and nothing else. What a row of the list shows (its snippet, tags,
    // and picture) costs far more to work out, and is then worked out for
    // the page's notes only, not for every note of the listing.
    let (page, total) = if ranked && filter.sort == NoteSort::Relevance {
        let found = by_relevance(&connection, from, &where_sql, &mut parameters, &compiled)?;
        let total = found.len() as u64;
        (found.into_iter().skip(offset).take(limit).collect(), total)
    } else {
        let total: u64 = connection.query_row(
            &format!("SELECT count(*) FROM {from} WHERE {where_sql}"),
            params_from_iter(parameters.iter()),
            |row| row.get(0),
        )?;
        let order = match filter.sort {
            NoteSort::Relevance | NoteSort::UpdatedDesc => "n.updated_at DESC".to_owned(),
            NoteSort::UpdatedAsc => "n.updated_at ASC".to_owned(),
            NoteSort::CreatedDesc => "n.created_at DESC".to_owned(),
            NoteSort::CreatedAsc => "n.created_at ASC".to_owned(),
            NoteSort::TitleAsc => format!("n.title COLLATE {} ASC", natural::COLLATION),
            NoteSort::TitleDesc => format!("n.title COLLATE {} DESC", natural::COLLATION),
        };
        // The id makes the order total, so pages never repeat or skip a note.
        let sql = format!(
            "SELECT n.rowid FROM {from} WHERE {where_sql} ORDER BY {order}, n.id LIMIT ? OFFSET ?"
        );
        parameters.push(SqlValue::Integer(limit as i64));
        parameters.push(SqlValue::Integer(offset as i64));
        let page = connection
            .prepare(&sql)?
            .query_map(params_from_iter(parameters.iter()), |row| {
                row.get::<_, i64>(0)
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        (page, total)
    };
    if page.is_empty() {
        return Ok(NotePage {
            notes: Vec::new(),
            total,
            corrected: None,
        });
    }

    // A search shows the passage that answers it, which needs the note's
    // whole text; a listing shows how the note begins.
    let searched = !compiled.words.is_empty();
    let text = if searched {
        "n.plain_text"
    } else {
        "substr(n.plain_text, 1, 320)"
    };
    // The picture that stands for a note: the one chosen for it, while it
    // is still in the note, and otherwise the largest one that is more than
    // an icon. A picture taken out of a note stays among its attachments, so
    // the note's content is asked whether it still shows it.
    let thumbnail = format!(
        "COALESCE(
            (SELECT r.sha256 FROM resources r
              WHERE r.note_id = n.id AND r.mime LIKE 'image/%'
                AND r.md5 = json_extract(n.attributes_json, '$.\"application-data\".\"{THUMBNAIL_KEY}\"')
                AND instr(n.content_html, r.md5) > 0
              LIMIT 1),
            (SELECT r.sha256 FROM resources r
              WHERE r.note_id = n.id AND r.mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
                AND (r.width IS NULL OR r.height IS NULL OR (r.width >= 48 AND r.height >= 48))
                AND instr(n.content_html, r.md5) > 0
              ORDER BY COALESCE(r.width, 0) * COALESCE(r.height, 0) DESC, r.position
              LIMIT 1))"
    );
    let marks = vec!["?"; page.len()].join(", ");
    let sql = format!(
        "SELECT n.rowid, n.id, n.notebook_id, nb.name, n.title, {text}, n.created_at, n.updated_at, n.deleted_at,
            COALESCE((SELECT group_concat(t.name, char(31)) FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = n.id), ''),
            EXISTS(SELECT 1 FROM resources r WHERE r.note_id = n.id),
            EXISTS(SELECT 1 FROM shortcuts s WHERE s.target_type = 'note' AND s.target_id = n.id),
            {thumbnail}
         FROM notes n JOIN notebooks nb ON nb.id = n.notebook_id
         WHERE n.rowid IN ({marks})"
    );
    let mut found = connection
        .prepare(&sql)?
        .query_map(params_from_iter(page.iter()), |row| {
            let tags: String = row.get(9)?;
            let mut tags = if tags.is_empty() {
                Vec::new()
            } else {
                tags.split(char::from(31))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            };
            tags.sort_by(|a, b| natural::compare(a, b));
            let text: String = row.get(5)?;
            Ok((
                row.get::<_, i64>(0)?,
                NoteSummary {
                    id: row.get(1)?,
                    notebook_id: row.get(2)?,
                    notebook_name: row.get(3)?,
                    title: row.get(4)?,
                    snippet: if searched {
                        snippet(&text, &compiled.words)
                    } else {
                        text
                    },
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    deleted_at: row.get(8)?,
                    tags,
                    has_attachments: row.get(10)?,
                    is_shortcut: row.get(11)?,
                    thumbnail: row.get(12)?,
                },
            ))
        })?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    // In the order of the page; a note deleted between the two questions is
    // simply not there.
    let notes = page.iter().filter_map(|key| found.remove(key)).collect();
    Ok(NotePage {
        notes,
        total,
        corrected: None,
    })
}

/// The notes a search found, best answer first, as rows of the notes table.
///
/// A person who types a note's name wants that note first, however often
/// the words occur elsewhere. So what was found is ordered by where the
/// words are, before any counting of occurrences:
///
/// 1. in the title;
/// 2. in the name of the notebook;
/// 3. in the tags;
/// 4. anywhere else: the text, and what the attachments are named and what
///    was recognised in them.
///
/// A field has the words when it has every one of them. Within a field
/// the notes come in this order: the field is what was typed, or begins
/// with it; then those that have every word whole before those in which a
/// word only begins so; then the words in their order with nothing
/// between them, with one word between, with two, and so on; then the
/// words in another order. "my apple" finds "my apple" before "my
/// friend's apple", and that before "apple of my eye".
///
/// After that the index's own measure decides, in which the title weighs
/// most, and then the note changed last.
fn by_relevance(
    connection: &Connection,
    from: &str,
    where_sql: &str,
    parameters: &mut Vec<SqlValue>,
    compiled: &Compiled,
) -> Result<Vec<i64>> {
    // Asked of the index once each, with whole words only, which it
    // answers directly; the words' beginnings were its work in the search
    // itself.
    const IN_INDEX: &str = "n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?)";
    let mut columns = Vec::new();
    let mut leading = Vec::new();
    let ranking = compiled.ranking.as_ref();
    for expression in [
        ranking.and_then(|ranking| ranking.phrase.clone()),
        ranking.map(|ranking| ranking.whole.clone()),
    ] {
        match expression {
            Some(expression) => {
                columns.push(IN_INDEX);
                leading.push(SqlValue::Text(expression));
            }
            None => columns.push("0"),
        }
    }
    // The title, the notebook and the tags are read from the index's own
    // row, where they stand before the note's text.
    let sql = format!(
        "SELECT n.rowid, notes_fts.rowid, notes_fts.title, notes_fts.notebook, notes_fts.tags,
                bm25(notes_fts, 0.0, 10.0, 5.0, 3.0, 1.0, 1.0), n.updated_at, n.id, {}, {}
         FROM {from} WHERE {where_sql}",
        columns[0], columns[1]
    );
    // The columns' parameters come before the search's own in the text.
    leading.append(parameters);
    *parameters = leading;

    struct Found {
        row: i64,
        /// The note's row in the index.
        indexed: i64,
        standing: Standing,
        measure: f64,
        updated: i64,
        id: String,
    }
    let typed = ranking.map(|ranking| ranking.text.to_lowercase());
    let searched = ranking.map_or(&[][..], |ranking| &ranking.words[..]);
    let mut found = connection
        .prepare(&sql)?
        .query_map(params_from_iter(parameters.iter()), |row| {
            let (together, whole): (bool, bool) = (row.get(8)?, row.get(9)?);
            let elsewhere = Standing {
                field: 3,
                lead: 2,
                partly: !whole,
                order: u8::from(!together),
                between: 0,
            };
            let standing = match &typed {
                Some(typed) if !searched.is_empty() => {
                    let title = row.get_ref(2)?.as_str()?;
                    let notebook = row.get_ref(3)?.as_str()?;
                    let tags = row.get_ref(4)?.as_str()?;
                    in_field(0, title, typed, searched)
                        .or_else(|| in_field(1, notebook, typed, searched))
                        .or_else(|| in_tags(tags, typed, searched))
                        .unwrap_or(elsewhere)
                }
                _ => elsewhere,
            };
            Ok(Found {
                row: row.get(0)?,
                indexed: row.get(1)?,
                standing,
                measure: row.get(5)?,
                updated: row.get(6)?,
                id: row.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    // Of the notes that have the words only in their text, and not side by
    // side, those that have them in their order are told by how many words
    // are between. That takes the places of the words from the index.
    if searched.len() > 1 {
        let apart = found
            .iter()
            .filter(|found| found.standing.field == 3 && found.standing.order == 1)
            .map(|found| found.indexed)
            .collect::<HashSet<_>>();
        if apart.len() > 1 {
            let between = words_between(connection, searched, &apart)?;
            for found in &mut found {
                if found.standing.field == 3 && found.standing.order == 1 {
                    if let Some(between) = between.get(&found.indexed) {
                        found.standing.order = 0;
                        found.standing.between = *between;
                    }
                }
            }
        }
    }
    found.sort_by(|a, b| {
        a.standing
            .cmp(&b.standing)
            .then(a.measure.total_cmp(&b.measure))
            .then(b.updated.cmp(&a.updated))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(found.into_iter().map(|found| found.row).collect())
}

/// A word of a search: its letters in lower case, and whether it has to be
/// a whole word (it was quoted) or may be the beginning of one.
type SearchWord = (String, bool);

/// The words of `text`: runs of letters and digits, with where each begins
/// and ends.
fn words_of(text: &str) -> impl Iterator<Item = (usize, usize)> + '_ {
    let mut characters = text.char_indices().peekable();
    std::iter::from_fn(move || {
        while characters.peek().is_some_and(|(_, c)| !c.is_alphanumeric()) {
            characters.next();
        }
        let (start, _) = *characters.peek()?;
        let mut end = start;
        while let Some((at, character)) = characters.peek().copied() {
            if !character.is_alphanumeric() {
                break;
            }
            end = at + character.len_utf8();
            characters.next();
        }
        Some((start, end))
    })
}

fn answers(word: &str, searched: &SearchWord) -> bool {
    if searched.1 {
        word == searched.0
    } else {
        word.starts_with(&searched.0)
    }
}

/// How well a note answers a search by where its words stand. The smaller
/// in the order of what follows, the better.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Standing {
    /// 0 the title, 1 the notebook's name, 2 the tags, 3 anywhere else.
    field: u8,
    /// 0 the field is what was typed; 1 it begins with it; 2 neither.
    lead: u8,
    /// A word typed is only the beginning of a word that is there.
    partly: bool,
    /// 0 the words follow each other in the order typed; 1 they do not;
    /// 2 they are spread over several tags.
    order: u8,
    /// Other words between the words typed, where they are in their order.
    between: u32,
}

/// How the words searched for stand among `words`: `None` when one is
/// missing; otherwise the fewest other words between them where they follow
/// each other in the order typed (`None` when they nowhere do), and whether
/// every one of them is there as a whole word.
fn among(words: &[&str], searched: &[SearchWord]) -> Option<(Option<u32>, bool)> {
    let mut whole = true;
    for searched in searched {
        if !words.iter().any(|word| answers(word, searched)) {
            return None;
        }
        whole &= words.iter().any(|word| *word == searched.0);
    }
    let (first, rest) = searched.split_first()?;
    let mut least: Option<u32> = None;
    for start in 0..words.len() {
        if !answers(words[start], first) {
            continue;
        }
        // The nearest word that answers each next one: no other choice
        // ends sooner.
        let mut at = start;
        let complete = rest.iter().all(|next| {
            match (at + 1..words.len()).find(|index| answers(words[*index], next)) {
                Some(index) => {
                    at = index;
                    true
                }
                None => false,
            }
        });
        if !complete {
            // Nor would a later beginning find them.
            break;
        }
        let between = (at - start - rest.len()) as u32;
        least = Some(least.map_or(between, |least| least.min(between)));
        if between == 0 {
            break;
        }
    }
    Some((least, whole))
}

/// The standing of a note by one of its short fields, when the field has
/// every word. `typed` is the search as it was typed, in lower case.
fn in_field(field: u8, text: &str, typed: &str, searched: &[SearchWord]) -> Option<Standing> {
    let text = text.trim().to_lowercase();
    let words = words_of(&text)
        .map(|(start, end)| &text[start..end])
        .collect::<Vec<_>>();
    let (between, whole) = among(&words, searched)?;
    let lead = if text == typed {
        0
    } else if text.starts_with(typed) {
        1
    } else {
        2
    };
    Some(Standing {
        field,
        lead,
        partly: !whole,
        order: u8::from(between.is_none()),
        between: between.unwrap_or(0),
    })
}

/// The standing of a note by its tags, as the index holds them: the best
/// of what each tag gives by itself, or, when no one tag has every word
/// and all of them together have, the last place among the tags.
fn in_tags(tags: &str, typed: &str, searched: &[SearchWord]) -> Option<Standing> {
    if tags.is_empty() {
        return None;
    }
    let divider = crate::repository::TAG_DIVIDER;
    if let Some(best) = tags
        .split(divider)
        .filter_map(|tag| in_field(2, tag, typed, searched))
        .min()
    {
        return Some(best);
    }
    let all = tags.to_lowercase();
    let words = words_of(&all)
        .map(|(start, end)| &all[start..end])
        .collect::<Vec<_>>();
    let (_, whole) = among(&words, searched)?;
    Some(Standing {
        field: 2,
        lead: 2,
        partly: !whole,
        order: 2,
        between: 0,
    })
}

/// Most places of words read from the index to order one search. Reading
/// them is what the order by nearness costs, and words that are everywhere
/// would cost more than their order is worth: past this, the notes that
/// have the words apart stay in the order of the index's own measure.
const PLACES: usize = 60_000;

/// For each of the notes `wanted` (rows of the index) in whose text the
/// words searched for follow each other in the order typed: the fewest
/// other words between them. The text is the note's own and, apart from
/// it, what its attachments are named and what was recognised in them.
fn words_between(
    connection: &Connection,
    searched: &[SearchWord],
    wanted: &HashSet<i64>,
) -> Result<HashMap<i64, u32>> {
    // For each word, where it stands in each note: (note, in the
    // attachments) to its places.
    let mut places: Vec<HashMap<(i64, bool), Vec<u32>>> = Vec::new();
    let mut left = PLACES;
    for (word, whole) in searched {
        let mut statement = connection.prepare_cached(if *whole {
            "SELECT doc, col, offset FROM notes_fts_places WHERE term = ?1 AND ?2 = ?2 LIMIT ?3"
        } else {
            "SELECT doc, col, offset FROM notes_fts_places WHERE term >= ?1 AND term < ?2 LIMIT ?3"
        })?;
        let after = format!("{word}\u{10FFFF}");
        let mut rows = statement.query(rusqlite::params![word, after, (left + 1) as i64])?;
        let mut of_word: HashMap<(i64, bool), Vec<u32>> = HashMap::new();
        let mut read = 0;
        while let Some(row) = rows.next()? {
            read += 1;
            if read > left {
                return Ok(HashMap::new());
            }
            let note: i64 = row.get(0)?;
            if !wanted.contains(&note) {
                continue;
            }
            let attached = match row.get_ref(1)?.as_str().unwrap_or_default() {
                "body" => false,
                "resources" => true,
                _ => continue,
            };
            of_word
                .entry((note, attached))
                .or_default()
                .push(row.get(2)?);
        }
        left -= read;
        // A word typed in part answers to several words of the index, each
        // with its places in their own order.
        if !*whole {
            for list in of_word.values_mut() {
                list.sort_unstable();
            }
        }
        places.push(of_word);
    }
    let mut between = HashMap::new();
    for note in wanted {
        let least = [false, true]
            .into_iter()
            .filter_map(|attached| {
                let lists = places
                    .iter()
                    .map(|of_word| of_word.get(&(*note, attached)))
                    .collect::<Option<Vec<_>>>()?;
                least_between(&lists)
            })
            .min();
        if let Some(least) = least {
            between.insert(*note, least);
        }
    }
    Ok(between)
}

/// The fewest other words between words that follow each other, one from
/// each list of places in turn; `None` when they nowhere do.
fn least_between(lists: &[&Vec<u32>]) -> Option<u32> {
    let (first, rest) = lists.split_first()?;
    let mut least: Option<u32> = None;
    for start in first.iter() {
        let mut at = *start;
        for list in rest {
            match list.get(list.partition_point(|place| *place <= at)) {
                Some(place) => at = *place,
                // Nor would a later beginning find them.
                None => return least,
            }
        }
        let between = at - start - rest.len() as u32;
        least = Some(least.map_or(between, |least| least.min(between)));
        if between == 0 {
            break;
        }
    }
    least
}

/// About this many words of a note are shown under its title.
const SNIPPET_WORDS: usize = 28;
/// Words shown before the first one that answers the search.
const SNIPPET_LEAD: usize = 4;

/// The passage of `text` that best answers a search, with the words that
/// answer it marked: the stretch in which the most of the searched words
/// occur, and of those the first. A note that answers only by its title or
/// tags is shown from its beginning.
fn snippet(text: &str, searched: &[SearchWord]) -> String {
    let lower = text.to_lowercase();
    // Lower case has the same length for nearly every letter. Where it has
    // not, places in one text are not places in the other, and the note is
    // shown from its beginning.
    let aligned = lower.len() == text.len();
    let words = words_of(&lower).collect::<Vec<_>>();
    let which = |(start, end): (usize, usize)| {
        searched
            .iter()
            .position(|searched| answers(&lower[start..end], searched))
    };
    let matches = words
        .iter()
        .enumerate()
        .filter_map(|(index, word)| which(*word).map(|searched| (index, searched)))
        .collect::<Vec<_>>();
    let beginning = || {
        let mut end = text.len().min(320);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_owned()
    };
    if matches.is_empty() || !aligned {
        return beginning();
    }
    // The stretch that begins at each answer, judged by how many different
    // words it holds; only so many are tried, which is enough to find one.
    let mut best = (0, 0);
    for (at, (index, _)) in matches.iter().enumerate().take(400) {
        let mut seen = 0u64;
        for (_, searched) in matches[at..]
            .iter()
            .take_while(|(other, _)| *other < index + SNIPPET_WORDS - SNIPPET_LEAD)
        {
            seen |= 1 << (*searched).min(63);
        }
        if seen.count_ones() > best.1 {
            best = (*index, seen.count_ones());
        }
    }
    let first = best.0.saturating_sub(SNIPPET_LEAD);
    let last = (first + SNIPPET_WORDS).min(words.len());
    let mut out = String::new();
    if first > 0 {
        out.push('…');
    }
    let mut at = words[first].0;
    for word in &words[first..last] {
        out.push_str(&text[at..word.0]);
        let marked = which(*word).is_some();
        if marked {
            out.push(SNIPPET_MATCH_START);
        }
        out.push_str(&text[word.0..word.1]);
        if marked {
            out.push(SNIPPET_MATCH_END);
        }
        at = word.1;
    }
    if last < words.len() {
        out.push('…');
    } else {
        out.push_str(text[at..].trim_end());
    }
    out
}

fn add_filter_predicates(compiled: &mut Compiled, filter: &NoteFilter) {
    if filter.trash_only {
        compiled.predicates.push("n.deleted_at IS NOT NULL".into());
    } else if !filter.include_trash {
        compiled.predicates.push("n.deleted_at IS NULL".into());
    }
    if let Some(id) = &filter.notebook_id {
        compiled.push("n.notebook_id = ?".into(), [SqlValue::Text(id.clone())]);
    }
    if let Some(id) = &filter.stack_id {
        compiled.push(
            "EXISTS(SELECT 1 FROM notebooks fnb WHERE fnb.id = n.notebook_id AND fnb.stack_id = ?)"
                .into(),
            [SqlValue::Text(id.clone())],
        );
    }
    for id in &filter.tag_ids {
        compiled.push(
            "EXISTS(SELECT 1 FROM note_tags fnt WHERE fnt.note_id = n.id AND fnt.tag_id = ?)"
                .into(),
            [SqlValue::Text(id.clone())],
        );
    }
    for (column, value) in [
        ("n.created_at", filter.created_from),
        ("n.updated_at", filter.updated_from),
    ] {
        if let Some(value) = value {
            compiled.push(format!("{column} >= ?"), [SqlValue::Integer(value)]);
        }
    }
    for (column, value) in [
        ("n.created_at", filter.created_to),
        ("n.updated_at", filter.updated_to),
    ] {
        if let Some(value) = value {
            compiled.push(format!("{column} <= ?"), [SqlValue::Integer(value)]);
        }
    }
    if let Some(contains) = &filter.contains {
        compiled.push(contains_predicate(contains), []);
    }
}

fn compile_terms(terms: &[Term]) -> Result<Compiled> {
    let any = terms.first().is_some_and(|term| {
        term.label.as_deref() == Some("any") && term.value.is_empty() && !term.negated
    });
    let terms = &terms[usize::from(any)..];
    let mut compiled = Compiled::default();
    for term in terms {
        if term.label.is_none() && !term.negated {
            // What is looked for is what is marked: the other spellings of
            // a word that was respelt, not the word as it was typed.
            let spellings = if term.alternatives.is_empty() {
                std::slice::from_ref(&term.value)
            } else {
                &term.alternatives[..]
            };
            for spelling in spellings {
                let value = spelling.trim_end_matches('*').to_lowercase();
                let mut words = words_of(&value)
                    .map(|(start, end)| (value[start..end].to_owned(), true))
                    .collect::<Vec<_>>();
                // Of a term's words, the last may be the beginning of a word.
                if let Some(last) = words.last_mut() {
                    last.1 = term.quoted;
                }
                compiled.words.extend(words);
            }
        }
    }
    let is_text = |term: &Term| matches!(term.label.as_deref(), None | Some("intitle"));

    if any {
        // Any term may match. Text alone can still be answered, and ranked,
        // by the index; mixed with other operators it needs one subquery each.
        if !terms.is_empty() && terms.iter().all(|term| is_text(term) && !term.negated) {
            let parts = terms.iter().filter_map(text_expression).collect::<Vec<_>>();
            if !parts.is_empty() {
                compiled.fts = Some(parts.join(" OR "));
            }
            return Ok(compiled);
        }
        let mut alternatives = Vec::new();
        for term in terms {
            if let Some((sql, parameters)) = compile_term(term)? {
                alternatives.push(format!("({sql})"));
                compiled.parameters.extend(parameters);
            }
        }
        if !alternatives.is_empty() {
            compiled
                .predicates
                .push(format!("({})", alternatives.join(" OR ")));
        }
        return Ok(compiled);
    }

    let mut required = Vec::new();
    for term in terms {
        if is_text(term) && !term.negated {
            required.extend(text_expression(term));
        } else if let Some((sql, parameters)) = compile_term(term)? {
            compiled.push(sql, parameters);
        }
    }
    if !required.is_empty() {
        compiled.fts = Some(required.join(" AND "));
        let plain = terms
            .iter()
            .filter(|term| term.label.is_none() && !term.negated)
            .filter(|term| term.value.chars().any(char::is_alphanumeric))
            .collect::<Vec<_>>();
        if !plain.is_empty() {
            let text = plain
                .iter()
                .map(|term| term.understood().trim_end_matches('*'))
                .collect::<Vec<_>>()
                .join(" ");
            let mut words = Vec::new();
            for term in &plain {
                let value = term.understood().trim_end_matches('*').to_lowercase();
                let mut of_term = words_of(&value)
                    .map(|(start, end)| (value[start..end].to_owned(), true))
                    .collect::<Vec<_>>();
                // Of a term's words, the last may be the beginning of a word.
                if let Some(last) = of_term.last_mut() {
                    last.1 = term.quoted;
                }
                words.extend(of_term);
            }
            compiled.ranking = Some(Ranking {
                words,
                whole: plain
                    .iter()
                    .filter_map(|term| fts_expression(term.understood(), true, None))
                    .collect::<Vec<_>>()
                    .join(" AND "),
                phrase: (plain.len() > 1).then(|| format!("\"{}\"", text.replace('"', "\"\""))),
                text,
            });
        }
    }
    Ok(compiled)
}

/// Full-text expression for a plain or `intitle:` term, or `None` when the
/// term contains nothing the index could hold (for example a lone `&`).
fn text_expression(term: &Term) -> Option<String> {
    let column = (term.label.as_deref() == Some("intitle")).then_some("title");
    if term.alternatives.is_empty() {
        return fts_expression(&term.value, term.quoted, column);
    }
    let spellings = term
        .alternatives
        .iter()
        .filter_map(|spelling| fts_expression(spelling, term.quoted, column))
        .collect::<Vec<_>>();
    (!spellings.is_empty()).then(|| format!("({})", spellings.join(" OR ")))
}

/// SQL for one term as a standalone predicate, with its negation applied.
/// Returns `None` for a term that cannot match or exclude anything.
fn compile_term(term: &Term) -> Result<Option<(String, Vec<SqlValue>)>> {
    let (sql, parameters): (String, Vec<SqlValue>) = match term.label.as_deref() {
        None | Some("intitle") => match text_expression(term) {
            Some(expression) => (FTS_SUBQUERY.into(), vec![SqlValue::Text(expression)]),
            None => return Ok(None),
        },
        Some("tag") => name_predicate(
            "EXISTS(SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND ",
            &term.value,
            "t.name",
        ),
        Some("notebook") => name_predicate(
            "EXISTS(SELECT 1 FROM notebooks nb2 WHERE nb2.id = n.notebook_id AND ",
            &term.value,
            "nb2.name",
        ),
        Some("stack") => name_predicate(
            "EXISTS(SELECT 1 FROM notebooks nb2 JOIN stacks st ON st.id = nb2.stack_id WHERE nb2.id = n.notebook_id AND ",
            &term.value,
            "st.name",
        ),
        Some(label @ ("created" | "updated")) => date_predicate(&format!("n.{label}_at"), &term.value)?,
        Some("resource") => (
            "EXISTS(SELECT 1 FROM resources r WHERE r.note_id = n.id AND r.mime LIKE ?)".into(),
            vec![SqlValue::Text(term.value.replace('*', "%"))],
        ),
        // Evernote's meaning: true = a ticked checkbox, false = an unticked one.
        Some("todo") => {
            let sql = match term.value.as_str() {
                "true" => "n.content_html LIKE '%<en-todo checked=\"true\"%' OR n.content_html LIKE '%data-checked=\"true\"%'",
                "false" => "n.content_html LIKE '%<en-todo checked=\"false\"%' OR n.content_html LIKE '%<en-todo></en-todo>%' OR n.content_html LIKE '%data-checked=\"false\"%'",
                "*" => "n.content_html LIKE '%<en-todo%' OR n.content_html LIKE '%data-type=\"taskItem\"%'",
                _ => return Err(BeverError::Invalid("todo: expects true, false, or *".into())),
            };
            (sql.into(), vec![])
        }
        Some("encryption") => ("n.content_html LIKE '%<en-crypt%'".into(), vec![]),
        Some("contains") => (contains_predicate(&term.value), vec![]),
        Some("source" | "sourceurl") => (
            "COALESCE(json_extract(n.attributes_json, '$.source-url'), '') LIKE ?".into(),
            vec![SqlValue::Text(term.value.replace('*', "%"))],
        ),
        Some("any") => {
            return Err(BeverError::Invalid(
                "any: is only valid at the start of a search".into(),
            ));
        }
        Some(label) => {
            return Err(BeverError::Invalid(format!(
                "unsupported search operator: {label}:"
            )));
        }
    };
    let sql = if term.negated {
        format!("NOT ({sql})")
    } else {
        sql
    };
    Ok(Some((sql, parameters)))
}

fn contains_predicate(value: &str) -> String {
    match value {
        "images" | "image" => "EXISTS(SELECT 1 FROM resources r WHERE r.note_id = n.id AND r.mime LIKE 'image/%')",
        "audio" => "EXISTS(SELECT 1 FROM resources r WHERE r.note_id = n.id AND r.mime LIKE 'audio/%')",
        "video" => "EXISTS(SELECT 1 FROM resources r WHERE r.note_id = n.id AND r.mime LIKE 'video/%')",
        "pdf" => "EXISTS(SELECT 1 FROM resources r WHERE r.note_id = n.id AND r.mime = 'application/pdf')",
        "files" | "attachments" => "EXISTS(SELECT 1 FROM resources r WHERE r.note_id = n.id)",
        "checklist" | "todo" => "n.content_html LIKE '%<en-todo%' OR n.content_html LIKE '%data-type=\"taskItem\"%'",
        "code" | "codeblocks" => "n.content_html LIKE '%<pre%' OR n.content_html LIKE '%--en-codeblock:true%'",
        "tables" | "table" => "n.content_html LIKE '%<table%'",
        "links" | "link" => "n.content_html LIKE '%<a %'",
        _ => "0 = 1",
    }
    .to_owned()
}

fn name_predicate(prefix: &str, value: &str, column: &str) -> (String, Vec<SqlValue>) {
    if value == "*" {
        return (format!("{prefix}1 = 1)"), vec![]);
    }
    if value.contains('*') {
        (
            format!("{prefix}{column} LIKE ? COLLATE NOCASE)"),
            vec![SqlValue::Text(value.replace('*', "%"))],
        )
    } else {
        (
            format!("{prefix}{column} = ? COLLATE NOCASE)"),
            vec![SqlValue::Text(value.to_owned())],
        )
    }
}

/// A quoted term matches exactly; an unquoted one also matches words that
/// begin with it, which is what search-as-you-type needs.
fn fts_expression(value: &str, quoted: bool, column: Option<&str>) -> Option<String> {
    let value = value.trim_end_matches('*');
    if !value.chars().any(char::is_alphanumeric) {
        return None;
    }
    let prefix = if quoted { "" } else { "*" };
    let expression = format!("\"{}\"{prefix}", value.replace('"', "\"\""));
    Some(match column {
        Some(column) => format!("{column} : {expression}"),
        None => expression,
    })
}

fn tokenize(query: &str) -> Vec<Term> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut was_quoted = false;
    let mut escaped = false;
    for character in query.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            was_quoted = true;
            continue;
        }
        if character.is_whitespace() && !quoted {
            if !current.is_empty() || was_quoted {
                tokens.push(make_term(std::mem::take(&mut current), was_quoted));
                was_quoted = false;
            }
            continue;
        }
        current.push(character);
    }
    // While someone is still typing, a query naturally ends inside a quote or
    // after a backslash; treat what is there as the term instead of failing.
    if !current.is_empty() {
        tokens.push(make_term(current, was_quoted));
    }
    tokens
}

fn make_term(mut raw: String, quoted: bool) -> Term {
    let negated = raw.starts_with('-') && raw.len() > 1;
    if negated {
        raw.remove(0);
    }
    // Only a known operator name makes a colon special, so that ordinary
    // text such as "10:30" or "https://…" is searched as written.
    let (label, value) = match raw.split_once(':') {
        Some((label, value)) if is_operator(label) => (Some(label.to_lowercase()), value),
        _ => (None, raw.as_str()),
    };
    Term {
        label,
        value: value.to_owned(),
        negated,
        quoted,
        alternatives: Vec::new(),
    }
}

impl Term {
    /// The term as it would be typed, with the word it was understood as.
    fn written(&self) -> String {
        let value = self.understood();
        format!(
            "{}{}{}",
            if self.negated { "-" } else { "" },
            self.label
                .as_ref()
                .map(|label| format!("{label}:"))
                .unwrap_or_default(),
            if self.quoted {
                format!("\"{value}\"")
            } else {
                value.to_owned()
            }
        )
    }
}

fn is_operator(label: &str) -> bool {
    matches!(
        label.to_lowercase().as_str(),
        "any"
            | "intitle"
            | "tag"
            | "notebook"
            | "stack"
            | "created"
            | "updated"
            | "resource"
            | "todo"
            | "encryption"
            | "contains"
            | "source"
            | "sourceurl"
    )
}

/// `created:` and `updated:` accept a day (`20240131` or `2024-01-31`), an
/// instant (`20240131T120000Z`), a relative period (`day-1`, `week`,
/// `month-2`, `year`), or a range of two of these joined by `..`. A single
/// value means "on or after"; a range includes its last day.
fn date_predicate(column: &str, value: &str) -> Result<(String, Vec<SqlValue>)> {
    let Some((from, to)) = value.split_once("..") else {
        let (start, _) = parse_search_date(value)?;
        return Ok((format!("{column} >= ?"), vec![SqlValue::Integer(start)]));
    };
    let mut conditions = Vec::new();
    let mut parameters = Vec::new();
    if !from.is_empty() {
        conditions.push(format!("{column} >= ?"));
        parameters.push(SqlValue::Integer(parse_search_date(from)?.0));
    }
    if !to.is_empty() {
        conditions.push(format!("{column} < ?"));
        parameters.push(SqlValue::Integer(parse_search_date(to)?.1));
    }
    if conditions.is_empty() {
        return Err(BeverError::Invalid(format!("invalid date search: {value}")));
    }
    Ok((conditions.join(" AND "), parameters))
}

/// Start of the period a date expression names and the instant just after it
/// ends, as Unix milliseconds. Days are days in this device's time zone.
fn parse_search_date(value: &str) -> Result<(i64, i64)> {
    let invalid = || BeverError::Invalid(format!("invalid date search: {value}"));
    if let Ok(instant) = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ") {
        let start = instant.and_utc().timestamp_millis();
        return Ok((start, start + 1000));
    }
    let day = NaiveDate::parse_from_str(value, "%Y%m%d")
        .or_else(|_| NaiveDate::parse_from_str(value, "%Y-%m-%d"));
    if let Ok(day) = day {
        return Ok((local_midnight(day), local_midnight(day + Duration::days(1))));
    }
    let (unit, amount) = match value.split_once('-') {
        Some((unit, amount)) => (unit, amount.parse::<u32>().map_err(|_| invalid())?),
        None => (value, 0),
    };
    let today = Local::now().date_naive();
    let (start, end) = match unit.to_lowercase().as_str() {
        "day" => {
            let start = today - Duration::days(i64::from(amount));
            (start, start + Duration::days(1))
        }
        "week" => {
            let monday = today - Duration::days(i64::from(today.weekday().num_days_from_monday()));
            let start = monday - Duration::weeks(i64::from(amount));
            (start, start + Duration::weeks(1))
        }
        "month" => {
            let first = today.with_day(1).ok_or_else(invalid)?;
            let start = first
                .checked_sub_months(Months::new(amount))
                .ok_or_else(invalid)?;
            let end = start
                .checked_add_months(Months::new(1))
                .ok_or_else(invalid)?;
            (start, end)
        }
        "year" => {
            let year = today.year() - i32::try_from(amount).map_err(|_| invalid())?;
            (
                NaiveDate::from_ymd_opt(year, 1, 1).ok_or_else(invalid)?,
                NaiveDate::from_ymd_opt(year + 1, 1, 1).ok_or_else(invalid)?,
            )
        }
        _ => return Err(invalid()),
    };
    Ok((local_midnight(start), local_midnight(end)))
}

fn local_midnight(day: NaiveDate) -> i64 {
    let midnight = day.and_hms_opt(0, 0, 0).expect("midnight exists");
    Local
        .from_local_datetime(&midnight)
        .earliest()
        // A zone can skip midnight on a daylight-saving change.
        .map_or_else(|| midnight.and_utc().timestamp_millis(), |local| local.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::models::{NoteFilter, SaveNote};

    fn library() -> (tempfile::TempDir, Library) {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open_at(directory.path().join("db"), directory.path().join("blobs")).unwrap();
        (directory, library)
    }

    fn add_note(library: &Library, title: &str, html: &str, tags: &[&str]) -> String {
        let note = library.create_note(None).unwrap();
        library
            .save_note(&SaveNote {
                id: note.id.clone(),
                notebook_id: note.notebook_id,
                title: title.into(),
                content_html: html.into(),
                attributes: json!({}),
                tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
                base_revision: None,
            })
            .unwrap();
        note.id
    }

    fn search(library: &Library, query: &str) -> NotePage {
        library
            .list_notes(&NoteFilter {
                query: query.into(),
                sort: NoteSort::Relevance,
                ..NoteFilter::default()
            })
            .unwrap()
    }

    fn titles(page: &NotePage) -> Vec<&str> {
        page.notes.iter().map(|note| note.title.as_str()).collect()
    }

    #[test]
    fn tokenizes_quoted_operators_and_negation() {
        let terms = tokenize("notebook:\"My Notebook\" -tag:archive \"exact phrase\" prefix*");
        assert_eq!(terms.len(), 4);
        assert_eq!(terms[0].value, "My Notebook");
        assert!(terms[1].negated);
        assert!(terms[2].quoted);
    }

    #[test]
    fn colons_in_ordinary_text_are_not_operators() {
        let (_directory, library) = library();
        add_note(
            &library,
            "Standup",
            "<p>Meet at 10:30 near https://example.com/docs</p>",
            &[],
        );
        assert_eq!(search(&library, "10:30").total, 1);
        assert_eq!(search(&library, "https://example.com").total, 1);
        assert!(library
            .list_notes(&NoteFilter {
                query: "any: one any:two".into(),
                ..NoteFilter::default()
            })
            .is_err());
    }

    #[test]
    fn searches_title_body_tags_and_notebooks_offline() {
        let (_directory, library) = library();
        let notebook = library.ensure_notebook("Research", None).unwrap();
        let note = library.create_note(Some(&notebook)).unwrap();
        library
            .save_note(&SaveNote {
                id: note.id,
                notebook_id: notebook,
                title: "Offline Search".into(),
                content_html: "<p>Fast local indexing</p>".into(),
                attributes: json!({}),
                tags: vec!["engineering".into()],
                base_revision: None,
            })
            .unwrap();
        for query in [
            "intitle:offline",
            "indexing",
            "tag:engineering",
            "notebook:Research",
            "any: missing indexing",
            "any: tag:nothing indexing",
            "offline -tag:other",
        ] {
            assert_eq!(search(&library, query).total, 1, "query: {query}");
        }
        for query in [
            "-tag:engineering",
            "intitle:indexing",
            "offline -indexing",
            "missing",
        ] {
            assert_eq!(search(&library, query).total, 0, "query: {query}");
        }
    }

    #[test]
    fn results_are_ranked_and_snippets_mark_the_match() {
        let (_directory, library) = library();
        let filler = "filler ".repeat(300);
        add_note(
            &library,
            "Shopping",
            &format!("<p>{filler} one roadmap mention at the very end</p>"),
            &[],
        );
        add_note(
            &library,
            "Project roadmap",
            "<p>The roadmap for the roadmap.</p>",
            &[],
        );
        add_note(&library, "Unrelated", "<p>Nothing to see here.</p>", &[]);
        // More documents make the term rare enough to carry weight.
        for index in 0..6 {
            add_note(
                &library,
                &format!("Filler {index}"),
                "<p>Plain text.</p>",
                &[],
            );
        }

        let page = search(&library, "roadmap");
        assert_eq!(titles(&page), ["Project roadmap", "Shopping"]);
        assert_eq!(page.total, 2);
        let marked = format!("{SNIPPET_MATCH_START}roadmap{SNIPPET_MATCH_END}");
        assert!(
            page.notes[0].snippet.contains(&marked),
            "{:?}",
            page.notes[0].snippet
        );
        // The snippet shows the passage that matched, not the note's opening.
        assert!(page.notes[1].snippet.contains(&marked));
        assert!(page.notes[1].snippet.contains("mention"));

        // Without a text term there is nothing to mark.
        let listed = library.list_notes(&NoteFilter::default()).unwrap();
        assert!(listed
            .notes
            .iter()
            .all(|note| !note.snippet.contains(SNIPPET_MATCH_START)));
    }

    #[test]
    fn unquoted_terms_match_word_beginnings_and_quoted_terms_match_exactly() {
        let (_directory, library) = library();
        add_note(&library, "Roadmap", "<p>Quarterly planning notes</p>", &[]);
        assert_eq!(search(&library, "road").total, 1);
        assert_eq!(search(&library, "plan quart").total, 1);
        assert_eq!(search(&library, "intitle:road").total, 1);
        assert_eq!(search(&library, "\"road\"").total, 0);
        assert_eq!(search(&library, "\"quarterly planning\"").total, 1);
        assert_eq!(search(&library, "oadmap").total, 0);
        // Punctuation alone, and an unfinished quote, are not errors.
        assert_eq!(search(&library, "road &").total, 1);
        assert_eq!(search(&library, "\"quarterly pla").total, 0);
        // A term with nothing searchable in it is ignored.
        assert_eq!(search(&library, "-").total, 1);
    }

    #[test]
    fn pages_cover_every_note_exactly_once() {
        let (_directory, library) = library();
        for index in 0..25 {
            add_note(
                &library,
                &format!("Note {index:02}"),
                "<p>same body</p>",
                &[],
            );
        }
        let mut seen = Vec::new();
        for offset in [0, 10, 20] {
            let page = library
                .list_notes(&NoteFilter {
                    sort: NoteSort::TitleAsc,
                    limit: 10,
                    offset,
                    ..NoteFilter::default()
                })
                .unwrap();
            assert_eq!(page.total, 25);
            seen.extend(page.notes.into_iter().map(|note| note.title));
        }
        assert_eq!(seen.len(), 25);
        let expected = (0..25)
            .map(|index| format!("Note {index:02}"))
            .collect::<Vec<_>>();
        assert_eq!(seen, expected);

        let searched = library
            .list_notes(&NoteFilter {
                query: "same".into(),
                sort: NoteSort::Relevance,
                limit: 10,
                ..NoteFilter::default()
            })
            .unwrap();
        assert_eq!((searched.notes.len(), searched.total), (10, 25));
    }

    #[test]
    fn date_operators_accept_days_ranges_and_relative_periods() {
        let (_directory, library) = library();
        let id = add_note(&library, "Dated", "<p>Body</p>", &[]);
        let noon = Local
            .with_ymd_and_hms(2024, 3, 15, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        library.update_note_timestamps(&id, noon, noon).unwrap();
        for (query, expected) in [
            ("created:20240315", 1),
            ("created:2024-03-15", 1),
            ("created:20240316", 0),
            ("-created:20240316", 1),
            ("created:2024-03-01..2024-03-15", 1),
            ("created:2024-03-01..2024-03-14", 0),
            ("created:2024-03-15..", 1),
            ("created:..2024-03-14", 0),
            ("updated:20240301..20240331", 1),
            ("created:year-50", 1),
            ("created:day-1", 0),
            ("created:week", 0),
            ("created:month-1", 0),
        ] {
            assert_eq!(search(&library, query).total, expected, "query: {query}");
        }
        for query in ["created:yesterday", "created:..", "created:day-x"] {
            assert!(
                library
                    .list_notes(&NoteFilter {
                        query: query.into(),
                        ..NoteFilter::default()
                    })
                    .is_err(),
                "query: {query}"
            );
        }
    }

    #[test]
    fn todo_follows_evernote_semantics() {
        let (_directory, library) = library();
        add_note(
            &library,
            "Ticked",
            r#"<ul data-type="taskList"><li data-type="taskItem" data-checked="true">Done</li></ul>"#,
            &[],
        );
        add_note(
            &library,
            "Open",
            r#"<p><en-todo checked="false"></en-todo>Later</p>"#,
            &[],
        );
        add_note(&library, "Plain", "<p>No boxes</p>", &[]);
        assert_eq!(titles(&search(&library, "todo:true")), ["Ticked"]);
        assert_eq!(titles(&search(&library, "todo:false")), ["Open"]);
        assert_eq!(search(&library, "todo:*").total, 2);
        assert_eq!(search(&library, "-todo:*").total, 1);
        assert_eq!(search(&library, "contains:checklist").total, 2);
    }

    #[test]
    fn what_was_typed_is_looked_for_in_titles_before_anywhere_else() {
        let (_directory, library) = library();
        let often = "<p>budget plan budget plan budget plan budget plan budget plan</p>";
        // Listed here from the worst answer to the best.
        add_note(
            &library,
            "Only beginnings",
            "<p>budgets and planning</p>",
            &[],
        );
        add_note(&library, "Apart", "<p>a plan that has no budget</p>", &[]);
        add_note(&library, "Together", "<p>see the budget plan here</p>", &[]);
        add_note(&library, "Budgeting and planning", "<p>Text</p>", &[]);
        add_note(&library, "The plan for the budget", often, &[]);
        add_note(&library, "Budget plan for 2026", "<p>Text</p>", &[]);
        add_note(&library, "budget PLAN", "<p>Text</p>", &[]);
        for index in 0..8 {
            add_note(&library, &format!("Other {index}"), "<p>Nothing</p>", &[]);
        }
        assert_eq!(
            titles(&search(&library, "budget plan")),
            [
                "budget PLAN",
                "Budget plan for 2026",
                "The plan for the budget",
                "Budgeting and planning",
                "Together",
                "Apart",
                "Only beginnings",
            ]
        );
        // One word, still being typed: titles that begin with it lead.
        let typing = search(&library, "budg");
        let mut leading = titles(&typing)[..3].to_vec();
        leading.sort_unstable();
        assert_eq!(
            leading,
            [
                "Budget plan for 2026",
                "Budgeting and planning",
                "budget PLAN"
            ]
        );
        assert_eq!(typing.total, 7);
        // A quoted word has to be the whole word, in a title as anywhere.
        assert_eq!(
            titles(&search(&library, "\"budget\" \"plan\""))[..3],
            [
                "budget PLAN",
                "Budget plan for 2026",
                "The plan for the budget"
            ]
        );
        // The pages of a search follow one another without a gap.
        let second = library
            .list_notes(&NoteFilter {
                query: "budget plan".into(),
                sort: NoteSort::Relevance,
                limit: 3,
                offset: 3,
                ..NoteFilter::default()
            })
            .unwrap();
        assert_eq!(
            titles(&second),
            ["Budgeting and planning", "Together", "Apart"]
        );
        assert_eq!(second.total, 7);
    }

    #[test]
    fn among_equal_answers_the_note_changed_last_comes_first() {
        let (_directory, library) = library();
        let older = add_note(&library, "Garden", "<p>Same words</p>", &[]);
        let newer = add_note(&library, "Garden", "<p>Same words</p>", &[]);
        library
            .update_note_timestamps(&older, 1_000, 2_000)
            .unwrap();
        library
            .update_note_timestamps(&newer, 1_000, 9_000)
            .unwrap();
        let page = search(&library, "garden");
        assert_eq!(
            page.notes.iter().map(|note| &note.id).collect::<Vec<_>>(),
            [&newer, &older]
        );
    }

    #[test]
    fn the_passage_shown_is_the_one_with_the_most_of_what_was_searched() {
        let (_directory, library) = library();
        let filler = "filler ".repeat(60);
        add_note(
            &library,
            "Long",
            &format!(
                "<p>An early train. {filler} The late TRAIN to Vienna leaves at nine. {filler}</p>"
            ),
            &[],
        );
        let page = search(&library, "train vienn");
        let shown = &page.notes[0].snippet;
        let mark = |word: &str| format!("{SNIPPET_MATCH_START}{word}{SNIPPET_MATCH_END}");
        assert!(shown.contains(&mark("TRAIN")), "{shown:?}");
        assert!(shown.contains(&mark("Vienna")), "{shown:?}");
        assert!(shown.starts_with('…') && shown.ends_with('…'), "{shown:?}");
        assert!(!shown.contains("early"), "{shown:?}");
        // A note found by its title alone is shown from its beginning.
        add_note(
            &library,
            "Vienna trains",
            "<p>Nothing about them here.</p>",
            &[],
        );
        let page = search(&library, "intitle:vienna");
        assert_eq!(page.notes[0].snippet, "Nothing about them here.");
        // Words that only partly consist of letters and digits.
        add_note(&library, "Clock", "<p>Meet at 10:30 by the door</p>", &[]);
        let page = search(&library, "10:30");
        assert!(
            page.notes[0].snippet.contains(&mark("10")),
            "{:?}",
            page.notes[0].snippet
        );
        assert!(page.notes[0].snippet.contains(&mark("30")));
    }

    #[test]
    fn titles_are_listed_with_their_numbers_read_as_numbers() {
        let (_directory, library) = library();
        for title in [
            "my-note-10",
            "my-note-002",
            "B001-note",
            "my-note-1",
            "b9-note",
            "001-note",
            "2-note",
        ] {
            add_note(&library, title, "<p>Body</p>", &["t10", "t9", "T1"]);
        }
        let listed = |sort| {
            library
                .list_notes(&NoteFilter {
                    sort,
                    ..NoteFilter::default()
                })
                .unwrap()
        };
        let ascending = listed(NoteSort::TitleAsc);
        assert_eq!(
            titles(&ascending),
            [
                "001-note",
                "2-note",
                "B001-note",
                "b9-note",
                "my-note-1",
                "my-note-002",
                "my-note-10"
            ]
        );
        assert_eq!(ascending.notes[0].tags, ["T1", "t9", "t10"]);
        let mut descending = listed(NoteSort::TitleDesc);
        descending.notes.reverse();
        assert_eq!(titles(&descending), titles(&ascending));
        // Tags and notebooks are listed the same way.
        library.ensure_notebook("Week 10", None).unwrap();
        library.ensure_notebook("Week 9", None).unwrap();
        let snapshot = library.snapshot().unwrap();
        assert_eq!(
            snapshot
                .tags
                .iter()
                .map(|tag| tag.name.as_str())
                .collect::<Vec<_>>(),
            ["T1", "t9", "t10"]
        );
        assert_eq!(
            snapshot
                .notebooks
                .iter()
                .map(|notebook| notebook.name.as_str())
                .collect::<Vec<_>>(),
            ["Inbox", "Week 9", "Week 10"]
        );
        assert_eq!(
            library.get_note(&ascending.notes[0].id).unwrap().tags,
            // On the note itself, in the order they were put on it.
            ["t10", "t9", "T1"]
        );
    }

    #[test]
    fn a_misspelt_word_finds_what_the_right_spelling_would() {
        let (_directory, library) = library();
        add_note(
            &library,
            "Project roadmap",
            "<p>Quarterly budget and planning</p>",
            &[],
        );
        add_note(
            &library,
            "Gardening",
            "<p>Tomatoes in the greenhouse</p>",
            &[],
        );
        add_note(
            &library,
            "Receipt",
            "<p>Paid for the definitely necessary tools</p>",
            &[],
        );
        for index in 0..5 {
            add_note(&library, &format!("Other {index}"), "<p>Nothing</p>", &[]);
        }
        // Two letters in each other's place, a letter missing, a letter too
        // many, another letter; in a word of eight letters or more, two slips.
        for (typed, understood, title) in [
            ("roadmpa", "roadmap", "Project roadmap"),
            ("buget", "budget", "Project roadmap"),
            ("gardenning", "gardening", "Gardening"),
            ("reciept", "receipt", "Receipt"),
            ("tomatos", "tomatoes", "Gardening"),
            ("definatly", "definitely", "Receipt"),
            ("greenhuose", "greenhouse", "Gardening"),
        ] {
            let page = search(&library, typed);
            assert_eq!(titles(&page), [title], "{typed}");
            assert_eq!(page.corrected.as_deref(), Some(understood), "{typed}");
            // The word that was found is the one marked.
            let marked = format!("{SNIPPET_MATCH_START}{understood}{SNIPPET_MATCH_END}");
            if title != "Project roadmap" || typed == "buget" {
                assert!(
                    page.notes[0].snippet.to_lowercase().contains(&marked)
                        || page.notes[0].title.to_lowercase().contains(understood),
                    "{typed}: {:?}",
                    page.notes[0].snippet
                );
            }
        }
        // One misspelt word among others that are right.
        let page = search(&library, "quarterly buget planing");
        assert_eq!(titles(&page), ["Project roadmap"]);
        assert_eq!(page.corrected.as_deref(), Some("quarterly budget planning"));
        // A word still being typed: its beginning is what is misspelt.
        let page = search(&library, "greenhuo");
        assert_eq!(titles(&page), ["Gardening"]);
        assert_eq!(page.corrected.as_deref(), Some("greenhouse"));
        // The other pages of such a search are pages of the same search.
        let later = library
            .list_notes(&NoteFilter {
                query: "roadmpa".into(),
                sort: NoteSort::Relevance,
                limit: 10,
                offset: 10,
                ..NoteFilter::default()
            })
            .unwrap();
        assert_eq!((later.notes.len(), later.total), (0, 1));
    }

    #[test]
    fn spelling_is_only_helped_where_nothing_was_found_as_typed() {
        let (_directory, library) = library();
        add_note(&library, "Form", "<p>A from and a form</p>", &[]);
        add_note(&library, "Cart", "<p>The cart before the horse</p>", &[]);
        // Found as typed: nothing is respelt, however near another word is.
        let page = search(&library, "form");
        assert_eq!((page.total, page.corrected.as_deref()), (1, None));
        // A quoted word is meant as written, and a short one is too little
        // to tell a slip from another word.
        assert_eq!(search(&library, "\"hosre\"").total, 0);
        assert_eq!(search(&library, "cat").total, 0);
        assert_eq!(search(&library, "crt").total, 0);
        // Too far from any word, or beginning with another letter.
        assert_eq!(search(&library, "hippopotamus").total, 0);
        assert_eq!(search(&library, "worse").total, 0);
        // Operators are not words.
        assert_eq!(search(&library, "tag:hosre").total, 0);
        let page = search(&library, "hosre -tag:nothing");
        assert_eq!(titles(&page), ["Cart"]);
        assert_eq!(page.corrected.as_deref(), Some("horse -tag:nothing"));
        // A listing without a search is never respelt.
        let listed = library.list_notes(&NoteFilter::default()).unwrap();
        assert_eq!(listed.corrected, None);
    }

    #[test]
    fn slips_of_the_hand_are_counted() {
        let count = |typed: &str, word: &str, most| {
            slips(
                &typed.chars().collect::<Vec<_>>(),
                &word.chars().collect::<Vec<_>>(),
                most,
            )
        };
        assert_eq!(count("garden", "garden", 1), Some(0));
        assert_eq!(count("gadren", "garden", 1), Some(1));
        assert_eq!(count("gaden", "garden", 1), Some(1));
        assert_eq!(count("gardden", "garden", 1), Some(1));
        assert_eq!(count("gurden", "garden", 1), Some(1));
        assert_eq!(count("gurdan", "garden", 1), None);
        assert_eq!(count("gurdan", "garden", 2), Some(2));
        assert_eq!(count("gar", "garden", 2), None);
        assert_eq!(count("", "ab", 2), Some(2));
    }

    #[test]
    fn the_title_comes_before_the_notebook_the_tags_and_the_text() {
        let (_directory, library) = library();
        let orchard = library.ensure_notebook("Apple orchard", None).unwrap();
        // Listed here from the worst answer to the best.
        let in_text = add_note(&library, "In the text", "<p>An apple a day</p>", &[]);
        add_note(&library, "By its tag", "<p>Nothing</p>", &["apple"]);
        let filed = library.create_note(Some(&orchard)).unwrap();
        library
            .save_note(&SaveNote {
                id: filed.id.clone(),
                notebook_id: orchard.clone(),
                title: "In the notebook".into(),
                content_html: "<p>Nothing</p>".into(),
                attributes: json!({}),
                tags: vec![],
                base_revision: None,
            })
            .unwrap();
        add_note(&library, "Apple pie", "<p>Nothing</p>", &[]);
        for index in 0..5 {
            add_note(&library, &format!("Other {index}"), "<p>Nothing</p>", &[]);
        }
        assert_eq!(
            titles(&search(&library, "apple")),
            ["Apple pie", "In the notebook", "By its tag", "In the text"]
        );
        // Words in different fields of a note still find it.
        assert_eq!(
            titles(&search(&library, "orchard nothing")),
            ["In the notebook"]
        );

        // The index follows a notebook that is renamed and a note that is
        // moved, by whatever means.
        library.rename_notebook(&orchard, "Pear garden").unwrap();
        assert_eq!(
            titles(&search(&library, "apple")),
            ["Apple pie", "By its tag", "In the text"]
        );
        assert_eq!(titles(&search(&library, "pear")), ["In the notebook"]);
        library.move_notes(&[in_text], &orchard).unwrap();
        let mut moved = search(&library, "garden");
        moved.notes.sort_by(|a, b| a.title.cmp(&b.title));
        assert_eq!(titles(&moved), ["In the notebook", "In the text"]);
    }

    #[test]
    fn words_in_the_order_typed_and_near_each_other_come_first() {
        let (_directory, library) = library();
        // Listed here from the worst answer to the best: in the text first.
        add_note(
            &library,
            "Text, another order",
            "<p>apple pie is what my aunt bakes</p>",
            &[],
        );
        add_note(
            &library,
            "Text, far",
            "<p>my neighbour once grew an apple</p>",
            &[],
        );
        add_note(&library, "Text, near", "<p>my green apple</p>", &[]);
        add_note(&library, "Text, together", "<p>this is my apple</p>", &[]);
        add_note(
            &library,
            "By tags apart",
            "<p>Nothing</p>",
            &["my", "apple"],
        );
        add_note(&library, "By one tag", "<p>Nothing</p>", &["my apple"]);
        add_note(&library, "Apple of my eye", "<p>Nothing</p>", &[]);
        add_note(&library, "My very dear apple", "<p>Nothing</p>", &[]);
        add_note(&library, "My dear apple", "<p>Nothing</p>", &[]);
        add_note(&library, "This is my apple tree", "<p>Nothing</p>", &[]);
        add_note(&library, "My apple tree", "<p>Nothing</p>", &[]);
        add_note(&library, "My apple", "<p>Nothing</p>", &[]);
        for index in 0..5 {
            add_note(&library, &format!("Other {index}"), "<p>Nothing</p>", &[]);
        }
        assert_eq!(
            titles(&search(&library, "my apple")),
            [
                "My apple",
                "My apple tree",
                "This is my apple tree",
                "My dear apple",
                "My very dear apple",
                "Apple of my eye",
                "By one tag",
                "By tags apart",
                "Text, together",
                "Text, near",
                "Text, far",
                "Text, another order",
            ]
        );
    }

    #[test]
    fn how_words_stand_among_others_is_told() {
        let words = |text: &'static str| text.split(' ').collect::<Vec<_>>();
        let searched = |text: &str| {
            text.split(' ')
                .map(|word| (word.to_owned(), false))
                .collect::<Vec<_>>()
        };
        let my_apple = searched("my apple");
        assert_eq!(among(&words("my apple"), &my_apple), Some((Some(0), true)));
        assert_eq!(
            among(&words("oh my dear old apple"), &my_apple),
            Some((Some(2), true))
        );
        // The nearest of several ways counts.
        assert_eq!(
            among(&words("my old apple and my apple"), &my_apple),
            Some((Some(0), true))
        );
        assert_eq!(
            among(&words("apple of my eye"), &my_apple),
            Some((None, true))
        );
        assert_eq!(
            among(&words("my apples"), &my_apple),
            Some((Some(0), false))
        );
        assert_eq!(among(&words("my pear"), &my_apple), None);
        // Places as the index gives them.
        assert_eq!(least_between(&[&vec![4, 9], &vec![2, 12]]), Some(2));
        assert_eq!(least_between(&[&vec![4, 9], &vec![2, 10]]), Some(0));
        assert_eq!(least_between(&[&vec![9], &vec![2]]), None);
        assert_eq!(least_between(&[&vec![1], &vec![3], &vec![2, 6]]), Some(3));
    }
}
