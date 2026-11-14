//! Evernote's tasks, brought into a note as the items of a checklist.
//!
//! Evernote keeps a task apart from the text of the note it is in. The
//! note's markup has only the place of a group of tasks: an element whose
//! style says `--en-task-group:true` and names the group in `--en-id`. The
//! tasks themselves are beside the note: an export has each as a `<task>`
//! element after the note's attributes, and Evernote's own files have them
//! in a table.
//!
//! Bever has no tasks, and a note that showed an empty box where they were
//! would have lost what they say. So each group becomes a checklist where it
//! stood: an item for each task in Evernote's order, ticked when the task is
//! completed, followed by the day it is due and the times it is to remind
//! of. From then on it is an ordinary checklist of the note.
use std::{collections::HashMap, fmt::Display};

use chrono::{Local, TimeZone};
use quick_xml::{events::Event, Reader};
use regex::Regex;

use crate::enex::{parse_enex_date, resolve_reference};

/// One task of a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    /// The group it is in: what the note's markup has as `--en-id`.
    pub group: String,
    pub title: String,
    pub done: bool,
    /// Evernote's key for the order within the group, the least first.
    pub weight: String,
    pub created: i64,
    pub due: Option<i64>,
    /// The task is due on a day, not at a time of it.
    pub due_is_a_day: bool,
    /// When it is to remind, for each reminder that is not muted.
    pub reminders: Vec<i64>,
}

