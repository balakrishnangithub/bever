//! The folder a library is kept in at the storage.
//!
//! One storage account can hold several libraries, each in a folder of its
//! own: two people who share an account, or one person with two libraries.
//! A folder that holds a library says so in a small file, [`MARKER`], which
//! names the library. With it:
//!
//! - a folder can be told to hold a library, and which, by whoever chooses
//!   one;
//! - a library that finds another library where its own was, or nothing, or
//!   no folder, stops instead of taking what it finds for its own. What it
//!   knows of the storage (which notes are there, and as what) is true of one
//!   library only.
//!
//! A run pays nothing for this: the listing it begins with shows the file
//! and what stands for its content, and the file is read only when that is
//! not what was last seen.
//!
//! Nothing here knows which storage service it is.
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    remote::{Listing, RemoteStore},
    Layout, BLOBS, DEFAULT_REMOTE_ROOT, ITEMS,
};
use crate::{
    db::Library,
    error::{BeverError, Result},
};

/// The file that says a folder holds a library, and which.
pub const MARKER: &str = "library.json";

/// The setting that names the folder chosen for this library.
const FOLDER: &str = "sync_folder";
/// The setting [`Known`] is kept in.
const IDENTITY: &str = "sync_library";
/// Settings that are true of the library last synchronized with, and of no
/// other.
const OF_THE_REMOTE: [&str; 2] = ["sync_metadata_seen", "last_sync_at"];

#[derive(Debug, Serialize, Deserialize)]
struct Marker {
    /// For whoever finds the file among their own.
    about: String,
    id: String,
}

/// The library this device synchronizes with, as its folder named it when
/// last seen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Known {
    id: String,
    /// The marker's version; see [`super::RemoteFile::version`].
    version: String,
}

/// A folder at the storage, as shown to whoever chooses where a library is
/// kept.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    pub path: String,
    /// The folders inside, in the order names are read in. None are given of
    /// a folder that holds a library: there is nowhere to go in it.
    pub folders: Vec<String>,
    /// Whether nothing at all is in it.
    pub empty: bool,
    /// Whether it holds a library.
    pub holds_library: bool,
    /// Whether that is the library this device synchronizes with already.
    pub ours: bool,
}

/// What is chosen for a library: a folder that is made for it, or one that
/// holds a library already, which this device joins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    New,
    Existing,
}

impl Library {
    /// The folder this library synchronizes with, once that is settled: the
    /// one chosen for it, or, for a library that was synchronized before
    /// folders could be chosen, the one every library had.
    pub fn sync_folder(&self) -> Result<Option<String>> {
        if let Some(folder) = self.setting(FOLDER)?.filter(|folder| !folder.is_empty()) {
            return Ok(Some(folder));
        }
        let connection = self.connection.lock();
        let synchronized: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_items)
                 OR EXISTS(SELECT 1 FROM settings WHERE key IN (?1, ?2, ?3))",
            params![OF_THE_REMOTE[0], OF_THE_REMOTE[1], IDENTITY],
            |row| row.get(0),
        )?;
        Ok(synchronized.then(|| DEFAULT_REMOTE_ROOT.to_owned()))
    }
}

pub(crate) fn known(library: &Library) -> Result<Option<Known>> {
    Ok(library
        .setting(IDENTITY)?
        .and_then(|stored| serde_json::from_str(&stored).ok()))
}

fn remember(library: &Library, known: &Known) -> Result<()> {
    library.set_setting(IDENTITY, &serde_json::to_string(known)?)
}

/// Whether what a folder holds is a library: it says so, or, written before
/// libraries said so, it has the two folders of one.
fn holds_library(listing: &Listing) -> bool {
    listing.file(MARKER).is_some() || (listing.has_folder(ITEMS) && listing.has_folder(BLOBS))
}

fn marker_path(folder: &str) -> String {
    format!("{folder}/{MARKER}")
}

