// Unter Windows kein zusätzliches Konsolenfenster
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Ohne Fenster nur den Webserver fürs Heimnetz starten: projekt-fem-app --server [--port 8790]
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--server") {
        let port = args.iter().position(|a| a == "--port").and_then(|i| args.get(i + 1)).and_then(|p| p.parse().ok());
        projekt_fem_app::server::run_headless(port);
        return;
    }
    // WebKitGTK + NVIDIA unter Wayland: Der DMA-BUF-Renderer führt zu
    // "Error 71 (Protokollfehler) dispatching to Wayland display" – daher abschalten,
    // sofern nicht ausdrücklich anders gesetzt.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    projekt_fem_app::run()
}
