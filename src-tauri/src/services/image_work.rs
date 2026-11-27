//! Admission budget for screenshot pixels and temporary encoding buffers.
use super::ServiceError;
use std::sync::{Mutex, OnceLock};

pub const MAX_WORKING_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_CONCURRENT: usize = 2;
pub const MAX_RAW_BYTES: usize = 8 * 1024 * 1024;
fn usage() -> &'static Mutex<(usize, usize)> {
    static USAGE: OnceLock<Mutex<(usize, usize)>> = OnceLock::new();
    USAGE.get_or_init(|| Mutex::new((0, 0)))
}
pub struct Permit(usize);
pub fn acquire(pixels: u64, encoded_limit: usize) -> Result<Permit, ServiceError> {
    // Reserve for the destination, native tiles and codec workspace. This is
    // admission accounting, not a measurement of total process memory.
    let bytes = usize::try_from(pixels)
        .ok()
        .and_then(|n| n.checked_mul(16))
        .and_then(|n| n.checked_add(encoded_limit))
        .filter(|n| *n <= MAX_WORKING_BYTES)
        .ok_or_else(|| {
            ServiceError::bad_params(
                "screenshot exceeds working-memory budget; request a smaller rectangle",
            )
        })?;
    let mut used = usage().lock().unwrap();
    if used.1 >= MAX_CONCURRENT || used.0 + bytes > MAX_WORKING_BYTES {
        return Err(ServiceError::conflict(
            "screenshot workers are busy; wait for the previous capture",
        ));
    }
    used.0 += bytes;
    used.1 += 1;
    Ok(Permit(bytes))
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut used = usage().lock().unwrap();
        used.0 -= self.0;
        used.1 -= 1;
    }
}
pub struct Output {
    pub bytes: Vec<u8>,
    pub exceeded: bool,
    limit: usize,
}
impl Output {
    pub fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            exceeded: false,
            limit,
        }
    }
}
impl std::io::Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit - self.bytes.len() {
            self.exceeded = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "encoded screenshot exceeds byte limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
