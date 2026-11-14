//! File references issued by the native picker and owned by one plugin window.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::async_runtime::Mutex as Slot;
use tauri::ipc::{Request, Response};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;

use crate::binary_ipc::{caller_key, chunk_body, chunk_headers, TransferKey, MAX_CHUNK_BYTES};
use crate::services::ServiceError;
use crate::{observe_rpc, run_service, RpcRejection};

const PERMISSION: &str = "rpc:fs";
const MAX_HANDLES: usize = 32;

#[derive(Default)]
struct Registry {
    files: Mutex<HashMap<TransferKey, Arc<Slot<Entry>>>>,
    live: Arc<AtomicUsize>,
    commits: Mutex<()>,
}

#[derive(Clone, Default)]
pub struct FileHandles(Arc<Registry>);

enum Resource {
    Pending,
    Reader(File),
    Writer(Writer),
    Committed,
}

struct Entry {
    resource: Resource,
    _permit: Permit,
}

struct Permit(Arc<AtomicUsize>);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl FileHandles {
    fn files(&self) -> std::sync::MutexGuard<'_, HashMap<TransferKey, Arc<Slot<Entry>>>> {
        self.0.files.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn reserve(&self, key: TransferKey) -> Result<PendingFile, ServiceError> {
        let mut files = self.files();
        if files.contains_key(&key) {
            return Err(ServiceError::conflict(
                "file reference is already open or pending",
            ));
        }
        if self.0.live.load(Ordering::Relaxed) >= MAX_HANDLES {
            return Err(ServiceError::conflict("file reference limit reached"));
        }
        self.0.live.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(Slot::new(Entry {
            resource: Resource::Pending,
            _permit: Permit(self.0.live.clone()),
        }));
        files.insert(key.clone(), entry.clone());
        Ok(PendingFile {
            handles: self.clone(),
            key,
            entry,
            published: false,
        })
    }

    fn acquire(
        &self,
        key: &TransferKey,
    ) -> Result<impl std::ops::DerefMut<Target = Entry> + Send + 'static, ServiceError> {
        let files = self.files();
        let entry = files.get(key).cloned().ok_or_else(closed)?;
        entry
            .try_lock_owned()
            .map_err(|_| ServiceError::conflict("file operation already in progress"))
    }

    pub fn read_at(
        &self,
        key: &TransferKey,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, ServiceError> {
        read_at(&mut self.acquire(key)?.resource, offset, length)
    }

    pub fn write(&self, key: &TransferKey, offset: u64, bytes: &[u8]) -> Result<u64, ServiceError> {
        write_at(&mut self.acquire(key)?.resource, offset, bytes)
    }

    pub fn commit(&self, key: &TransferKey) -> Result<(), ServiceError> {
        commit(&mut self.acquire(key)?.resource, &self.0)
    }

    fn remove(&self, key: &TransferKey) -> Option<Arc<Slot<Entry>>> {
        self.files().remove(key)
    }

    pub fn close(&self, key: &TransferKey) -> bool {
        self.remove(key).is_some()
    }

    pub(crate) fn close_all(&self) {
        let removed = std::mem::take(&mut *self.files());
        drop(removed);
    }

    pub(crate) fn close_window(&self, window: &str) {
        let removed: Vec<_> = self
            .files()
            .extract_if(|key, _| key.window == window)
            .collect();
        if !removed.is_empty() {
            // Dropping a writer can unlink a temporary file. Page callbacks
            // invalidate references now and hand the filesystem work off.
            tauri::async_runtime::spawn_blocking(move || drop(removed));
        }
    }
}

pub struct PendingFile {
    handles: FileHandles,
    key: TransferKey,
    entry: Arc<Slot<Entry>>,
    published: bool,
}

impl Drop for PendingFile {
    fn drop(&mut self) {
        if !self.published {
            let mut files = self.handles.files();
            if files
                .get(&self.key)
                .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry))
            {
                files.remove(&self.key);
            }
        }
    }
}

