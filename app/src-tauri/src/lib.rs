//! Tauri-Backend: verbindet die Oberfläche mit dem Rechenkern.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use fem_core::gmsh::{self, MeshOptions, Refine};
use fem_core::mesh::Face;
use fem_core::region::{fit_cylinder, Cylinder};
use fem_core::{Fix, Load, LocalFix, Material, Mesh, Model, Order, Region, Results, Selection, SolverKind};
use serde::{Deserialize, Serialize};

pub mod cad;
pub mod onshape;
pub mod server;

/// Aktueller Fortschritt einer langen Rechnung (für die Anzeige)
#[derive(Clone, Serialize)]
pub struct ProgressView {
    text: String,
    fraction: Option<f64>,
}

pub type ProgressSlot = Arc<Mutex<Option<ProgressView>>>;

/// Fortschritts-Empfänger, der in den Zustand der Sitzung schreibt
fn progress_for(state: &AppState) -> (fem_core::Progress, ProgressSlot) {
    let slot = state.lock().unwrap().progress.clone();
    let s2 = slot.clone();
    let p = fem_core::Progress::new(move |text, fraction| {
        *s2.lock().unwrap() = Some(ProgressView { text: text.to_string(), fraction });
    });
    (p, slot)
}

pub fn progress_impl(state: &AppState) -> Option<ProgressView> {
    let slot = state.lock().map(|s| s.progress.clone()).ok()?;
    let v = slot.lock().ok()?.clone();
    v
}

#[derive(Default)]
pub struct Inner {
    progress: ProgressSlot,
    /// Leichtbau-Vorschlag: Dichte je Element
    topo: Option<Vec<f64>>,
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

// --- Eigene Werkstoffe (Datei im Konfigurationsordner) ----------------------------------

fn user_materials_path() -> Result<PathBuf, String> {
    Ok(server::config_dir().ok_or("Kein Konfigurationsordner gefunden")?.join("werkstoffe.json"))
}

pub fn user_materials_load() -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(user_materials_path()?) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!([])),
    }
}

pub fn user_materials_save(v: &serde_json::Value) -> Result<(), String> {
    if !v.is_array() {
        return Err("Werkstoffliste erwartet".into());
    }
    let p = user_materials_path()?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_string_pretty(v).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_user_materials() -> Result<serde_json::Value, String> {
    user_materials_load()
}

#[tauri::command]
fn save_user_materials(list: serde_json::Value) -> Result<(), String> {
    user_materials_save(&list)
}

/// Datei aus der Befehlszeile (`projekt-fem-app --open teil.step`, z. B. vom CAD-Add-in gestartet)
#[tauri::command]
fn startup_file() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == "--open").and_then(|i| args.get(i + 1)).cloned()
}

/// Ergebniswerte für „Ergebnis holen“ im CAD hinterlegen
#[tauri::command]
fn cad_set_summary(name: String, summary: serde_json::Value) {
    cad::set_summary(&name, summary);
}

/// Angaben für den Dialog „CAD“: Schlüssel für die Lesezeichen, lokaler Port, Onshape eingerichtet?
#[tauri::command]
fn cad_info() -> serde_json::Value {
    serde_json::json!({
        "key": server::ServerConfig::load_saved().key,
        "localPort": cad::LOCAL_PORT,
        "onshape": onshape::configured(),
    })
}

#[tauri::command]
fn onshape_set_keys(access: String, secret: String) -> Result<bool, String> {
    onshape::save_keys(&access, &secret)?;
    Ok(onshape::configured())
}

#[tauri::command]
async fn onshape_import(url: String) -> Result<cad::Incoming, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::import(&url)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn progress(state: tauri::State<'_, AppState>) -> Option<ProgressView> {
    progress_impl(state.inner())
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
    refine: Option<Vec<Refine>>,
) -> Result<MeshView, String> {
    let refine = refine.unwrap_or_default();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || open_step_impl(&state, &path, size, linear == Some(true), &refine))
        .await
        .map_err(|e| e.to_string())?
}

