use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use md5::Context as Md5;
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use crate::{db::Library, error::Result, BeverError};

/// Width and height a picture is brought within for the list of notes.
const THUMBNAIL_SIDE: u32 = 240;
/// Largest picture a thumbnail is made of; decoding it takes memory.
const THUMBNAIL_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredBlob {
    pub sha256: String,
    pub md5: String,
    pub size: u64,
}

struct BlobWriter {
    file: BufWriter<File>,
    sha256: Sha256,
    md5: Md5,
    size: u64,
}

impl Write for BlobWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.file.write(buf)?;
        self.sha256.update(&buf[..written]);
        self.md5.consume(&buf[..written]);
        self.size += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

impl Library {
    pub fn store_blob(&self, bytes: &[u8]) -> Result<StoredBlob> {
        self.store_blob_reader(&mut BufReader::new(bytes))
    }

    pub fn store_blob_file(&self, path: impl AsRef<Path>) -> Result<StoredBlob> {
        let mut reader = BufReader::new(File::open(path)?);
        self.store_blob_reader(&mut reader)
    }

    /// Streams bytes into the store and returns their hashes. Nothing is kept
    /// when reading fails part-way.
    pub fn store_blob_reader(&self, reader: &mut impl Read) -> Result<StoredBlob> {
        let staging = self.blob_dir.join(format!(".{}", Uuid::new_v4()));
        let stored = self.write_staging(reader, &staging);
        if stored.is_err() {
            let _ = fs::remove_file(&staging);
        }
        self.publish_staging(&staging, stored?)
    }

    fn write_staging(&self, reader: &mut impl Read, staging: &Path) -> Result<StoredBlob> {
        let file = File::create(staging)?;
        let mut writer = BlobWriter {
            file: BufWriter::with_capacity(256 * 1024, file),
            sha256: Sha256::new(),
            md5: Md5::new(),
            size: 0,
        };
        std::io::copy(reader, &mut writer)?;
        writer.flush()?;
        Ok(StoredBlob {
            sha256: format!("{:x}", writer.sha256.finalize()),
            md5: format!("{:x}", writer.md5.compute()),
            size: writer.size,
        })
    }

    fn publish_staging(&self, staging: &Path, stored: StoredBlob) -> Result<StoredBlob> {
        let destination = self.blob_path(&stored.sha256)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if destination.exists() {
            fs::remove_file(staging)?;
        } else if let Err(error) = fs::rename(staging, &destination) {
            if destination.exists() {
                fs::remove_file(staging)?;
            } else {
                let _ = fs::remove_file(staging);
                return Err(error.into());
            }
        }
        Ok(stored)
    }

    /// Removes staging files left behind by a process that was killed while
    /// storing a blob. Call once at startup, before anything is imported.
    pub fn remove_stale_staging(&self) -> Result<()> {
        for entry in fs::read_dir(&self.blob_dir)? {
            let entry = entry?;
            let is_staging = entry.file_name().to_string_lossy().starts_with('.');
            if is_staging && entry.file_type()?.is_file() {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    pub fn blob_path(&self, sha256: &str) -> Result<PathBuf> {
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(BeverError::Invalid("invalid blob SHA-256".into()));
        }
        Ok(self
            .blob_dir
            .join(&sha256[0..2])
            .join(&sha256[2..4])
            .join(sha256))
    }

    pub fn read_blob(&self, sha256: &str) -> Result<Vec<u8>> {
        Ok(fs::read(self.blob_path(sha256)?)?)
    }

    pub fn open_blob(&self, sha256: &str) -> Result<File> {
        Ok(File::open(self.blob_path(sha256)?)?)
    }

    fn thumbnail_path(&self, sha256: &str) -> Result<PathBuf> {
        // Checks the name, which becomes part of a path.
        self.blob_path(sha256)?;
        Ok(self
            .blob_dir
            .join("thumbnails")
            .join(format!("{sha256}.jpg")))
    }

    /// A small JPEG of the picture with these bytes, for the list of notes.
    /// It is made once and kept next to the attachments.
    pub fn thumbnail(&self, sha256: &str) -> Result<Vec<u8>> {
        let path = self.thumbnail_path(sha256)?;
        if let Ok(known) = fs::read(&path) {
            return Ok(known);
        }
        let source = self.blob_path(sha256)?;
        if fs::metadata(&source)?.len() > THUMBNAIL_MAX_BYTES {
            return Err(BeverError::Invalid(
                "the picture is too large for a thumbnail".into(),
            ));
        }
        let small = crate::picture::thumbnail(&fs::read(source)?, THUMBNAIL_SIDE)?;
        // Kept for the next time; it is shown either way.
        if let Some(parent) = path.parent() {
            if fs::create_dir_all(parent).is_ok() {
                let staging = parent.join(format!(".{}", Uuid::new_v4()));
                if fs::write(&staging, &small).is_err() || fs::rename(&staging, &path).is_err() {
                    let _ = fs::remove_file(&staging);
                }
            }
        }
        Ok(small)
    }

    /// Removes an attachment's file, and the small picture made of it.
    pub(crate) fn remove_blob(&self, sha256: &str) -> Result<()> {
        let _ = fs::remove_file(self.thumbnail_path(sha256)?);
        match fs::remove_file(self.blob_path(sha256)?) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn blobs_are_verifiable_and_deduplicated() {
        let directory = tempdir().unwrap();
        let library = Library::open_at(
            directory.path().join("db.sqlite"),
            directory.path().join("blobs"),
        )
        .unwrap();
        let first = library.store_blob(b"bever").unwrap();
        let second = library.store_blob(b"bever").unwrap();
        assert_eq!(first, second);
        assert_eq!(library.read_blob(&first.sha256).unwrap(), b"bever");
        assert_eq!(first.md5, "09aee0fa7484b262a39863a9fdaa5c20");
    }
}
