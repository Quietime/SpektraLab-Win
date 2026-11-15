fn main() {
    // A release compiled without this feature silently loads build.devUrl and
    // ships a connection-refused page instead of the embedded frontend.
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_none()
    {
        panic!("Packaged releases require --features custom-protocol (embedded frontend)");
    }
    tauri_build::build()
}