/// STEP öffnen und vernetzen (auch für Tests ohne Oberfläche nutzbar).
pub fn open_step_impl(state: &AppState, path: &str, size: Option<f64>, linear: bool, refine: &[Refine]) -> Result<MeshView, String> {
    {
        let opts = MeshOptions {
            size,
            order: if linear { Order::Linear } else { Order::Quadratic },
            refine: refine.to_vec(),
            ..Default::default()
        };
        let (progress, slot) = progress_for(state);
        progress.report(if refine.is_empty() { "Vernetzen (Gmsh)" } else { "Vernetzen mit örtlicher Verfeinerung (Gmsh)" }, None);
        let mesh = gmsh::mesh_step(&PathBuf::from(path), &opts).map_err(|e| e.to_string())?;
        let (lo, hi) = mesh.bbox();
        let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
        let faces = mesh.boundary_faces();
        let (view, disp_nodes) = build_view(&mesh, &faces, size.unwrap_or(diag / 25.0));
        *slot.lock().unwrap() = None;
        let mut s = state.lock().unwrap();
        *s = Inner { progress: slot, topo: None, mesh: Some(mesh), faces, disp_nodes, model: None, results: None };
        Ok(view)
    }
}

// --- Geometrie anpassen -------------------------------------------------------

#[derive(Serialize)]
pub struct GeometryView {
    mesh: MeshView,
    /// geänderte STEP-Datei (für Neuvernetzen und Export)
    step: String,
    volume_before: f64,
    volume_after: f64,
}

/// Änderungen auf die Original-STEP anwenden, Ergebnis vernetzen.
pub fn modify_geometry_impl(
    state: &AppState,
    base: &str,
    ops: &[fem_core::geometry::GeoOp],
    size: Option<f64>,
    refine: &[Refine],
) -> Result<GeometryView, String> {
    progress_for(state).0.report("Geometrie anpassen (OpenCASCADE)", None);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let stem = PathBuf::from(base).file_stem().and_then(|s| s.to_str()).unwrap_or("geometrie").to_string();
    let out = std::env::temp_dir().join("projekt-fem-geo").join(format!("{stamp}")).join(format!("{stem}_geaendert.step"));
    let r = fem_core::geometry::modify_step(&PathBuf::from(base), ops, &out).map_err(|e| e.to_string())?;
    let step = out.display().to_string();
    let mesh = open_step_impl(state, &step, size, false, refine)?;
    Ok(GeometryView { mesh, step, volume_before: r.volume_before, volume_after: r.volume_after })
}

#[tauri::command]
async fn modify_geometry(
    state: tauri::State<'_, AppState>,
    base: String,
    ops: Vec<fem_core::geometry::GeoOp>,
    size: Option<f64>,
    refine: Option<Vec<Refine>>,
) -> Result<GeometryView, String> {
    let state = state.inner().clone();
    let refine = refine.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || modify_geometry_impl(&state, &base, &ops, size, &refine))
        .await
        .map_err(|e| e.to_string())?
}

/// Geänderte STEP-Datei speichern (Kopie)
#[tauri::command]
fn copy_step(from: String, to: String) -> Result<(), String> {
    let ok = |p: &str| p.to_lowercase().ends_with(".step") || p.to_lowercase().ends_with(".stp");
    if !ok(&from) || !ok(&to) {
        return Err("Nur STEP-Dateien".into());
    }
    std::fs::copy(from, to).map(|_| ()).map_err(|e| e.to_string())
}

// --- Rechnung ---------------------------------------------------------------

