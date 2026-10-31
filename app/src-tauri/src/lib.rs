//! Tauri-Backend: verbindet die Oberfläche mit dem Rechenkern.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use fem_core::gmsh::{self, MeshOptions};
use fem_core::mesh::Face;
use fem_core::region::{fit_cylinder, Cylinder};
use fem_core::{Fix, Load, Material, Mesh, Model, Order, Region, Results, Selection, SolverKind};
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub struct Inner {
    mesh: Option<Mesh>,
    faces: Vec<Face>,
    /// Anzeigeknoten → Netzknoten
    disp_nodes: Vec<usize>,
    model: Option<Model>,
    results: Option<Results>,
}

pub type AppState = Arc<Mutex<Inner>>;

// --- Netz ------------------------------------------------------------------

#[derive(Serialize)]
struct SurfaceInfo {
    tag: i32,
    area: f64,
    center: [f64; 3],
    /// Flächennormale, falls die Fläche eben ist
    normal: Option<[f64; 3]>,
    /// Achse, Radius usw., falls die Fläche ein Zylinder(ausschnitt) ist (Welle, Bohrung)
    cylinder: Option<Cylinder>,
}

#[derive(Serialize)]
pub struct MeshView {
    nodes: usize,
    elements: usize,
    order: u8,
    volume: f64,
    bbox: [[f64; 3]; 2],
    mesh_size: f64,
    /// Anzeigeknoten, flach x,y,z
    positions: Vec<f32>,
    /// Dreiecke (Indizes in positions)
    triangles: Vec<u32>,
    /// CAD-Fläche je Dreieck
    tri_surface: Vec<i32>,
    /// Kanten zwischen verschiedenen CAD-Flächen (Paare von Anzeigeknoten)
    feature_edges: Vec<u32>,
    /// alle Netzkanten der Oberfläche
    mesh_edges: Vec<u32>,
    surfaces: Vec<SurfaceInfo>,
}

