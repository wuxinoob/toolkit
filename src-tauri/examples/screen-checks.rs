//! Deterministic capture provider: never reads the user's desktop pixels.
use serde_json::json;
use toolkit_lib::services::screen_capture::{
    capture_desktop, select_window, Rect, Request, WindowInfo, WindowSelector,
};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--native-metadata") {
        let windows =
            toolkit_lib::services::screen_capture::windows(&WindowSelector::default()).unwrap();
        let selected = windows
            .iter()
            .find(|w| !w.minimized && w.exe_name.is_some())
            .expect("an accessible desktop window");
        let selector = WindowSelector {
            id: Some(selected.id),
            pid: Some(selected.pid),
            app_name: selected.exe_name.clone(),
        };
        let matches = toolkit_lib::services::screen_capture::windows(&selector).unwrap();
        assert_eq!(select_window(&matches, &selector).unwrap().id, selected.id);
        let p = toolkit_lib::services::screen_capture::pointer().unwrap();
        let x = p["x"].as_i64().unwrap();
        let y = p["y"].as_i64().unwrap();
        assert!(xcap::Monitor::all().unwrap().iter().any(|m| {
            let (Ok(mx), Ok(my), Ok(w), Ok(h)) = (m.x(), m.y(), m.width(), m.height()) else {
                return false;
            };
            x >= i64::from(mx)
                && x < i64::from(mx) + i64::from(w)
                && y >= i64::from(my)
                && y < i64::from(my) + i64::from(h)
        }));
        println!("PASS native metadata: {} windows, executable/PID/ID selector and physical pointer match a real display; no pixels captured",windows.len());
        return;
    }
    let displays = [
        Rect {
            x: -100,
            y: 0,
            width: 100,
            height: 100,
        },
        Rect {
            x: 20,
            y: 0,
            width: 100,
            height: 100,
        },
    ];
    let bounds = Rect {
        x: -10,
        y: 5,
        width: 40,
        height: 10,
    };
    let mut calls = Vec::new();
    let image = capture_desktop(bounds, &displays, |index, rect| {
        calls.push((index, rect));
        Ok(image::RgbaImage::from_pixel(
            rect.width,
            rect.height,
            if index == 0 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 255])
            },
        ))
    })
    .unwrap();
    assert_eq!((image.width(), image.height()), (40, 10));
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[0],
        (
            0,
            Rect {
                x: 90,
                y: 5,
                width: 10,
                height: 10
            }
        )
    );
    assert_eq!(
        calls[1],
        (
            1,
            Rect {
                x: 0,
                y: 5,
                width: 10,
                height: 10
            }
        )
    );
    assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0, 255]);
    assert_eq!(image.get_pixel(15, 0).0, [0, 0, 0, 0]);
    assert_eq!(image.get_pixel(39, 9).0, [0, 0, 255, 255]);
    assert!(capture_desktop(
        Rect {
            x: 1000,
            y: 0,
            width: 10,
            height: 10
        },
        &displays,
        |_, _| panic!("off-screen capture must not call native provider")
    )
    .is_err());
    assert!(capture_desktop(bounds, &displays, |_, _| Ok(image::RgbaImage::new(1, 1))).is_err());
    println!("PASS native ROI plan, negative desktop origins, cross-display composition, transparent gaps and geometry changes");

    let frame = Rect {
        x: -1200,
        y: 100,
        width: 1000,
        height: 800,
    };
    assert_eq!(
        frame
            .region(Some(Rect {
                x: 50,
                y: 30,
                width: 400,
                height: 200
            }))
            .unwrap(),
        Rect {
            x: -1150,
            y: 130,
            width: 400,
            height: 200
        }
    );
    for rect in [
        Rect {
            x: -1,
            y: 0,
            width: 10,
            height: 10,
        },
        Rect {
            x: 990,
            y: 0,
            width: 20,
            height: 10,
        },
        Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 1,
        },
    ] {
        assert!(frame.region(Some(rect)).is_err());
    }
    assert!(Rect {
        x: 0,
        y: 0,
        width: 16384,
        height: 16384
    }
    .validate()
    .is_err());
    assert!(Rect {
        x: 0,
        y: 0,
        width: 16384,
        height: 16384
    }
    .region(Some(Rect {
        x: 1,
        y: 1,
        width: 100,
        height: 100
    }))
    .is_ok());
    assert!(Request::parse(json!({"monitor":0,"target":{"kind":"desktop"}})).is_err());
    assert!(Request::parse(
        json!({"target":{"kind":"desktop"},"rect":{"x":-10,"y":0,"width":400,"height":200}})
    )
    .is_ok());
    assert!(
        Request::parse(json!({"monitor":0,"rect":{"x":0,"y":1,"width":100,"height":200}})).is_ok()
    );
    assert!(Request::parse(json!({"unit":"logical"})).is_err());
    assert!(Request::parse(json!({"unit":"physical"})).is_ok());
    println!("PASS target-relative physical geometry, bounds/pixel budgets, signed desktop rectangles and legacy requests");

    let mut windows = vec![WindowInfo {
        id: 1,
        pid: 42,
        app_name: "Browser".into(),
        exe_name: Some("Chrome.EXE".into()),
        title: "one".into(),
        bounds: frame,
        minimized: false,
        focused: false,
        unit: "physical",
    }];
    let selector: WindowSelector =
        serde_json::from_value(json!({"appName":"CHROME","pid":42})).unwrap();
    assert_eq!(select_window(&windows, &selector).unwrap().id, 1);
    let mut other = windows[0].clone();
    other.id = 2;
    windows.push(other);
    assert_eq!(
        select_window(&windows, &selector).unwrap_err().code,
        "conflict"
    );
    assert_eq!(
        select_window(
            &windows,
            &serde_json::from_value(json!({"id":2,"pid":42})).unwrap()
        )
        .unwrap()
        .id,
        2
    );
    assert_eq!(
        select_window(
            &windows,
            &serde_json::from_value(json!({"id":2,"pid":43})).unwrap()
        )
        .unwrap_err()
        .code,
        "not_found"
    );
    assert_eq!(
        select_window(
            &windows,
            &serde_json::from_value(json!({"appName":"chrome.exe.exe"})).unwrap()
        )
        .unwrap_err()
        .code,
        "not_found"
    );
    windows[1].minimized = true;
    assert_eq!(
        select_window(&windows, &serde_json::from_value(json!({"id":2})).unwrap())
            .unwrap_err()
            .code,
        "unsupported"
    );
    assert!(select_window(&windows, &WindowSelector::default()).is_err());
    assert!(Request::parse(json!({"target":{"kind":"window","pid":-1}})).is_err());
    println!("PASS executable/name/PID matching, multiple-window ambiguity, exact IDs, closed targets and minimized windows");
}
