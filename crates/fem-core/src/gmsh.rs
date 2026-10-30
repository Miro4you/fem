//! Anbindung an Gmsh: STEP-Datei vernetzen und Gmsh-Netze (.msh 4.1, ASCII) einlesen.
//!
//! Gmsh läuft als eigenes Programm. Gesucht wird in dieser Reihenfolge:
//! Umgebungsvariable `FEM_GMSH`, `PATH`, übliche Installationsorte (uv/pip, Homebrew, Gmsh.app).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::mesh::{Mesh, Order};
use crate::{FemError, Result};

#[derive(Debug, Clone)]
pub struct MeshOptions {
    /// Größte Elementkantenlänge; `None` = automatisch (Bauteildiagonale / 25)
    pub size: Option<f64>,
    pub order: Order,
    /// Elemente je Vollkreis an gekrümmten Flächen (feineres Netz an Bohrungen und Radien)
    pub curvature_points: u32,
}

impl Default for MeshOptions {
    fn default() -> Self {
        MeshOptions { size: None, order: Order::Quadratic, curvature_points: 16 }
    }
}

pub fn find_gmsh() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("FEM_GMSH") {
        return Some(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "gmsh.exe" } else { "gmsh" };
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(exe)).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin").join(exe));
    }
    for p in ["/opt/homebrew/bin/gmsh", "/usr/local/bin/gmsh", "/Applications/Gmsh.app/Contents/MacOS/gmsh"] {
        candidates.push(PathBuf::from(p));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Vernetzt eine STEP-Datei (Einheit mm) mit Tetraedern. Mehrere Körper werden
/// an gemeinsamen Flächen verbunden (verklebt).
pub fn mesh_step(step: &Path, opts: &MeshOptions) -> Result<Mesh> {
    let gmsh = find_gmsh().ok_or_else(|| {
        FemError::Gmsh("Gmsh nicht gefunden – installieren (z. B. `uv tool install gmsh`) oder FEM_GMSH setzen".into())
    })?;
    let step = step.canonicalize().map_err(|e| FemError::Gmsh(format!("{}: {e}", step.display())))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("projekt-fem-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| FemError::Gmsh(e.to_string()))?;
    let geo = dir.join("netz.geo");
    let msh = dir.join("netz.msh");

    let size = match opts.size {
        Some(h) if h > 0.0 => format!("Mesh.MeshSizeMax = {h};"),
        _ => "v() = Volume \"*\";\n\
              bb() = BoundingBox Volume{v()};\n\
              Mesh.MeshSizeMax = Sqrt((bb(3)-bb(0))^2 + (bb(4)-bb(1))^2 + (bb(5)-bb(2))^2) / 25;"
            .into(),
    };
    let script = format!(
        r#"SetFactory("OpenCASCADE");
Geometry.OCCTargetUnit = "MM";
Merge "{step}";
Coherence;
{size}
Mesh.MeshSizeFromCurvature = {curv};
Mesh.ElementOrder = {order};
Mesh.HighOrderOptimize = 1;
Mesh.Optimize = 1;
Mesh.SaveAll = 1;
Mesh.MshFileVersion = 4.1;
Mesh.Binary = 0;
Mesh 3;
Save "{msh}";
"#,
        step = escape(&step),
        msh = escape(&msh),
        curv = opts.curvature_points,
        order = if opts.order == Order::Quadratic { 2 } else { 1 },
    );
    std::fs::write(&geo, script).map_err(|e| FemError::Gmsh(e.to_string()))?;

    let out = Command::new(&gmsh)
        .arg(&geo)
        .arg("-")
        // bewusst einthreadig: nur so liefert Gmsh bei gleicher Eingabe immer dasselbe Netz
        .arg("-nt")
        .arg("1")
        .output()
        .map_err(|e| FemError::Gmsh(format!("{} konnte nicht gestartet werden: {e}", gmsh.display())))?;
    let text = std::fs::read_to_string(&msh);
    let _ = std::fs::remove_dir_all(&dir);
    let log = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    // Gmsh beendet sich auch bei Skriptfehlern erfolgreich → Fehlerzeilen selbst prüfen
    let errors: Vec<&str> = log.lines().filter(|l| l.trim_start().starts_with("Error")).collect();
    let text = match text {
        Ok(t) if out.status.success() && errors.is_empty() => t,
        _ => return Err(FemError::Gmsh(if errors.is_empty() { log } else { errors.join("\n") })),
    };
    read_msh(&text)
}

fn escape(p: &Path) -> String {
    p.display().to_string().replace('\\', "/").replace('"', "\\\"")
}

/// Liest ein Gmsh-Netz im Format 4.1 (ASCII). Übernommen werden Tetraeder
/// (TET4/TET10) und die Randdreiecke mit ihrer CAD-Flächennummer.
pub fn read_msh(text: &str) -> Result<Mesh> {
    let err = |m: &str| FemError::Gmsh(format!("Netzdatei: {m}"));
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let mut file_nodes: HashMap<usize, [f64; 3]> = HashMap::new();
    let mut tets: Vec<Vec<usize>> = Vec::new();
    let mut tris: Vec<(i32, Vec<usize>)> = Vec::new();

    let num = |s: Option<&str>| -> Result<f64> { s.and_then(|v| v.parse().ok()).ok_or_else(|| err("Zahl erwartet")) };

    while let Some(line) = lines.next() {
        match line {
            "$MeshFormat" => {
                let v = lines.next().ok_or_else(|| err("Format fehlt"))?;
                if !v.starts_with("4.1 0") {
                    return Err(err(&format!("nur Version 4.1 ASCII wird unterstützt, gefunden: {v}")));
                }
            }
            "$Nodes" => {
                let mut h = lines.next().ok_or_else(|| err("$Nodes leer"))?.split_whitespace();
                let blocks = num(h.next())? as usize;
                for _ in 0..blocks {
                    let mut b = lines.next().ok_or_else(|| err("Knotenblock fehlt"))?.split_whitespace();
                    let (_, _, parametric, n) = (b.next(), b.next(), num(b.next())? as u8, num(b.next())? as usize);
                    let mut tags = Vec::with_capacity(n);
                    for _ in 0..n {
                        tags.push(num(lines.next())? as usize);
                    }
                    for tag in tags {
                        let mut c = lines.next().ok_or_else(|| err("Koordinaten fehlen"))?.split_whitespace();
                        let p = [num(c.next())?, num(c.next())?, num(c.next())?];
                        let _ = parametric; // Parameterkoordinaten (falls vorhanden) werden ignoriert
                        file_nodes.insert(tag, p);
                    }
                }
            }
            "$Elements" => {
                let mut h = lines.next().ok_or_else(|| err("$Elements leer"))?.split_whitespace();
                let blocks = num(h.next())? as usize;
                for _ in 0..blocks {
                    let mut b = lines.next().ok_or_else(|| err("Elementblock fehlt"))?.split_whitespace();
                    let (_, entity, etype, n) =
                        (num(b.next())?, num(b.next())? as i32, num(b.next())? as u32, num(b.next())? as usize);
                    for _ in 0..n {
                        let l = lines.next().ok_or_else(|| err("Element fehlt"))?;
                        let ids: Vec<usize> = l.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
                        match etype {
                            4 | 11 => tets.push(ids),
                            2 | 9 => tris.push((entity, ids)),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if tets.is_empty() {
        return Err(FemError::Gmsh("Das Netz enthält keine Volumenelemente – ist die STEP-Datei ein geschlossener Körper?".into()));
    }
    let npe = tets[0].len();
    if tets.iter().any(|t| t.len() != npe) {
        return Err(err("gemischte Elementordnungen werden nicht unterstützt"));
    }

    // nur Knoten übernehmen, die zu Tetraedern gehören
    let mut index: HashMap<usize, usize> = HashMap::new();
    let mut nodes = Vec::new();
    let mut conn = Vec::with_capacity(tets.len() * npe);
    for t in &tets {
        for &tag in t {
            let i = *index.entry(tag).or_insert_with(|| {
                nodes.push(file_nodes.get(&tag).copied().unwrap_or([f64::NAN; 3]));
                nodes.len() - 1
            });
            conn.push(i);
        }
    }
    if nodes.iter().any(|p| p[0].is_nan()) {
        return Err(err("Element verweist auf unbekannten Knoten"));
    }

    let mut surface_tags = HashMap::new();
    for (entity, t) in tris {
        if let (Some(&a), Some(&b), Some(&c)) = (index.get(&t[0]), index.get(&t[1]), index.get(&t[2])) {
            let mut key = [a, b, c];
            key.sort_unstable();
            surface_tags.insert(key, entity);
        }
    }

    let mut mesh = Mesh { nodes, npe, conn, surface_tags };
    mesh.fix_orientation()?;
    Ok(mesh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::TET_EDGES;

    fn step(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/geometrie").join(name)
    }

    #[test]
    fn step_vernetzen_knotenreihenfolge_und_flaechen() {
        if find_gmsh().is_none() {
            eprintln!("Gmsh fehlt – Test übersprungen");
            return;
        }
        // automatische Elementgröße muss funktionieren
        let auto = mesh_step(&step("winkel.step"), &MeshOptions::default()).unwrap();
        assert!(auto.n_elems() > 100);
        let m = mesh_step(&step("winkel.step"), &MeshOptions { size: Some(6.0), ..Default::default() }).unwrap();
        assert_eq!(m.npe, 10);
        // Seitenmittenknoten liegen (nahezu) mittig auf der richtigen Kante
        for e in 0..m.n_elems() {
            let c = m.elem_coords(e);
            for (k, &(a, b)) in TET_EDGES.iter().enumerate() {
                let mid = [(c[a][0] + c[b][0]) / 2.0, (c[a][1] + c[b][1]) / 2.0, (c[a][2] + c[b][2]) / 2.0];
                let len = ((c[a][0] - c[b][0]).powi(2) + (c[a][1] - c[b][1]).powi(2) + (c[a][2] - c[b][2]).powi(2)).sqrt();
                let p = c[4 + k];
                let d = ((p[0] - mid[0]).powi(2) + (p[1] - mid[1]).powi(2) + (p[2] - mid[2]).powi(2)).sqrt();
                assert!(d < 0.25 * len, "Element {e}, Kante {k}");
            }
        }
        // jede Außenfläche gehört zu einer CAD-Fläche
        let faces = m.boundary_faces();
        assert!(faces.iter().all(|f| f.tag.is_some()));
        // Volumen: Fuß + Schenkel + Hohlkehle − Bohrungen
        let v = 80.0 * 40.0 * 8.0 + 8.0 * 40.0 * 52.0 + (36.0 - std::f64::consts::PI * 9.0) * 40.0
            - std::f64::consts::PI * (2.0 * 4.5f64.powi(2) * 8.0 + 5.5f64.powi(2) * 8.0);
        assert!((m.volume() - v).abs() / v < 0.005, "Volumen {} statt {v}", m.volume());
    }
}
