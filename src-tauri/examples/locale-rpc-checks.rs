//! Real child-process named-pipe locale reads, without a frontend or user data.
#[cfg(windows)]
fn main() {
    use serde_json::{json, Value};
    use std::{
        process::{Command, Stdio},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::Manager;
    use toolkit_lib::{
        host::registry,
        locale,
        services::{self, caller::Caller},
        sidecar_rpc,
    };
    if std::env::args().any(|arg| arg == "--locale-child") {
        tauri::async_runtime::block_on(async {
            let allowed = std::env::var("CHECK_LOCALE_ALLOWED").unwrap() == "yes";
            let client = toolkit_host::Client::connect_from_env().await.unwrap();
            let schema = client.request("host", "schema", Value::Null).await.unwrap();
            assert_eq!(schema["services"]["i18n"].is_array(), allowed);
            assert_eq!(schema["i18n"].is_object(), allowed);
            if allowed {
                let snapshot = client.locale().await.unwrap();
                assert_eq!(
                    snapshot["resolvedLocale"],
                    std::env::var("CHECK_LOCALE_EXPECTED").unwrap()
                );
                assert_eq!(snapshot["mode"], "system");
                assert!(snapshot["revision"].as_u64().unwrap() > 0);
                assert_eq!(
                    client
                        .request("i18n", "set", json!({"locale":"zh-CN"}))
                        .await
                        .unwrap_err()
                        .code,
                    "unknown_action"
                );
                assert_eq!(
                    client.locale().await.unwrap()["revision"],
                    snapshot["revision"]
                );
            } else {
                assert_eq!(client.locale().await.unwrap_err().code, "denied");
            }
            println!("PASS locale Sidecar allowed={allowed}");
        });
        return;
    }
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "com.tan18.toolkit.locale-checks-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .manage(locale::Host::default())
        .build(context)
        .unwrap();
    app.run(|app, event| {
        if !matches!(event, tauri::RunEvent::Ready) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let checking = app.clone();
            let mut task = tokio::spawn(async move {
                let app = checking;
                let root = app.path().app_data_dir().unwrap();
                assert!(
                    !root.exists(),
                    "the test must use a new isolated application identity"
                );
                for allowed in [true, false] {
                    let id = if allowed {
                        "checks.locale.allowed"
                    } else {
                        "checks.locale.denied"
                    };
                    registry::register(
                        id,
                        &if allowed {
                            vec!["rpc:i18n".into()]
                        } else {
                            vec![]
                        },
                    );
                    let instance = sidecar_rpc::instance_id();
                    let caller = Caller::sidecar(id, &instance);
                    let endpoint = sidecar_rpc::Prepared::new(
                        &instance,
                        caller.clone(),
                        services::sidecar_services(&app, caller).unwrap(),
                    )
                    .unwrap();
                    let child = Command::new(std::env::current_exe().unwrap())
                        .arg("--locale-child")
                        .env("TOOLKIT_HOST_PIPE", &endpoint.path)
                        .env_remove("TOOLKIT_RESOURCE_PIPE")
                        .env("CHECK_LOCALE_ALLOWED", if allowed { "yes" } else { "no" })
                        .env(
                            "CHECK_LOCALE_EXPECTED",
                            locale::resolve_system(&locale::system_locale()),
                        )
                        .stdin(Stdio::null())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped())
                        .spawn()
                        .unwrap();
                    let lease = endpoint.start(child.id());
                    let output =
                        tokio::task::spawn_blocking(move || child.wait_with_output().unwrap())
                            .await
                            .unwrap();
                    assert!(
                        output.status.success(),
                        "{}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                    drop(lease);
                    registry::unregister(id);
                }
                assert!(
                    !root.exists(),
                    "read-only metadata must not create a preferences file or user-data directory"
                );
            });
            let result = tokio::time::timeout(Duration::from_secs(40), &mut task).await;
            let passed = matches!(result, Ok(Ok(())));
            if !passed {
                task.abort();
                eprintln!("FAIL locale Sidecar checks: {result:?}");
            }
            app.exit(if passed { 0 } else { 1 });
        });
    });
}
#[cfg(not(windows))]
fn main() {
    println!("SKIP locale named-pipe checks require Windows");
}
