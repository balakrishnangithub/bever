//! Notebooks, stacks, tags, and shortcuts.
//!
//! Every deletion here leaves a tombstone in `sync_tombstones`, because the
//! synchronized metadata is otherwise merged additively and a deleted item
//! would return from another device.
use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{Notebook, Stack, Tag, Tombstone},
    repository::{default_notebook, normalized_name, reindex_note},
};

impl Library {
    pub fn ensure_notebook(&self, name: &str, stack_id: Option<&str>) -> Result<String> {
        let name = normalized_name(name)?;
        let connection = self.connection.lock();
        ensure_notebook_with(&connection, name, stack_id)
    }

    pub fn rename_notebook(&self, id: &str, name: &str) -> Result<()> {
        let name = normalized_name(name)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let taken = transaction
            .prepare("SELECT 1 FROM notebooks WHERE name = ?1 COLLATE NOCASE AND id != ?2")?
            .exists(params![name, id])?;
        if taken {
            return Err(BeverError::Invalid(format!(
                "a notebook named “{name}” already exists"
            )));
        }
        let changed = transaction.execute(
            "UPDATE notebooks SET name = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?1",
            params![id, name, Utc::now().timestamp_millis()],
        )?;
        if changed == 0 {
            return Err(BeverError::NotFound(format!("notebook {id}")));
        }
        relabel_shortcut(&transaction, "notebook", id, name)?;
        transaction.commit()?;
        Ok(())
    }

