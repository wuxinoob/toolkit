"""Finish the classification for storage.rs, session.rs, stream.rs."""
import pathlib

SRC = pathlib.Path('src-tauri/src')

PLAN = {
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
        ('        .map_err(|e| format!("app data dir: {e}"))',
         '        .map_err(|e| ServiceError::io(format!("app data dir: {e}")))'),
        ('                    return Err(format!(\n                        "plugin `{plugin_id}` may not revoke a plugin registration"\n                    ));',
         '                    return Err(ServiceError::new(\n                        code::DENIED,\n                        format!("plugin `{plugin_id}` may not revoke a plugin registration"),\n                    ));'),
        ('_ => Err(format!("unknown action `{service}/{action}`")),',
         '_ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `{service}/{action}`"))),'),
        ('.contains("unknown action"));', '.msg.contains("unknown action"));'),
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
    p = SRC / rel
    s = p.read_text(encoding='utf-8')
    for old, new in pairs:
        if old not in s:
            print(f'MISS {rel}: {old[:75]!r}')
            raise SystemExit(1)
        s = s.replace(old, new)
    p.write_text(s, encoding='utf-8')
    print(f'ok   {rel}  ({len(pairs)} replacements)')
