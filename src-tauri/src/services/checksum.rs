//! File checksums computed on the native side with a fixed-size read buffer.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::ServiceError;

pub struct FileChecksum {
    pub size: u64,
    pub sha256: String,
}

pub fn sha256(path: &Path) -> Result<FileChecksum, ServiceError> {
    let mut file = File::open(path)?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(ServiceError::bad_params("select a regular file"));
    }

    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let mut size = 0;
    let mut input = file.by_ref().take(before.len());
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        size += count as u64;
    }

    let after = file.metadata()?;
    if size != before.len()
        || size != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(ServiceError::conflict(
            "file changed while computing SHA-256",
        ));
    }
    Ok(FileChecksum {
        size,
        sha256: format!("{:x}", hash.finalize()),
    })
}
