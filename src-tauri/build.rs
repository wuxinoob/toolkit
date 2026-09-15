use std::path::PathBuf;

fn main() {
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
        if let Some(lib) = find_resource_lib() {
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

/// Locate the `resource.lib` tauri-build just produced.
///
/// The build script's own `OUT_DIR` is `<target>/<profile>/build/<pkg>-<hash>/out`,
/// so the sibling build directories are one level up. Several may exist (one per
/// build-script hash); the most recently written one is the current build's.
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
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            newest = Some((mtime, candidate));
        }
    }
    newest.map(|(_, path)| path)
}