    /// Deletes a notebook. Its notes move to the trash and, because every
    /// note needs a notebook, into the default one. Returns how many notes
    /// were moved. The last remaining notebook cannot be deleted.
    pub fn delete_notebook(&self, id: &str) -> Result<u64> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let exists = transaction
            .prepare("SELECT 1 FROM notebooks WHERE id = ?1")?
            .exists([id])?;
        if !exists {
            return Err(BeverError::NotFound(format!("notebook {id}")));
        }
        let fallback = default_notebook(&transaction, Some(id))
            .map_err(|_| BeverError::Invalid("the last notebook cannot be deleted".into()))?;
        let now = Utc::now().timestamp_millis();
        let moved = transaction.execute(
            "UPDATE notes SET notebook_id = ?2, deleted_at = COALESCE(deleted_at, ?3), revision = revision + 1, dirty = 1 WHERE notebook_id = ?1",
            params![id, fallback, now],
        )?;
        remove_shortcut(&transaction, "notebook", id, now, true)?;
        transaction.execute("DELETE FROM notebooks WHERE id = ?1", [id])?;
        record_tombstone(&transaction, "notebook", id, now)?;
        transaction.commit()?;
        Ok(moved as u64)
    }

    pub fn set_notebook_stack(
        &self,
        notebook_id: &str,
        stack_id: Option<&str>,
    ) -> Result<Notebook> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE notebooks SET stack_id = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?1",
            params![notebook_id, stack_id, Utc::now().timestamp_millis()],
        )?;
        if changed == 0 {
            return Err(BeverError::NotFound(format!("notebook {notebook_id}")));
        }
        let notebook = connection.query_row(
            "SELECT id, name, stack_id, created_at, updated_at, revision FROM notebooks WHERE id = ?1",
            [notebook_id],
            |row| {
                Ok(Notebook {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    stack_id: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    revision: row.get(5)?,
                })
            },
        )?;
        Ok(notebook)
    }

    pub fn create_stack(&self, name: &str) -> Result<Stack> {
        let name = normalized_name(name)?;
        let now = Utc::now().timestamp_millis();
        let stack = Stack {
            id: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            created_at: now,
            updated_at: now,
            revision: 1,
        };
        let connection = self.connection.lock();
        let taken = connection
            .prepare("SELECT 1 FROM stacks WHERE name = ?1 COLLATE NOCASE")?
            .exists([name])?;
        if taken {
            return Err(BeverError::Invalid(format!(
                "a stack named “{name}” already exists"
            )));
        }
        connection.execute(
            "INSERT INTO stacks(id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![stack.id, stack.name, now],
        )?;
        Ok(stack)
    }

    /// The stack named `name`, made if there is none.
    pub fn ensure_stack(&self, name: &str) -> Result<String> {
        let name = normalized_name(name)?;
        let existing = {
            let connection = self.connection.lock();
            connection
                .query_row(
                    "SELECT id FROM stacks WHERE name = ?1 COLLATE NOCASE",
                    [name],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        };
        match existing {
            Some(id) => Ok(id),
            None => Ok(self.create_stack(name)?.id),
        }
    }

    pub fn rename_stack(&self, id: &str, name: &str) -> Result<()> {
        let name = normalized_name(name)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let taken = transaction
            .prepare("SELECT 1 FROM stacks WHERE name = ?1 COLLATE NOCASE AND id != ?2")?
            .exists(params![name, id])?;
        if taken {
            return Err(BeverError::Invalid(format!(
                "a stack named “{name}” already exists"
            )));
        }
        let changed = transaction.execute(
            "UPDATE stacks SET name = ?2, updated_at = ?3, revision = revision + 1 WHERE id = ?1",
            params![id, name, Utc::now().timestamp_millis()],
        )?;
        if changed == 0 {
            return Err(BeverError::NotFound(format!("stack {id}")));
        }
        relabel_shortcut(&transaction, "stack", id, name)?;
        transaction.commit()?;
        Ok(())
    }

    /// Deletes a stack; its notebooks stay and become unstacked.
    pub fn delete_stack(&self, id: &str) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let now = Utc::now().timestamp_millis();
        // Recorded as a notebook change so the unstacking reaches other devices.
        transaction.execute(
            "UPDATE notebooks SET stack_id = NULL, updated_at = ?2, revision = revision + 1 WHERE stack_id = ?1",
            params![id, now],
        )?;
        let removed = transaction.execute("DELETE FROM stacks WHERE id = ?1", [id])?;
        if removed == 0 {
            return Err(BeverError::NotFound(format!("stack {id}")));
        }
        remove_shortcut(&transaction, "stack", id, now, true)?;
        record_tombstone(&transaction, "stack", id, now)?;
        transaction.commit()?;
        Ok(())
    }

    /// The tag named `name`, made under `parent_id` if there is none. A
    /// note carries its tags by name, so a name is one tag wherever it is
    /// nested: a tag that exists is returned as it is, where it is.
    pub fn create_tag(&self, name: &str, parent_id: Option<&str>) -> Result<Tag> {
        let name = normalized_name(name)?;
        let connection = self.connection.lock();
        let existing = connection
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE ORDER BY parent_id IS ?2 DESC LIMIT 1",
                params![name, parent_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let id = match existing {
            Some(id) => id,
            None => {
                let id = Uuid::new_v4().to_string();
                let now = Utc::now().timestamp_millis();
                connection.execute(
                    "INSERT INTO tags(id, name, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, name, parent_id, now],
                )?;
                id
            }
        };
        tag_with(&connection, &id)
    }

    pub fn rename_tag(&self, id: &str, name: &str) -> Result<()> {
        let name = normalized_name(name)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        tag_with(&transaction, id)?;
        let taken = transaction
            .prepare("SELECT 1 FROM tags WHERE lower(name) = lower(?1) AND id != ?2")?
            .exists(params![name, id])?;
        if taken {
            return Err(BeverError::Invalid(format!(
                "a tag named “{name}” already exists"
            )));
        }
        let now = Utc::now().timestamp_millis();
        transaction.execute(
            "UPDATE tags SET name = ?2, updated_at = max(?3, created_at + 1) WHERE id = ?1",
            params![id, name, now],
        )?;
        relabel_shortcut(&transaction, "tag", id, name)?;
        // Notes carry tag names when synchronized and indexed.
        mark_tagged_notes_changed(&transaction, &[id.to_owned()])?;
        transaction.commit()?;
        Ok(())
    }

    /// Places a tag under another, or at the top with `None`. A tag cannot
    /// go under itself or under a tag that is inside it.
    ///
    /// A tag that was renamed or placed has a time of change later than
    /// its making, even when both fell in the same millisecond: that is how
    /// [`Library::nest_tags_as`] tells a tag arranged here from one that
    /// only arrived.
    pub fn set_tag_parent(&self, id: &str, parent_id: Option<&str>) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let tag = tag_with(&transaction, id)?;
        if let Some(parent) = parent_id {
            let under = tag_with(&transaction, parent)?;
            if parent == id || is_inside(&transaction, parent, id)? {
                return Err(BeverError::Invalid(format!(
                    "“{}” is inside “{}” and cannot hold it",
                    under.name, tag.name
                )));
            }
        }
        transaction.execute(
            "UPDATE tags SET parent_id = ?2, updated_at = max(?3, created_at + 1) WHERE id = ?1",
            params![id, parent_id, Utc::now().timestamp_millis()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Nests tags as another application has them nested. `parents` gives,
    /// for a tag's name in lower case, the name of the tag it is under
    /// there. A tag here goes under that tag, which is made if there is
    /// none, provided it is at the top and was never renamed or placed
    /// here: what was arranged in this library stays as it is. Returns how
    /// many tags were placed.
    pub fn nest_tags_as(&self, parents: &HashMap<String, String>) -> Result<u64> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let now = Utc::now().timestamp_millis();
        let mut waiting = transaction
            .prepare(
                "SELECT id, name FROM tags WHERE parent_id IS NULL AND created_at = updated_at",
            )?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut placed = 0;
        while let Some((id, name)) = waiting.pop() {
            let Some(parent_name) = parents.get(&name.to_lowercase()) else {
                continue;
            };
            let Ok(parent_name) = normalized_name(parent_name) else {
                continue;
            };
            let existing = transaction
                .query_row(
                    "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE ORDER BY parent_id IS NULL DESC LIMIT 1",
                    [parent_name],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let parent = match existing {
                Some(parent) => parent,
                None => {
                    // A tag that only holds others: no note has it, so no
                    // note brought it. It has a place of its own to find.
                    let parent = Uuid::new_v4().to_string();
                    transaction.execute(
                        "INSERT INTO tags(id, name, parent_id, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?3)",
                        params![parent, parent_name, now],
                    )?;
                    waiting.push((parent.clone(), parent_name.to_owned()));
                    parent
                }
            };
            if parent == id || is_inside(&transaction, &parent, &id)? {
                continue;
            }
            placed += transaction.execute(
                "UPDATE OR IGNORE tags SET parent_id = ?2, updated_at = ?3 WHERE id = ?1 AND parent_id IS NULL",
                // Later than its making even within the same moment, so
                // that it counts as placed.
                params![id, parent, now + 1],
            )? as u64;
        }
        transaction.commit()?;
        Ok(placed)
    }

    /// Deletes a tag, removing it from every note. Tags inside it are kept
    /// and move up to where it was.
    pub fn delete_tag(&self, id: &str) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let tag = tag_with(&transaction, id)?;
        let tree = [id.to_owned()];
        let now = Utc::now().timestamp_millis();
        let notes = tagged_notes(&transaction, &tree)?;
        for tag in &tree {
            remove_shortcut(&transaction, "tag", tag, now, true)?;
            record_tombstone(&transaction, "tag", tag, now)?;
        }
        release_nested_tags(&transaction, id, tag.parent_id.as_deref(), now)?;
        // Its place on notes goes with it through the foreign key.
        transaction.execute("DELETE FROM tags WHERE id = ?1", [id])?;
        for note in &notes {
            transaction.execute(
                "UPDATE notes SET revision = revision + 1, dirty = 1 WHERE id = ?1",
                [note],
            )?;
            reindex_note(&transaction, note)?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Adds the shortcut when absent and removes it when present. Returns
    /// whether the shortcut now exists.
    pub fn toggle_shortcut(&self, target_type: &str, target_id: &str, label: &str) -> Result<bool> {
        // A search is a shortcut by its words: they are its target.
        if !matches!(
            target_type,
            "note" | "notebook" | "stack" | "tag" | "search"
        ) {
            return Err(BeverError::Invalid("unknown shortcut type".into()));
        }
        if target_id.trim().is_empty() {
            return Err(BeverError::Invalid("a shortcut needs a target".into()));
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let now = Utc::now().timestamp_millis();
        let removed = remove_shortcut(&transaction, target_type, target_id, now, true)?;
        if !removed {
            transaction.execute(
                "INSERT INTO shortcuts(id, target_type, target_id, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![Uuid::new_v4().to_string(), target_type, target_id, label, now],
            )?;
            transaction.execute(
                "DELETE FROM sync_tombstones WHERE kind = 'shortcut' AND id = ?1",
                [shortcut_key(target_type, target_id)],
            )?;
        }
        transaction.commit()?;
        Ok(!removed)
    }

    /// Adds the shortcuts another application has, in its order, after the
    /// ones that are here. One is added when what it points to is in this
    /// library and outside the trash, when there is no shortcut to it yet,
    /// and when no shortcut to it was removed here: what was taken away in
    /// this library is not brought back. Returns how many were added.
    pub fn add_shortcuts_as(&self, wanted: &[ForeignShortcut]) -> Result<(u64, u64)> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let now = Utc::now().timestamp_millis();
        let mut order: i64 = transaction.query_row(
            "SELECT COALESCE(max(sort_order), 0) FROM shortcuts",
            [],
            |row| row.get(0),
        )?;
        let named = |table: &str, name: &str| -> Result<Option<(String, String)>> {
            Ok(transaction
                .query_row(
                    &format!("SELECT id, name FROM {table} WHERE name = ?1 COLLATE NOCASE LIMIT 1"),
                    [name.trim()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        };
        let mut added = 0;
        let mut nowhere = 0;
        for shortcut in wanted {
            let (kind, target) = match shortcut {
                ForeignShortcut::Note { evernote_guid } => (
                    "note",
                    transaction
                        .query_row(
                            "SELECT id, title FROM notes WHERE evernote_guid = ?1 AND deleted_at IS NULL
                             ORDER BY updated_at DESC LIMIT 1",
                            [evernote_guid],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                        )
                        .optional()?
                        .map(|(id, title)| {
                            let title = title.trim();
                            (id, if title.is_empty() { "Untitled" } else { title }.to_owned())
                        }),
                ),
                ForeignShortcut::Notebook { name } => ("notebook", named("notebooks", name)?),
                ForeignShortcut::Stack { name } => ("stack", named("stacks", name)?),
                ForeignShortcut::Tag { name } => ("tag", named("tags", name)?),
                ForeignShortcut::Search { query, label } => {
                    let (query, label) = (query.trim(), label.trim());
                    let label = if label.is_empty() { query } else { label };
                    (
                        "search",
                        (!query.is_empty()).then(|| (query.to_owned(), label.to_owned())),
                    )
                }
            };
            let Some((id, label)) = target else {
                nowhere += 1;
                continue;
            };
            let removed_here = transaction
                .prepare_cached(
                    "SELECT 1 FROM sync_tombstones WHERE kind = 'shortcut' AND id = ?1",
                )?
                .exists([shortcut_key(kind, &id)])?;
            if removed_here {
                continue;
            }
            let inserted = transaction.execute(
                "INSERT OR IGNORE INTO shortcuts(id, target_type, target_id, label, sort_order, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![Uuid::new_v4().to_string(), kind, id, label, order + 1, now],
            )?;
            if inserted > 0 {
                order += 1;
                added += 1;
            }
        }
        transaction.commit()?;
        Ok((added, nowhere))
    }

    /// Makes the tags of `names` that are not here, at the top, and returns
    /// how many it made. An import of a whole account brings the tags that
    /// no note has this way; the notes bring the others.
    ///
    /// A name is offered once: the library remembers which names it was
    /// given, so that a tag deleted or renamed here is not made again by
    /// the next import.
    pub fn add_tags_once(&self, names: &[String]) -> Result<u64> {
        const OFFERED: &str = "import.tags-offered";
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let now = Utc::now().timestamp_millis();
        let mut offered: Vec<String> = transaction
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [OFFERED],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default();
        let mut added = 0;
        for name in names {
            let Ok(name) = normalized_name(name) else {
                continue;
            };
            let lower = name.to_lowercase();
            if offered.contains(&lower) {
                continue;
            }
            offered.push(lower);
            let here = transaction
                .prepare_cached("SELECT 1 FROM tags WHERE name = ?1 COLLATE NOCASE")?
                .exists([name])?;
            if !here {
                transaction.execute(
                    "INSERT INTO tags(id, name, parent_id, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?3)",
                    params![Uuid::new_v4().to_string(), name, now],
                )?;
                added += 1;
            }
        }
        transaction.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![OFFERED, serde_json::to_string(&offered)?],
        )?;
        transaction.commit()?;
        Ok(added)
    }

    /// Deleted stacks, notebooks, tags, and shortcuts awaiting synchronization.
    pub fn metadata_tombstones(&self) -> Result<Vec<Tombstone>> {
        let connection = self.connection.lock();
        let tombstones = connection
            .prepare("SELECT kind, id, deleted_at FROM sync_tombstones WHERE kind != 'note' ORDER BY kind, id")?
            .query_map([], |row| {
                Ok(Tombstone {
                    kind: row.get(0)?,
                    id: row.get(1)?,
                    deleted_at: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tombstones)
    }
}

/// A shortcut another application has, by what it points to there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForeignShortcut {
    /// A note, by the identifier Evernote gives it.
    Note {
        evernote_guid: String,
    },
    Notebook {
        name: String,
    },
    Stack {
        name: String,
    },
    Tag {
        name: String,
    },
    /// A search that was saved, with the name it was saved under.
    Search {
        query: String,
        label: String,
    },
}

pub(crate) fn shortcut_key(target_type: &str, target_id: &str) -> String {
    format!("{target_type}:{target_id}")
}

pub(crate) fn record_tombstone(
    connection: &Connection,
    kind: &str,
    id: &str,
    deleted_at: i64,
) -> Result<()> {
    connection.execute(
        "INSERT INTO sync_tombstones(kind, id, deleted_at) VALUES (?1, ?2, ?3) ON CONFLICT(kind, id) DO UPDATE SET deleted_at = max(deleted_at, excluded.deleted_at)",
        params![kind, id, deleted_at],
    )?;
    Ok(())
}

/// Removes the shortcut to a target, if there is one, and reports whether it
/// existed. `leave_tombstone` is false when the removal came from another
/// device and is already recorded there.
pub(crate) fn remove_shortcut(
    connection: &Connection,
    target_type: &str,
    target_id: &str,
    now: i64,
    leave_tombstone: bool,
) -> Result<bool> {
    let removed = connection.execute(
        "DELETE FROM shortcuts WHERE target_type = ?1 AND target_id = ?2",
        params![target_type, target_id],
    )? > 0;
    if removed && leave_tombstone {
        record_tombstone(
            connection,
            "shortcut",
            &shortcut_key(target_type, target_id),
            now,
        )?;
    }
    Ok(removed)
}

fn relabel_shortcut(
    connection: &Connection,
    target_type: &str,
    target_id: &str,
    label: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE shortcuts SET label = ?3 WHERE target_type = ?1 AND target_id = ?2",
        params![target_type, target_id, label],
    )?;
    Ok(())
}

pub(crate) fn ensure_notebook_with(
    connection: &Connection,
    name: &str,
    stack_id: Option<&str>,
) -> Result<String> {
    if let Some(id) = connection
        .query_row(
            "SELECT id FROM notebooks WHERE name = ?1 COLLATE NOCASE",
            [name],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp_millis();
    connection.execute(
        "INSERT INTO notebooks(id, name, stack_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, name, stack_id, now],
    )?;
    Ok(id)
}

fn tag_with(connection: &Connection, id: &str) -> Result<Tag> {
    connection
        .query_row(
            "SELECT id, name, parent_id, color, created_at, updated_at FROM tags WHERE id = ?1",
            [id],
            |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    color: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| BeverError::NotFound(format!("tag {id}")))
}

/// Whether the tag `id` is somewhere inside the tag `ancestor`.
fn is_inside(connection: &Connection, id: &str, ancestor: &str) -> Result<bool> {
    let mut current = id.to_owned();
    // Deeper than any nesting a person makes; ends a loop in damaged data.
    for _ in 0..64 {
        let parent: Option<String> = connection
            .query_row(
                "SELECT parent_id FROM tags WHERE id = ?1",
                [&current],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        match parent {
            Some(parent) if parent == ancestor => return Ok(true),
            Some(parent) => current = parent,
            None => return Ok(false),
        }
    }
    Ok(true)
}

/// Moves the tags directly inside `id` to `parent`, where `id` itself is:
/// what a tag held is not deleted with it.
pub(crate) fn release_nested_tags(
    connection: &Connection,
    id: &str,
    parent: Option<&str>,
    now: i64,
) -> Result<()> {
    connection.execute(
        "UPDATE tags SET parent_id = ?2, updated_at = max(?3, created_at + 1) WHERE parent_id = ?1",
        params![id, parent, now],
    )?;
    Ok(())
}

fn tagged_notes(connection: &Connection, tags: &[String]) -> Result<Vec<String>> {
    let mut notes = Vec::new();
    for tag in tags {
        let mut statement =
            connection.prepare_cached("SELECT note_id FROM note_tags WHERE tag_id = ?1")?;
        let found = statement
            .query_map([tag], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        notes.extend(found);
    }
    notes.sort();
    notes.dedup();
    Ok(notes)
}

/// Notes whose tag names changed must be re-indexed and re-synchronized.
pub(crate) fn mark_tagged_notes_changed(connection: &Connection, tags: &[String]) -> Result<()> {
    for note in tagged_notes(connection, tags)? {
        connection.execute(
            "UPDATE notes SET revision = revision + 1, dirty = 1 WHERE id = ?1",
            [&note],
        )?;
        reindex_note(connection, &note)?;
    }
    Ok(())
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

    fn tagged_note(library: &Library, notebook: &str, title: &str, tags: &[&str]) -> String {
        let note = library.create_note(Some(notebook)).unwrap();
        library
            .save_note(&SaveNote {
                id: note.id.clone(),
                notebook_id: notebook.to_owned(),
                title: title.into(),
                content_html: "<p>Body</p>".into(),
                attributes: json!({}),
                tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
                base_revision: None,
            })
            .unwrap();
        note.id
    }

    fn tombstones(library: &Library) -> Vec<(String, String)> {
        library
            .metadata_tombstones()
            .unwrap()
            .into_iter()
            .map(|tombstone| (tombstone.kind, tombstone.id))
            .collect()
    }

    #[test]
    fn renaming_a_notebook_rejects_duplicates_and_updates_its_shortcut() {
        let (_directory, library) = library();
        let work = library.ensure_notebook("Work", None).unwrap();
        library.ensure_notebook("Home", None).unwrap();
        library.toggle_shortcut("notebook", &work, "Work").unwrap();
        assert!(library.rename_notebook(&work, " home ").is_err());
        assert!(library.rename_notebook(&work, "  ").is_err());
        assert!(library.rename_notebook("missing", "Other").is_err());
        library.rename_notebook(&work, "Projects").unwrap();
        // Changing only the letter case of its own name is allowed.
        library.rename_notebook(&work, "PROJECTS").unwrap();
        let snapshot = library.snapshot().unwrap();
        let notebook = snapshot
            .notebooks
            .iter()
            .find(|item| item.id == work)
            .unwrap();
        assert_eq!(notebook.name, "PROJECTS");
        assert_eq!(notebook.revision, 3);
        assert_eq!(snapshot.shortcuts[0].label, "PROJECTS");
    }

    #[test]
    fn deleting_a_notebook_trashes_its_notes_and_leaves_a_tombstone() {
        let (_directory, library) = library();
        let work = library.ensure_notebook("Work", None).unwrap();
        let note = tagged_note(&library, &work, "Plan", &[]);
        library.toggle_shortcut("notebook", &work, "Work").unwrap();
        assert_eq!(library.delete_notebook(&work).unwrap(), 1);

        let snapshot = library.snapshot().unwrap();
        assert_eq!(snapshot.notebooks.len(), 1);
        assert!(snapshot.shortcuts.is_empty());
        let moved = library.get_note(&note).unwrap();
        assert!(moved.deleted_at.is_some());
        assert_eq!(moved.notebook_id, snapshot.notebooks[0].id);
        let recorded = tombstones(&library);
        assert!(recorded.contains(&("notebook".into(), work.clone())));
        assert!(recorded.contains(&("shortcut".into(), format!("notebook:{work}"))));

        let last = snapshot.notebooks[0].id.clone();
        assert!(library.delete_notebook(&last).is_err());
        assert!(library.delete_notebook(&work).is_err());
        assert_eq!(library.snapshot().unwrap().notebooks.len(), 1);
    }

    #[test]
    fn deleting_a_stack_keeps_its_notebooks() {
        let (_directory, library) = library();
        let stack = library.create_stack("Learning").unwrap();
        assert!(library.create_stack("learning").is_err());
        let notebook = library.ensure_notebook("Reading", Some(&stack.id)).unwrap();
        library.rename_stack(&stack.id, "Study").unwrap();
        assert_eq!(library.snapshot().unwrap().stacks[0].name, "Study");
        library.delete_stack(&stack.id).unwrap();
        let snapshot = library.snapshot().unwrap();
        assert!(snapshot.stacks.is_empty());
        let reading = snapshot
            .notebooks
            .iter()
            .find(|item| item.id == notebook)
            .unwrap();
        assert_eq!(reading.stack_id, None);
        assert_eq!(reading.revision, 2);
        assert!(tombstones(&library).contains(&("stack".into(), stack.id.clone())));
        assert!(library.delete_stack(&stack.id).is_err());
    }

    #[test]
    fn renaming_and_deleting_tags_updates_notes_search_and_sync_state() {
        let (_directory, library) = library();
        let inbox = library.snapshot().unwrap().notebooks[0].id.clone();
        let note = tagged_note(&library, &inbox, "Tagged", &["draft", "keep"]);
        let draft = library
            .snapshot()
            .unwrap()
            .tags
            .into_iter()
            .find(|tag| tag.name == "draft")
            .unwrap();
        let before = library.get_note(&note).unwrap().revision;

        assert!(library.rename_tag(&draft.id, "KEEP").is_err());
        library.rename_tag(&draft.id, "final").unwrap();
        let renamed = library.get_note(&note).unwrap();
        assert_eq!(renamed.tags, ["final", "keep"]);
        assert_eq!(renamed.revision, before + 1);
        let search = |query: &str| {
            library
                .list_notes(&NoteFilter {
                    query: query.into(),
                    ..NoteFilter::default()
                })
                .unwrap()
                .total
        };
        assert_eq!(search("tag:final"), 1);
        assert_eq!(search("tag:draft"), 0);
        assert_eq!(search("final"), 1);

        library.delete_tag(&draft.id).unwrap();
        let untagged = library.get_note(&note).unwrap();
        assert_eq!(untagged.tags, ["keep"]);
        assert_eq!(untagged.revision, before + 2);
        assert_eq!(search("final"), 0);
        assert!(tombstones(&library).contains(&("tag".into(), draft.id.clone())));
        assert!(library.delete_tag(&draft.id).is_err());
    }

    #[test]
    fn removing_a_shortcut_is_recorded_and_adding_it_again_clears_the_record() {
        let (_directory, library) = library();
        let inbox = library.snapshot().unwrap().notebooks[0].id.clone();
        assert!(library
            .toggle_shortcut("notebook", &inbox, "Inbox")
            .unwrap());
        assert!(tombstones(&library).is_empty());
        assert!(!library
            .toggle_shortcut("notebook", &inbox, "Inbox")
            .unwrap());
        assert_eq!(
            tombstones(&library),
            [("shortcut".to_owned(), format!("notebook:{inbox}"))]
        );
        assert!(library
            .toggle_shortcut("notebook", &inbox, "Inbox")
            .unwrap());
        assert!(tombstones(&library).is_empty());
        assert!(library.toggle_shortcut("window", "x", "x").is_err());
        // A search is a shortcut by its words.
        assert!(library
            .toggle_shortcut("search", "tag:recipes soup", "Soups")
            .unwrap());
        assert!(library.toggle_shortcut("search", " ", "Nothing").is_err());
    }

    #[test]
    fn a_note_shortcut_follows_the_notes_title() {
        let (_directory, library) = library();
        let inbox = library.snapshot().unwrap().notebooks[0].id.clone();
        let note = tagged_note(&library, &inbox, "Old title", &[]);
        library.toggle_shortcut("note", &note, "Old title").unwrap();
        tagged_note_rename(&library, &note, &inbox, "New title");
        assert_eq!(library.snapshot().unwrap().shortcuts[0].label, "New title");
    }

    fn tagged_note_rename(library: &Library, id: &str, notebook: &str, title: &str) {
        library
            .save_note(&SaveNote {
                id: id.to_owned(),
                notebook_id: notebook.to_owned(),
                title: title.into(),
                content_html: "<p>Body</p>".into(),
                attributes: json!({}),
                tags: Vec::new(),
                base_revision: None,
            })
            .unwrap();
    }

    fn tag_named(library: &Library, name: &str) -> Tag {
        library
            .snapshot()
            .unwrap()
            .tags
            .into_iter()
            .find(|tag| tag.name == name)
            .unwrap_or_else(|| panic!("no tag named {name}"))
    }

    #[test]
    fn a_tag_is_placed_under_another_but_never_inside_itself() {
        let (_directory, library) = library();
        let courses = library.create_tag("Courses", None).unwrap();
        let algebra = library.create_tag("Algebra", Some(&courses.id)).unwrap();
        let lesson = library.create_tag("Lesson 1", None).unwrap();
        assert_eq!(algebra.parent_id.as_deref(), Some(courses.id.as_str()));
        library
            .set_tag_parent(&lesson.id, Some(&algebra.id))
            .unwrap();
        assert_eq!(
            tag_named(&library, "Lesson 1").parent_id.as_deref(),
            Some(algebra.id.as_str())
        );
        // Not under itself, and not under what it holds, however deep.
        assert!(library
            .set_tag_parent(&courses.id, Some(&courses.id))
            .is_err());
        assert!(library
            .set_tag_parent(&courses.id, Some(&lesson.id))
            .is_err());
        assert!(library
            .set_tag_parent(&courses.id, Some("missing"))
            .is_err());
        assert!(library.set_tag_parent("missing", None).is_err());
        assert_eq!(tag_named(&library, "Courses").parent_id, None);
        library.set_tag_parent(&lesson.id, None).unwrap();
        assert_eq!(tag_named(&library, "Lesson 1").parent_id, None);
    }

    #[test]
    fn a_name_is_one_tag_wherever_it_is_nested() {
        let (_directory, library) = library();
        let inbox = library.snapshot().unwrap().notebooks[0].id.clone();
        let courses = library.create_tag("Courses", None).unwrap();
        let algebra = library.create_tag("Algebra", Some(&courses.id)).unwrap();
        // Asked for again, at the top or by a note, it is the same tag.
        assert_eq!(library.create_tag("algebra", None).unwrap().id, algebra.id);
        let note = tagged_note(&library, &inbox, "Tagged", &["ALGEBRA"]);
        assert_eq!(library.get_note(&note).unwrap().tags, ["Algebra"]);
        assert_eq!(library.snapshot().unwrap().tags.len(), 2);
        // And no other tag may take its name, wherever that one is.
        let other = library.create_tag("Geometry", None).unwrap();
        assert!(library.rename_tag(&other.id, "algebra").is_err());
    }

    #[test]
    fn deleting_a_tag_keeps_the_tags_inside_it() {
        let (_directory, library) = library();
        let inbox = library.snapshot().unwrap().notebooks[0].id.clone();
        let courses = library.create_tag("Courses", None).unwrap();
        let algebra = library.create_tag("Algebra", Some(&courses.id)).unwrap();
        let lesson = library.create_tag("Lesson 1", Some(&algebra.id)).unwrap();
        let note = tagged_note(&library, &inbox, "Tagged", &["Algebra", "Lesson 1"]);

        library.delete_tag(&algebra.id).unwrap();
        // The tag inside it moved up to where it was, and is still on the note.
        assert_eq!(
            tag_named(&library, "Lesson 1").parent_id.as_deref(),
            Some(courses.id.as_str())
        );
        assert_eq!(library.get_note(&note).unwrap().tags, ["Lesson 1"]);
        assert_eq!(
            tombstones(&library),
            [("tag".to_owned(), algebra.id.clone())]
        );
        library.delete_tag(&courses.id).unwrap();
        assert_eq!(tag_named(&library, "Lesson 1").parent_id, None);
        assert_eq!(tag_named(&library, "Lesson 1").id, lesson.id);
    }

    #[test]
    fn tags_are_nested_as_another_application_has_them() {
        let (_directory, library) = library();
        let inbox = library.snapshot().unwrap().notebooks[0].id.clone();
        tagged_note(&library, &inbox, "One", &["lesson 1", "Loose", "Mine"]);
        // "Mine" was arranged here: placed and brought back to the top.
        let mine = tag_named(&library, "Mine");
        let loose = tag_named(&library, "Loose");
        library.set_tag_parent(&mine.id, Some(&loose.id)).unwrap();
        library.set_tag_parent(&mine.id, None).unwrap();

        let mut parents = HashMap::from([
            ("lesson 1".to_owned(), "Algebra".to_owned()),
            ("algebra".to_owned(), "Courses".to_owned()),
            ("mine".to_owned(), "Courses".to_owned()),
            // A loop in what was read places nothing in a loop.
            ("courses".to_owned(), "Lesson 1".to_owned()),
        ]);
        assert_eq!(library.nest_tags_as(&parents).unwrap(), 2);
        let algebra = tag_named(&library, "Algebra");
        let courses = tag_named(&library, "Courses");
        assert_eq!(
            tag_named(&library, "lesson 1").parent_id.as_deref(),
            Some(algebra.id.as_str())
        );
        assert_eq!(algebra.parent_id.as_deref(), Some(courses.id.as_str()));
        assert_eq!(courses.parent_id, None);
        assert_eq!(tag_named(&library, "Loose").parent_id, None);
        assert_eq!(tag_named(&library, "Mine").parent_id, None);
        // Once placed, tags are left where they are.
        assert_eq!(library.nest_tags_as(&parents).unwrap(), 0);
        library
            .set_tag_parent(&tag_named(&library, "lesson 1").id, None)
            .unwrap();
        // Without the loop, which would now be none: a tag moved here stays.
        parents.remove("courses");
        assert_eq!(library.nest_tags_as(&parents).unwrap(), 0);
        assert_eq!(tag_named(&library, "lesson 1").parent_id, None);
    }
}
