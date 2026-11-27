//! Hidden native WebViews: environment reuse, concurrent open and reopen.
#[cfg(windows)]
fn main() {
    use std::time::Duration;
    use tauri::Manager;
    use toolkit_lib::llm::{model_window, Host};
    use windows_core::Interface;
    let data = tempfile::tempdir().unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "com.tan18.toolkit.model-window-checks-{}",
        std::process::id()
    );
    context.config_mut().app.windows.clear();
    let directory = data.path().join("webview");
    let app = tauri::Builder::default()
        .manage(Host::default())
        .manage(toolkit_lib::binary_ipc::Transfers::default())
        .invoke_handler(tauri::generate_handler![
            toolkit_lib::llm::settings::host_llm_admin
        ])
        .build(context)
        .unwrap();
    app.run(move |app,event| {
        if !matches!(event,tauri::RunEvent::Ready) {return;}
        let foreground=unsafe {windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow()} as usize;
        let main=tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::External("about:blank".parse().unwrap()))
            .visible(false).focused(false).data_directory(directory.clone()).build().unwrap();
        let app=app.clone();
        tauri::async_runtime::spawn(async move {
            let result=tokio::time::timeout(Duration::from_secs(30),async {
                let (a,b)=tokio::join!(model_window::get_or_create(app.clone(),main.clone()),model_window::get_or_create(app.clone(),main.clone()));
                let first=a?;let second=b?;
                assert_eq!(first.label(),second.label());assert_eq!(app.webview_windows().len(),2);
                assert!(!first.is_visible().unwrap());
                async fn browser(window:&tauri::WebviewWindow)->(u32,isize) {
                    let (tx,rx)=tokio::sync::oneshot::channel();
                    window.with_webview(move |view| {
                        let mut pid=0;unsafe {view.controller().CoreWebView2().unwrap().BrowserProcessId(&mut pid).unwrap()};
                        let _=tx.send((pid,view.environment().as_raw() as isize));
                    }).unwrap();rx.await.unwrap()
                }
                assert_eq!(browser(&main).await,browser(&first).await,"the settings window must reuse the same COM environment and browser process");
                assert!(model_window::get_or_create(app.clone(),first.clone()).await.is_err());
                println!("PASS shared environment, browser PID, concurrent open deduplication and caller restriction");
                first.destroy().unwrap();
                tokio::time::timeout(Duration::from_secs(5),async {while app.get_webview_window("host-llm-settings").is_some(){tokio::time::sleep(Duration::from_millis(10)).await;}}).await.unwrap();
                let reopened=model_window::get_or_create(app.clone(),main.clone()).await?;
                assert!(!reopened.is_visible().unwrap());assert_eq!(browser(&main).await,browser(&reopened).await);
                assert_eq!(unsafe {windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow()} as usize,foreground);
                assert!(model_window::failure("create","HRESULT(0x80010108)").contains("Restart Toolkit"));
                println!("PASS close/reopen, hidden windows preserve foreground and disconnected errors include recovery guidance");
                Ok::<_,String>(())
            }).await;
            let passed=matches!(&result,Ok(Ok(())));
            if !passed {eprintln!("FAIL model window checks: {result:?}");}
            app.exit(if passed {0}else {1});
        });
    });
}
#[cfg(not(windows))]
fn main() {
    println!("SKIP model window checks require Windows WebView2");
}
