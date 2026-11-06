//! Geometrie anpassen (grobe Abschätzung „was wäre, wenn“): Radien und Bohrungen ändern,
//! Material per Skizze hinzufügen oder entfernen. Läuft über das Python-Modul von Gmsh (OpenCASCADE).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::region::Region;
use crate::{FemError, Result};

const SCRIPT: &str = include_str!("geometry.py");

/// Eine Änderung. Flächen werden über ihren Schwerpunkt gefunden (Nummern ändern sich bei jeder Änderung).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum GeoOp {
    /// Verrundung auf `radius` ändern (0 = scharfe Kante). `surfaces`: Schwerpunkte der Radiusflächen
    Fillet { surfaces: Vec<[f64; 3]>, axis: [f64; 3], radius: f64 },
    /// Bohrung auf `diameter` ändern (0 = schließen)
    Hole { surfaces: Vec<[f64; 3]>, axis: [f64; 3], origin: [f64; 3], diameter: f64 },
    /// Skizze (Kreis/Rechteck) entlang der Flächennormale um `height` herausziehen und anfügen
    Add { sketch: Region, height: f64 },
    /// Skizze um `depth` in das Bauteil hinein abtragen (`None` = durch alles)
    Cut { sketch: Region, depth: Option<f64> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoResult {
    pub volume_before: f64,
    pub volume_after: f64,
}

/// Python mit Gmsh-Modul suchen: `FEM_GMSH_PYTHON`, Interpreter aus dem Gmsh-Startskript (uv), sonst `python3`.
pub fn find_python() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("FEM_GMSH_PYTHON") {
        return Some(PathBuf::from(p));
    }
    let mut candidates = Vec::new();
    if let Some(gmsh) = crate::gmsh::find_gmsh() {
        // uv: ~/.local/bin/gmsh → …/tools/gmsh/bin/gmsh (Python-Skript, Interpreter daneben)
        let real = std::fs::canonicalize(&gmsh).unwrap_or(gmsh);
        if let Ok(text) = std::fs::read(&real) {
            if let Some(line) = text.split(|&b| b == b'\n').next().and_then(|l| std::str::from_utf8(l).ok()) {
                if let Some(interp) = line.strip_prefix("#!") {
                    let interp = interp.trim();
                    if !interp.starts_with("/usr/bin/env") {
                        candidates.push(PathBuf::from(interp));
                    }
                }
            }
        }
        if let Some(dir) = real.parent() {
            candidates.push(dir.join("python"));
            candidates.push(dir.join("python3"));
        }
    }
    candidates.push(PathBuf::from("python3"));
    candidates.into_iter().find(|p| {
        Command::new(p).args(["-c", "import gmsh"]).output().map(|o| o.status.success()).unwrap_or(false)
    })
}

/// Wendet die Änderungen auf `input` an und schreibt das Ergebnis nach `output` (STEP).
pub fn modify_step(input: &Path, ops: &[GeoOp], output: &Path) -> Result<GeoResult> {
    let python = find_python().ok_or_else(|| {
        FemError::Gmsh(
            "Für „Geometrie anpassen“ wird das Python-Modul von Gmsh gebraucht – mit `uv tool install gmsh` installieren \
             (oder Pfad zum passenden Python in FEM_GMSH_PYTHON setzen)"
                .into(),
        )
    })?;
    let input = input.canonicalize().map_err(|e| FemError::Gmsh(format!("{}: {e}", input.display())))?;
    let dir = output.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| FemError::Gmsh(e.to_string()))?;
    let script = dir.join("geometrie.py");
    let job = dir.join("auftrag.json");
    std::fs::write(&script, SCRIPT).map_err(|e| FemError::Gmsh(e.to_string()))?;
    let job_json = serde_json::json!({ "input": input, "output": output, "ops": ops });
    std::fs::write(&job, job_json.to_string()).map_err(|e| FemError::Gmsh(e.to_string()))?;
    let out = Command::new(&python).arg(&script).arg(&job).output().map_err(|e| FemError::Gmsh(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines().rev() {
        if let Some(msg) = line.strip_prefix("FEHLER ") {
            return Err(FemError::Gmsh(msg.to_string()));
        }
        if let Some(res) = line.strip_prefix("ERGEBNIS ") {
            return serde_json::from_str(res).map_err(|e| FemError::Gmsh(e.to_string()));
        }
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(FemError::Gmsh(format!(
        "Geometrie anpassen fehlgeschlagen: {}",
        stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unbekannter Fehler")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hebel_radius_material_aussparung_bohrung() {
        if find_python().is_none() {
            eprintln!("Gmsh-Python fehlt – Test übersprungen");
            return;
        }
        let step = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Daten/Hebel.step");
        let out = std::env::temp_dir().join(format!("projekt-fem-geotest-{}", std::process::id())).join("hebel.step");
        let up = [0.0, 0.0, 1.0];
        let ops = vec![
            // R3-Radius (Schwerpunkt aus der Oberfläche) → R8
            GeoOp::Fillet { surfaces: vec![[17.95, 10.79, 2.5]], axis: up, radius: 8.0 },
            // Aufdopplung 20 × 8 × 3 auf der Oberseite
            GeoOp::Add {
                sketch: Region::Rect { center: [35.0, 0.0, 5.0], normal: up, u: [1.0, 0.0, 0.0], width: 20.0, height: 8.0 },
                height: 3.0,
            },
            // Aussparung Ø10 durch alles
            GeoOp::Cut { sketch: Region::Circle { center: [70.0, -10.0, 5.0], normal: up, radius: 5.0 }, depth: None },
            // Bohrung Ø8 → Ø6
            GeoOp::Hole { surfaces: vec![[70.0, -40.0, 2.5]], axis: up, origin: [70.0, -40.0, 0.0], diameter: 6.0 },
        ];
        let r = modify_step(&step, &ops, &out).unwrap();
        let pi = std::f64::consts::PI;
        // +480 Aufdopplung, −Aussparung (teilweise außerhalb), +Bohrung kleiner (π·(4²−3²)·5 ≈ 110), Radius: wenige mm³
        let hole = pi * (16.0 - 9.0) * 5.0;
        assert!(r.volume_after > r.volume_before + 480.0 + hole - 400.0 && r.volume_after < r.volume_before + 480.0 + hole, "{r:?}");
        let mesh = crate::gmsh::mesh_step(&out, &crate::gmsh::MeshOptions { size: Some(3.0), ..Default::default() }).unwrap();
        assert!((mesh.volume() - r.volume_after).abs() < 0.01 * r.volume_after);

        // Fehler verständlich melden: Material, das das Bauteil nicht berührt
        let lose = vec![GeoOp::Add {
            sketch: Region::Circle { center: [200.0, 200.0, 5.0], normal: up, radius: 2.0 },
            height: 1.0,
        }];
        let e = modify_step(&step, &lose, &out).unwrap_err().to_string();
        assert!(e.contains("berührt das Bauteil nicht"), "{e}");
    }
}
