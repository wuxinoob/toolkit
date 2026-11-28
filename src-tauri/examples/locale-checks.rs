use toolkit_lib::locale::{resolve_system, system_locale, text, Mode, Preference, Preferences};
fn main() {
    for tag in ["zh-CN", "zh_SG", "zh-Hans", "zh-Hans-HK", "ZH-cn"] {
        assert_eq!(resolve_system(tag), "zh-CN");
    }
    for tag in ["zh", "zh-TW", "zh-HK", "zh-Hant-CN", "en-GB", "fr-FR", ""] {
        assert_eq!(resolve_system(tag), "en-US");
    }
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("preferences.json");
    std::fs::write(
        &path,
        br#"{"other":{"keep":true},"language":{"mode":"manual","locale":"invalid"}}"#,
    )
    .unwrap();
    let mut prefs = Preferences::open(&path, "zh-CN").unwrap();
    let initial = prefs.snapshot("zh-CN");
    assert_eq!(initial.preference.mode, Mode::System);
    assert_eq!(initial.resolved_locale, "zh-CN");
    let selected = prefs
        .set(
            Preference {
                mode: Mode::Manual,
                locale: "en-US".into(),
            },
            "zh-CN",
        )
        .unwrap();
    assert!(selected.revision > initial.revision);
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["other"]["keep"], true);
    let mut reopened = Preferences::open(&path, "zh-CN").unwrap();
    assert_eq!(reopened.snapshot("zh-CN").resolved_locale, "en-US");
    assert!(prefs
        .set(
            Preference {
                mode: Mode::Manual,
                locale: "fr-FR".into()
            },
            "zh-CN"
        )
        .is_err());
    assert_eq!(prefs.snapshot("zh-CN").revision, selected.revision);
    let following = prefs
        .set(
            Preference {
                mode: Mode::System,
                locale: "en-US".into(),
            },
            "en-US",
        )
        .unwrap();
    let changed = prefs.snapshot("zh-CN");
    assert_eq!(changed.resolved_locale, "zh-CN");
    assert!(changed.revision > following.revision);
    let broken = temporary.path().join("broken.json");
    let mut unwritable = Preferences::open(&broken, "en-US").unwrap();
    std::fs::create_dir(&broken).unwrap();
    assert!(unwritable
        .set(
            Preference {
                mode: Mode::Manual,
                locale: "zh-CN".into()
            },
            "en-US"
        )
        .is_err());
    assert_eq!(unwritable.snapshot("en-US").resolved_locale, "en-US");
    assert_eq!(text("en-US", "tray.show"), "Show main window");
    assert_eq!(text("zh-CN", "tray.show"), "显示主窗口");
    assert!(!system_locale().is_empty());
    println!("PASS: locale resolution, persistence, unrelated preferences, revisions, write failures and native messages");
}
