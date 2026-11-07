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
    /// örtliche Verfeinerungen (Lastflächen, Druckwände)
    pub refine: Vec<Refine>,
    /// Körper (Volumennummern der STEP-Datei), die nicht vernetzt werden – z. B. Schrauben, die als Verbinder gerechnet werden
    pub exclude: Vec<i32>,
}

impl Default for MeshOptions {
    fn default() -> Self {
        MeshOptions { size: None, order: Order::Quadratic, curvature_points: 16, refine: vec![], exclude: vec![] }
    }
}

/// Örtliche Netzverfeinerung: im Bereich höchstens `size`, nach außen weicher Übergang.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Refine {
    Ball { center: [f64; 3], radius: f64, size: f64 },
    Box { min: [f64; 3], max: [f64; 3], size: f64 },
    /// Zylinder um die Strecke center … center + axis
    Cylinder { center: [f64; 3], axis: [f64; 3], radius: f64, size: f64 },
    /// Nahe aller Oberflächen (bis Abstand `dist`), z. B. Druckwände
    Surface { size: f64, dist: f64 },
}

/// Gmsh-Felder für die Verfeinerungen (leer, wenn keine)
fn refine_fields(refine: &[Refine]) -> String {
    let mut s = String::new();
    let mut ids = Vec::new();
    let mut n = 0;
    for r in refine {
        n += 1;
        match r {
            Refine::Ball { center, radius, size } => s += &format!(
                "Field[{n}] = Ball; Field[{n}].Radius = {radius}; Field[{n}].XCenter = {}; Field[{n}].YCenter = {}; \
                 Field[{n}].ZCenter = {}; Field[{n}].VIn = {size}; Field[{n}].VOut = 1e22; Field[{n}].Thickness = {};\n",
                center[0], center[1], center[2], 0.5 * radius
            ),
            Refine::Box { min, max, size } => s += &format!(
                "Field[{n}] = Box; Field[{n}].XMin = {}; Field[{n}].YMin = {}; Field[{n}].ZMin = {}; Field[{n}].XMax = {}; \
                 Field[{n}].YMax = {}; Field[{n}].ZMax = {}; Field[{n}].VIn = {size}; Field[{n}].VOut = 1e22; Field[{n}].Thickness = {};\n",
                min[0], min[1], min[2], max[0], max[1], max[2], 4.0 * size
            ),
            Refine::Cylinder { center, axis, radius, size } => s += &format!(
                "Field[{n}] = Cylinder; Field[{n}].Radius = {radius}; Field[{n}].XCenter = {}; Field[{n}].YCenter = {}; \
                 Field[{n}].ZCenter = {}; Field[{n}].XAxis = {}; Field[{n}].YAxis = {}; Field[{n}].ZAxis = {}; \
                 Field[{n}].VIn = {size}; Field[{n}].VOut = 1e22;\n",
                center[0] + axis[0] / 2.0,
                center[1] + axis[1] / 2.0,
                center[2] + axis[2] / 2.0,
                axis[0] / 2.0,
                axis[1] / 2.0,
                axis[2] / 2.0
            ),
            Refine::Surface { size, dist } => {
                s += &format!(
                    "rs{n}() = Surface{{:}};\nField[{n}] = Distance; Field[{n}].SurfacesList = {{rs{n}()}}; Field[{n}].Sampling = 30;\n"
                );
                let d = n;
                n += 1;
                s += &format!(
                    "Field[{n}] = Threshold; Field[{n}].InField = {d}; Field[{n}].SizeMin = {size}; Field[{n}].SizeMax = hmax; \
                     Field[{n}].DistMin = {dist}; Field[{n}].DistMax = {};\n",
                    3.0 * dist
                );
            }
        }
        ids.push(n);
    }
    if ids.is_empty() {
        return s;
    }
    n += 1;
    let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ");
    s += &format!("Field[{n}] = Min; Field[{n}].FieldsList = {{{list}}};\nBackground Field = {n};\nMesh.MeshSizeExtendFromBoundary = 0;\n");
    s
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
        Some(h) if h > 0.0 => format!("hmax = {h};\nMesh.MeshSizeMax = hmax;"),
        _ => "v() = Volume \"*\";\n\
              bb() = BoundingBox Volume{v()};\n\
              hmax = Sqrt((bb(3)-bb(0))^2 + (bb(4)-bb(1))^2 + (bb(5)-bb(2))^2) / 25;\n\
              Mesh.MeshSizeMax = hmax;"
            .into(),
    };
    let script = format!(
        r#"SetFactory("OpenCASCADE");
Geometry.OCCTargetUnit = "MM";
Merge "{step}";
{exclude}Coherence;
Save "{xao}";
{size}
Mesh.MeshSizeFromCurvature = {curv};
{fields}
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
        xao = escape(&dir.join("geometrie.geo_unrolled")),
        exclude = if opts.exclude.is_empty() {
            String::new()
        } else {
            format!("Recursive Delete {{ Volume{{{}}}; }}\n", opts.exclude.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(", "))
        },
        curv = opts.curvature_points,
        fields = refine_fields(&opts.refine),
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
    let names = std::fs::read_to_string(dir.join("geometrie.geo_unrolled.xao")).map(|x| solid_names(&x)).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    let log = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    // Gmsh beendet sich auch bei Skriptfehlern erfolgreich → Fehlerzeilen selbst prüfen
    let errors: Vec<&str> = log.lines().filter(|l| l.trim_start().starts_with("Error")).collect();
    let text = match text {
        Ok(t) if out.status.success() && errors.is_empty() => t,
        _ => return Err(FemError::Gmsh(if errors.is_empty() { log } else { errors.join("\n") })),
    };
    let mut mesh = read_msh(&text)?;
    // Körpernamen: Reihenfolge der Volumen in der Geometrie = Gmsh-Volumennummer
    let bodies = mesh.bodies();
    if bodies.len() > 1 && names.len() == bodies.len() {
        mesh.body_names = bodies.into_iter().zip(names).filter(|(_, n)| !n.is_empty()).collect();
    }
    Ok(mesh)
}

