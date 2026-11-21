//! Window presentation helpers shared by the SDK gateway and native checks.

/// Show through Tauri so its visibility state stays in sync with the OS.
/// The caller runs this on the window's event-loop thread.
pub fn present_inactive(
    window: &tauri::Window,
    show: bool,
    focusable: Option<bool>,
) -> Result<(), String> {
    #[cfg(windows)]
    let _activation =
        activation::Guard::new(window.hwnd().map_err(|e| e.to_string())?.0, focusable)?;
    if let Some(focusable) = focusable {
        window.set_focusable(focusable).map_err(|e| e.to_string())?;
    }
    if show {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
mod activation {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, STYLESTRUCT, WM_STYLECHANGING,
        WS_EX_NOACTIVATE,
    };

    unsafe extern "system" fn filter(
        window: HWND,
        message: u32,
        param: WPARAM,
        data: LPARAM,
        _id: usize,
        _context: usize,
    ) -> LRESULT {
        if message == WM_STYLECHANGING && param as i32 == GWL_EXSTYLE {
            // Tao rebuilds extended styles when showing or changing focusability.
            // Keep this bit until the operation finishes, then restore it below.
            unsafe { (*(data as *mut STYLESTRUCT)).styleNew |= WS_EX_NOACTIVATE };
        }
        unsafe { DefSubclassProc(window, message, param, data) }
    }

    // Temporarily suppress activation while Tauri updates its own window state.
    // The subclass lives only for this event-thread call and this one window.
    pub(super) struct Guard {
        window: HWND,
        no_activate: bool,
    }

    impl Guard {
        pub(super) fn new(window: HWND, focusable: Option<bool>) -> Result<Self, String> {
            let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) };
            if unsafe { SetWindowSubclass(window, Some(filter), 1, 0) } == 0 {
                return Err(format!(
                    "cannot guard window activation: {}",
                    std::io::Error::last_os_error()
                ));
            }
            unsafe { SetWindowLongPtrW(window, GWL_EXSTYLE, style | WS_EX_NOACTIVATE as isize) };
            Ok(Self {
                window,
                no_activate: focusable
                    .map_or(style & WS_EX_NOACTIVATE as isize != 0, |value| !value),
            })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                RemoveWindowSubclass(self.window, Some(filter), 1);
                let style = GetWindowLongPtrW(self.window, GWL_EXSTYLE);
                let style = if self.no_activate {
                    style | WS_EX_NOACTIVATE as isize
                } else {
                    style & !(WS_EX_NOACTIVATE as isize)
                };
                SetWindowLongPtrW(self.window, GWL_EXSTYLE, style);
            }
        }
    }
}
