//! Create the credential settings WebView using the main window's environment.
use tauri::{Manager, WebviewWindow};

const LABEL: &str = "host-llm-settings";
static OPENING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn note(app: tauri::AppHandle, message: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let _ =
            crate::services::storage::append_debug_log(&app, &format!("model settings: {message}"));
    });
}

pub fn failure(stage: &str, error: impl std::fmt::Display) -> String {
    let error = error.to_string();
    if error.to_ascii_lowercase().contains("80010108") {
        format!("WebView2 disconnected while opening model settings ({stage}, 0x80010108). Restart Toolkit, then open Manage models again. Details: {error}")
    } else {
        format!("Model settings {stage} failed: {error}")
    }
}

/// Returns a hidden new window, or the existing window. Presentation is separate
/// so native checks can exercise real creation without stealing the foreground.
pub async fn get_or_create(
    app: tauri::AppHandle,
    main: WebviewWindow,
) -> Result<WebviewWindow, String> {
    if main.label() != "main" {
        return Err("model settings can only be opened by the main window".into());
    }
    let _opening = OPENING.lock().await;
    if let Some(existing) = app.get_webview_window(LABEL) {
        return Ok(existing);
    }
    note(app.clone(), "create requested, source=main".into());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let target = app.clone();
    // with_webview posts to the native event loop. COM objects never cross into
    // a worker thread, and creation starts after the original IPC callback exits.
    main.with_webview(move |source| {
        let result = (|| {
            let mut builder = tauri::WebviewWindowBuilder::new(
                &target,
                LABEL,
                tauri::WebviewUrl::App("llmsettings.html".into()),
            )
            .title(crate::locale::text(&crate::locale::cached_locale(&target), "model.title"))
            .inner_size(820.0, 760.0)
            .min_inner_size(640.0, 480.0)
            .visible(false)
            .focused(false);
            if let Some(args) = target
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .and_then(|w| w.additional_browser_args.as_deref())
            {
                builder = builder.additional_browser_args(args);
            }
            #[cfg(windows)]
            {
                let (pid, version) =
                    environment_info(&source).map_err(|e| failure("main environment", e))?;
                note(
                    target.clone(),
                    format!("source ready, browserPid={pid}, runtime={version}"),
                );
                builder = builder.with_environment(source.environment());
            }
            #[cfg(not(windows))]
            let _ = source;
            builder.build().map_err(|e| failure("create", e))
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| failure("schedule", e))?;
    let result = rx
        .await
        .map_err(|_| failure("create", "native window callback ended without a result"))?;
    match &result {
        Ok(window) => {
            note(app.clone(), "created, environment=main".into());
            watch(window);
        }
        Err(error) => note(app, error.clone()),
    }
    result
}

#[cfg(windows)]
fn environment_info(
    view: &tauri::webview::PlatformWebview,
) -> Result<(u32, String), webview2_com::Error> {
    let mut version = Default::default();
    unsafe { view.environment().BrowserVersionString(&mut version) }?;
    let version = webview2_com::take_pwstr(version);
    let mut pid = 0;
    unsafe { view.controller().CoreWebView2()?.BrowserProcessId(&mut pid) }?;
    Ok((pid, version))
}

#[cfg(windows)]
fn watch(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let logger = app.clone();
    if let Err(error) = window.with_webview(move |view| {
        let result = (|| {
            let (pid, version) = environment_info(&view)?;
            let core = unsafe { view.controller().CoreWebView2() }?;
            note(
                logger.clone(),
                format!("ready, browserPid={pid}, runtime={version}"),
            );
            let events = logger.clone();
            let handler =
                webview2_com::ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut kind = Default::default();
                        unsafe { args.ProcessFailedKind(&mut kind) }?;
                        note(
                            events.clone(),
                            format!("process failed, browserPid={pid}, kind={kind:?}"),
                        );
                    }
                    Ok(())
                }));
            let mut token = 0;
            unsafe { core.add_ProcessFailed(&handler, &mut token) }?;
            Ok::<_, webview2_com::Error>(())
        })();
        if let Err(error) = result {
            note(logger, format!("diagnostics attach failed: {error}"));
        }
    }) {
        note(app, format!("diagnostics schedule failed: {error}"));
    }
}
#[cfg(not(windows))]
fn watch(_: &WebviewWindow) {}
