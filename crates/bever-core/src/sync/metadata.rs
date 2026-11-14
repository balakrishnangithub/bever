//! Synchronization of stacks, notebooks, tags, and shortcuts.
//!
//! Items merge by id with the most recent update winning. Deletions travel
//! as tombstones, because without them a deleted item would simply be merged
//! back in from the other side. Names are unique within a library, so an item
//! that arrives with the name of a different local item absorbs it instead of
//! producing "Inbox" and "Inbox (2)".
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::{
    remote::{RemoteFile, RemoteStore},
    Layout, Progress, METADATA,
};
use crate::{
    db::Library,
    error::{BeverError, Result},
    models::{LibrarySnapshot, Notebook, Stack, Tag, Tombstone},
    organize::{mark_tagged_notes_changed, record_tombstone, release_nested_tags, shortcut_key},
    repository::default_notebook,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataEnvelope {
    revision: i64,
    updated_at: i64,
    device_id: String,
    snapshot: LibrarySnapshot,
    tombstones: Vec<Tombstone>,
}

/// What this library keeps of the remote metadata it last merged or
/// uploaded. With it, a folder listing is enough to tell that the remote file
/// is still that one, and a successor can be uploaded without downloading it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Seen {
    /// The remote file's version; see [`RemoteFile::version`].
    version: String,
    revision: i64,
    /// [`fingerprint`] of what the file holds.
    fingerprint: String,
}

/// The setting [`Seen`] is kept in.
const SEEN: &str = "sync_metadata_seen";

fn remembered(library: &Library) -> Result<Option<Seen>> {
    Ok(library
        .setting(SEEN)?
        .and_then(|stored| serde_json::from_str(&stored).ok()))
}

/// Merges the remote metadata into the library, unless the library already
/// holds it: `listed` is the remote file as the folder listing describes it,
/// and a file whose version is the one last seen is not downloaded again.
/// Deletions the metadata carries are recorded but not yet carried out; see
/// [`apply_tombstones`].
pub(crate) fn pull(
    library: &Library,
    remote: &dyn RemoteStore,
    layout: &Layout,
    listed: Option<&RemoteFile>,
    progress: &mut Progress<'_>,
) -> Result<Option<Seen>> {
    let Some(listed) = listed else {
        // Nothing has been uploaded yet.
        return Ok(None);
    };
    if let Some(seen) = remembered(library)? {
        if !listed.version.is_empty() && seen.version == listed.version {
            return Ok(Some(seen));
        }
    }
    progress.emit("metadata", "Reading notebooks and tags", 0, 0);
    receive(library, remote, layout, listed).map(Some)
}

/// Downloads the remote metadata, merges it, and remembers it as seen.
fn receive(
    library: &Library,
    remote: &dyn RemoteStore,
    layout: &Layout,
    listed: &RemoteFile,
) -> Result<Seen> {
    let bytes = remote.download(&layout.metadata())?;
    let envelope: MetadataEnvelope = serde_json::from_slice(&bytes).map_err(|error| {
        BeverError::Remote(format!("the remote notebook list is unreadable: {error}"))
    })?;
    merge_remote(library, &envelope)?;
    // Should the file have been replaced between the listing and the
    // download, this pairs an older version with newer content. The next
    // listing then shows a version not seen, and the file is merged again,
    // which changes nothing.
    let seen = Seen {
        version: listed.version.clone(),
        revision: envelope.revision,
        fingerprint: fingerprint(&envelope.snapshot, &envelope.tombstones),
    };
    library.set_setting(SEEN, &serde_json::to_string(&seen)?)?;
    Ok(seen)
}