/// Which library a folder says it holds.
fn read(remote: &dyn RemoteStore, folder: &str) -> Result<String> {
    let bytes = remote.download(&marker_path(folder))?;
    let marker: Marker = serde_json::from_slice(&bytes).map_err(|error| {
        BeverError::Remote(format!(
            "{} is unreadable ({error}); the folder cannot be told to be this library's",
            marker_path(folder)
        ))
    })?;
    Ok(marker.id)
}

/// Makes a folder say that it holds a library, a new one.
fn write(remote: &dyn RemoteStore, folder: &str) -> Result<Known> {
    let marker = Marker {
        about: "A library of notes kept here by Bever. Bever tells the library by this file: leave it where it is.".into(),
        id: Uuid::new_v4().to_string(),
    };
    let stored = remote.upload(&marker_path(folder), serde_json::to_vec_pretty(&marker)?)?;
    Ok(Known {
        id: marker.id,
        version: stored.version,
    })
}

fn not_there(folder: &str) -> BeverError {
    BeverError::Remote(format!(
        "the folder {folder}, where this library is kept, is not there any more. If it was moved or renamed, choose it again in Settings, as an existing library; if it was removed, start a new one there. Nothing was changed on this device."
    ))
}

fn not_ours(folder: &str) -> BeverError {
    BeverError::Remote(format!(
        "the folder {folder} no longer holds the library this device synchronizes with: it was replaced, or emptied. Choose the folder of this library again in Settings. Nothing was changed on either side."
    ))
}

/// The folder a run works in, as its listing shows it: `None` when there is
/// no such folder. A library that knows which library it synchronizes with
/// goes on only when that is the one in the folder. Returns whether the
/// folder has yet to say which library it holds; see [`mark`].
pub(crate) fn recognise(
    library: &Library,
    remote: &dyn RemoteStore,
    layout: &Layout,
    listing: Option<&Listing>,
) -> Result<bool> {
    let known = known(library)?;
    let Some(listing) = listing else {
        // A folder that was never there is made by the run. One that was
        // there is not made again: an empty folder in its place would be
        // taken for the library, with all its notes already in it.
        return match known {
            Some(_) => Err(not_there(&layout.root)),
            None => Ok(true),
        };
    };
    match (listing.file(MARKER), known) {
        (Some(marker), Some(known))
            if !marker.version.is_empty() && marker.version == known.version =>
        {
            Ok(false)
        }
        (Some(marker), known) => {
            let id = read(remote, &layout.root)?;
            if known.is_some_and(|known| known.id != id) {
                return Err(not_ours(&layout.root));
            }
            remember(
                library,
                &Known {
                    id,
                    version: marker.version.clone(),
                },
            )?;
            Ok(false)
        }
        (None, Some(_)) => Err(not_ours(&layout.root)),
        // Written before libraries were named, or about to be written for
        // the first time.
        (None, None) => Ok(true),
    }
}

/// Makes the folder of a run say which library it holds. A run does this
/// last, when the folder holds what the library has.
pub(crate) fn mark(library: &Library, remote: &dyn RemoteStore, layout: &Layout) -> Result<()> {
    remember(library, &write(remote, &layout.root)?)
}

/// Whether `path` names a folder a library can be kept in: absolute, with
/// no empty or relative part, and not the top of the storage.
pub(crate) fn is_folder_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && !path.ends_with('/')
        && !path.contains("//")
        && !path.contains('\\')
        && !path
            .split('/')
            .any(|part| part == "." || part == ".." || part.trim() != part)
}

/// What is in a folder, for choosing where a library is kept. `/` is the
/// top of the storage.
pub fn look(library: &Library, remote: &dyn RemoteStore, path: &str) -> Result<FolderView> {
    if path != "/" && !is_folder_path(path) {
        return Err(BeverError::Invalid(format!("{path} is not a folder")));
    }
    let listing = remote
        .list(path)?
        .ok_or_else(|| BeverError::NotFound(format!("there is no folder {path}")))?;
    let holds_library = path != "/" && holds_library(&listing);
    let ours = holds_library
        && match (listing.file(MARKER), known(library)?) {
            (Some(marker), Some(known)) => {
                (!marker.version.is_empty() && marker.version == known.version)
                    || read(remote, path)? == known.id
            }
            (None, Some(_)) => false,
            (_, None) => from_before(library, path)?,
        };
    let mut folders = if holds_library {
        Vec::new()
    } else {
        listing.folders.clone()
    };
    folders.sort_by(|left, right| crate::natural::compare(left, right));
    Ok(FolderView {
        path: path.to_owned(),
        folders,
        empty: listing.files.is_empty() && listing.folders.is_empty(),
        holds_library,
        ours,
    })
}

