//! Run on an interactive Windows desktop to check real window activation.

#[cfg(windows)]
fn main() {
    use toolkit_lib::host::windows::present_inactive;
    use toolkit_lib::services::{screen::ScreenService, Service};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, SetForegroundWindow, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };

    let mut context = tauri::generate_context!();
    let browser_args = context
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.clone());
    context.config_mut().app.windows.clear();
    tauri::Builder::default().build(context).unwrap().run(move |app, event| {
        if !matches!(event, tauri::RunEvent::Ready) {
            return;
        }
        let before = unsafe { GetForegroundWindow() };
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut builder = tauri::WebviewWindowBuilder::new(app, "plugin-window-check",
                tauri::WebviewUrl::External("about:blank".parse().unwrap()))
                .title("Toolkit window checks").inner_size(240.0, 100.0)
                .visible(false).focused(false);
            if let Some(args) = &browser_args {
                builder = builder.additional_browser_args(args);
            }
            let popup = builder.build().unwrap();
            let hwnd = popup.hwnd().unwrap().0;
            assert_eq!(unsafe { GetForegroundWindow() }, before);
            for _ in 0..3 {
                present_inactive(&popup.as_ref().window(), true, None).unwrap();
                assert!(popup.is_visible().unwrap());
                assert_eq!(unsafe { GetForegroundWindow() }, before);
                assert_eq!(unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_NOACTIVATE as isize, 0);
                present_inactive(&popup.as_ref().window(), false, Some(false)).unwrap();
                assert!(popup.is_visible().unwrap());
                assert_eq!(unsafe { GetForegroundWindow() }, before);
                assert_ne!(unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_NOACTIVATE as isize, 0);
                popup.hide().unwrap();
                assert!(!popup.is_visible().unwrap());
                present_inactive(&popup.as_ref().window(), false, Some(true)).unwrap();
                assert!(!popup.is_visible().unwrap());
                assert_eq!(unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_NOACTIVATE as isize, 0);
            }
            println!("PASS inactive presentation: repeated show, hide and focusability changes preserve foreground");
            popup.show().unwrap();
            popup.set_focus().unwrap();
            assert_eq!(unsafe { GetForegroundWindow() }, popup.hwnd().unwrap().0,
                "active presentation must be able to focus the test window");
            println!("PASS active presentation: regular show and focus still activate");
            let monitors = ScreenService.dispatch(app, "checks", "monitors", serde_json::Value::Null).unwrap();
            let monitors = monitors.as_array().unwrap();
            assert!(!monitors.is_empty());
            for monitor in monitors {
                assert_eq!(monitor["unit"], "physical");
                assert!(monitor["position"]["x"].is_i64());
                assert!(monitor["position"]["y"].is_i64());
                assert!(monitor["workArea"]["width"].as_u64().unwrap() > 0);
                assert!(monitor["workArea"]["height"].as_u64().unwrap() > 0);
            }
            println!("PASS monitor geometry: {} displays matched to native work areas", monitors.len());
            popup.destroy().unwrap();
        }));
        if !before.is_null() {
            unsafe { SetForegroundWindow(before) };
        }
        app.exit(i32::from(checked.is_err()));
    });
}

#[cfg(not(windows))]
fn main() {
    println!("window-checks requires an interactive Windows desktop");
}
