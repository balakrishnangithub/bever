//! Times listing and searching a library of made-up notes.
//!
//! ```sh
//! cargo run --release -p bever-core --example bench_search -- 5000
//! ```
//!
//! The library is made in a temporary folder and removed afterwards. With
//! `--library <folder>` an existing library is timed instead: give it a copy,
//! since opening a library may bring its database up to date. Only timings
//! and counts are printed. The figures are for comparing one build with
//! another on the same computer.
use std::time::Instant;

use bever_core::{
    models::{NoteFilter, NoteSort, SaveNote},
    Library, Result,
};
use serde_json::json;

const WORDS: [&str; 48] = [
    "roadmap", "meeting", "budget", "travel", "recipe", "invoice", "design", "review", "garden",
    "physics", "algebra", "reading", "project", "weekly", "summary", "launch", "server", "kernel",
    "matrix", "holiday", "doctor", "school", "music", "guitar", "camera", "photo", "letter",
    "report", "planning", "research", "notebook", "example", "function", "variable", "equation",
    "history", "science", "language", "practice", "exercise", "chapter", "lesson", "problem",
    "solution", "question", "answer", "theory", "method",
];

/// A small generator, so that every run makes the same library.
struct Random(u64);

impl Random {
    fn next(&mut self) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as usize
    }

    fn word(&mut self) -> &'static str {
        WORDS[self.next() % WORDS.len()]
    }

    fn words(&mut self, count: usize) -> String {
        (0..count)
            .map(|_| self.word())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn timed<T>(label: &str, runs: u32, mut work: impl FnMut() -> Result<T>) -> Result<T> {
    let mut last = None;
    let started = Instant::now();
    for _ in 0..runs {
        last = Some(work()?);
    }
    println!(
        "{label}: {:.1} ms",
        started.elapsed().as_secs_f64() * 1000.0 / f64::from(runs)
    );
    Ok(last.expect("at least one run"))
}

fn main() -> Result<()> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(at) = arguments
        .iter()
        .position(|argument| argument == "--library")
    {
        let folder = arguments.get(at + 1).expect("--library needs a folder");
        let library = Library::open(folder)?;
        let count = library.counts()?.all as usize;
        println!("{count} notes in the library given");
        return measure(
            &library,
            count,
            &[
                "a",
                "th",
                "note",
                "the plan",
                "how to in",
                "2024",
                // Misspelt, and not a word at all: what a search that finds
                // nothing as typed costs.
                "algorthm",
                "recieve",
                "definatly",
                "qzxvkjw",
            ],
        );
    }
    let count = arguments
        .first()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5000);
    let directory = tempfile::tempdir()?;
    let library = Library::open(directory.path())?;
    let mut random = Random(0x9E37_79B9_7F4A_7C15);
    let notebooks = (0..12)
        .map(|index| library.ensure_notebook(&format!("Notebook {index}"), None))
        .collect::<Result<Vec<_>>>()?;
    let started = Instant::now();
    for index in 0..count {
        let notebook = &notebooks[random.next() % notebooks.len()];
        let note = library.create_note(Some(notebook))?;
        let paragraphs = (0..6)
            .map(|_| format!("<p>{}</p>", random.words(40)))
            .collect::<String>();
        let tags = (0..random.next() % 4)
            .map(|_| format!("tag-{}", random.next() % 60))
            .collect::<Vec<_>>();
        library.save_note(&SaveNote {
            id: note.id.clone(),
            notebook_id: notebook.clone(),
            title: format!("{} {index:05}", random.words(3)),
            content_html: paragraphs,
            attributes: json!({}),
            tags,
            base_revision: None,
        })?;
        if index % 3 == 0 {
            let bytes = format!("attachment {index}");
            library.add_resource(&note.id, &mut bytes.as_bytes(), "file.txt", None)?;
        }
    }
    println!("{count} notes made in {:.1?}", started.elapsed());
    measure(
        &library,
        count,
        &["r", "ro", "roadmap", "roadmap budget", "weekly summary re"],
    )
}

fn measure(library: &Library, count: usize, queries: &[&str]) -> Result<()> {
    timed("notebooks, tags, and counts", 20, || {
        library.snapshot()?;
        library.counts()
    })?;
    let list = |sort: NoteSort, query: &str, offset: u32| {
        library.list_notes(&NoteFilter {
            query: query.to_owned(),
            sort,
            limit: 60,
            offset,
            ..NoteFilter::default()
        })
    };
    timed("first page, recently updated", 20, || {
        list(NoteSort::UpdatedDesc, "", 0)
    })?;
    timed("a page in the middle, recently updated", 20, || {
        list(NoteSort::UpdatedDesc, "", (count / 2) as u32)
    })?;
    timed("first page, newest created", 20, || {
        list(NoteSort::CreatedDesc, "", 0)
    })?;
    timed("first page, by title", 20, || {
        list(NoteSort::TitleAsc, "", 0)
    })?;
    timed("last page, by title", 20, || {
        list(NoteSort::TitleAsc, "", count.saturating_sub(60) as u32)
    })?;
    for query in queries {
        let page = timed(&format!("search “{query}”"), 20, || {
            list(NoteSort::Relevance, query, 0)
        })?;
        println!(
            "    {} matches{}",
            page.total,
            if page.corrected.is_some() {
                ", by another spelling"
            } else {
                ""
            }
        );
    }
    Ok(())
}