impl PendingFile {
    fn publish(
        mut self,
        path: &Path,
        size: u64,
        resource: Resource,
    ) -> Result<Value, ServiceError> {
        let mut slot = self
            .entry
            .try_lock()
            .map_err(|_| ServiceError::conflict("file reference is busy"))?;
        let files = self.handles.files();
        if !files
            .get(&self.key)
            .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry))
        {
            return Err(closed());
        }
        slot.resource = resource;
        self.published = true;
        Ok(
            json!({ "path": path.to_string_lossy(), "size": size, "maxChunkBytes": MAX_CHUNK_BYTES }),
        )
    }

    pub fn reader(self, path: &Path) -> Result<Value, ServiceError> {
        if !path.metadata()?.is_file() {
            return Err(ServiceError::bad_params("select a regular file"));
        }
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(ServiceError::bad_params("select a regular file"));
        }
        self.publish(path, metadata.len(), Resource::Reader(file))
    }

    pub fn writer(self, path: &Path) -> Result<Value, ServiceError> {
        let parent = path
            .parent()
            .ok_or_else(|| ServiceError::bad_params("missing output directory"))?;
        let name = path
            .file_name()
            .ok_or_else(|| ServiceError::bad_params("missing output file name"))?;
        let parent = parent.canonicalize()?;
        let target = parent.join(name);
        let before = snapshot(&target)?;
        let temp = NamedTempFile::new_in(parent)?;
        self.publish(
            path,
            0,
            Resource::Writer(Writer {
                target,
                before,
                temp: Some(temp),
                written: 0,
                failed: false,
            }),
        )
    }
}

fn closed() -> ServiceError {
    ServiceError::not_found("file reference is closed or belongs to another caller")
}

fn check_size(length: usize) -> Result<(), ServiceError> {
    if length > MAX_CHUNK_BYTES {
        return Err(ServiceError::bad_params("file chunk exceeds 256 KiB"));
    }
    Ok(())
}

fn read_at(resource: &mut Resource, offset: u64, length: usize) -> Result<Vec<u8>, ServiceError> {
    check_size(length)?;
    let Resource::Reader(file) = resource else {
        return Err(ServiceError::conflict(
            "file reference is not open for reading",
        ));
    };
    file.seek(SeekFrom::Start(offset))?;
    let mut chunk = Vec::with_capacity(length);
    file.take(length as u64).read_to_end(&mut chunk)?;
    Ok(chunk)
}

struct Writer {
    target: PathBuf,
    before: Option<(u64, SystemTime)>,
    temp: Option<NamedTempFile>,
    written: u64,
    failed: bool,
}

