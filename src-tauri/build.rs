use std::path::PathBuf;

fn main() {
    // 换了图标要能看到：tauri-build 把 `bundle.icon` 里的 .ico/.png 嵌进 Windows
    // 资源（resource.lib），但**没有为这些文件声明依赖**，所以"只改了图标"的改动
    // 不会重跑这个脚本 —— 于是不会重新生成 resource.lib，也就不会重新链接，
    // 表现就是"图标明明换了，exe 里还是旧的"。实测过一次：改了 icon.ico、跑完
    // `npm run tauri dev`，target/debug/toolbox.exe 的时间戳仍然停在改动之前。
    //
    // 显式声明这几个输入，让图标改动像源码改动一样触发重建。
    for icon in [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    tauri_build::build();

    // tauri-build compiles the Windows app manifest (plus the other app
    // resources) into a `resource.lib` and links it into BIN targets only
    // (`cargo:rustc-link-arg-bins`). Test and example binaries therefore had no
    // embedded manifest, so Windows bound them to comctl32 v5 while the linked
    // code imports v6 symbols — `cargo test` and `cargo run --example` died at
    // load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139), while the app binary
    // ran fine. Forward the same resource to those targets so every binary in
    // this crate loads.
    #[cfg(windows)]
    {
        // The resource this build just had tauri-build write lives in OUR OWN
        // `OUT_DIR` — that is the first place to look, and normally the only one.
        // The sibling search is a fallback for layouts where it is not there.
        let own = std::env::var_os("OUT_DIR")
            .map(PathBuf::from)
            .map(|out| out.join("resource.lib"))
            .filter(|p| p.is_file());
        if let Some(lib) = own.or_else(find_resource_lib) {
            // `-examples` is a nameable target kind (there is no `-tests`, and
            // the generic `rustc-link-arg` cannot be used: it also applies to
            // bins, which already link this .lib through tauri-build, and a
            // second copy fails the link with LNK1123). So `cargo test` remains
            // unavailable in this crate — `cargo run --example host-checks` is
            // the harness-free equivalent, see src-tauri/examples/host-checks.rs.
            println!("cargo:rustc-link-arg-examples={}", lib.display());
        }
    }
}

/// Locate the `resource.lib` tauri-build produced, by looking at the sibling
/// build directories (`<target>/<profile>/build/<pkg>-<hash>/out`).
///
/// **Compare the LIBRARY's timestamp, not its directory's.** Sorting by the
/// directory's mtime picked the wrong file in practice: rewriting `resource.lib`
/// in place updates the file but not always the directory entry, so a directory
/// holding a freshly written library could still look older than one that merely
/// had its contents read. The symptom was invisible and infuriating — the app's
/// icon changed, `resource.lib` was rebuilt with the new bytes, and the binaries
/// built from it kept linking the OLD resource (`.rsrc` stayed 39424 bytes across
/// builds whose libraries differed by 45 KB).
#[cfg(windows)]
fn find_resource_lib() -> Option<PathBuf> {
    let out = PathBuf::from(std::env::var_os("OUT_DIR")?);
    let build_dir = out.parent()?.parent()?.to_path_buf(); // <target>/<profile>/build
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(build_dir).ok()?.flatten() {
        let candidate = entry.path().join("out").join("resource.lib");
        if !candidate.is_file() {
            continue;
        }
        let Ok(mtime) = candidate.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            newest = Some((mtime, candidate));
        }
    }
    newest.map(|(_, path)| path)
}
