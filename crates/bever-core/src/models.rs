use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub stack_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub label: String,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub note_id: String,
    pub sha256: String,
    pub md5: String,
    pub mime: String,
    pub file_name: Option<String>,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<u64>,
    pub recognition_xml: Option<String>,
    pub recognition_text: Option<String>,
    pub attributes: Value,
    pub alternate_sha256: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub notebook_id: String,
    pub title: String,
    pub content_html: String,
    pub original_enml: Option<String>,
    pub plain_text: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub attributes: Value,
    pub evernote_guid: Option<String>,
    pub revision: i64,
    pub tags: Vec<String>,
    pub resources: Vec<Resource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub title: String,
    pub snippet: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub tags: Vec<String>,
    pub has_attachments: bool,
    pub is_shortcut: bool,
    /// SHA-256 of the picture that stands for the note in a list: the one
    /// chosen for it, or else the largest picture in it; none when the note
    /// is to have none.
    pub thumbnail: Option<String>,
    /// Whether the note is pinned to the top of the notebook it is in.
    #[serde(default)]
    pub pinned: bool,
}

/// The key under a note's `application-data` that says which picture stands
/// for the note in a list: the picture's MD5, [`NO_THUMBNAIL`], or
/// [`AUTOMATIC_THUMBNAIL`]. See `marks.rs`.
pub const THUMBNAIL_KEY: &str = "bever.thumbnail";
/// The note is to have no picture in a list.
pub const NO_THUMBNAIL: &str = "none";
/// The picture found for the note stands for it, whatever the note said
/// when it came.
pub const AUTOMATIC_THUMBNAIL: &str = "auto";
/// The key under a note's `application-data` that pins the note to the top
/// of a notebook: the notebook's id, a space, and the note's place among the
/// pinned, which is the time it was pinned at.
pub const PINNED_KEY: &str = "bever.pinned";

/// Which picture stands for a note in a list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "md5")]
pub enum ThumbnailChoice {
    /// The one found for the note: the largest that is more than an icon.
    Automatic,
    None,
    /// One of the note's pictures, by its MD5.
    Picture(String),
}

/// One page of a note listing together with the size of the whole result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotePage {
    pub notes: Vec<NoteSummary>,
    pub total: u64,
    /// The search as it was understood, when nothing answered it as typed
    /// and words spelt nearly so did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corrected: Option<String>,
}

/// Note counts for navigation. Kept apart from [`LibrarySnapshot`] so that
/// creating or trashing notes never changes the synchronized metadata hash.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCounts {
    pub all: u64,
    pub trash: u64,
    pub notebooks: std::collections::HashMap<String, u64>,
    pub tags: std::collections::HashMap<String, u64>,
}

/// A deleted stack, notebook, tag, or shortcut that must also disappear on
/// other devices. Shortcuts use `"<target type>:<target id>"` as their id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub kind: String,
    pub id: String,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNote {
    pub id: String,
    pub notebook_id: String,
    pub title: String,
    pub content_html: String,
    pub attributes: Value,
    pub tags: Vec<String>,
    /// Revision the editor started from. When the stored note has moved on
    /// with different content, for example because synchronization replaced
    /// it, the stored version is kept as a separate note instead of being
    /// overwritten unseen.
    #[serde(default)]
    pub base_revision: Option<i64>,
}

/// A note as it was before it was changed in the editor, kept on this
/// device so that the change can be taken back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersion {
    pub id: i64,
    /// When this form was put aside.
    pub kept_at: i64,
    /// The date the note itself had then.
    pub updated_at: i64,
    pub title: String,
    /// How its text begins, to tell it from the others.
    pub preview: String,
}

/// Result of saving a note from the editor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    pub note: Note,
    /// Title of the note that preserves the version the save replaced.
    pub conflict_copy: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum NoteSort {
    Relevance,
    #[default]
    UpdatedDesc,
    UpdatedAsc,
    CreatedDesc,
    CreatedAsc,
    TitleAsc,
    TitleDesc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFilter {
    #[serde(default)]
    pub query: String,
    pub notebook_id: Option<String>,
    pub stack_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub include_trash: bool,
    #[serde(default)]
    pub trash_only: bool,
    pub created_from: Option<i64>,
    pub created_to: Option<i64>,
    pub updated_from: Option<i64>,
    pub updated_to: Option<i64>,
    pub contains: Option<String>,
    #[serde(default)]
    pub sort: NoteSort,
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

const fn default_limit() -> u32 {
    100
}

impl Default for NoteFilter {
    fn default() -> Self {
        Self {
            query: String::new(),
            notebook_id: None,
            stack_id: None,
            tag_ids: Vec::new(),
            include_trash: false,
            trash_only: false,
            created_from: None,
            created_to: None,
            updated_from: None,
            updated_to: None,
            contains: None,
            sort: NoteSort::UpdatedDesc,
            limit: default_limit(),
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub stacks: Vec<Stack>,
    pub notebooks: Vec<Notebook>,
    pub tags: Vec<Tag>,
    pub shortcuts: Vec<Shortcut>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub notes_imported: u64,
    /// Notes whose newer form took the place of the one imported before.
    #[serde(default)]
    pub notes_updated: u64,
    /// Of the imported notes, those added beside an earlier form of
    /// themselves that had been changed in this library.
    #[serde(default)]
    pub notes_kept_both: u64,
    /// Notes already present from an earlier import of the same content.
    pub notes_skipped: u64,
    /// Notes that could not be read; each has an entry in `warnings`.
    pub notes_failed: u64,
    pub resources_imported: u64,
    pub bytes_imported: u64,
    /// Images queued for background text recognition.
    pub images_queued: u64,
    /// Internal Evernote links that now point at local notes.
    pub links_resolved: u64,
    /// Evernote's tasks that came as items of checklists, and the notes
    /// they are in.
    #[serde(default)]
    pub tasks_brought: u64,
    #[serde(default)]
    pub notes_with_tasks: u64,
    pub cancelled: bool,
    pub notebook_id: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub phase: String,
    pub notebook_id: String,
    pub note_index: u64,
    pub note_title: Option<String>,
    pub notes_imported: u64,
    pub notes_skipped: u64,
    pub notes_failed: u64,
    pub resources_imported: u64,
    pub bytes_read: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: u64,
    pub pulled: u64,
    pub conflicts: u64,
    pub blobs_uploaded: u64,
    pub blobs_downloaded: u64,
    pub synced_at: i64,
    pub duration_ms: u64,
    pub network_ms: u64,
    pub remote_requests: u64,
    pub bytes_uploaded: u64,
    pub bytes_downloaded: u64,
    /// Notes that could not be synchronized this time, with the reason.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// Requests that were made again because they did not complete.
    #[serde(default)]
    pub retries: u64,
    /// Times the storage service said it was being asked too much.
    #[serde(default)]
    pub throttled: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: String,
    pub message: String,
    pub current: u64,
    pub total: u64,
    pub elapsed_ms: u64,
    pub network_ms: u64,
    pub remote_requests: u64,
    pub bytes_uploaded: u64,
    pub bytes_downloaded: u64,
    /// Requests that were made again because they did not complete.
    #[serde(default)]
    pub retries: u64,
}