/// Uploads the library's metadata when it differs from what the remote holds.
pub(crate) fn push(
    library: &Library,
    remote: &dyn RemoteStore,
    layout: &Layout,
    previous: Option<Seen>,
    progress: &mut Progress<'_>,
) -> Result<()> {
    let local = || -> Result<String> {
        Ok(fingerprint(
            &library.snapshot()?,
            &library.metadata_tombstones()?,
        ))
    };
    let mut previous = previous;
    if let Some(seen) = &previous {
        if seen.fingerprint == local()? {
            return Ok(());
        }
    }
    // Notes can take minutes to transfer, and another device may have
    // uploaded its own list in that time. Uploading over it would drop what
    // that device added until it next runs, so it is merged in first. The
    // deletions it carries are carried out by the next run, after that run
    // has received the notes they concern. One listing tells whether there
    // is such a list.
    let listed = remote
        .list(&layout.root)?
        .and_then(|listing| listing.file(METADATA).cloned());
    if let Some(listed) = listed {
        let seen_already = previous
            .as_ref()
            .is_some_and(|seen| !listed.version.is_empty() && seen.version == listed.version);
        if !seen_already {
            let seen = receive(library, remote, layout, &listed)?;
            if seen.fingerprint == local()? {
                return Ok(());
            }
            previous = Some(seen);
        }
    }
    progress.emit("metadata", "Uploading notebooks and tags", 0, 0);
    let (snapshot, tombstones) = (library.snapshot()?, library.metadata_tombstones()?);
    let fingerprint = fingerprint(&snapshot, &tombstones);
    let envelope = MetadataEnvelope {
        revision: previous.map_or(1, |previous| previous.revision + 1),
        updated_at: Utc::now().timestamp_millis(),
        device_id: library.device_id().to_owned(),
        snapshot,
        tombstones,
    };
    let stored = remote.upload(&layout.metadata(), serde_json::to_vec(&envelope)?)?;
    let seen = Seen {
        version: stored.version,
        revision: envelope.revision,
        fingerprint,
    };
    library.set_setting(SEEN, &serde_json::to_string(&seen)?)
}

/// Makes a notebook known that a note arrived for before any notebook list
/// naming it did. `notebook` and `stack` are what the note's envelope says
/// about it. The notebook keeps its identity, so the list merges with it
/// when it arrives.
pub(super) fn adopt_notebook(
    transaction: &Transaction<'_>,
    notebook: &Notebook,
    stack: Option<&Stack>,
) -> Result<()> {
    let now = Utc::now().timestamp_millis();
    if let Some(stack) = stack.filter(|stack| notebook.stack_id.as_deref() == Some(&stack.id)) {
        if deleted_at(transaction, "stack", &stack.id)?.is_none() {
            merge_stack(transaction, stack, now)?;
        }
    }
    merge_notebook(transaction, notebook, now)
}

/// Order-independent identity of a metadata state. Shortcut ids and labels
/// are local detail: two devices that star the same note agree.
fn fingerprint(snapshot: &LibrarySnapshot, tombstones: &[Tombstone]) -> String {
    let mut lines = Vec::new();
    for stack in &snapshot.stacks {
        lines.push(format!(
            "stack\u{1f}{}\u{1f}{}\u{1f}{}",
            stack.id, stack.name, stack.updated_at
        ));
    }
    for notebook in &snapshot.notebooks {
        lines.push(format!(
            "notebook\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            notebook.id,
            notebook.name,
            notebook.stack_id.as_deref().unwrap_or(""),
            notebook.updated_at
        ));
    }
    for tag in &snapshot.tags {
        lines.push(format!(
            "tag\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            tag.id,
            tag.name,
            tag.parent_id.as_deref().unwrap_or(""),
            tag.updated_at
        ));
    }
    for shortcut in &snapshot.shortcuts {
        lines.push(format!(
            "shortcut\u{1f}{}",
            shortcut_key(&shortcut.target_type, &shortcut.target_id)
        ));
    }
    for tombstone in tombstones {
        lines.push(format!(
            "tombstone\u{1f}{}\u{1f}{}\u{1f}{}",
            tombstone.kind, tombstone.id, tombstone.deleted_at
        ));
    }
    lines.sort();
    format!("{:x}", Sha256::digest(lines.join("\n")))
}