fn build_view(mesh: &Mesh, faces: &[Face], mesh_size: f64) -> (MeshView, Vec<usize>) {
    let mut disp_index: HashMap<usize, u32> = HashMap::new();
    let mut disp_nodes = Vec::new();
    let mut idx = |n: usize, disp_nodes: &mut Vec<usize>| -> u32 {
        *disp_index.entry(n).or_insert_with(|| {
            disp_nodes.push(n);
            (disp_nodes.len() - 1) as u32
        })
    };

    let mut triangles = Vec::new();
    let mut tri_surface = Vec::new();
    let mut edge_tags: HashMap<(usize, usize), (i32, Option<i32>, Option<usize>)> = HashMap::new();
    let mut surf: HashMap<i32, (f64, [f64; 3], [f64; 3], Vec<[f64; 3]>)> = HashMap::new();
    // Integrationspunkte je Fläche (Lage, Normale mit Flächengewicht) für die Zylindererkennung
    let mut samples: HashMap<i32, (Vec<[f64; 3]>, Vec<([f64; 3], [f64; 3], f64)>)> = HashMap::new();

    for f in faces {
        let tag = f.tag.unwrap_or(-1);
        let n = &f.nodes;
        let subs: Vec<[usize; 3]> = if n.len() == 6 {
            vec![[n[0], n[3], n[5]], [n[3], n[1], n[4]], [n[5], n[4], n[2]], [n[3], n[4], n[5]]]
        } else {
            vec![[n[0], n[1], n[2]]]
        };
        for t in subs {
            for v in t {
                triangles.push(idx(v, &mut disp_nodes));
            }
            tri_surface.push(tag);
        }
        // Kanten der Fläche (Ecken), mit Seitenmitte falls vorhanden
        for k in 0..3 {
            let (a, b) = (n[k], n[(k + 1) % 3]);
            let mid = if n.len() == 6 { Some(n[3 + k]) } else { None };
            let key = (a.min(b), a.max(b));
            edge_tags
                .entry(key)
                .and_modify(|e| e.1 = Some(tag))
                .or_insert((tag, None, mid));
        }
        // Flächeneigenschaften
        let p: Vec<[f64; 3]> = n.iter().map(|&i| mesh.nodes[i]).collect();
        let (mut area, mut nrm) = (0.0, [0.0; 3]);
        for (_, nda) in fem_core::element::tri_integration(&p) {
            area += nda.norm();
            for k in 0..3 {
                nrm[k] += nda[k];
            }
        }
        let smp = samples.entry(tag).or_default();
        smp.0.extend(p.iter().copied());
        for q in fem_core::element::tri_integration_points(&p, 1) {
            let da = q.nda.norm();
            smp.1.push((q.x.into(), (q.nda / da.max(1e-300)).into(), da));
        }
        let c = [(p[0][0] + p[1][0] + p[2][0]) / 3.0, (p[0][1] + p[1][1] + p[2][1]) / 3.0, (p[0][2] + p[1][2] + p[2][2]) / 3.0];
        let e = surf.entry(tag).or_insert((0.0, [0.0; 3], [0.0; 3], Vec::new()));
        e.0 += area;
        for k in 0..3 {
            e.1[k] += c[k] * area;
            e.2[k] += nrm[k];
        }
        let l = (nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]).sqrt().max(1e-300);
        e.3.push([nrm[0] / l, nrm[1] / l, nrm[2] / l]);
    }

    let mut feature_edges = Vec::new();
    let mut mesh_edges = Vec::new();
    for (&(a, b), &(t1, t2, mid)) in &edge_tags {
        let pts: Vec<usize> = match mid {
            Some(m) => vec![a, m, b],
            None => vec![a, b],
        };
        let feature = t2.is_none_or(|t2| t2 != t1);
        for w in pts.windows(2) {
            let (i, j) = (idx(w[0], &mut disp_nodes), idx(w[1], &mut disp_nodes));
            mesh_edges.extend([i, j]);
            if feature {
                feature_edges.extend([i, j]);
            }
        }
    }

    let mut surfaces: Vec<SurfaceInfo> = surf
        .into_iter()
        .map(|(tag, (area, c, n, normals))| {
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-300);
            let n = [n[0] / l, n[1] / l, n[2] / l];
            let planar = normals.iter().all(|m| m[0] * n[0] + m[1] * n[1] + m[2] * n[2] > 1.0 - 1e-6);
            let cylinder = if planar { None } else { samples.get(&tag).and_then(|(p, nr)| fit_cylinder(p, nr)) };
            SurfaceInfo { tag, area, center: [c[0] / area, c[1] / area, c[2] / area], normal: planar.then_some(n), cylinder }
        })
        .collect();
    surfaces.sort_by_key(|s| s.tag);

    let (lo, hi) = mesh.bbox();
    let positions = disp_nodes.iter().flat_map(|&n| mesh.nodes[n].map(|v| v as f32)).collect();
    let view = MeshView {
        nodes: mesh.nodes.len(),
        elements: mesh.n_elems(),
        order: if mesh.npe == 10 { 2 } else { 1 },
        volume: mesh.volume(),
        bbox: [lo, hi],
        mesh_size,
        positions,
        triangles,
        tri_surface,
        feature_edges,
        mesh_edges,
        surfaces,
    };
    (view, disp_nodes)
}

#[tauri::command]
fn gmsh_path() -> Option<String> {
    gmsh::find_gmsh().map(|p| p.display().to_string())
}

#[tauri::command]
async fn open_step(
    state: tauri::State<'_, AppState>,
    path: String,
    size: Option<f64>,
    linear: Option<bool>,
) -> Result<MeshView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || open_step_impl(&state, &path, size, linear == Some(true)))
        .await
        .map_err(|e| e.to_string())?
}