/// Whether `path` is where this library was synchronized before libraries
/// were named: it knows no name for what it synchronizes with, and that is
/// the folder it synchronizes with. What is there is then its own library.
fn from_before(library: &Library, path: &str) -> Result<bool> {
    Ok(known(library)?.is_none() && library.sync_folder()?.as_deref() == Some(path))
}

/// Settles where this library is kept.
///
/// [`Choice::New`] makes the folder, which must not be there yet or must be
/// empty, and has it say that it holds a library. Every note of this device
/// is uploaded to it by the next run.
///
/// [`Choice::Existing`] joins the library a folder holds. When that is the
/// library this device synchronizes with already, found again where it was
/// moved to, the next run goes on from where the last one ended. When it is
/// another, the two become one: the notes of each go to the other, and a
/// note that both have, and have differently, is kept twice.
///
/// Nothing is removed from the folder that was synchronized with before.
pub fn choose(
    library: &Library,
    remote: &dyn RemoteStore,
    path: &str,
    choice: Choice,
) -> Result<()> {
    if !is_folder_path(path) {
        return Err(BeverError::Invalid(format!(
            "{path} cannot be the folder of a library"
        )));
    }
    let before = known(library)?;
    let from_before = from_before(library, path)?;
    let listing = remote.list(path)?;
    let (now, same) = match choice {
        Choice::New => {
            match &listing {
                None => remote.ensure_folder(path)?,
                Some(listing) if listing.files.is_empty() && listing.folders.is_empty() => {}
                Some(listing) if holds_library(listing) => {
                    return Err(BeverError::Invalid(format!(
                        "{path} already holds a library. Give the new one another name, or choose that folder as an existing library."
                    )));
                }
                Some(_) => {
                    return Err(BeverError::Invalid(format!(
                        "{path} has other things in it. A library needs a folder of its own: give the new one another name."
                    )));
                }
            }
            (write(remote, path)?, false)
        }
        Choice::Existing => {
            let listing = listing
                .ok_or_else(|| BeverError::NotFound(format!("there is no folder {path}")))?;
            if !holds_library(&listing) {
                return Err(BeverError::Invalid(format!(
                    "{path} does not hold a library"
                )));
            }
            match listing.file(MARKER) {
                Some(marker) => {
                    let id = read(remote, path)?;
                    let same = from_before || before.as_ref().is_some_and(|before| before.id == id);
                    (
                        Known {
                            id,
                            version: marker.version.clone(),
                        },
                        same,
                    )
                }
                // Written before libraries were named: it is named now.
                None => (write(remote, path)?, from_before),
            }
        }
    };

    let mut connection = library.connection.lock();
    let transaction = connection.transaction()?;
    if !same {
        // What this device knows of the storage is true of the library it
        // synchronized with, and is forgotten with it.
        transaction.execute("DELETE FROM sync_items", [])?;
        for key in OF_THE_REMOTE {
            transaction.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        }
        match choice {
            // Nothing is there to delete.
            Choice::New => {
                transaction.execute("DELETE FROM sync_tombstones WHERE kind = 'note'", [])?;
            }
            // A note both have may differ, and neither is known to be the
            // later: counted as changed here, it is kept beside the other.
            Choice::Existing => {
                transaction.execute("UPDATE notes SET dirty = 1", [])?;
            }
        }
    }
    for (key, value) in [
        (FOLDER, path.to_owned()),
        (IDENTITY, serde_json::to_string(&now)?),
    ] {
        transaction.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    transaction.commit()?;
    Ok(())
}
