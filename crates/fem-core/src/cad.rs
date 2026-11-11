//! Konstruktion (kleines CAD): eine Feature-Liste – Skizzen, Extrudieren, Drehen, Bohrungen, Verrunden, Fasen,
//! Muster, Spiegeln – mit OpenCASCADE zu Körpern aufbauen. Läuft über das Python-Modul von Gmsh (`cad.py`).
//!
//! Die Features kommen als JSON aus der Oberfläche (Skizzen sind dort schon gelöst, hier stehen nur Zahlen).
//! Ergebnis: Zustand je Feature, Volumen, Darstellung (Dreiecke, Flächen, Kanten) und auf Wunsch eine STEP-Datei.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::geometry::find_python;
use crate::{FemError, Result};

const SCRIPT: &str = include_str!("cad.py");
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Ein Aufbau-Auftrag.
#[derive(Debug, Default, Clone)]
pub struct CadJob {
    /// Ausgangsgeometrie (STEP), an der weiterkonstruiert wird
    pub base: Option<PathBuf>,
    /// Feature-Liste (nur aktive Features, in Reihenfolge)
    pub features: Value,
    /// nur die ersten `upto` Features aufbauen (Zustand vor einem Feature, das gerade bearbeitet wird)
    pub upto: Option<usize>,
    /// STEP-Datei schreiben
    pub output: Option<PathBuf>,
    /// geschlossene Bereiche dieser Skizze mitliefern (zum Auswählen)
    pub regions_of: Option<Value>,
    /// Darstellung (Dreiecke, Flächen, Kanten) mitliefern
    pub tess: bool,
}

/// Arbeitsordner (Skript, Zwischenstände, Aufträge)
pub fn work_dir() -> PathBuf {
    std::env::temp_dir().join("projekt-fem-cad")
}

