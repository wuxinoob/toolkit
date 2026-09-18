"""Give every service error site a real code from the closed set.

Includes the sites the compiler CANNOT catch: `?` on a `Result<_, String>`, and
`Err("...".into())` / `ok_or("...")` — those convert silently via `From` and
would all have become `internal`, which is exactly the uninformative outcome
this work exists to remove.
"""
import pathlib

SRC = pathlib.Path('src-tauri/src')
S = SRC / 'services'

PLAN = {
    'services/mod.rs': [
        # a `?` on std::io::Result should be an IO error, not a compile error
        ("""impl From<String> for ServiceError {""",
         """impl From<std::io::Error> for ServiceError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}

impl From<String> for ServiceError {"""),
    ],
    'lib.rs': [
        # these two commands return Result<_, String> (invoke rejections), so the
        # ServiceError has to be unwrapped into its message
        ('fn plugin_register(plugin_id: String, permissions: Vec<String>) -> Result<(), String> {\n    services::storage::validate_plugin_id(&plugin_id)?;',
         'fn plugin_register(plugin_id: String, permissions: Vec<String>) -> Result<(), String> {\n    services::storage::validate_plugin_id(&plugin_id).map_err(|e| e.msg)?;'),
        ('fn plugin_rpc(app: tauri::AppHandle, plugin_id: String, msg: Envelope) -> Result<Envelope, String> {\n    services::storage::validate_plugin_id(&plugin_id)?;',
         'fn plugin_rpc(app: tauri::AppHandle, plugin_id: String, msg: Envelope) -> Result<Envelope, String> {\n    services::storage::validate_plugin_id(&plugin_id).map_err(|e| e.msg)?;'),
        ('        Err(e) => Ok(Envelope::err(Some(id), format!("{svc}/{act}"), e)),',
         '        // The service classified it; the caller gets that code, not a\n        // synthesized `svc/act` string it cannot branch on.\n        Err(e) => Ok(Envelope::err(Some(id), e.code, e.msg)),'),
    ],
    'services/bus.rs': [
        ('.ok_or("missing string param `topic`")?;',
         '.ok_or_else(|| ServiceError::bad_params("missing string param `topic`"))?;'),
        ('_ => Err(format!("unknown action `bus/{action}`")),',
         '_ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `bus/{action}`"))),'),
    ],
    'services/hotkey.rs': [
        ('return Err("empty `owner`".into());', 'return Err(ServiceError::bad_params("empty `owner`"));'),
        ('        Some(_) => Err(format!(\n            "plugin `{caller}` may not register a hotkey for another plugin"\n        )),',
         '        Some(_) => Err(ServiceError::new(\n            code::DENIED,\n            format!("plugin `{caller}` may not register a hotkey for another plugin"),\n        )),'),
        ('return Err("empty shortcut".into());', 'return Err(ServiceError::bad_params("empty shortcut"));'),
        ('        .map_err(|e| format!("invalid shortcut `{key}`: {e}"))',
         '        .map_err(|e| ServiceError::bad_params(format!("invalid shortcut `{key}`: {e}")))'),
        ('                .ok_or_else(|| format!("missing string param `{key}`"))',
         '                .ok_or_else(|| ServiceError::bad_params(format!("missing string param `{key}`")))'),
        ('_ => Err(format!("unknown action `hotkey/{action}`")),',
         '_ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `hotkey/{action}`"))),'),
        # the unit tests assert on the message; they can now assert the code too
        ('assert!(err.contains("invalid shortcut"), "got: {err}");',
         'assert_eq!(err.code, code::BAD_PARAMS);\n        assert!(err.msg.contains("invalid shortcut"), "got: {err}");'),
        ('assert!(err.contains("may not register"), "got: {err}");',
         'assert_eq!(err.code, code::DENIED, "acting for another plugin is an authorization failure");\n        assert!(err.msg.contains("may not register"), "got: {err}");'),
    ],
    'services/proc.rs': [
        ('        .ok_or_else(|| format!("missing string param `{key}`"))',
         '        .ok_or_else(|| ServiceError::bad_params(format!("missing string param `{key}`")))'),
        ('    let stdin = child.stdin.take().ok_or("child stdin unavailable")?;',
         '    let stdin = child\n        .stdin\n        .take()\n        .ok_or_else(|| ServiceError::spawn_failed("child stdin unavailable"))?;'),
        ('    let stdout = child.stdout.take().ok_or("child stdout unavailable")?;',
         '    let stdout = child\n        .stdout\n        .take()\n        .ok_or_else(|| ServiceError::spawn_failed("child stdout unavailable"))?;'),
        ('.map_err(|e| format!("spawn {}: {e}", exe.display()))?;',
         '.map_err(|e| ServiceError::spawn_failed(format!("spawn {}: {e}", exe.display())))?;'),
        ('.map_err(|e| format!("spawn reader thread: {e}"))?;',
         '.map_err(|e| ServiceError::spawn_failed(format!("spawn reader thread: {e}")))?;'),
        ('.map_err(|e| format!("resolve plugin dir: {e}"))?;',
         '.map_err(|e| ServiceError::io(format!("resolve plugin dir: {e}")))?;'),
        ('.map_err(|e| format!("resolve exe: {e}"))?;',
         '.map_err(|e| ServiceError::bad_params(format!("resolve exe: {e}")))?;'),
        ('return Err("empty exe path".into());', 'return Err(ServiceError::bad_params("empty exe path"));'),
        ('return Err("exe escapes plugin dir".into()); // traversal guard',
         'return Err(ServiceError::bad_params("exe escapes plugin dir")); // traversal guard'),
        ('return Err("exe is not a file".into());',
         'return Err(ServiceError::not_found("exe is not a file"));'),
        ('            Err(match code {\n                Some(c) => format!("sidecar exited (code {c}): {e}"),\n                None => format!("write sidecar: {e}"),\n            })',
         '            Err(ServiceError::io(match code {\n                Some(c) => format!("sidecar exited (code {c}): {e}"),\n                None => format!("write sidecar: {e}"),\n            }))'),
        ('    let dir = external::scan_at(root)?',
         '    let dir = external::scan_at(root).map_err(ServiceError::io)?'),
        ('        .ok_or("plugin not found in plugins root — install its folder (plugin.json) first")?',
         '        .ok_or_else(|| {\n            ServiceError::not_found(\n                "plugin not found in plugins root — install its folder (plugin.json) first",\n            )\n        })?'),
        ('        return Err(format!(\n            "too many sidecars for `{plugin_id}` (max {MAX_PROCS_PER_PLUGIN}) — proc.killAll() first"\n        ));',
         '        return Err(ServiceError::conflict(format!(\n            "too many sidecars for `{plugin_id}` (max {MAX_PROCS_PER_PLUGIN}) — proc.killAll() first"\n        )));'),
        ('        .ok_or("sidecar not running — spawn first")?;',
         '        .ok_or_else(|| ServiceError::not_found("sidecar not running — spawn first"))?;'),
        ('        let root = external::plugins_root(app)?;',
         '        let root = external::plugins_root(app).map_err(ServiceError::io)?;'),
        ('_ => Err(format!("unknown action `proc/{action}`")),',
         '_ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `proc/{action}`"))),'),
    ],
    'services/storage.rs': [
        ('        return Err(format!("invalid plugin id: `{plugin_id}`"));',
         '        return Err(ServiceError::bad_params(format!("invalid plugin id: `{plugin_id}`")));'),
        ('        .ok_or_else(|| format!("missing string param `{key}`"))',
         '        .ok_or_else(|| ServiceError::bad_params(format!("missing string param `{key}`")))'),
        ('.map_err(|e| format!("corrupt store: {e}"))?;',
         '.map_err(|e| ServiceError::io(format!("corrupt store: {e}")))?;'),
        ('.map_err(|e| e.to_string())?;',
         '.map_err(|e| ServiceError::internal(format!("serialize store: {e}")))?;'),
        ('.map_err(|e| format!("write store: {e}"))?;',
         '.map_err(|e| ServiceError::io(format!("write store: {e}")))?;'),
        ('            .map_err(|e| format!("app data dir: {e}"))',
         '            .map_err(|e| ServiceError::io(format!("app data dir: {e}")))'),
        ('                    return Err(format!(\n                        "plugin `{plugin_id}` may not revoke a plugin registration"\n                    ));',
         '                    return Err(ServiceError::new(\n                        code::DENIED,\n                        format!("plugin `{plugin_id}` may not revoke a plugin registration"),\n                    ));'),
        ('_ => Err(format!("unknown action `{service}/{action}`")),',
         '_ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `{service}/{action}`"))),'),
        ('.contains("unknown action"));',
         '.msg.contains("unknown action"));'),
    ],
    'services/session.rs': [
        ('        return Err(format!("session `{id}` is already open"));',
         '        return Err(ServiceError::conflict(format!("session `{id}` is already open")));'),
        ('assert!(err.contains("already open"), "got: {err}");',
         'assert_eq!(err.code, code::CONFLICT);\n        assert!(err.msg.contains("already open"), "got: {err}");'),
    ],
    'services/stream.rs': [
        ('            Sink::Json(_) => Err("the json-envelope codec cannot carry raw bytes".into()),',
         '            Sink::Json(_) => Err(ServiceError::unsupported(\n                "the json-envelope codec cannot carry raw bytes",\n            )),'),
        ('        Arc::new(move || cancel_for_stop.store(true, Ordering::SeqCst)),\n    )?;',
         '        Arc::new(move || cancel_for_stop.store(true, Ordering::SeqCst)),\n    )\n    .map_err(|e| e.msg)?;'),
        ('                    .ok_or("missing string param `ch`")?;',
         '                    .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;'),
        ('                .ok_or("missing string param `ch`")?;',
         '                .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;'),
        ('_ => Err(format!("unknown action `stream/{action}`")),',
         '_ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `stream/{action}`"))),'),
    ],
}

for rel, pairs in PLAN.items():
    p = SRC / rel if rel.startswith('lib.rs') else pathlib.Path('src-tauri/src') / rel
    p = pathlib.Path('src-tauri/src') / rel
    s = p.read_text(encoding='utf-8')
    for old, new in pairs:
        if old not in s:
            print(f'MISS {rel}: {old[:75]!r}')
            raise SystemExit(1)
        s = s.replace(old, new)
    p.write_text(s, encoding='utf-8')
    print(f'ok   {rel}  ({len(pairs)} replacements)')