#[derive(Deserialize)]
struct SupportDef {
    surfaces: Vec<i32>,
    fix: Fix,
    #[serde(default)]
    region: Option<Region>,
    /// lokale Lagerung (reibungsfrei auf beliebiger Fläche, zylindrisch)
    #[serde(default)]
    local: Option<LocalFix>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum LoadDef {
    Force { surfaces: Vec<i32>, force: [f64; 3], #[serde(default)] region: Option<Region> },
    Pressure { surfaces: Vec<i32>, pressure: f64, #[serde(default)] region: Option<Region> },
    Moment { surfaces: Vec<i32>, moment: [f64; 3], #[serde(default)] region: Option<Region> },
    Bearing { surfaces: Vec<i32>, force: [f64; 3], #[serde(default)] region: Option<Region> },
    /// Strömung/Wind: Druck (MPa) auf alle angeströmten Flächen
    Flow { surfaces: Vec<i32>, direction: [f64; 3], pressure: f64, #[serde(default)] region: Option<Region> },
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
    /// gefülltes Volumen [mm³] (für die Masse; mit Infill Wand + Kern × Füllgrad)
    solid_volume: f64,
    /// Sicherheit gegen Bruch (Rm)
    safety_break: Option<f64>,
    /// Auslastung je Anzeigeknoten (1 = Festigkeitsgrenze), bei Schichtaufbau richtungsabhängig
    utilization: Option<Vec<f32>>,
    /// Auslastung der Schichthaftung je Anzeigeknoten (nur bei Schichtaufbau)
    utilization_layers: Option<Vec<f32>>,
    max_utilization: Option<Extreme>,
    /// Auslastung im Infill je Anzeigeknoten (3D-Druck mit Füllung)
    utilization_infill: Option<Vec<f32>>,
    /// Wandanteil je Anzeigeknoten (1 = Wand, 0 = Infill)
    shell_fraction: Option<Vec<f32>>,
    /// Am Ort der größten Auslastung maßgeblich: „Schichthaftung“ oder „in der Schicht“
    governing: Option<String>,
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
/// Modell aus dem aktuellen Netz und den Einstellungen der Oberfläche
fn build_model(state: &AppState, setup: &Setup) -> Result<(Model, Vec<Face>, Vec<usize>, ProgressSlot), String> {
    let (mesh, faces, disp_nodes) = {
        let s = state.lock().unwrap();
        let mesh = s.mesh.clone().ok_or("Zuerst eine Geometrie öffnen")?;
        (mesh, s.faces.clone(), s.disp_nodes.clone())
    };
    if setup.supports.is_empty() {
        return Err("Mindestens ein Lager festlegen".to_string());
    }
    let (progress, slot) = progress_for(state);
    let mut model = Model::new(mesh, setup.material.clone()).solver(setup.solver).progress(progress);
        for (i, s) in setup.supports.iter().enumerate() {
            let name = format!("Lager {}", i + 1);
            model = model.group_in(&name, Selection::Surfaces(s.surfaces.clone()), s.region.clone());
            model = match &s.local {
                Some(local) => model.support_local(&name, local.clone()),
                None => model.support(&name, s.fix),
            };
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
                LoadDef::Flow { surfaces, direction, pressure, region } => {
                    (surfaces, region, Load::Flow { group, direction: *direction, pressure: *pressure })
                }
            };
            model = model.group_in(&name, Selection::Surfaces(sel.clone()), region.clone()).load(load);
        }
    Ok((model, faces, disp_nodes, slot))
}

pub fn solve_impl(state: &AppState, setup: Setup) -> Result<ResultView, String> {
    {
        let t0 = Instant::now();
        let (model, faces, disp_nodes, slot) = build_model(state, &setup)?;
        let res = fem_core::solve(&model);
        *slot.lock().unwrap() = None;
        let res = res.map_err(|e| e.to_string())?;
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
        // maßgeblich bei Schichtaufbau: Schichthaftung oder Festigkeit in der Schicht
        // maßgeblich: Infill, Schichthaftung oder Festigkeit in der Schicht
        let governing = match (res.max_utilization(), &res.utilization_layers, &res.utilization_infill) {
            (Some((n, u)), _, Some(c)) if c[n] >= u - 1e-12 => Some("Infill".to_string()),
            (Some((n, u)), Some(l), _) => Some(if l[n] >= u - 1e-12 { "Schichthaftung" } else { "in der Schicht" }.to_string()),
            (Some(_), None, Some(_)) => Some("Wand".to_string()),
            _ => None,
        };
        if governing.as_deref() == Some("Infill") {
            warnings.push(
                "Maßgeblich ist das Infill im Inneren. Mehr Füllgrad, ein tragfähigeres Muster (Gitter, Dreiecke, Kubisch) \
                 oder mehr Wände bzw. Deckschichten helfen. Mit „Schnitt“ im Ergebnis ins Bauteil schauen."
                    .into(),
            );
        }
        if governing.as_deref() == Some("Schichthaftung") {
            warnings.push(
                "Maßgeblich ist die Schichthaftung (Zug quer zu den Schichten bzw. Schub zwischen den Schichten). \
                 Eine andere Aufbaurichtung kann deutlich mehr Sicherheit bringen – „Aufbaurichtung vergleichen“ nutzen."
                    .into(),
            );
        }
        if let Some(sf) = safety {
            if sf < 1.0 {
                warnings.push(format!(
                    "Sicherheit {sf:.2} < 1: Die Festigkeit wird überschritten – das Bauteil verformt sich bleibend oder bricht. \
                     Die Rechnung ist linear-elastisch, die Werte oberhalb der Festigkeitsgrenze sind daher nicht realistisch."
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
            safety_break: res.safety_break,
            solid_volume: res.solid_volume,
            utilization: res.utilization.as_ref().map(|u| disp_nodes.iter().map(|&n| u[n] as f32).collect()),
            utilization_layers: res.utilization_layers.as_ref().map(|u| disp_nodes.iter().map(|&n| u[n] as f32).collect()),
            max_utilization: res.max_utilization().map(|(n, u)| ext(n, u)),
            utilization_infill: res.utilization_infill.as_ref().map(|u| disp_nodes.iter().map(|&n| u[n] as f32).collect()),
            shell_fraction: res.shell_fraction.as_ref().map(|u| disp_nodes.iter().map(|&n| u[n] as f32).collect()),
            governing,
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

// --- Stabwerk (Balken, Rahmen, Fachwerke) -----------------------------------------------

#[tauri::command]
async fn frame_solve(frame: fem_core::frame::Frame) -> Result<fem_core::frame::FrameResults, String> {
    tauri::async_runtime::spawn_blocking(move || fem_core::frame::solve_frame(&frame).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

// --- Eigenfrequenzen und Knicken --------------------------------------------------------

#[derive(Serialize)]
pub struct ModesView {
    /// "modal" oder "buckling"
    kind: String,
    /// Eigenfrequenzen [Hz] bzw. Knicklastfaktoren
    values: Vec<f64>,
    /// je Mode Verschiebung je Anzeigeknoten (flach, auf 1 normiert)
    shapes: Vec<Vec<f32>>,
    seconds: f64,
}

pub fn modes_impl(state: &AppState, setup: Setup, kind: &str, count: usize, density: Option<f64>) -> Result<ModesView, String> {
    let t0 = Instant::now();
    let (model, _, disp_nodes, slot) = build_model(state, &setup)?;
    let count = count.clamp(1, 30);
    let r = match kind {
        "modal" => fem_core::dynamics::eigenfrequencies(&model, density.unwrap_or(0.0) * 1e-9, count),
        _ => fem_core::dynamics::buckling(&model, count),
    };
    *slot.lock().unwrap() = None;
    let r = r.map_err(|e| e.to_string())?;
    Ok(ModesView {
        kind: kind.to_string(),
        values: r.values,
        shapes: r.shapes.iter().map(|sh| disp_nodes.iter().flat_map(|&n| sh[n].map(|v| v as f32)).collect()).collect(),
        seconds: t0.elapsed().as_secs_f64(),
    })
}

#[tauri::command]
async fn modes(state: tauri::State<'_, AppState>, setup: Setup, kind: String, count: usize, density: Option<f64>) -> Result<ModesView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || modes_impl(&state, setup, &kind, count, density)).await.map_err(|e| e.to_string())?
}

// --- Leichtbau: Topologieoptimierung -----------------------------------------------------

#[derive(Deserialize)]
pub struct TopoArgs {
    volume_fraction: f64,
    iterations: usize,
    #[serde(default)]
    filter_radius: f64,
}

#[derive(Serialize)]
pub struct TopoSurface {
    positions: Vec<f32>,
    triangles: Vec<u32>,
    /// Volumenanteil der Elemente ≥ Schwellwert
    volume_fraction: f64,
}

#[derive(Serialize)]
pub struct TopoView {
    /// Dichte je Anzeigeknoten
    density: Vec<f32>,
    /// je Durchlauf (Nachgiebigkeit, Volumenanteil)
    history: Vec<(f64, f64)>,
    surface: TopoSurface,
}

fn topo_surface_of(mesh: &Mesh, density: &[f64], threshold: f64) -> TopoSurface {
    let (pts, tris) = fem_core::topopt::shape_surface(mesh, density, threshold, 3);
    let (mut v, mut vt) = (0.0, 0.0);
    for e in 0..mesh.n_elems() {
        let ve = fem_core::element::tet_volume(&mesh.elem_coords(e)[..4]).abs();
        vt += ve;
        if density[e] >= threshold {
            v += ve;
        }
    }
    TopoSurface {
        positions: pts.iter().flat_map(|p| p.map(|x| x as f32)).collect(),
        triangles: tris.iter().flat_map(|t| *t).collect(),
        volume_fraction: v / vt.max(1e-300),
    }
}

pub fn topopt_impl(state: &AppState, setup: Setup, args: TopoArgs) -> Result<TopoView, String> {
    let (model, _, disp_nodes, slot) = build_model(state, &setup)?;
    let params = fem_core::topopt::TopoParams {
        volume_fraction: args.volume_fraction,
        iterations: args.iterations.clamp(1, 200),
        filter_radius: args.filter_radius,
        ..Default::default()
    };
    let r = fem_core::topopt::optimize(&model, &params);
    *slot.lock().unwrap() = None;
    let r = r.map_err(|e| e.to_string())?;
    let nd = fem_core::topopt::nodal_density(&model.mesh, &r.density);
    let view = TopoView {
        density: disp_nodes.iter().map(|&n| nd[n] as f32).collect(),
        history: r.history.clone(),
        surface: topo_surface_of(&model.mesh, &r.density, 0.5),
    };
    state.lock().unwrap().topo = Some(r.density);
    Ok(view)
}

pub fn topo_surface_impl(state: &AppState, threshold: f64) -> Result<TopoSurface, String> {
    let s = state.lock().unwrap();
    let (Some(mesh), Some(d)) = (&s.mesh, &s.topo) else {
        return Err("Noch kein Leichtbau-Vorschlag berechnet".into());
    };
    Ok(topo_surface_of(mesh, d, threshold))
}

pub fn topo_stl_impl(state: &AppState, threshold: f64) -> Result<Vec<u8>, String> {
    let s = state.lock().unwrap();
    let (Some(mesh), Some(d)) = (&s.mesh, &s.topo) else {
        return Err("Noch kein Leichtbau-Vorschlag berechnet".into());
    };
    let (pts, tris) = fem_core::topopt::shape_surface(mesh, d, threshold, 3);
    let mut buf = Vec::new();
    fem_core::topopt::write_stl(&pts, &tris, &mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[tauri::command]
async fn topopt(state: tauri::State<'_, AppState>, setup: Setup, args: TopoArgs) -> Result<TopoView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || topopt_impl(&state, setup, args)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn topo_surface(state: tauri::State<'_, AppState>, threshold: f64) -> Result<TopoSurface, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || topo_surface_impl(&state, threshold)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn topo_stl(state: tauri::State<'_, AppState>, path: String, threshold: f64) -> Result<(), String> {
    let data = topo_stl_impl(state.inner(), threshold)?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

// --- 3D-Druck: Aufbaurichtung bewerten ----------------------------------------------------

/// Bewertet ~400 Aufbaurichtungen mit den Spannungen der letzten Rechnung (Festigkeit) und der Geometrie (Stützmaterial)
pub fn orientation_scan_impl(state: &AppState, material: Material) -> Result<Vec<fem_core::orientation::OrientationScore>, String> {
    let s = state.lock().unwrap();
    let mesh = s.mesh.as_ref().ok_or("Zuerst eine Geometrie öffnen")?;
    let stress: &[[f64; 6]] = s.results.as_ref().map(|r| r.stress.as_slice()).unwrap_or(&[]);
    // Achsrichtungen und die aktuelle Richtung exakt, dazu gleichmäßig verteilte Richtungen
    let mut dirs: Vec<[f64; 3]> = vec![[0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0]];
    if let Some(l) = &material.layers {
        dirs.insert(0, l.build_dir);
    }
    dirs.extend(fem_core::orientation::sphere_directions(400));
    Ok(fem_core::orientation::scan(mesh, &s.faces, &material, stress, &dirs))
}

#[tauri::command]
async fn orientation_scan(state: tauri::State<'_, AppState>, material: Material) -> Result<Vec<fem_core::orientation::OrientationScore>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || orientation_scan_impl(&state, material)).await.map_err(|e| e.to_string())?
}

// --- Schnitt -----------------------------------------------------------------------

#[derive(Serialize)]
pub struct SectionView {
    positions: Vec<f32>,
    triangles: Vec<u32>,
    displacement: Vec<f32>,
    /// Werte je Eckpunkt: von_mises, sigma1, sigma3, utilization, utilization_layers, utilization_infill, shell_fraction
    fields: HashMap<String, Vec<f32>>,
}

/// Schnitt durch das aktuelle Ergebnis mit der Ebene durch `point` mit Normale `normal`
pub fn section_impl(state: &AppState, point: [f64; 3], normal: [f64; 3]) -> Result<SectionView, String> {
    let s = state.lock().unwrap();
    let (Some(model), Some(res)) = (&s.model, &s.results) else {
        return Err("Noch kein Ergebnis vorhanden".into());
    };
    let s1: Vec<f64> = res.principal.iter().map(|p| p[0]).collect();
    let s3: Vec<f64> = res.principal.iter().map(|p| p[2]).collect();
    let mut names = vec!["von_mises", "sigma1", "sigma3"];
    let mut fields: Vec<&[f64]> = vec![&res.von_mises, &s1, &s3];
    for (name, f) in [
        ("utilization", &res.utilization),
        ("utilization_layers", &res.utilization_layers),
        ("utilization_infill", &res.utilization_infill),
        ("shell_fraction", &res.shell_fraction),
    ] {
        if let Some(f) = f {
            names.push(name);
            fields.push(f);
        }
    }
    let c = fem_core::section::cut(&model.mesh, point, normal, &fields, &res.displacement);
    Ok(SectionView {
        positions: c.positions.iter().map(|&v| v as f32).collect(),
        triangles: c.triangles,
        displacement: c.displacement.iter().map(|&v| v as f32).collect(),
        fields: names.into_iter().zip(c.values).map(|(n, v)| (n.to_string(), v.into_iter().map(|x| x as f32).collect())).collect(),
    })
}

#[tauri::command]
async fn section(state: tauri::State<'_, AppState>, point: [f64; 3], normal: [f64; 3]) -> Result<SectionView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || section_impl(&state, point, normal)).await.map_err(|e| e.to_string())?
}

/// Ergebnis als `.vtu` schreiben (Datei oder Download im Heimnetz)
pub fn write_vtu_impl(state: &AppState, w: &mut impl std::io::Write) -> Result<(), String> {
    let s = state.lock().unwrap();
    let (Some(model), Some(res)) = (&s.model, &s.results) else {
        return Err("Noch kein Ergebnis vorhanden".into());
    };
    fem_core::vtk::write_vtu(w, &model.mesh, res).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_vtu(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    write_vtu_impl(state.inner(), &mut std::io::BufWriter::new(file))
}

// --- Freigabe im Heimnetz ------------------------------------------------------------

#[derive(Default)]
struct ServerHandle(Mutex<Option<server::Running>>);

#[derive(Serialize)]
struct ServerStatus {
    running: bool,
    #[serde(flatten)]
    info: server::ServerInfo,
}

fn server_status_impl(handle: &ServerHandle) -> ServerStatus {
    ServerStatus { running: handle.0.lock().unwrap().is_some(), info: server::info(&server::ServerConfig::load()) }
}

#[tauri::command]
fn server_status(handle: tauri::State<'_, ServerHandle>) -> ServerStatus {
    server_status_impl(&handle)
}

#[tauri::command]
async fn server_start(handle: tauri::State<'_, ServerHandle>) -> Result<ServerStatus, String> {
    if handle.0.lock().unwrap().is_none() {
        let cfg = server::ServerConfig::load();
        cfg.save()?;
        let running = server::start(&cfg).await?;
        *handle.0.lock().unwrap() = Some(running);
    }
    Ok(server_status_impl(&handle))
}

#[tauri::command]
fn server_stop(handle: tauri::State<'_, ServerHandle>) -> ServerStatus {
    if let Some(r) = handle.0.lock().unwrap().take() {
        r.stop();
    }
    server_status_impl(&handle)
}

/// Einstellungen ändern: automatisch freigeben, neuer Schlüssel (alte Links werden ungültig)
#[tauri::command]
async fn server_configure(
    handle: tauri::State<'_, ServerHandle>,
    autostart: Option<bool>,
    new_key: Option<bool>,
) -> Result<ServerStatus, String> {
    let mut cfg = server::ServerConfig::load();
    if let Some(a) = autostart {
        cfg.autostart = a;
    }
    if new_key == Some(true) {
        cfg.key = server::new_key();
    }
    cfg.save()?;
    // laufenden Server mit neuem Schlüssel neu starten
    let running = handle.0.lock().unwrap().take();
    if let Some(r) = running {
        r.stop();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        *handle.0.lock().unwrap() = Some(server::start(&cfg).await?);
    }
    Ok(server_status_impl(&handle))
}

#[tauri::command]
fn save_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// Binärdatei schreiben (Inhalt Base64, z. B. PDF-Bericht)
#[tauri::command]
fn save_bytes(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
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
        .manage(ServerHandle::default())
        .setup(|app| {
            use tauri::{Emitter, Manager};
            // CAD-Schnittstelle: eingehende Teile an die Oberfläche melden, lokalen Empfang starten
            let h = app.handle().clone();
            cad::on_incoming(move |inc| {
                let _ = h.emit("cad-open", inc.clone());
            });
            tauri::async_runtime::spawn(async {
                if let Err(e) = cad::start_local().await {
                    eprintln!("{e}");
                }
            });
            if server::ServerConfig::load().autostart {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let cfg = server::ServerConfig::load();
                    match server::start(&cfg).await {
                        Ok(r) => *handle.state::<ServerHandle>().0.lock().unwrap() = Some(r),
                        Err(e) => eprintln!("Heimnetz-Freigabe: {e}"),
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gmsh_path,
            progress,
            startup_file,
            cad_set_summary,
            cad_info,
            onshape_set_keys,
            onshape_import,
            load_user_materials,
            save_user_materials,
            open_step,
            modify_geometry,
            copy_step,
            solve,
            section,
            orientation_scan,
            topopt,
            modes,
            frame_solve,
            topo_surface,
            topo_stl,
            export_vtu,
            save_text,
            save_bytes,
            load_text,
            server_status,
            server_start,
            server_stop,
            server_configure
        ])
        .run(tauri::generate_context!())
        .expect("Fehler beim Start von Projekt-FEM");
}
