//! Schreibt Netz- und Ergebnisdaten als JSON – für Oberflächentests im Browser ohne Tauri.
//! cargo run --release -p projekt-fem-app --example dump -- <step> <setup.json> <ausgabeordner> [netzgröße]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let state = projekt_fem_app::AppState::default();
    let mesh = projekt_fem_app::open_step_impl(&state, &a[1], a.get(4).map(|s| s.parse().unwrap()), false).unwrap();
    std::fs::write(format!("{}/mesh.json", a[3]), serde_json::to_string(&mesh).unwrap()).unwrap();
    let setup = serde_json::from_str(&std::fs::read_to_string(&a[2]).unwrap()).unwrap();
    let res = projekt_fem_app::solve_impl(&state, setup).unwrap();
    std::fs::write(format!("{}/result.json", a[3]), serde_json::to_string(&res).unwrap()).unwrap();
}
