fn main() {
    // Die Oberfläche wird für die Heimnetz-Freigabe eingebettet; fehlt sie (noch nicht gebaut),
    // leeren Ordner anlegen, damit das Übersetzen trotzdem klappt.
    let _ = std::fs::create_dir_all("../dist");
    tauri_build::build()
}