/// A `<task>` element as an export has it (`evernote-export4.dtd`), or
/// `None` when `element` is something else or lacks what a task must have.
pub fn from_export(element: &str) -> Option<Task> {
    let mut reader = Reader::from_str(element);
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut reminders: Vec<HashMap<String, String>> = Vec::new();
    loop {
        match reader.read_event().ok()? {
            Event::Start(start) => {
                let name = start.name().as_ref().to_owned();
                if path.is_empty() && name != "task" {
                    return None;
                }
                if path.len() == 1 && name == "reminder" {
                    reminders.push(HashMap::new());
                }
                path.push(name);
                text.clear();
            }
            Event::Text(part) => match quick_xml::escape::unescape(&part) {
                Ok(plain) => text.push_str(&plain),
                Err(_) => text.push_str(&part),
            },
            Event::CData(part) => text.push_str(&part),
            Event::GeneralRef(name) => text.push_str(&resolve_reference(&name)),
            Event::End(_) => {
                let name = path.pop()?;
                let value = std::mem::take(&mut text);
                match path.len() {
                    1 => {
                        fields.insert(name, value);
                    }
                    2 if path[1] == "reminder" => {
                        reminders.last_mut()?.insert(name, value);
                    }
                    _ => {}
                }
            }
            // A field that is there and says nothing.
            Event::Empty(empty) if path.len() == 1 => {
                fields.insert(empty.name().as_ref().to_owned(), String::new());
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let field = |name: &str| fields.get(name).map(|value| value.trim());
    let date = |value: Option<&str>| {
        value
            .filter(|value| !value.is_empty())
            .and_then(|value| parse_enex_date(value).ok())
    };
    Some(Task {
        group: field("taskGroupNoteLevelID")
            .filter(|group| !group.is_empty())?
            .to_owned(),
        title: field("title")?.to_owned(),
        done: field("taskStatus")? == "completed",
        weight: field("sortWeight").unwrap_or_default().to_owned(),
        created: date(field("created")).unwrap_or(0),
        due: date(field("dueDate")),
        due_is_a_day: field("dueDateUIOption") == Some("date_only"),
        reminders: reminders
            .iter()
            .filter(|reminder| {
                reminder.get("reminderStatus").map(|status| status.trim()) != Some("muted")
            })
            .filter_map(|reminder| date(reminder.get("reminderDate").map(|value| value.trim())))
            .collect(),
    })
}

/// `content`, a note's markup, with each group of `tasks` as a checklist in
/// the group's place; a group that has no place in the markup comes at the
/// note's end. Times are written as this computer's clock has them.
pub fn place(content: &str, tasks: &[Task]) -> String {
    place_in(content, tasks, &Local)
}

pub(crate) fn place_in<Z: TimeZone>(content: &str, tasks: &[Task], zone: &Z) -> String
where
    Z::Offset: Display,
{
    if tasks.is_empty() {
        return content.to_owned();
    }
    let mut sorted: Vec<&Task> = tasks.iter().collect();
    sorted.sort_by(|a, b| {
        (a.weight.as_str(), a.created, a.title.as_str()).cmp(&(
            b.weight.as_str(),
            b.created,
            b.title.as_str(),
        ))
    });
    let mut groups: Vec<(&str, Vec<&Task>)> = Vec::new();
    for task in sorted {
        match groups
            .iter_mut()
            .find(|(group, _)| group.eq_ignore_ascii_case(&task.group))
        {
            Some((_, list)) => list.push(task),
            None => groups.push((&task.group, vec![task])),
        }
    }

    let opening = Regex::new(r"<div\b[^>]*--en-task-group:\s*true[^>]*>").expect("valid regex");
    let named = Regex::new(r"--en-id:\s*([0-9A-Za-z-]+)").expect("valid regex");
    let div = Regex::new(r"<(/?)div\b[^>]*?(/?)>").expect("valid regex");
    // Where each group stands: from the beginning of its element to its end.
    let mut places: Vec<(usize, usize, usize)> = Vec::new();
    for found in opening.find_iter(content) {
        let Some(name) = named.captures(found.as_str()) else {
            continue;
        };
        let Some(group) = groups
            .iter()
            .position(|(group, _)| group.eq_ignore_ascii_case(&name[1]))
        else {
            continue;
        };
        if places.iter().any(|(_, _, placed)| *placed == group) {
            continue;
        }
        let closed_at_once = found.as_str().ends_with("/>");
        if let Some(end) = element_end(content, found.end(), closed_at_once, &div) {
            // A group inside another's element goes with that one.
            if places
                .last()
                .is_none_or(|(_, last, _)| found.start() >= *last)
            {
                places.push((found.start(), end, group));
            }
        }
    }
    let mut out = content.to_owned();
    // The last first, so that what stands before each stays where it is.
    for (start, end, group) in places.iter().rev() {
        out.replace_range(*start..*end, &checklist(&groups[*group].1, zone));
    }
    let rest: String = groups
        .iter()
        .enumerate()
        .filter(|(index, _)| !places.iter().any(|(_, _, placed)| placed == index))
        .map(|(_, (_, list))| checklist(list, zone))
        .collect();
    if !rest.is_empty() {
        match out.rfind("</en-note>") {
            Some(at) => out.insert_str(at, &rest),
            None => out.push_str(&rest),
        }
    }
    out
}

/// Where the element ends whose opening tag ends at `from`.
fn element_end(content: &str, from: usize, closed_at_once: bool, div: &Regex) -> Option<usize> {
    if closed_at_once {
        return Some(from);
    }
    let mut depth = 1;
    for tag in div.captures_iter(&content[from..]) {
        if !tag[1].is_empty() {
            depth -= 1;
            if depth == 0 {
                return Some(from + tag.get(0)?.end());
            }
        } else if tag[2].is_empty() {
            depth += 1;
        }
    }
    None
}

/// The tasks as a checklist, written the way Evernote writes a checklist.
fn checklist<Z: TimeZone>(tasks: &[&Task], zone: &Z) -> String
where
    Z::Offset: Display,
{
    let mut out = String::from("<ul style=\"--en-todo:true;\">");
    for task in tasks {
        out.push_str(if task.done {
            "<li style=\"--en-checked:true;\"><div>"
        } else {
            "<li style=\"--en-checked:false;\"><div>"
        });
        let words = words(task, zone);
        if words.is_empty() {
            out.push_str("<br/>");
        }
        for character in words.chars() {
            match character {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                // Not characters of XML.
                '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => {}
                '\n' | '\r' | '\t' => out.push(' '),
                other => out.push(other),
            }
        }
        out.push_str("</div></li>");
    }
    out.push_str("</ul>");
    out
}

/// What the task says, with when it is due and when it reminds.
fn words<Z: TimeZone>(task: &Task, zone: &Z) -> String
where
    Z::Offset: Display,
{
    let time = |at: i64, day: bool| {
        zone.timestamp_millis_opt(at).single().map(|at| {
            at.format(if day { "%Y-%m-%d" } else { "%Y-%m-%d %H:%M" })
                .to_string()
        })
    };
    let mut notes = Vec::new();
    if let Some(due) = task.due.and_then(|at| time(at, task.due_is_a_day)) {
        notes.push(format!("due {due}"));
    }
    for reminder in &task.reminders {
        if let Some(at) = time(*reminder, false) {
            notes.push(format!("reminder {at}"));
        }
    }
    let title = task.title.trim();
    if notes.is_empty() {
        title.to_owned()
    } else if title.is_empty() {
        format!("({})", notes.join("; "))
    } else {
        format!("{title} ({})", notes.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;

    use super::*;
    use crate::enml::enml_to_html;

    const GROUP: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const OTHER: &str = "bbbbbbbb-0000-4000-8000-000000000002";

    fn task(group: &str, title: &str, done: bool, weight: &str) -> Task {
        Task {
            group: group.to_owned(),
            title: title.to_owned(),
            done,
            weight: weight.to_owned(),
            created: 0,
            due: None,
            due_is_a_day: false,
            reminders: Vec::new(),
        }
    }

    /// A group's place as Evernote writes it: an element that holds what a
    /// program without tasks is to show instead.
    fn place_of(group: &str) -> String {
        format!(
            r#"<div style="--en-task-group:true; --en-id:{group};--en-content-hash:00112233445566778899aabbccddeeff;user-modify:read-only;border:1px solid rgba(182,182,182,0.09)"><div style="background:rgba(182,182,182,0.09) no-repeat 6px 6px url(&quot;data:image/svg+xml;base64,AAAA&quot;)"><div>Tasks</div></div></div>"#
        )
    }

    fn zone() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    #[test]
    fn a_group_of_tasks_becomes_a_checklist_where_it_stood_in_evernotes_order() {
        let content = format!(
            "<en-note><div>Before</div>{}<div>After</div></en-note>",
            place_of(GROUP)
        );
        let tasks = [
            task(GROUP, "Second, done", true, "M"),
            task(GROUP, "Third", false, "X"),
            task(GROUP, "First & <foremost>", false, "E"),
        ];
        assert_eq!(
            place_in(&content, &tasks, &zone()),
            r#"<en-note><div>Before</div><ul style="--en-todo:true;"><li style="--en-checked:false;"><div>First &amp; &lt;foremost></div></li><li style="--en-checked:true;"><div>Second, done</div></li><li style="--en-checked:false;"><div>Third</div></li></ul><div>After</div></en-note>"#
        );
        // The editor reads it as a checklist with its ticks.
        let html = enml_to_html(&place_in(&content, &tasks, &zone()));
        assert!(html.contains(r#"<ul data-type="taskList""#));
        assert_eq!(html.matches(r#"data-checked="true""#).count(), 1);
        assert_eq!(html.matches(r#"data-checked="false""#).count(), 2);
    }

    #[test]
    fn each_group_goes_to_its_own_place_and_one_without_a_place_to_the_end() {
        let content = format!(
            "<en-note>{}<div>Between</div>{}</en-note>",
            place_of(GROUP),
            place_of(OTHER)
        );
        let tasks = [
            task(OTHER, "In the second", false, "B"),
            task("11111111-0000-4000-8000-000000000003", "Nowhere", true, "B"),
            task(GROUP, "In the first", false, "B"),
        ];
        let placed = place_in(&content, &tasks, &zone());
        let first = placed.find("In the first").unwrap();
        let between = placed.find("Between").unwrap();
        let second = placed.find("In the second").unwrap();
        let nowhere = placed.find("Nowhere").unwrap();
        assert!(first < between && between < second && second < nowhere);
        assert!(placed.ends_with("</ul></en-note>"));
        assert!(!placed.contains("en-task-group"));

        // A place whose tasks are not there is left as it is, and a note
        // without tasks is not touched.
        let alone = place_in(&content, &[task(GROUP, "One", false, "B")], &zone());
        assert_eq!(alone.matches("en-task-group").count(), 1);
        assert_eq!(place_in(&content, &[], &zone()), content);
    }

    #[test]
    fn when_a_task_is_due_and_reminds_is_said_after_it() {
        let at = |hour, minute, second| {
            zone()
                .with_ymd_and_hms(2026, 11, 20, hour, minute, second)
                .unwrap()
                .timestamp_millis()
        };
        // The last moment of a day is how Evernote keeps a day: in another
        // part of the world it is the same day, or the one after.
        let mut whole_day = task(GROUP, "Pay", false, "B");
        whole_day.due = Some(at(23, 59, 59) + 999);
        whole_day.due_is_a_day = true;
        let mut timed = task(GROUP, "Call", true, "C");
        timed.due = Some(at(9, 0, 0));
        timed.reminders = vec![at(8, 30, 0)];
        let mut nameless = task(GROUP, " ", false, "D");
        nameless.reminders = vec![at(9, 0, 0)];
        let placed = place_in(
            "<en-note></en-note>",
            &[whole_day, timed, nameless],
            &zone(),
        );
        assert!(
            placed.contains("<div>Pay (due 2026-11-20)</div>"),
            "{placed}"
        );
        assert!(
            placed.contains("<div>Call (due 2026-11-20 09:00; reminder 2026-11-20 08:30)</div>"),
            "{placed}"
        );
        assert!(
            placed.contains("<div>(reminder 2026-11-20 09:00)</div>"),
            "{placed}"
        );
        assert!(placed.ends_with("</ul></en-note>"));
    }

    #[test]
    fn a_task_is_read_from_an_export() {
        let element = "<task>\n      <title>Renew &amp; file</title>\n      <created>20240102T030405Z</created>\n      <updated>20240103T030405Z</updated>\n      <taskStatus>completed</taskStatus>\n      <inNote>true</inNote>\n      <taskFlag>false</taskFlag>\n      <sortWeight>M</sortWeight>\n      <noteLevelID>aaaaaaaa-0000-4000-8000-000000000009</noteLevelID>\n      <taskGroupNoteLevelID>aaaaaaaa-0000-4000-8000-000000000001</taskGroupNoteLevelID>\n      <dueDate>20240105T182959Z</dueDate>\n      <dueDateUIOption>date_only</dueDateUIOption>\n      <timeZone>Europe/Paris</timeZone>\n      <reminder>\n        <created>20240102T030405Z</created>\n        <updated>20240102T030405Z</updated>\n        <noteLevelID>bbbbbbbb-0000-4000-8000-000000000009</noteLevelID>\n        <reminderDate>20240105T033000Z</reminderDate>\n        <reminderStatus>active</reminderStatus>\n      </reminder>\n      <reminder>\n        <created>20240102T030405Z</created>\n        <updated>20240102T030405Z</updated>\n        <noteLevelID>cccccccc-0000-4000-8000-000000000009</noteLevelID>\n        <reminderDate>20240104T033000Z</reminderDate>\n        <reminderStatus>muted</reminderStatus>\n      </reminder>\n    </task>";
        let read = from_export(element).unwrap();
        assert_eq!(read.group, GROUP);
        assert_eq!(read.title, "Renew & file");
        assert!(read.done);
        assert_eq!(read.weight, "M");
        assert_eq!(read.created, parse_enex_date("20240102T030405Z").unwrap());
        assert_eq!(read.due, Some(parse_enex_date("20240105T182959Z").unwrap()));
        assert!(read.due_is_a_day);
        assert_eq!(
            read.reminders,
            [parse_enex_date("20240105T033000Z").unwrap()]
        );

        // Something else beside a note, and a task without what it must have.
        assert_eq!(from_export("<something><title>x</title></something>"), None);
        assert_eq!(
            from_export("<task><title>x</title><taskStatus>open</taskStatus></task>"),
            None
        );
        assert_eq!(from_export("not markup"), None);
    }
}