fn snapshot(path: &Path) -> Result<Option<(u64, SystemTime)>, ServiceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some((metadata.len(), metadata.modified()?))),
        Ok(_) => Err(ServiceError::bad_params(
            "save target must be a regular file",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_at(resource: &mut Resource, offset: u64, bytes: &[u8]) -> Result<u64, ServiceError> {
    check_size(bytes.len())?;
    let Resource::Writer(writer) = resource else {
        return Err(ServiceError::conflict(
            "file reference is not open for writing",
        ));
    };
    if writer.failed {
        return Err(ServiceError::conflict(
            "write failed; close the writer and start again",
        ));
    }
    let end = offset
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| ServiceError::bad_params("invalid file offset"))?;
    let file = writer
        .temp
        .as_mut()
        .expect("uncommitted writer")
        .as_file_mut();
    if offset == writer.written {
        file.seek(SeekFrom::Start(offset))?;
        if let Err(error) = file.write_all(bytes) {
            writer.failed = true;
            return Err(error.into());
        }
        writer.written = end;
    } else if end <= writer.written {
        file.seek(SeekFrom::Start(offset))?;
        let mut existing = vec![0; bytes.len()];
        file.read_exact(&mut existing)?;
        if existing != bytes {
            return Err(ServiceError::conflict(
                "replayed bytes differ from the written block",
            ));
        }
    } else {
        return Err(ServiceError::conflict(
            "write must continue at the acknowledged offset",
        ));
    }
    Ok(writer.written)
}

fn commit(resource: &mut Resource, registry: &Registry) -> Result<(), ServiceError> {
    let writer = match resource {
        Resource::Committed => return Ok(()),
        Resource::Writer(writer) if !writer.failed => writer,
        _ => return Err(ServiceError::conflict("file reference cannot be committed")),
    };
    writer
        .temp
        .as_ref()
        .expect("uncommitted writer")
        .as_file()
        .sync_all()?;
    // Serialize the check and replacement between Toolkit writers. File size
    // and modification time detect ordinary external edits, not an OS lock.
    let _commit = registry.commits.lock().unwrap_or_else(|e| e.into_inner());
    if snapshot(&writer.target)? != writer.before {
        return Err(ServiceError::conflict(
            "save target changed after selection",
        ));
    }
    let temp = writer.temp.take().expect("uncommitted writer");
    let result = if writer.before.is_some() {
        temp.persist(&writer.target)
    } else {
        temp.persist_noclobber(&writer.target)
    };
    match result {
        Ok(_) => {
            *resource = Resource::Committed;
            Ok(())
        }
        Err(error) => {
            writer.temp = Some(error.file);
            Err(error.error.into())
        }
    }
}

pub fn capabilities() -> Value {
    json!({ "version": 1, "permission": PERMISSION, "maxChunkBytes": MAX_CHUNK_BYTES, "maxHandles": MAX_HANDLES })
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Control {
    Open {
        write: bool,
        title: Option<String>,
        directory: Option<PathBuf>,
        #[serde(rename = "defaultPath")]
        default_path: Option<String>,
    },
    Stat,
    Commit,
    Close,
}

#[tauri::command]
pub(crate) async fn plugin_fs_control(
    window: WebviewWindow,
    handles: State<'_, FileHandles>,
    plugin_id: String,
    id: String,
    action: Control,
) -> Result<Value, RpcRejection> {
    let key = caller_key(&window, plugin_id, id, PERMISSION)?;
    let name = match &action {
        Control::Open { .. } => "open",
        Control::Stat => "stat",
        Control::Commit => "commit",
        Control::Close => "close",
    };
    let ticket = Arc::new(observe_rpc(window.label(), "fs", name));
    let handles = handles.inner().clone();
    let result = match action {
        Control::Open {
            write,
            title,
            directory,
            default_path,
        } => {
            let pending = handles.reserve(key)?;
            let mut dialog = window.dialog().file().set_parent(&window);
            if let Some(title) = title {
                dialog = dialog.set_title(title);
            }
            if let Some(directory) = directory {
                dialog = dialog.set_directory(directory);
            }
            if let Some(name) = default_path {
                dialog = dialog.set_file_name(name);
            }
            run_service(ticket, move || {
                let picked = if write {
                    dialog.blocking_save_file()
                } else {
                    dialog.blocking_pick_file()
                };
                let Some(path) = picked else {
                    return Ok(Value::Null);
                };
                let path = path
                    .into_path()
                    .map_err(|error| ServiceError::io(error.to_string()))?;
                if write {
                    pending.writer(&path)
                } else {
                    pending.reader(&path)
                }
            })
            .await
        }
        Control::Stat => {
            let entry = handles.acquire(&key)?;
            run_service(ticket, move || {
                let Resource::Reader(file) = &entry.resource else {
                    return Err(ServiceError::conflict(
                        "file reference is not open for reading",
                    ));
                };
                Ok(json!({ "size": file.metadata()?.len() }))
            })
            .await
        }
        Control::Commit => {
            let mut resource = handles.acquire(&key)?;
            run_service(ticket, move || {
                commit(&mut resource.resource, &handles.0).map(|()| Value::Bool(true))
            })
            .await
        }
        Control::Close => {
            let removed = handles.remove(&key);
            run_service(ticket, move || Ok(json!(removed.is_some()))).await
        }
    };
    Ok(result.map_err(|error| ServiceError::internal(error.to_string()))??)
}

#[tauri::command]
pub(crate) async fn plugin_fs_read(
    window: WebviewWindow,
    handles: State<'_, FileHandles>,
    plugin_id: String,
    id: String,
    offset: u64,
    length: usize,
) -> Result<Response, RpcRejection> {
    check_size(length)?;
    let key = caller_key(&window, plugin_id, id, PERMISSION)?;
    let mut resource = handles.acquire(&key)?;
    let ticket = Arc::new(observe_rpc(window.label(), "fs", "read"));
    let chunk = run_service(ticket, move || {
        read_at(&mut resource.resource, offset, length)
    })
    .await
    .map_err(|error| ServiceError::internal(error.to_string()))??;
    Ok(Response::new(chunk))
}

#[tauri::command]
pub(crate) async fn plugin_fs_write(
    window: WebviewWindow,
    handles: State<'_, FileHandles>,
    request: Request<'_>,
) -> Result<u64, RpcRejection> {
    let (plugin, id, offset) = chunk_headers(&request)?;
    let key = caller_key(&window, plugin.into(), id.into(), PERMISSION)?;
    let mut resource = handles.acquire(&key)?;
    let bytes = chunk_body(&request)?.into_owned();
    let ticket = Arc::new(observe_rpc(window.label(), "fs", "write"));
    Ok(run_service(ticket, move || {
        write_at(&mut resource.resource, offset, &bytes)
    })
    .await
    .map_err(|error| ServiceError::internal(error.to_string()))??)
}