fn merge_remote(library: &Library, remote: &MetadataEnvelope) -> Result<()> {
    let mut connection = library.connection.lock();
    let transaction = connection.transaction()?;
    let now = Utc::now().timestamp_millis();
    for tombstone in &remote.tombstones {
        if matches!(
            tombstone.kind.as_str(),
            "stack" | "notebook" | "tag" | "shortcut"
        ) {
            record_tombstone(
                &transaction,
                &tombstone.kind,
                &tombstone.id,
                tombstone.deleted_at,
            )?;
        }
    }
    for stack in &remote.snapshot.stacks {
        if deleted_at(&transaction, "stack", &stack.id)?.is_none() {
            merge_stack(&transaction, stack, now)?;
        }
    }
    for notebook in &remote.snapshot.notebooks {
        if deleted_at(&transaction, "notebook", &notebook.id)?.is_none() {
            merge_notebook(&transaction, notebook, now)?;
        }
    }
    // A tag can only be stored after its parent.
    let mut waiting: Vec<&Tag> = Vec::new();
    for tag in &remote.snapshot.tags {
        if deleted_at(&transaction, "tag", &tag.id)?.is_none() {
            waiting.push(tag);
        }
    }
    while !waiting.is_empty() {
        let before = waiting.len();
        let mut still_waiting = Vec::new();
        for tag in waiting {
            let parent_ready = match &tag.parent_id {
                Some(parent) => exists(&transaction, "tags", parent)?,
                None => true,
            };
            if parent_ready {
                merge_tag(&transaction, tag, tag.parent_id.as_deref(), now)?;
            } else {
                still_waiting.push(tag);
            }
        }
        waiting = still_waiting;
        if waiting.len() == before {
            // Their parents are gone; keep the tags at the top level.
            for tag in &waiting {
                merge_tag(&transaction, tag, None, now)?;
            }
            break;
        }
    }
    for shortcut in &remote.snapshot.shortcuts {
        let key = shortcut_key(&shortcut.target_type, &shortcut.target_id);
        let removed_later = deleted_at(&transaction, "shortcut", &key)?
            .is_some_and(|deleted| deleted >= shortcut.created_at);
        if removed_later {
            continue;
        }
        transaction.execute(
            "INSERT OR IGNORE INTO shortcuts(id, target_type, target_id, label, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![shortcut.id, shortcut.target_type, shortcut.target_id, shortcut.label, shortcut.sort_order, shortcut.created_at],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

/// Carries out the deletions recorded for this library: the ones that arrived
/// from other devices, since local ones were applied when they were made.
/// Runs after remote notes have been applied, so notes the other device moved
/// out of a deleted notebook are already in their new place; any note still
/// in it exists only here and moves to the default notebook.
pub(crate) fn apply_tombstones(library: &Library) -> Result<()> {
    let tombstones = library.metadata_tombstones()?;
    if tombstones.is_empty() {
        return Ok(());
    }
    let mut connection = library.connection.lock();
    let transaction = connection.transaction()?;
    let now = Utc::now().timestamp_millis();
    for tombstone in &tombstones {
        match tombstone.kind.as_str() {
            "stack" => {
                transaction.execute(
                    "UPDATE notebooks SET stack_id = NULL, updated_at = ?2, revision = revision + 1 WHERE stack_id = ?1",
                    params![tombstone.id, now],
                )?;
                transaction.execute("DELETE FROM stacks WHERE id = ?1", [&tombstone.id])?;
                drop_shortcut(&transaction, "stack", &tombstone.id)?;
            }
            "notebook" => {
                if !exists(&transaction, "notebooks", &tombstone.id)? {
                    continue;
                }
                // A library always keeps one notebook.
                let Ok(fallback) = default_notebook(&transaction, Some(&tombstone.id)) else {
                    continue;
                };
                transaction.execute(
                    "UPDATE notes SET notebook_id = ?2, revision = revision + 1, dirty = 1 WHERE notebook_id = ?1",
                    params![tombstone.id, fallback],
                )?;
                transaction.execute("DELETE FROM notebooks WHERE id = ?1", [&tombstone.id])?;
                drop_shortcut(&transaction, "notebook", &tombstone.id)?;
            }
            "tag" => {
                if !exists(&transaction, "tags", &tombstone.id)? {
                    continue;
                }
                let affected = transaction
                    .prepare("SELECT note_id FROM note_tags WHERE tag_id = ?1")?
                    .query_map([&tombstone.id], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                // What it held stays, where it was; the device that deleted
                // it did the same.
                let parent: Option<String> = transaction.query_row(
                    "SELECT parent_id FROM tags WHERE id = ?1",
                    [&tombstone.id],
                    |row| row.get(0),
                )?;
                release_nested_tags(&transaction, &tombstone.id, parent.as_deref(), now)?;
                transaction.execute("DELETE FROM tags WHERE id = ?1", [&tombstone.id])?;
                for note in affected {
                    transaction.execute(
                        "UPDATE notes SET revision = revision + 1, dirty = 1 WHERE id = ?1",
                        [&note],
                    )?;
                    crate::repository::reindex_note(&transaction, &note)?;
                }
                drop_shortcut(&transaction, "tag", &tombstone.id)?;
            }
            "shortcut" => {
                if let Some((target_type, target_id)) = tombstone.id.split_once(':') {
                    transaction.execute(
                        "DELETE FROM shortcuts WHERE target_type = ?1 AND target_id = ?2 AND created_at <= ?3",
                        params![target_type, target_id, tombstone.deleted_at],
                    )?;
                }
            }
            _ => {}
        }
    }
    transaction.commit()?;
    Ok(())
}

fn merge_stack(transaction: &Transaction<'_>, stack: &Stack, now: i64) -> Result<()> {
    let local_updated: Option<i64> = transaction
        .query_row(
            "SELECT updated_at FROM stacks WHERE id = ?1",
            [&stack.id],
            |row| row.get(0),
        )
        .optional()?;
    match local_updated {
        Some(updated) if stack.updated_at <= updated => return Ok(()),
        Some(_) => {}
        None => {
            transaction.execute(
                "INSERT INTO stacks(id, name, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![stack.id, placeholder_name(&stack.id), stack.created_at, stack.updated_at, stack.revision],
            )?;
        }
    }
    let namesake: Option<String> = transaction
        .query_row(
            "SELECT id FROM stacks WHERE name = ?1 COLLATE NOCASE AND id != ?2",
            params![stack.name, stack.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(other) = namesake {
        transaction.execute(
            "UPDATE notebooks SET stack_id = ?2, updated_at = ?3, revision = revision + 1 WHERE stack_id = ?1",
            params![other, stack.id, now],
        )?;
        move_shortcut(transaction, "stack", &other, &stack.id)?;
        transaction.execute("DELETE FROM stacks WHERE id = ?1", [&other])?;
        record_tombstone(transaction, "stack", &other, now)?;
    }
    transaction.execute(
        "UPDATE stacks SET name = ?2, updated_at = ?3, revision = ?4 WHERE id = ?1",
        params![stack.id, stack.name, stack.updated_at, stack.revision],
    )?;
    Ok(())
}

fn merge_notebook(transaction: &Transaction<'_>, notebook: &Notebook, now: i64) -> Result<()> {
    let local_updated: Option<i64> = transaction
        .query_row(
            "SELECT updated_at FROM notebooks WHERE id = ?1",
            [&notebook.id],
            |row| row.get(0),
        )
        .optional()?;
    match local_updated {
        Some(updated) if notebook.updated_at <= updated => return Ok(()),
        Some(_) => {}
        None => {
            transaction.execute(
                "INSERT INTO notebooks(id, name, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![notebook.id, placeholder_name(&notebook.id), notebook.created_at, notebook.updated_at, notebook.revision],
            )?;
        }
    }
    let namesake: Option<String> = transaction
        .query_row(
            "SELECT id FROM notebooks WHERE name = ?1 COLLATE NOCASE AND id != ?2",
            params![notebook.name, notebook.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(other) = namesake {
        // The notes change notebook, which other devices must learn.
        transaction.execute(
            "UPDATE notes SET notebook_id = ?2, revision = revision + 1, dirty = 1 WHERE notebook_id = ?1",
            params![other, notebook.id],
        )?;
        move_shortcut(transaction, "notebook", &other, &notebook.id)?;
        transaction.execute("DELETE FROM notebooks WHERE id = ?1", [&other])?;
        record_tombstone(transaction, "notebook", &other, now)?;
    }
    let stack_id = match &notebook.stack_id {
        Some(stack) if exists(transaction, "stacks", stack)? => Some(stack.as_str()),
        _ => None,
    };
    transaction.execute(
        "UPDATE notebooks SET name = ?2, stack_id = ?3, updated_at = ?4, revision = ?5 WHERE id = ?1",
        params![notebook.id, notebook.name, stack_id, notebook.updated_at, notebook.revision],
    )?;
    Ok(())
}

fn merge_tag(
    transaction: &Transaction<'_>,
    tag: &Tag,
    parent_id: Option<&str>,
    now: i64,
) -> Result<()> {
    let local: Option<(i64, String)> = transaction
        .query_row(
            "SELECT updated_at, name FROM tags WHERE id = ?1",
            [&tag.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match &local {
        Some((updated, _)) if tag.updated_at <= *updated => return Ok(()),
        Some(_) => {}
        None => {
            transaction.execute(
                "INSERT INTO tags(id, name, parent_id, color, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
                params![tag.id, placeholder_name(&tag.id), tag.color, tag.created_at, tag.updated_at],
            )?;
        }
    }
    let namesake: Option<String> = transaction
        .query_row(
            "SELECT id FROM tags WHERE lower(name) = lower(?1) AND id != ?2",
            params![tag.name, tag.id],
            |row| row.get(0),
        )
        .optional()?;
    // Only a new name concerns the notes: a tag that was merely placed
    // under another leaves them as they are, and a library whose tags were
    // all nested at once must not send every note again.
    let renamed = local.is_some_and(|(_, name)| name != tag.name);
    if let Some(other) = namesake {
        transaction.execute(
            "UPDATE OR IGNORE note_tags SET tag_id = ?2 WHERE tag_id = ?1",
            params![other, tag.id],
        )?;
        transaction.execute(
            "UPDATE OR IGNORE tags SET parent_id = ?2 WHERE parent_id = ?1",
            params![other, tag.id],
        )?;
        move_shortcut(transaction, "tag", &other, &tag.id)?;
        transaction.execute("DELETE FROM tags WHERE id = ?1", [&other])?;
        record_tombstone(transaction, "tag", &other, now)?;
    }
    transaction.execute(
        "UPDATE tags SET name = ?2, parent_id = ?3, color = ?4, updated_at = ?5 WHERE id = ?1",
        params![tag.id, tag.name, parent_id, tag.color, tag.updated_at],
    )?;
    if renamed {
        // Notes are indexed and synchronized with their tag names.
        mark_tagged_notes_changed(transaction, std::slice::from_ref(&tag.id))?;
    }
    Ok(())
}

/// A name no real item has, held until a namesake has been absorbed.
fn placeholder_name(id: &str) -> String {
    format!("\u{1}{id}")
}

fn exists(connection: &Connection, table: &str, id: &str) -> Result<bool> {
    debug_assert!(matches!(table, "stacks" | "notebooks" | "tags"));
    Ok(connection
        .prepare_cached(&format!("SELECT 1 FROM {table} WHERE id = ?1"))?
        .exists([id])?)
}

/// When an item was deleted, here or on another device, if it was.
pub(super) fn deleted_at(connection: &Connection, kind: &str, id: &str) -> Result<Option<i64>> {
    Ok(connection
        .prepare_cached("SELECT deleted_at FROM sync_tombstones WHERE kind = ?1 AND id = ?2")?
        .query_row(params![kind, id], |row| row.get(0))
        .optional()?)
}

/// Re-targets a shortcut, unless the new target already has one.
fn move_shortcut(connection: &Connection, target_type: &str, from: &str, to: &str) -> Result<()> {
    connection.execute(
        "UPDATE OR IGNORE shortcuts SET target_id = ?3 WHERE target_type = ?1 AND target_id = ?2",
        params![target_type, from, to],
    )?;
    drop_shortcut(connection, target_type, from)
}

fn drop_shortcut(connection: &Connection, target_type: &str, target_id: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM shortcuts WHERE target_type = ?1 AND target_id = ?2",
        params![target_type, target_id],
    )?;
    Ok(())
}
