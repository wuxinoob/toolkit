//! Compatible command surface for tauri-plugin-pty 0.3.1, with native IO
//! isolated from the runtime and an independently owned PTY lifecycle.

pub mod backend;

use backend::{Session, SpawnOptions};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[derive(Default)]
struct PluginState {
    session_id: AtomicU32,
    sessions: Arc<Mutex<BTreeMap<u32, Arc<Session>>>>,
}
impl PluginState {
    fn get(&self, pid: u32) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pid)
            .cloned()
            .ok_or_else(|| "Unavailable pid".into())
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn spawn(
    file: String,
    args: Vec<String>,
    term_name: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    encoding: Option<String>,
    handle_flow_control: Option<bool>,
    flow_control_pause: Option<String>,
    flow_control_resume: Option<String>,
    state: tauri::State<'_, PluginState>,
) -> Result<u32, String> {
    let _ = (
        term_name,
        encoding,
        handle_flow_control,
        flow_control_pause,
        flow_control_resume,
    );
    let session = tauri::async_runtime::spawn_blocking(move || {
        Session::spawn(SpawnOptions {
            file,
            args,
            cols,
            rows,
            cwd,
            env,
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let pid = state.session_id.fetch_add(1, Ordering::Relaxed);
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(pid, Arc::new(session));
    Ok(pid)
}

#[tauri::command]
async fn read(
    pid: u32,
    state: tauri::State<'_, PluginState>,
) -> Result<tauri::ipc::Response, String> {
    state.get(pid)?.read().await.map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn write(pid: u32, data: String, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    let session = state.get(pid)?;
    tauri::async_runtime::spawn_blocking(move || session.write(data.as_bytes()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resize(
    pid: u32,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state.get(pid)?;
    tauri::async_runtime::spawn_blocking(move || session.resize(cols, rows))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn kill(pid: u32, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    let session = state.get(pid)?;
    let stopping = session.clone();
    tauri::async_runtime::spawn_blocking(move || stopping.kill())
        .await
        .map_err(|e| e.to_string())??;
    // Registration can fail before the frontend starts exitstatus. Stop must
    // still reclaim the plugin's entry, without relying on that command.
    let status = session.exitstatus().await;
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&pid);
    status.map(|_| ())
}

#[tauri::command]
async fn exitstatus(pid: u32, state: tauri::State<'_, PluginState>) -> Result<u32, String> {
    let session = state.get(pid)?;
    let status = session.exitstatus().await;
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&pid);
    status
}

#[tauri::command]
async fn get_all_pids(state: tauri::State<'_, PluginState>) -> Result<Vec<u32>, String> {
    Ok(state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .copied()
        .collect())
}

/// The host's session registry owns this callback, not an OS pid guessed from
/// the plugin's integer handle. Calling it needs no async runtime or frontend.
pub fn stop_callback<R: Runtime>(
    app: &AppHandle<R>,
    pid: u32,
) -> Result<Arc<dyn Fn() + Send + Sync>, String> {
    let state = app.state::<PluginState>();
    let stop = state.get(pid)?.stop_callback();
    let sessions = state.sessions.clone();
    Ok(Arc::new(move || {
        stop();
        // Native teardown is independent of this entry and of any old page.
        sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid);
    }))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("pty")
        .invoke_handler(tauri::generate_handler![
            spawn,
            write,
            read,
            resize,
            kill,
            exitstatus,
            get_all_pids
        ])
        .setup(|app, _| {
            app.manage(PluginState::default());
            Ok(())
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let sessions = std::mem::take(
                    &mut *app
                        .state::<PluginState>()
                        .sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()),
                );
                for session in sessions.values() {
                    let _ = session.kill();
                }
            }
        })
        .build()
}
