"""Step 1 of the error-code migration: imports + signatures only.

Every bare `Err("...")` then becomes a compile error, so the compiler enumerates
the sites that need a real code — nothing gets silently left as a string.
"""
import pathlib

ROOT = pathlib.Path('src-tauri/src/services')

# (file, [(old, new), ...]) — every pair must apply, or the script fails loudly.
PLAN = {
    'bus.rs': [
        ('use super::Service;',
         'use super::{Service, ServiceError};\nuse crate::protocol::codes::code;'),
        (') -> Result<Value, String> {', ') -> Result<Value, ServiceError> {'),
    ],
    'hotkey.rs': [
        ('use super::Service;',
         'use super::{Service, ServiceError};\nuse crate::protocol::codes::code;'),
        (') -> Result<Value, String> {', ') -> Result<Value, ServiceError> {'),
        ('pub fn resolve_owner(caller: &str, params: &Value) -> Result<String, String> {',
         'pub fn resolve_owner(caller: &str, params: &Value) -> Result<String, ServiceError> {'),
        ('pub fn parse_shortcut(key: &str) -> Result<Shortcut, String> {',
         'pub fn parse_shortcut(key: &str) -> Result<Shortcut, ServiceError> {'),
    ],
    'proc.rs': [
        ('use super::Service;',
         'use super::{Service, ServiceError};\nuse crate::protocol::codes::code;'),
        (') -> Result<Value, String> {', ') -> Result<Value, ServiceError> {'),
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
    ],
    'storage.rs': [
        ('use super::Service;',
         'use super::{Service, ServiceError};\nuse crate::protocol::codes::code;'),
        (') -> Result<Value, String> {', ') -> Result<Value, ServiceError> {'),
        ('fn params_str(params: &Value, key: &str) -> Result<String, String> {',
         'fn params_str(params: &Value, key: &str) -> Result<String, ServiceError> {'),
    ],
    'stream.rs': [
        ('use super::Service;',
         'use super::{Service, ServiceError};\nuse crate::protocol::codes::code;'),
        (') -> Result<Value, String> {', ') -> Result<Value, ServiceError> {'),
    ],
    'session.rs': [
        ('use super::Service;',
         'use super::{Service, ServiceError};\nuse crate::protocol::codes::code;'),
        ('    stop: StopFn,\n) -> Result<Arc<AtomicU64>, String> {',
         '    stop: StopFn,\n) -> Result<Arc<AtomicU64>, ServiceError> {'),
    ],
}

for name, pairs in PLAN.items():
    p = ROOT / name
    s = p.read_text(encoding='utf-8')
    for old, new in pairs:
        if old not in s:
            print(f'MISS {name}: {old[:60]!r}')
            raise SystemExit(1)
        s = s.replace(old, new, 1)
    p.write_text(s, encoding='utf-8')
    print(f'ok   {name}')