/// Baut die Features auf. Fehler einzelner Features stehen im Ergebnis (`status`), nicht im `Err`.
pub fn build(job: &CadJob) -> Result<Value> {
    let err = |e: &dyn std::fmt::Display| FemError::Gmsh(e.to_string());
    let python = find_python().ok_or_else(|| {
        FemError::Gmsh(
            "Für die Konstruktion wird das Python-Modul von Gmsh gebraucht – mit `uv tool install gmsh` installieren \
             (oder Pfad zum passenden Python in FEM_GMSH_PYTHON setzen)"
                .into(),
        )
    })?;
    let dir = work_dir();
    std::fs::create_dir_all(&dir).map_err(|e| err(&e))?;
    let script = dir.join("cad.py");
    if std::fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
        std::fs::write(&script, SCRIPT).map_err(|e| err(&e))?;
    }
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let stem = format!("auftrag-{}-{n}", std::process::id());
    let job_path = dir.join(format!("{stem}.json"));
    let result_path = dir.join(format!("{stem}-ergebnis.json"));
    if let Some(out) = &job.output {
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| err(&e))?;
        }
    }
    let base = match &job.base {
        Some(b) => Some(b.canonicalize().map_err(|e| FemError::Gmsh(format!("{}: {e}", b.display())))?),
        None => None,
    };
    let spec = json!({
        "base": base,
        "features": job.features,
        "upto": job.upto,
        "output": job.output,
        "result": result_path,
        "cache": dir.join("zwischenstand"),
        "tess": job.tess,
        "regions_of": job.regions_of,
    });
    std::fs::write(&job_path, spec.to_string()).map_err(|e| err(&e))?;
    let out = Command::new(&python).arg(&script).arg(&job_path).output().map_err(|e| err(&e));
    let _ = std::fs::remove_file(&job_path);
    let out = out?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().rev().find(|l| l.starts_with("ERGEBNIS") || l.starts_with("FEHLER "));
    let result = match last {
        Some(l) if l.starts_with("ERGEBNIS") => std::fs::read_to_string(&result_path)
            .map_err(|e| err(&e))
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| err(&e))),
        Some(l) => Err(FemError::Gmsh(l.trim_start_matches("FEHLER ").to_string())),
        None => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let hint = stderr.lines().rev().find(|l| !l.trim().is_empty() && !l.contains('\u{1b}')).unwrap_or("unbekannter Fehler");
            Err(FemError::Gmsh(format!("Konstruktion fehlgeschlagen: {hint}")))
        }
    };
    let _ = std::fs::remove_file(&result_path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Value> {
        let p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        (0..4).map(|i| json!({"t": "line", "a": p[i], "b": p[(i + 1) % 4]})).collect()
    }

    fn run(features: Value, upto: Option<usize>, output: Option<PathBuf>) -> Option<Value> {
        if find_python().is_none() {
            eprintln!("Gmsh-Python fehlt – Test übersprungen");
            return None;
        }
        Some(build(&CadJob { features, upto, output, tess: true, ..Default::default() }).unwrap())
    }

    /// Flansch: Ring, Bohrung mit Kreismuster, Nut gespiegelt – Volumen exakt, Flächenarten erkannt, STEP vernetzbar
    #[test]
    fn flansch_aus_skizzen() {
        let xy = json!({"origin": [0, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0]});
        let top = json!({"origin": [0, 0, 12], "normal": [0, 0, 1], "u": [1, 0, 0]});
        let features = json!([
            {"id": 1, "type": "sketch", "plane": xy, "ents": [{"t": "circle", "c": [0, 0], "r": 50}, {"t": "circle", "c": [0, 0], "r": 20}]},
            {"id": 2, "type": "extrude", "sketch": 1, "mode": "add", "depth": 12, "dir": 1},
            {"id": 3, "type": "sketch", "plane": top, "ents": [], "pts": [[35, 0]]},
            {"id": 4, "type": "hole", "sketch": 3, "diameter": 9, "through": true},
            {"id": 5, "type": "pattern", "kind": "circular", "features": [4], "axis": {"point": [0, 0, 0], "dir": [0, 0, 1]}, "count": 6, "angle": 360},
            {"id": 6, "type": "sketch", "plane": top, "ents": rect(22.0, -3.0, 30.0, 3.0)},
            {"id": 7, "type": "extrude", "sketch": 6, "mode": "cut", "depth": 4, "dir": -1},
            {"id": 8, "type": "mirror", "features": [7], "plane": {"origin": [0, 0, 0], "normal": [1, 0, 0]}},
            {"id": 9, "type": "fillet", "edges": [{"mid": [-50, 0, 12]}], "radius": 2},
        ]);
        let out = work_dir().join(format!("test-{}", std::process::id())).join("flansch.step");
        let Some(r) = run(features.clone(), None, Some(out.clone())) else { return };
        assert!(r["status"].as_array().unwrap().iter().all(|s| s["ok"] == true), "{}", r["status"]);
        let pi = std::f64::consts::PI;
        let ring = pi * (2500.0 - 400.0) * 12.0 - 6.0 * pi * 4.5 * 4.5 * 12.0 - 2.0 * 8.0 * 6.0 * 4.0;
        // Verrundung R2 an der Außenkante: Ringquerschnitt (1 − π/4)·r² um den Schwerpunktsradius
        let fillet = (1.0 - pi / 4.0) * 4.0 * 2.0 * pi * (50.0 - 2.0 * (1.0 - (10.0 - 3.0 * pi) / (12.0 - 3.0 * pi)));
        let v = r["volume"].as_f64().unwrap();
        assert!((v - (ring - fillet)).abs() < 1e-3 * ring, "{v} statt {}", ring - fillet);
        assert_eq!(r["bodies"], 1);
        let surfaces = r["tess"]["surfaces"].as_array().unwrap();
        let holes = surfaces.iter().filter(|s| s["kind"] == "cylinder" && s["hole"] == true && (s["radius"].as_f64().unwrap() - 4.5).abs() < 1e-6).count();
        assert_eq!(holes, 6, "sechs Bohrungen Ø9");
        assert!(surfaces.iter().any(|s| s["kind"] == "plane" && s["normal"][2].as_f64().unwrap() > 0.999));
        // die STEP-Datei lässt sich vernetzen und hat dasselbe Volumen
        let mesh = crate::gmsh::mesh_step(&out, &crate::gmsh::MeshOptions { size: Some(4.0), ..Default::default() }).unwrap();
        assert!((mesh.volume() - v).abs() < 0.01 * v, "{} / {v}", mesh.volume());

        // nur bis vor die Bohrung: voller Ring
        let r = run(features, Some(2), None).unwrap();
        assert!((r["volume"].as_f64().unwrap() - pi * 2100.0 * 12.0).abs() < 1e-6 * ring);
    }

    /// Ein Feature, das nicht geht, meldet sich verständlich; der Stand davor bleibt, der Rest wird übersprungen
    #[test]
    fn fehler_bleibt_beim_feature() {
        let xy = json!({"origin": [0, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0]});
        let features = json!([
            {"id": 1, "type": "sketch", "plane": xy, "ents": rect(0.0, 0.0, 40.0, 30.0)},
            {"id": 2, "type": "extrude", "sketch": 1, "mode": "add", "depth": 10, "dir": 1},
            {"id": 3, "type": "fillet", "edges": [{"mid": [0, 0, 5]}], "radius": 80},
            {"id": 4, "type": "chamfer", "edges": [{"mid": [20, 0, 10]}], "distance": 1},
        ]);
        let Some(r) = run(features, None, None) else { return };
        let st = r["status"].as_array().unwrap();
        assert_eq!(st[1]["ok"], true);
        assert!(st[2]["error"].as_str().unwrap().contains("Radius 80 mm"), "{}", st[2]);
        assert_eq!(st[3]["skipped"], true);
        assert!((r["volume"].as_f64().unwrap() - 12000.0).abs() < 1e-6);
    }

    /// Drehteil und überlappende Formen ohne Trimmen (Bereiche einzeln wählbar)
    #[test]
    fn drehteil_und_bereiche() {
        let xz = json!({"origin": [0, 0, 0], "normal": [0, -1, 0], "u": [1, 0, 0]});
        let prof = [[0, 0], [40, 0], [40, 10], [25, 10], [25, 15], [0, 15]];
        let ents: Vec<Value> = (0..6).map(|i| json!({"t": "line", "a": prof[i], "b": prof[(i + 1) % 6]})).collect();
        let features = json!([
            {"id": 1, "type": "sketch", "plane": xz, "ents": ents},
            {"id": 2, "type": "revolve", "sketch": 1, "axis": {"a": [0, 0], "b": [1, 0]}, "angle": 360, "mode": "add"},
        ]);
        let Some(r) = run(features, None, None) else { return };
        let pi = std::f64::consts::PI;
        let soll = pi * 100.0 * 40.0 + pi * (225.0 - 100.0) * 25.0;
        assert!((r["volume"].as_f64().unwrap() - soll).abs() < 1e-6 * soll, "{}", r["volume"]);

        let xy = json!({"origin": [0, 0, 0], "normal": [0, 0, 1], "u": [1, 0, 0]});
        let mut ents = rect(0.0, 0.0, 60.0, 40.0);
        ents.push(json!({"t": "circle", "c": [60, 40], "r": 15}));
        let features = json!([
            {"id": 1, "type": "sketch", "plane": xy, "ents": ents},
            {"id": 2, "type": "extrude", "sketch": 1, "mode": "add", "depth": 5, "regions": [[30, 20], [55, 35], [70, 45]]},
        ]);
        let r = build(&CadJob { features, regions_of: Some(json!(1)), tess: false, ..Default::default() }).unwrap();
        let soll = (2400.0 + pi * 225.0 * 0.75) * 5.0;
        assert!((r["volume"].as_f64().unwrap() - soll).abs() < 1e-6 * soll, "{}", r["volume"]);
        assert_eq!(r["regions"].as_array().unwrap().len(), 3);
    }
}