/// STEP öffnen und vernetzen (auch für Tests ohne Oberfläche nutzbar).
pub fn open_step_impl(state: &AppState, path: &str, size: Option<f64>, linear: bool) -> Result<MeshView, String> {
    {
        let opts = MeshOptions {
            size,
            order: if linear { Order::Linear } else { Order::Quadratic },
            ..Default::default()
        };
        let mesh = gmsh::mesh_step(&PathBuf::from(path), &opts).map_err(|e| e.to_string())?;
        let (lo, hi) = mesh.bbox();
        let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
        let faces = mesh.boundary_faces();
        let (view, disp_nodes) = build_view(&mesh, &faces, size.unwrap_or(diag / 25.0));
        let mut s = state.lock().unwrap();
        *s = Inner { mesh: Some(mesh), faces, disp_nodes, model: None, results: None };
        Ok(view)
    }
}

// --- Rechnung ---------------------------------------------------------------

#[derive(Deserialize)]
struct SupportDef {
    surfaces: Vec<i32>,
    fix: Fix,
    #[serde(default)]
    region: Option<Region>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum LoadDef {
    Force { surfaces: Vec<i32>, force: [f64; 3], #[serde(default)] region: Option<Region> },
    Pressure { surfaces: Vec<i32>, pressure: f64, #[serde(default)] region: Option<Region> },
    Moment { surfaces: Vec<i32>, moment: [f64; 3], #[serde(default)] region: Option<Region> },
    Bearing { surfaces: Vec<i32>, force: [f64; 3], #[serde(default)] region: Option<Region> },
}

#[derive(Deserialize)]
pub struct Setup {
    material: Material,
    supports: Vec<SupportDef>,
    loads: Vec<LoadDef>,
    /// Gleichungslöser, Standard: automatisch nach Modellgröße
    #[serde(default)]
    solver: SolverKind,
}

#[derive(Serialize)]
struct Extreme {
    value: f64,
    at: [f64; 3],
}

#[derive(Serialize)]
pub struct ResultView {
    /// je Anzeigeknoten
    displacement: Vec<f32>,
    von_mises: Vec<f32>,
    sigma1: Vec<f32>,
    sigma3: Vec<f32>,
    max_displacement: Extreme,
    max_von_mises: Extreme,
    max_sigma1: Extreme,
    min_sigma3: Extreme,
    safety: Option<f64>,
    reactions: Vec<[f64; 3]>,
    total_load: [f64; 3],
    total_reaction: [f64; 3],
    equations: usize,
    /// Iterationen des iterativen Lösers (`None` = direkt gelöst)
    iterations: Option<usize>,
    seconds: f64,
    warnings: Vec<String>,
}

#[tauri::command]
async fn solve(state: tauri::State<'_, AppState>, setup: Setup) -> Result<ResultView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || solve_impl(&state, setup))
        .await
        .map_err(|e| e.to_string())?
}

/// Rechnung mit dem aktuellen Netz (auch für Tests ohne Oberfläche nutzbar).
pub fn solve_impl(state: &AppState, setup: Setup) -> Result<ResultView, String> {
    {
        let t0 = Instant::now();
        let (mesh, faces, disp_nodes) = {
            let s = state.lock().unwrap();
            let mesh = s.mesh.clone().ok_or("Zuerst eine Geometrie öffnen")?;
            (mesh, s.faces.clone(), s.disp_nodes.clone())
        };
        if setup.supports.is_empty() {
            return Err("Mindestens ein Lager festlegen".to_string());
        }
        let mut model = Model::new(mesh, setup.material.clone()).solver(setup.solver);
        for (i, s) in setup.supports.iter().enumerate() {
            let name = format!("Lager {}", i + 1);
            model = model.group_in(&name, Selection::Surfaces(s.surfaces.clone()), s.region.clone()).support(&name, s.fix);
        }
        for (i, l) in setup.loads.iter().enumerate() {
            let name = format!("Last {}", i + 1);
            let group = name.clone();
            let (sel, region, load) = match l {
                LoadDef::Force { surfaces, force, region } => (surfaces, region, Load::Force { group, force: *force }),
                LoadDef::Pressure { surfaces, pressure, region } => {
                    (surfaces, region, Load::Pressure { group, pressure: *pressure })
                }
                LoadDef::Moment { surfaces, moment, region } => (surfaces, region, Load::Moment { group, moment: *moment }),
                LoadDef::Bearing { surfaces, force, region } => (surfaces, region, Load::Bearing { group, force: *force }),
            };
            model = model.group_in(&name, Selection::Surfaces(sel.clone()), region.clone()).load(load);
        }

        let res = fem_core::solve(&model).map_err(|e| e.to_string())?;
        let m = &model.mesh;

        let mut warnings = Vec::new();
        let (vm_node, vm) = res.max_von_mises();
        // Maximum auf einer gelagerten Fläche → wahrscheinlich Singularität
        let supported: Vec<i32> = setup.supports.iter().flat_map(|s| s.surfaces.clone()).collect();
        let on_support = faces
            .iter()
            .filter(|f| f.tag.is_some_and(|t| supported.contains(&t)))
            .any(|f| f.nodes.contains(&vm_node));
        if on_support {
            warnings.push(
                "Die höchste Vergleichsspannung liegt direkt an einem Lager. Starre Lager erzeugen dort \
                 künstliche Spannungsspitzen, die mit feinerem Netz immer weiter wachsen. Spannungen mit \
                 etwas Abstand zum Lager auswerten."
                    .into(),
            );
        }
        let safety = res.safety_factor(&model.material);
        if let Some(sf) = safety {
            if sf < 1.0 {
                warnings.push(format!(
                    "Sicherheit {sf:.2} < 1: Die Streckgrenze wird überschritten, das Bauteil verformt sich bleibend. \
                     Die Rechnung ist linear-elastisch, die Werte oberhalb der Streckgrenze sind daher nicht realistisch."
                ));
            }
        }
        let (lo, hi) = m.bbox();
        let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
        let (_, umax) = res.max_displacement();
        if umax > 0.05 * diag {
            warnings.push(
                "Die Verformung ist groß im Verhältnis zur Bauteilgröße (> 5 %). Die lineare Rechnung wird hier ungenau."
                    .into(),
            );
        }

        let ext = |n: usize, value: f64| Extreme { value, at: m.nodes[n] };
        let (dn, dv) = res.max_displacement();
        let (s1n, s1) = res.principal.iter().enumerate().fold((0, f64::MIN), |a, (i, p)| if p[0] > a.1 { (i, p[0]) } else { a });
        let (s3n, s3) = res.principal.iter().enumerate().fold((0, f64::MAX), |a, (i, p)| if p[2] < a.1 { (i, p[2]) } else { a });

        let view = ResultView {
            displacement: disp_nodes.iter().flat_map(|&n| res.displacement[n].map(|v| v as f32)).collect(),
            von_mises: disp_nodes.iter().map(|&n| res.von_mises[n] as f32).collect(),
            sigma1: disp_nodes.iter().map(|&n| res.principal[n][0] as f32).collect(),
            sigma3: disp_nodes.iter().map(|&n| res.principal[n][2] as f32).collect(),
            max_displacement: ext(dn, dv),
            max_von_mises: ext(vm_node, vm),
            max_sigma1: ext(s1n, s1),
            min_sigma3: ext(s3n, s3),
            safety,
            reactions: res.reactions.iter().map(|r| r.1).collect(),
            total_load: res.total_load,
            total_reaction: res.total_reaction,
            equations: res.n_equations,
            iterations: res.iterations,
            seconds: t0.elapsed().as_secs_f64(),
            warnings,
        };
        let mut s = state.lock().unwrap();
        s.model = Some(model);
        s.results = Some(res);
        Ok(view)
    }
}

#[tauri::command]
fn export_vtu(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let s = state.lock().unwrap();
    let (Some(model), Some(res)) = (&s.model, &s.results) else {
        return Err("Noch kein Ergebnis vorhanden".into());
    };
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    fem_core::vtk::write_vtu(&mut std::io::BufWriter::new(file), &model.mesh, res).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![gmsh_path, open_step, solve, export_vtu, save_text, load_text])
        .run(tauri::generate_context!())
        .expect("Fehler beim Start von Projekt-FEM");
}
