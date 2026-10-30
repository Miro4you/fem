// Unter Windows kein zusätzliches Konsolenfenster
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK + NVIDIA unter Wayland: Der DMA-BUF-Renderer führt zu
    // "Error 71 (Protokollfehler) dispatching to Wayland display" – daher abschalten,
    // sofern nicht ausdrücklich anders gesetzt.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    projekt_fem_app::run()
}