/// Körper einer STEP-Datei mit Namen und Oberflächendreiecken (ohne Volumennetz, ohne Verschmelzen) – für die
/// Erkennung von Schrauben, Muttern und Scheiben in Baugruppen. Die Nummern gelten für `MeshOptions::exclude`.
pub fn inspect_step(step: &Path) -> Result<Vec<crate::fastener::Solid>> {
    let gmsh = find_gmsh().ok_or_else(|| FemError::Gmsh("Gmsh nicht gefunden".into()))?;
    let step = step.canonicalize().map_err(|e| FemError::Gmsh(format!("{}: {e}", step.display())))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("projekt-fem-pruefen-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| FemError::Gmsh(e.to_string()))?;
    let (geo, msh, xao) = (dir.join("pruefen.geo"), dir.join("flaechen.msh"), dir.join("geometrie.geo_unrolled"));
    let script = format!(
        r#"SetFactory("OpenCASCADE");
Geometry.OCCTargetUnit = "MM";
Merge "{step}";
Save "{xao}";
v() = Volume "*";
bb() = BoundingBox Volume{{v()}};
Mesh.MeshSizeMax = Sqrt((bb(3)-bb(0))^2 + (bb(4)-bb(1))^2 + (bb(5)-bb(2))^2) / 40;
Mesh.MeshSizeFromCurvature = 12;
Mesh.SaveAll = 1;
Mesh.MshFileVersion = 4.1;
Mesh.Binary = 0;
Mesh 2;
Save "{msh}";
"#,
        step = escape(&step),
        xao = escape(&xao),
        msh = escape(&msh),
    );
    std::fs::write(&geo, script).map_err(|e| FemError::Gmsh(e.to_string()))?;
    let out = Command::new(&gmsh).arg(&geo).arg("-").arg("-nt").arg("1").output().map_err(|e| FemError::Gmsh(e.to_string()))?;
    let text = std::fs::read_to_string(&msh);
    let names = std::fs::read_to_string(dir.join("geometrie.geo_unrolled.xao")).map(|x| solid_names(&x)).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    let text = text.map_err(|_| FemError::Gmsh(String::from_utf8_lossy(&out.stderr).to_string()))?;
    let mut solids = read_surfaces(&text)?;
    if names.len() == solids.len() {
        for (s, n) in solids.iter_mut().zip(names) {
            s.name = n;
        }
    }
    Ok(solids)
}

/// Volumen mit ihren Randflächen ($Entities) und die Dreiecke je Fläche aus einer Gmsh-Datei 4.1 (ASCII)
fn read_surfaces(text: &str) -> Result<Vec<crate::fastener::Solid>> {
    let err = |m: &str| FemError::Gmsh(format!("Flächennetz: {m}"));
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let mut volumes: Vec<(i32, Vec<i32>)> = Vec::new();
    let mut nodes: HashMap<usize, [f64; 3]> = HashMap::new();
    let mut tris: HashMap<i32, Vec<[usize; 3]>> = HashMap::new();
    let num = |s: Option<&str>| -> Result<f64> { s.and_then(|v| v.parse().ok()).ok_or_else(|| err("Zahl erwartet")) };
    while let Some(line) = lines.next() {
        match line {
            "$Entities" => {
                let c: Vec<usize> = lines.next().ok_or_else(|| err("$Entities leer"))?.split_whitespace().filter_map(|v| v.parse().ok()).collect();
                if c.len() < 4 {
                    return Err(err("$Entities"));
                }
                for _ in 0..(c[0] + c[1] + c[2]) {
                    lines.next();
                }
                for _ in 0..c[3] {
                    let v: Vec<&str> = lines.next().ok_or_else(|| err("Volumen fehlt"))?.split_whitespace().collect();
                    let tag: i32 = v[0].parse().map_err(|_| err("Volumennummer"))?;
                    let nphys: usize = v.get(7).and_then(|x| x.parse().ok()).unwrap_or(0);
                    let nb: usize = v.get(8 + nphys).and_then(|x| x.parse().ok()).unwrap_or(0);
                    let surfs = v.iter().skip(9 + nphys).take(nb).filter_map(|x| x.parse::<i32>().ok()).map(i32::abs).collect();
                    volumes.push((tag, surfs));
                }
            }
            "$Nodes" => {
                let mut h = lines.next().ok_or_else(|| err("$Nodes leer"))?.split_whitespace();
                let blocks = num(h.next())? as usize;
                for _ in 0..blocks {
                    let mut b = lines.next().ok_or_else(|| err("Knotenblock fehlt"))?.split_whitespace();
                    let (_, _, _, n) = (b.next(), b.next(), b.next(), num(b.next())? as usize);
                    let mut tags = Vec::with_capacity(n);
                    for _ in 0..n {
                        tags.push(num(lines.next())? as usize);
                    }
                    for tag in tags {
                        let mut c = lines.next().ok_or_else(|| err("Koordinaten fehlen"))?.split_whitespace();
                        nodes.insert(tag, [num(c.next())?, num(c.next())?, num(c.next())?]);
                    }
                }
            }
            "$Elements" => {
                let mut h = lines.next().ok_or_else(|| err("$Elements leer"))?.split_whitespace();
                let blocks = num(h.next())? as usize;
                for _ in 0..blocks {
                    let mut b = lines.next().ok_or_else(|| err("Elementblock fehlt"))?.split_whitespace();
                    let (_, entity, etype, n) = (num(b.next())?, num(b.next())? as i32, num(b.next())? as u32, num(b.next())? as usize);
                    for _ in 0..n {
                        let l = lines.next().ok_or_else(|| err("Element fehlt"))?;
                        if etype == 2 {
                            let ids: Vec<usize> = l.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
                            if ids.len() >= 3 {
                                tris.entry(entity).or_default().push([ids[0], ids[1], ids[2]]);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    volumes.sort_by_key(|v| v.0);
    Ok(volumes
        .into_iter()
        .map(|(tag, surfs)| crate::fastener::Solid {
            tag,
            name: String::new(),
            surfaces: surfs
                .iter()
                .map(|s| {
                    tris.get(s)
                        .map(|ts| ts.iter().filter_map(|t| Some([*nodes.get(&t[0])?, *nodes.get(&t[1])?, *nodes.get(&t[2])?])).collect())
                        .unwrap_or_default()
                })
                .collect(),
        })
        .collect())
}

/// Namen der Volumenkörper aus der XAO-Datei von Gmsh (`<solid index="0" name="Shapes/Baugruppe/1/Platte" …/>`).
/// Gmsh übernimmt die Namen (Labels) aus der STEP-Datei; doppelte Namen bekommen eine Nummer.
fn solid_names(xao: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in xao.lines().map(str::trim).filter(|l| l.starts_with("<solid ")) {
        let name = line.split("name=\"").nth(1).and_then(|r| r.split('"').next()).unwrap_or("");
        let name = name.rsplit('/').find(|p| !p.trim().is_empty() && p.parse::<u32>().is_err()).unwrap_or("").trim();
        let name = name.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
        let name = if name == "Shapes" || name.starts_with("Open CASCADE STEP translator") { String::new() } else { name };
        let n = out.iter().filter(|o| *o == &name || o.starts_with(&format!("{name} ("))).count();
        out.push(if n > 0 && !name.is_empty() { format!("{name} ({})", n + 1) } else { name });
    }
    out
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
    let mut tet_body: Vec<i32> = Vec::new();
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
                            4 | 11 => {
                                tets.push(ids);
                                tet_body.push(entity);
                            }
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

    // ein Körper: keine Körperliste nötig
    let single = tet_body.iter().all(|&b| b == tet_body[0]);
    let elem_body = if single { vec![] } else { tet_body };
    let mut mesh = Mesh { nodes, npe, conn, surface_tags, elem_body, body_names: vec![] };
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

    #[test]
    fn baugruppe_koerper_und_namen() {
        if find_gmsh().is_none() {
            eprintln!("Gmsh fehlt – Test übersprungen");
            return;
        }
        // Grundplatte 100×40×5, Block 40×40×20 darauf (verklebt), Zapfen Ø8 mit 0,1 mm Spalt (lose)
        let m = mesh_step(&step("baugruppe.step"), &MeshOptions { size: Some(5.0), ..Default::default() }).unwrap();
        assert_eq!(m.bodies(), vec![1, 2, 3]);
        let names: Vec<String> = m.bodies().iter().map(|&b| m.body_name(b)).collect();
        assert_eq!(names, vec!["Grundplatte", "Block", "Zapfen"]);
        let mut vol = std::collections::HashMap::new();
        for e in 0..m.n_elems() {
            *vol.entry(m.body_of(e)).or_insert(0.0) += crate::element::tet_volume(&m.elem_coords(e)[..4]).abs();
        }
        assert!((vol[&1] - 20000.0).abs() < 50.0, "{vol:?}");
        assert!((vol[&2] - 32000.0).abs() < 50.0, "{vol:?}");
        assert!((vol[&3] - std::f64::consts::PI * 16.0 * 15.0).abs() < 15.0, "{vol:?}");
    }

    #[test]
    fn verschraubung_erkennen_und_rechnen() {
        if find_gmsh().is_none() {
            eprintln!("Gmsh fehlt – Test übersprungen");
            return;
        }
        let path = step("verschraubung.step");
        let solids = inspect_step(&path).unwrap();
        let names: Vec<&str> = solids.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names.len(), 6, "{names:?}");
        let det = crate::fastener::detect(&solids);
        assert_eq!(det.len(), 2, "{det:?}");
        let (b1, b2) = (&det[0], &det[1]);
        assert_eq!(b1.class.as_deref(), Some("10.9"));
        assert_eq!(b2.class.as_deref(), Some("8.8"));
        assert_eq!(b1.bolt.d, 8.0);
        assert!(b1.bolt.nut_t.is_none());
        // Kopf liegt oben auf (z = 25), Achse zeigt nach unten
        assert!((b1.bolt.axis[2] + 1.0).abs() < 1e-6, "{:?}", b1.bolt.axis);
        let z_head = b1.bolt.origin[2] + b1.bolt.axis[2] * b1.bolt.head_t;
        assert!((z_head - 25.0).abs() < 0.05, "Kopfauflage z = {z_head}");
        // Schraube 2: Scheibe unter dem Kopf (Auflage z = 25) und Mutter unten (Auflage z = 0)
        assert_eq!(b2.volumes.len(), 3, "{:?}", b2.parts);
        let z2 = b2.bolt.origin[2] + b2.bolt.axis[2] * b2.bolt.head_t;
        let zn = b2.bolt.origin[2] + b2.bolt.axis[2] * b2.bolt.nut_t.unwrap();
        assert!((z2 - 25.0).abs() < 0.05 && zn.abs() < 0.05, "Kopf {z2}, Mutter {zn}");

        let exclude: Vec<i32> = det.iter().flat_map(|d| d.volumes.clone()).collect();
        let m = mesh_step(&path, &MeshOptions { size: Some(4.0), exclude, ..Default::default() }).unwrap();
        assert_eq!(m.bodies().len(), 2);
        assert_eq!(m.body_name(m.bodies()[0]), "Unterteil");
        let f = 4000.0;
        let mut model = crate::Model::new(m, crate::Material::steel())
            .group("unten", crate::Selection::Plane { axis: crate::Axis::Z, value: 0.0 })
            .group("oben", crate::Selection::Plane { axis: crate::Axis::Z, value: 25.0 })
            .support("unten", crate::Fix::all())
            .load(crate::Load::Force { group: "oben".into(), force: [0.0, 0.0, f] });
        model.bolts = det.iter().map(|d| d.bolt.clone()).collect();
        let pairs = crate::bolt::open_joints(&mut model).unwrap();
        assert!(!pairs.is_empty());
        let res = crate::solve(&model).unwrap();
        let sum: f64 = res.bolts.iter().map(|b| b.axial).sum();
        assert!((sum - f).abs() < 1e-6 * f, "Schraubenkräfte {:?}", res.bolts);
        assert!(res.bolts.iter().all(|b| b.axial > 0.3 * f), "{:?}", res.bolts);
        // Zug: Fuge öffnet sich, keine Durchdringung
        assert!(crate::bolt::penetration(&model.mesh, &pairs, &res.displacement) < 1e-4);
    }

    #[test]
    fn verfeinerung_kugel_und_oberflaeche() {
        if find_gmsh().is_none() {
            eprintln!("Gmsh fehlt – Test übersprungen");
            return;
        }
        let step = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/geometrie/lochplatte.step");
        let base = MeshOptions { size: Some(8.0), order: Order::Linear, ..Default::default() };
        let grob = mesh_step(&step, &base).unwrap();
        // Kugel um die Bohrung: dort Kanten ≤ 1 mm
        let kugel = MeshOptions { refine: vec![Refine::Ball { center: [100.0, 25.0, 2.5], radius: 10.0, size: 1.0 }], ..base.clone() };
        let fein = mesh_step(&step, &kugel).unwrap();
        assert!(fein.n_elems() > 2 * grob.n_elems(), "{} vs {}", fein.n_elems(), grob.n_elems());
        let kante = |m: &Mesh, nahe: &dyn Fn([f64; 3]) -> bool| {
            let mut l: f64 = 0.0;
            for e in 0..m.n_elems() {
                let c = m.elem_coords(e);
                if nahe(c[0]) {
                    l = l.max(((c[0][0] - c[1][0]).powi(2) + (c[0][1] - c[1][1]).powi(2) + (c[0][2] - c[1][2]).powi(2)).sqrt());
                }
            }
            l
        };
        let an_bohrung = |p: [f64; 3]| ((p[0] - 100.0).powi(2) + (p[1] - 25.0).powi(2)).sqrt() < 7.0;
        let mittel = |m: &Mesh, nahe: &dyn Fn([f64; 3]) -> bool| {
            let (mut sum, mut n) = (0.0, 0);
            for e in 0..m.n_elems() {
                let c = m.elem_coords(e);
                if nahe(c[0]) {
                    for (a, b) in [(0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3)] {
                        sum += ((c[a][0] - c[b][0]).powi(2) + (c[a][1] - c[b][1]).powi(2) + (c[a][2] - c[b][2]).powi(2)).sqrt();
                        n += 1;
                    }
                }
            }
            sum / n as f64
        };
        eprintln!("Kugel: mittlere Kante {:.2}, max {:.2}; grob {:.2}", mittel(&fein, &an_bohrung), kante(&fein, &an_bohrung), mittel(&grob, &an_bohrung));
        assert!(mittel(&fein, &an_bohrung) < 1.5, "{}", mittel(&fein, &an_bohrung));
        // Oberfläche: Platte nur 5 mm dick → überall fein, weit weg von der Bohrung trotzdem ≤ 1,5·size
        let wand = MeshOptions { refine: vec![Refine::Surface { size: 1.5, dist: 1.5 }], ..base.clone() };
        let w = mesh_step(&step, &wand).unwrap();
        eprintln!("Wand: mittlere Kante {:.2}", mittel(&w, &|p| p[0] < 30.0));
        let weit = |p: [f64; 3]| p[0] < 30.0;
        assert!(mittel(&w, &weit) < 0.65 * mittel(&grob, &weit), "{} vs {}", mittel(&w, &weit), mittel(&grob, &weit));
    }
}
