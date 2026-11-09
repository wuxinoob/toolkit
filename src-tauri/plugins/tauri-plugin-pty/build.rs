fn main() {
    tauri_plugin::Builder::new(&[
        "spawn",
        "write",
        "read",
        "resize",
        "kill",
        "exitstatus",
        "get_all_pids",
    ])
    .build();
}
