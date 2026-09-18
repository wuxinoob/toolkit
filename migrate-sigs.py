"""Migrate the gateway-facing signatures to ServiceError.

Scope: the six `Service::dispatch` impls and the helpers reachable from them.
The stream COMMANDS' provider/sink machinery is deliberately left on String —
those errors surface as invoke rejections in JS, not as `err` envelopes, so they
are outside the code vocabulary.
"""
import pathlib

ROOT = pathlib.Path('src-tauri/src/services')

IMPORT_OLD = 'use super::Service;'
IMPORT_NEW = 'use super::{Service, ServiceError};\nuse crate::protocol::codes::code;'

PLAN = {
    'bus.rs': [],  # already migrated
    'hotkey.rs': [],  # already migrated
    'proc.rs': [
        (IMPORT_OLD, IMPORT_NEW),
        ('fn params_str(params: &Value, key: &str) -> Result<String, String> {',
         'fn params_str(params: &Value, key: &str) -> Result<String, ServiceError> {'),
        ('fn spawn_handle(exe: &Path, args: &[String], cwd: &Path) -> Result<ProcHandle, String> {',
         'fn spawn_handle(exe: &Path, args: &[String], cwd: &Path) -> Result<ProcHandle, ServiceError> {'),
        ('pub fn resolve_exe_at(plugin_dir: &Path, exe: &str) -> Result<PathBuf, String> {',
         'pub fn resolve_exe_at(plugin_dir: &Path, exe: &str) -> Result<PathBuf, ServiceError> {'),
        ('fn write_line(h: &ProcHandle, line: &str) -> Result<(), String> {',
         'fn write_line(h: &ProcHandle, line: &str) -> Result<(), ServiceError> {'),
        ('fn action_spawn(root: &Path, plugin_id: &str, params: &Value) -> Result<Value, String> {',
         'fn action_spawn(root: &Path, plugin_id: &str, params: &Value) -> Result<Value, ServiceError> {'),
        ('fn action_send(plugin_id: &str, params: &Value) -> Result<Value, String> {',
         'fn action_send(plugin_id: &str, params: &Value) -> Result<Value, ServiceError> {'),
        ('fn action_recv(plugin_id: &str, params: &Value) -> Result<Value, String> {',
         'fn action_recv(plugin_id: &str, params: &Value) -> Result<Value, ServiceError> {'),
        ('pub fn dispatch_at(root: &Path, plugin_id: &str, action: &str, params: Value) -> Result<Value, String> {',
         'pub fn dispatch_at(root: &Path, plugin_id: &str, action: &str, params: Value) -> Result<Value, ServiceError> {'),
    ],
    'storage.rs': [
        (IMPORT_OLD, IMPORT_NEW),
        ('pub(crate) fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {',
         'pub(crate) fn validate_plugin_id(plugin_id: &str) -> Result<(), ServiceError> {'),
        ('fn plugin_data_dir_at(data_root: &Path, plugin_id: &str) -> Result<PathBuf, String> {',
         'fn plugin_data_dir_at(data_root: &Path, plugin_id: &str) -> Result<PathBuf, ServiceError> {'),
        ('fn store_path_at(data_root: &Path, plugin_id: &str) -> Result<PathBuf, String> {',
         'fn store_path_at(data_root: &Path, plugin_id: &str) -> Result<PathBuf, ServiceError> {'),
        ('fn read_store(path: &Path) -> Result<Map<String, Value>, String> {',
         'fn read_store(path: &Path) -> Result<Map<String, Value>, ServiceError> {'),
        ('fn write_store(path: &Path, map: &Map<String, Value>) -> Result<(), String> {',
         'fn write_store(path: &Path, map: &Map<String, Value>) -> Result<(), ServiceError> {'),
        ('fn params_str(params: &Value, key: &str) -> Result<String, String> {',
         'fn params_str(params: &Value, key: &str) -> Result<String, ServiceError> {'),
        ('fn append_debug_log_at(data_root: &Path, content: &str) -> Result<(), String> {',
         'fn append_debug_log_at(data_root: &Path, content: &str) -> Result<(), ServiceError> {'),
        ('fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {',
         'fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, ServiceError> {'),
        ('pub fn dispatch_at(root: &Path, plugin_id: &str, service: &str, action: &str, params: Value) -> Result<Value, String> {',
         'pub fn dispatch_at(root: &Path, plugin_id: &str, service: &str, action: &str, params: Value) -> Result<Value, ServiceError> {'),
    ],
    'stream.rs': [
        (IMPORT_OLD, IMPORT_NEW),
    ],
    'session.rs': [
        ('use serde_json::{json, Value};',
         'use serde_json::{json, Value};\n\nuse super::ServiceError;\nuse crate::protocol::codes::code;'),
        ('    stop: StopFn,\n) -> Result<Arc<AtomicU64>, String> {',
         '    stop: StopFn,\n) -> Result<Arc<AtomicU64>, ServiceError> {'),
    ],
}

# every `) -> Result<Value, String> {` is a dispatch impl in these files
SIG_OLD = ') -> Result<Value, String> {'
SIG_NEW = ') -> Result<Value, ServiceError> {'

for name, pairs in PLAN.items():
    p = ROOT / name
    s = p.read_text(encoding='utf-8')
    for old, new in pairs:
        if old not in s:
            print(f'MISS {name}: {old[:70]!r}')
            raise SystemExit(1)
        s = s.replace(old, new, 1)
    # dispatch signatures (all of them in these files)
    n = s.count(SIG_OLD)
    if name in ('proc.rs', 'storage.rs', 'stream.rs'):
        s = s.replace(SIG_OLD, SIG_NEW)
    p.write_text(s, encoding='utf-8')
    print(f'ok   {name}  (dispatch signatures rewritten: {n})')
