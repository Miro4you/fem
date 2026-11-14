//! Konstruktion (kleines CAD): Ablage für die STEP-Dateien, die der Geometriekern im Browser erzeugt.
//!
//! Aufgebaut werden die Features in der Oberfläche (OpenCASCADE als WebAssembly, `app/src/cad/kernel`). Der frühere
//! Python-Kern (`cad.py` über Gmsh) ist entfallen; der Server speichert nur noch fertige STEP-Dateien zum Rechnen.

use std::path::PathBuf;

/// Arbeitsordner (fertige Teile aus der Konstruktion)
pub fn work_dir() -> PathBuf {
    std::env::temp_dir().join("projekt-fem-cad")
}

#[cfg(test)]
mod tests {
    #[test]
    fn namen_aus_dem_browserkern() {
        if crate::gmsh::find_gmsh().is_none() {
            eprintln!("Gmsh fehlt – Test übersprungen");
            return;
        }
        let step = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/neuer-kern-baugruppe.step");
        let mesh = crate::gmsh::mesh_step(&step, &crate::gmsh::MeshOptions { size: Some(4.0), ..Default::default() }).unwrap();
        let mut names: Vec<String> = mesh.bodies().iter().map(|&b| mesh.body_name(b)).collect();
        names.sort();
        assert_eq!(names, vec!["Buchse Ø32", "Welle"]);
        let pi = std::f64::consts::PI;
        let soll = pi * 100.0 * 60.0 + pi * (256.0 - 100.0) * 20.0;
        // grobes Netz (4 mm an r = 10): Tetraeder liegen innen an der Zylinderfläche
        assert!((mesh.volume() - soll).abs() < 0.03 * soll, "{} statt {soll}", mesh.volume());
    }
}
