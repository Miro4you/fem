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
pub mod solidcraft;
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
    let (slot, cancel) = {
        let s = state.lock().unwrap();
        (s.progress.clone(), s.cancel.clone())
    };
    // neuer langer Schritt: ein früheres „Abbrechen“ gilt nicht mehr
    cancel.store(false, std::sync::atomic::Ordering::Relaxed);
    let s2 = slot.clone();
    let p = fem_core::Progress::new(move |text, fraction| {
        *s2.lock().unwrap() = Some(ProgressView { text: text.to_string(), fraction });
    })
    .with_cancel(cancel);
    (p, slot)
}

/// Laufendes Vernetzen bzw. Rechnen abbrechen (Gmsh wird beendet, der Löser hört beim nächsten Durchgang auf)
pub fn cancel_impl(state: &AppState) {
    let flag = state.lock().map(|s| s.cancel.clone());
    if let Ok(f) = flag {
        f.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[tauri::command]
fn cancel(state: tauri::State<'_, AppState>) {
    cancel_impl(state.inner());
}

pub fn progress_impl(state: &AppState) -> Option<ProgressView> {
    let slot = state.lock().map(|s| s.progress.clone()).ok()?;
    let v = slot.lock().ok()?.clone();
    v
}

#[derive(Default)]
pub struct Inner {
    progress: ProgressSlot,
    /// Abbrechen angefordert (gilt für die laufende Aufgabe dieser Sitzung)
    cancel: Arc<std::sync::atomic::AtomicBool>,
    /// nur grobes Vorschau-Netz geladen (zum Ansehen und Lager/Lasten setzen, nicht zum Rechnen)
    preview: bool,
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
    /// Körper der Baugruppe, zu dem die Fläche gehört
    body: i32,
}

/// Körper einer Baugruppe (mehrere Volumen in der STEP-Datei)
#[derive(Serialize)]
struct BodyView {
    body: i32,
    name: String,
    volume: f64,
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
    /// Körper (nur bei Baugruppen mit mehreren Körpern)
    bodies: Vec<BodyView>,
    /// Schrauben: aus dem CAD erkannt (als Verbinder statt Körper) bzw. Vorschläge aus fluchtenden Bohrungen
    bolts: Vec<BoltView>,
    /// Körperpaare, die sich berühren (Körper A, Körper B, Fläche mm²) – wahlweise verklebt oder mit Kontakt
    touching: Vec<(i32, i32, f64)>,
    /// nur grobes Vorschau-Netz (vor dem Rechnen vernetzen)
    preview: bool,
}

#[derive(Serialize, Clone)]
struct BoltView {
    bolt: fem_core::bolt::Bolt,
    /// Festigkeitsklasse aus dem Namen
    class: Option<String>,
    /// „cad“ = Schraube aus dem CAD (Körper ersetzt), „bohrung“ = Vorschlag
    source: String,
    /// ersetzte Körper (Schraube, Scheiben, Mutter)
    parts: Vec<String>,
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
    let mut surf_body: HashMap<i32, i32> = HashMap::new();

    for f in faces {
        let tag = f.tag.unwrap_or(-1);
        surf_body.entry(tag).or_insert_with(|| mesh.body_of(f.elem));
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
            let body = surf_body.get(&tag).copied().unwrap_or(1);
            SurfaceInfo { tag, area, center: [c[0] / area, c[1] / area, c[2] / area], normal: planar.then_some(n), cylinder, body }
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
        bolts: vec![],
        touching: mesh.touching_bodies(),
        preview: false,
        bodies: {
            let ids = mesh.bodies();
            if ids.len() < 2 {
                vec![]
            } else {
                let mut vol: HashMap<i32, f64> = HashMap::new();
                for e in 0..mesh.n_elems() {
                    *vol.entry(mesh.body_of(e)).or_default() += fem_core::element::tet_volume(&mesh.elem_coords(e)[..4]).abs();
                }
                ids.into_iter().map(|b| BodyView { body: b, name: mesh.body_name(b), volume: vol.get(&b).copied().unwrap_or(0.0) }).collect()
            }
        },
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

// --- SolidCraft (Live-Verbindung) ---

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn solidcraft_status() -> Result<solidcraft::Status, String> {
    blocking(|| Ok(solidcraft::status())).await
}

#[tauri::command]
async fn solidcraft_live(on: bool) -> Result<solidcraft::Status, String> {
    blocking(move || Ok(solidcraft::set_live(on))).await
}

#[tauri::command]
fn solidcraft_auto(on: bool) {
    solidcraft::set_auto_result(on)
}

#[tauri::command]
async fn solidcraft_fetch() -> Result<cad::Incoming, String> {
    blocking(solidcraft::fetch_now).await
}

#[tauri::command]
async fn solidcraft_result(name: Option<String>) -> Result<String, String> {
    blocking(move || solidcraft::write_result(name.as_deref())).await
}

#[tauri::command]
async fn solidcraft_params() -> Result<Vec<solidcraft::Param>, String> {
    blocking(solidcraft::params).await
}

#[tauri::command]
fn solidcraft_pause(on: bool) {
    solidcraft::pause(on)
}

#[tauri::command]
async fn solidcraft_study(name: String, expression: String) -> Result<String, String> {
    blocking(move || solidcraft::study_value(&name, &expression)).await
}

/// Schraube von Hand an einer Bohrung (Liste der Bohrungen kommt aus der Oberfläche)
#[tauri::command]
fn bolt_at_hole(holes: Vec<fem_core::bolt::Hole>, pick: usize, d: Option<f64>, flip: bool) -> Result<fem_core::bolt::Bolt, String> {
    fem_core::bolt::bolt_at(&holes, pick, d, flip)
}

/// Spalte zwischen einander zugewandten ebenen Flächen (Schweißnaht-Vorschläge)
pub fn find_gaps_impl(state: &AppState, max_gap: f64) -> Result<Vec<fem_core::weld::GapCandidate>, String> {
    let s = state.lock().unwrap();
    let mesh = s.mesh.as_ref().ok_or("Zuerst eine Geometrie öffnen")?;
    Ok(fem_core::weld::find_gaps(mesh, &s.faces, max_gap.clamp(0.001, 50.0)))
}

#[tauri::command]
async fn find_gaps(state: tauri::State<'_, AppState>, max_gap: f64) -> Result<Vec<fem_core::weld::GapCandidate>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || find_gaps_impl(&state, max_gap)).await.map_err(|e| e.to_string())?
}

/// Angaben für den Dialog „CAD“: Schlüssel für die Lesezeichen, lokaler Port, Onshape eingerichtet?
#[tauri::command]
fn cad_info() -> serde_json::Value {
    serde_json::json!({
        "key": server::ServerConfig::load_saved().key,
        "localPort": cad::LOCAL_PORT,
        "onshape": onshape::configured(),
        "onshapeUsage": onshape::usage(),
    })
}

#[tauri::command]
fn onshape_set_keys(access: String, secret: String) -> Result<bool, String> {
    onshape::save_keys(&access, &secret)?;
    Ok(onshape::configured())
}

#[tauri::command]
async fn onshape_variables(url: String) -> Result<Vec<onshape::Variable>, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::variables(&url)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn onshape_set_variable(url: String, name: String, expression: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || onshape::set_variable(&url, &name, &expression)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn onshape_study(url: String, name: String, expression: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::study_value(&url, &name, &expression)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn onshape_import(url: String) -> Result<cad::Incoming, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::import(&url)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn onshape_documents(q: String, fresh: Option<bool>) -> Result<Vec<onshape::Document>, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::documents(&q, fresh.unwrap_or(false))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn onshape_elements(did: String, wid: String) -> Result<Vec<onshape::Element>, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::elements(&did, &wid)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn onshape_thumbnail(href: Option<String>, did: String, wid: String, eid: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::thumbnail(href.as_deref(), &did, &wid, &eid)).await.map_err(|e| e.to_string())?
}

/// Ergebniswerte in die Beschreibung der Teile des Onshape-Teilestudios schreiben → kurzer Text
#[tauri::command]
async fn onshape_write_result(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || onshape::write_result(&url).map(|(name, text, n)| format!("„{name}“: {text} ({n} Teil{})", if n == 1 { "" } else { "e" })))
        .await
        .map_err(|e| e.to_string())?
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
    keep_fasteners: Option<bool>,
    preview: Option<bool>,
) -> Result<MeshView, String> {
    let refine = refine.unwrap_or_default();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        open_step_full(&state, &path, size, linear == Some(true), &refine, keep_fasteners == Some(true), preview == Some(true))
    })
        .await
        .map_err(|e| e.to_string())?
}

/// STEP öffnen und vernetzen (auch für Tests ohne Oberfläche nutzbar).
pub fn open_step_impl(state: &AppState, path: &str, size: Option<f64>, linear: bool, refine: &[Refine]) -> Result<MeshView, String> {
    open_step_with(state, path, size, linear, refine, false)
}

/// Mehrere Volumenkörper in der STEP-Datei?
fn several_solids(path: &str) -> bool {
    std::fs::read_to_string(path).map(|t| t.matches("MANIFOLD_SOLID_BREP").count() + t.matches("BREP_WITH_VOIDS").count() >= 2).unwrap_or(false)
}

/// STEP öffnen; bei Baugruppen Schrauben/Muttern/Scheiben erkennen und (wenn `keep_fasteners` aus) als Verbinder
/// statt als Körper rechnen
pub fn open_step_with(state: &AppState, path: &str, size: Option<f64>, linear: bool, refine: &[Refine], keep_fasteners: bool) -> Result<MeshView, String> {
    open_step_full(state, path, size, linear, refine, keep_fasteners, false)
}

/// STEP öffnen und vernetzen. `preview`: nur grobes Netz mit linearen Elementen (schnell; zum Ansehen und Einrichten,
/// vor dem Rechnen richtig vernetzen)
pub fn open_step_full(
    state: &AppState,
    path: &str,
    size: Option<f64>,
    linear: bool,
    refine: &[Refine],
    keep_fasteners: bool,
    preview: bool,
) -> Result<MeshView, String> {
    {
        let (progress, slot) = progress_for(state);
        let done = |r: Result<MeshView, String>| {
            *slot.lock().unwrap() = None;
            r
        };
        let mut found: Vec<fem_core::fastener::Detected> = Vec::new();
        if several_solids(path) {
            progress.report("Baugruppe prüfen: Schrauben suchen", None);
            match gmsh::inspect_step_with(&PathBuf::from(path), &progress) {
                Ok(solids) => found = fem_core::fastener::detect(&solids),
                Err(fem_core::FemError::Cancelled) => return done(Err("Abgebrochen".into())),
                Err(_) => {}
            }
        }
        let opts = MeshOptions {
            size,
            order: if linear || preview { Order::Linear } else { Order::Quadratic },
            curvature_points: if preview { 6 } else { 16 },
            refine: if preview { vec![] } else { refine.to_vec() },
            exclude: if keep_fasteners { vec![] } else { found.iter().flat_map(|d| d.volumes.clone()).collect() },
        };
        progress.report(
            if preview {
                "Vorschau vernetzen (grob)"
            } else if refine.is_empty() {
                "Vernetzen (Gmsh)"
            } else {
                "Vernetzen mit örtlicher Verfeinerung (Gmsh)"
            },
            Some(0.0),
        );
        let mesh = match gmsh::mesh_step_with(&PathBuf::from(path), &opts, &progress) {
            Ok(m) => m,
            Err(fem_core::FemError::Cancelled) => return done(Err("Abgebrochen".into())),
            Err(e) => return done(Err(e.to_string())),
        };
        let (lo, hi) = mesh.bbox();
        let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
        let faces = mesh.boundary_faces();
        let (mut view, disp_nodes) = build_view(&mesh, &faces, size.unwrap_or(diag / 25.0));
        // Schrauben aus dem CAD und Vorschläge aus Bohrungen (nur Baugruppen)
        if !keep_fasteners {
            view.bolts = found
                .iter()
                .map(|d| BoltView { bolt: d.bolt.clone(), class: d.class.clone(), source: "cad".into(), parts: d.parts.clone() })
                .collect();
        }
        if mesh.bodies().len() > 1 {
            let holes: Vec<fem_core::bolt::Hole> =
                view.surfaces.iter().filter_map(|x| x.cylinder.clone().map(|cyl| fem_core::bolt::Hole { body: x.body, cyl })).collect();
            let existing: Vec<fem_core::bolt::Bolt> = view.bolts.iter().map(|b| b.bolt.clone()).collect();
            for (i, b) in fem_core::bolt::suggest(&holes, &existing).into_iter().enumerate() {
                let mut b = b;
                b.name = format!("Bohrung {} (M{})", i + 1, b.d);
                view.bolts.push(BoltView { bolt: b, class: None, source: "bohrung".into(), parts: vec![] });
            }
        }
        view.preview = preview;
        *slot.lock().unwrap() = None;
        let mut s = state.lock().unwrap();
        let cancel = s.cancel.clone();
        *s = Inner { progress: slot, cancel, preview, topo: None, mesh: Some(mesh), faces, disp_nodes, model: None, results: None };
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

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct BodyMaterial {
    body: i32,
    material: Material,
}

/// Schweißnaht: Fläche A wird über den Spalt an Fläche B gekoppelt
#[derive(Deserialize)]
struct WeldDef {
    /// Anzeigename (z. B. „Naht 2“, „Verbindung 1“)
    #[serde(default)]
    name: Option<String>,
    a: Vec<i32>,
    b: Vec<i32>,
    /// a-Maß [mm]; leer = durchgeschweißte Stumpfnaht
    #[serde(default)]
    throat: Option<f64>,
    /// größter Spalt [mm]; leer = automatisch
    #[serde(default)]
    max_gap: Option<f64>,
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
    /// Schweißnähte (Bleche mit Spalt an den Ecken, getrennte Teile)
    #[serde(default)]
    welds: Vec<WeldDef>,
    /// Baugruppe: eigener Werkstoff je Körper
    #[serde(default)]
    bodies: Vec<BodyMaterial>,
    /// Schrauben als Verbindungselemente
    #[serde(default)]
    bolts: Vec<fem_core::bolt::Bolt>,
    /// Fugen zwischen verschraubten Teilen mit Kontakt (Druck ja, Zug nein, Reibung); sonst verklebt
    #[serde(default = "yes")]
    open_joints: bool,
    /// Reibung in den Fugen (Standard: haftend)
    #[serde(default)]
    joint_friction: fem_core::contact::Friction,
    /// Körperpaare mit Kontakt statt verklebt (unabhängig von Schrauben)
    #[serde(default)]
    contacts: Vec<[i32; 2]>,
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
    /// Schweißnähte: übertragene Kraft, Linienkraft, Nahtspannung
    welds: Vec<fem_core::weld::WeldResult>,
    /// Baugruppe: Kennwerte je Körper und Kräfte zwischen den Körpern
    bodies: Vec<fem_core::results::BodyResult>,
    /// Schraubenkräfte
    bolts: Vec<fem_core::bolt::BoltResult>,
    /// Kontakt in den Fugen verschraubter Teile
    joints: Vec<fem_core::contact::JointResult>,
    /// Rechendurchgänge für Kontakt und Reibung
    contact_passes: usize,
    /// je Anzeigeknoten: 1 = Krafteinleitung einer Schraube (Farbskala ohne diese Spitzen)
    bolt_zone: Option<Vec<u8>>,
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
        if s.preview {
            return Err("Nur ein grobes Vorschau-Netz ist geladen – erst unter „Netz“ vernetzen, dann rechnen.".into());
        }
        (mesh, s.faces.clone(), s.disp_nodes.clone())
    };
    if setup.supports.is_empty() {
        return Err("Mindestens ein Lager festlegen".to_string());
    }
    let (progress, slot) = progress_for(state);
    let mut model = Model::new(mesh, setup.material.clone()).solver(setup.solver).progress(progress);
    model.body_materials = setup.bodies.iter().map(|b| (b.body, b.material.clone())).collect();
    model.bolts = setup.bolts.clone();
    if setup.open_joints && !model.bolts.is_empty() {
        model.joint_pairs = fem_core::bolt::open_joints(&mut model).map_err(|e| e.to_string())?;
    }
    // gewählte Berührflächen mit Kontakt (schon durch Schrauben geöffnete Fugen bleiben, wie sie sind)
    for &[a, b] in &setup.contacts {
        let pairs = model.mesh.split_bodies(a.min(b), a.max(b));
        model.joint_pairs.extend(pairs);
    }
    if !model.joint_pairs.is_empty() {
        model.joint_friction = setup.joint_friction;
    }
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
        for (i, w) in setup.welds.iter().enumerate() {
            let name = w.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("Naht {}", i + 1));
            let (ga, gb) = (format!("{name} A"), format!("{name} B"));
            model = model.group(&ga, Selection::Surfaces(w.a.clone())).group(&gb, Selection::Surfaces(w.b.clone()));
            model.welds.push(fem_core::weld::Weld { name, a: ga, b: gb, max_gap: w.max_gap, throat: w.throat.filter(|t| *t > 0.0) });
        }
    Ok((model, faces, disp_nodes, slot))
}

pub fn solve_impl(state: &AppState, setup: Setup) -> Result<ResultView, String> {
    {
        let t0 = Instant::now();
        let (model, faces, disp_nodes, slot) = build_model(state, &setup)?;
        let res = fem_core::solve(&model);
        *slot.lock().unwrap() = None;
        let res = res.map_err(|e| match e {
            fem_core::FemError::Underconstrained if setup.welds.is_empty() => format!(
                "{e}. Bei Blechen mit Spalt an den Ecken oder losen Teilen einer Baugruppe: Verbindungen anlegen \
                 (Studienbaum → Verbindungen → „Spalte suchen“, als Naht oder „flächig verbunden“)."
            ),
            e => e.to_string(),
        })?;
        let m = &model.mesh;

        let mut warnings = Vec::new();
        // Kontakt in den Fugen: Hinweise, wenn die Iteration nicht zur Ruhe kam oder die Fuge klafft bzw. rutscht
        if !res.joints.is_empty() && !res.contact_converged {
            warnings.push(format!(
                "Kontakt und Reibung in der Fuge haben sich nach {} Durchgängen noch nicht ganz eingependelt – Ergebnis mit Vorsicht \
                 betrachten (feineres Netz oder Reibung „haftend“ probieren).",
                res.contact_passes
            ));
        }
        let name = |b: i32| model.mesh.body_name(b);
        for j in &res.joints {
            let has_preload = res.bolts.iter().any(|b| b.preload > 0.0);
            if j.closed < 0.05 {
                let why = if has_preload {
                    " Die Last ist größer, als die Vorspannung zusammenhalten kann."
                } else if !res.bolts.is_empty() {
                    " Ohne Vorspannung hebt die Fuge schon bei kleiner Last ab."
                } else {
                    ""
                };
                warnings.push(format!(
                    "Die Teile {} und {} liegen nicht mehr aufeinander (Fuge ganz offen).{why}",
                    name(j.body_a),
                    name(j.body_b)
                ));
            } else if let Some(c0) = j.closed_preload.filter(|c0| j.closed < 0.5 * c0) {
                warnings.push(format!(
                    "Die Last öffnet die Fuge {} ↔ {}: nach dem Anziehen lagen {:.0} % der Fläche auf, unter Last noch {:.0} % (Restklemmkraft {:.1} kN).",
                    name(j.body_a),
                    name(j.body_b),
                    100.0 * c0,
                    100.0 * j.closed,
                    j.pressure_force / 1000.0
                ));
            }
            if let Some(lim) = j.friction_limit.filter(|l| *l > 0.0 && j.friction_force >= 0.95 * l) {
                warnings.push(format!(
                    "Die Fuge {} ↔ {} rutscht durch: der Reibschluss µ·F_K = {:.1} kN reicht nicht, den Rest der Querkraft tragen die Schrauben auf Abscherung.",
                    name(j.body_a),
                    name(j.body_b),
                    lim / 1000.0
                ));
            }
        }
        // Teil hängt nur über Kontakt und hat sich gelöst: riesige Verschiebung (nur die Stabilisierungsfedern halten)
        if !res.joints.is_empty() {
            let (lo, hi) = m.bbox();
            let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
            if res.max_displacement().1 > 0.05 * diag {
                warnings.push(
                    "Ein Teil hält nur über Kontakt und hat sich gelöst (sehr große Verschiebung) – das Ergebnis gilt so nicht. \
                     Lager, Schraube oder Reibung ergänzen bzw. die Berührfläche auf „verklebt“ stellen."
                        .into(),
                );
            }
        }
        if res.joints.is_empty() && res.bolts.iter().any(|b| b.axial < 0.0) {
            warnings.push(
                "Mindestens eine Schraube wird auf Druck belastet – mit „Fuge verklebt“ trägt sie Last, die eigentlich über die Fuge geht."
                    .into(),
            );
        }
        // Höchstwert für Anzeige und Nachweis ohne die Krafteinleitung der Schrauben (dort Nachweis nach VDI 2230)
        let (vm_node, vm) = res.max_von_mises_rated();
        let (_, vm_all) = res.max_von_mises();
        if vm_all > vm * 1.05 && !res.bolt_zone.is_empty() {
            warnings.push(format!(
                "An den Schraubenauflagen und im Gewinde gibt es örtliche Spannungsspitzen bis {vm_all:.0} MPa (Kraft wird dort über die Schraube \
                 als Ersatzelement eingeleitet). Sie zählen nicht zum Nachweis; dort gelten Flächenpressung unter Kopf/Mutter und Einschraubtiefe \
                 nach VDI 2230 (Tabelle bei den Schrauben)."
            ));
        }
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
        // Baugruppe: kleinste Sicherheit der Körper (jeder mit seinem Werkstoff)
        let safety = match res.bodies.iter().filter_map(|b| b.safety).reduce(f64::min) {
            Some(s) if res.bodies.len() > 1 => Some(s),
            _ => res.safety_factor(&model.material),
        };
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
        for w in &res.welds {
            if w.unmatched > 0 {
                warnings.push(format!(
                    "{}: {} Knoten der Fläche A haben keine Gegenfläche im Spalt (bis {:.2} mm) – dort ist nicht geschweißt. \
                     Bei Bedarf „Spalt bis“ vergrößern.",
                    w.name, w.unmatched, w.gap_max
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
            welds: res.welds.clone(),
            bodies: res.bodies.clone(),
            bolts: res.bolts.clone(),
            joints: res.joints.clone(),
            contact_passes: res.contact_passes,
            bolt_zone: (!res.bolt_zone.is_empty()).then(|| disp_nodes.iter().map(|&n| res.bolt_zone[n] as u8).collect()),
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
            cancel,
            startup_file,
            cad_set_summary,
            cad_info,
            find_gaps,
            bolt_at_hole,
            solidcraft_status,
            solidcraft_live,
            solidcraft_auto,
            solidcraft_fetch,
            solidcraft_result,
            solidcraft_params,
            solidcraft_pause,
            solidcraft_study,
            onshape_set_keys,
            onshape_import,
            onshape_variables,
            onshape_set_variable,
            onshape_study,
            onshape_documents,
            onshape_elements,
            onshape_thumbnail,
            onshape_write_result,
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

#[cfg(test)]
mod tests {
    /// Schrauben von Hand: zwei Platten mit Bohrungen Ø9,6 (keine Normbohrung → kein Vorschlag), Schrauben an beiden
    /// Bohrungen anlegen und vorgespannt mit Kontakt rechnen
    #[test]
    fn schraube_von_hand_an_bohrung() {
        if fem_core::gmsh::find_gmsh().is_none() {
            eprintln!("Gmsh fehlt – Test übersprungen");
            return;
        }
        let step = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/geometrie/flansch.step");
        let state = super::AppState::default();
        let view = super::open_step_with(&state, step.to_str().unwrap(), Some(4.0), false, &[], false).unwrap();
        let v = serde_json::to_value(&view).unwrap();
        assert_eq!(v["bolts"].as_array().unwrap().len(), 0, "Ø9,6 ist keine Normbohrung – kein Vorschlag");
        assert_eq!(v["touching"].as_array().unwrap().len(), 1);
        let surfaces = v["surfaces"].as_array().unwrap();
        let holes: Vec<fem_core::bolt::Hole> = surfaces
            .iter()
            .filter(|s| !s["cylinder"].is_null())
            .map(|s| serde_json::from_value(serde_json::json!({ "body": s["body"], "cyl": s["cylinder"] })).unwrap())
            .collect();
        assert_eq!(holes.len(), 4, "je Platte zwei Bohrungen");
        // beide Bohrungen der unteren Platte anklicken
        let mut bolts = Vec::new();
        for (i, h) in holes.iter().enumerate() {
            if h.body != holes[0].body {
                continue;
            }
            let b = fem_core::bolt::bolt_at(&holes, i, None, false).unwrap();
            // M8 (Ø9,6 ≈ 1,1·d … nächste Normgröße), Kopf oben (z = 18), Mutter unten (z = 0)
            assert_eq!(b.d, 8.0);
            let z = |t: f64| b.origin[2] + b.axis[2] * t;
            assert!((z(b.head_t) - 18.0).abs() < 0.05 && (z(b.nut_t.unwrap())).abs() < 0.05, "{b:?}");
            let flipped = fem_core::bolt::bolt_at(&holes, i, None, true).unwrap();
            assert!((flipped.origin[2] + flipped.axis[2] * flipped.head_t).abs() < 0.05, "umgedreht: Kopf unten");
            bolts.push(b);
        }
        assert_eq!(bolts.len(), 2);
        let tag = |nz: f64, z: f64| {
            surfaces
                .iter()
                .find(|s| s["normal"][2].as_f64().is_some_and(|n| (n - nz).abs() < 1e-6) && (s["center"][2].as_f64().unwrap() - z).abs() < 1e-6)
                .map(|s| s["tag"].as_i64().unwrap())
                .unwrap()
        };
        let bolts_json: Vec<serde_json::Value> = bolts
            .iter()
            .enumerate()
            .map(|(i, b)| {
                let mut j = serde_json::to_value(b).unwrap();
                j["name"] = format!("Schraube {}", i + 1).into();
                j["rp"] = 640.0.into();
                j["rm"] = 800.0.into();
                j["tighten"] = serde_json::json!({ "art": "ausnutzung", "nu": 0.9, "mu_g": 0.12, "mu_k": 0.12 });
                j
            })
            .collect();
        let setup = serde_json::json!({
            "material": { "name": "S235JR", "E": 210000.0, "nu": 0.3, "yield": 235.0, "tensile": 360.0 },
            "supports": [{ "surfaces": [tag(-1.0, 0.0)], "fix": { "x": 0.0, "y": 0.0, "z": 0.0 } }],
            "loads": [{ "type": "force", "surfaces": [tag(1.0, 18.0)], "force": [0.0, 0.0, 5000.0] }],
            "bolts": bolts_json,
            "open_joints": true,
            "joint_friction": { "art": "coulomb", "mu": 0.15 },
        });
        let res = super::solve_impl(&state, serde_json::from_value(setup).unwrap()).unwrap();
        let r = serde_json::to_value(&res).unwrap();
        let rb = r["bolts"].as_array().unwrap();
        assert_eq!(rb.len(), 2);
        // M8 8.8 nach VDI 2230 (90 %, µ 0,12): F_V ≈ 18,6 kN. Die Last greift nahe der Trennfuge an (Mutter auf der
        // festen Unterseite) – sie entlastet vor allem die Fuge, die Schraubenkraft ändert sich kaum
        let mut sum = 0.0;
        for b in rb {
            let (fv, fs) = (b["preload"].as_f64().unwrap(), b["axial"].as_f64().unwrap());
            assert!((fv - 18620.0).abs() < 100.0 && (fs - fv).abs() < 2500.0, "{b}");
            sum += fs;
        }
        // angezeigtes σv max gehört zum Nachweis (ohne örtliche Spitzen an der Krafteinleitung): S = Re / σv
        let (vm, sf) = (r["max_von_mises"]["value"].as_f64().unwrap(), r["safety"].as_f64().unwrap());
        assert!((vm * sf - 235.0).abs() < 0.5, "σv {vm} · S {sf} ≠ Re");
        let j = &r["joints"].as_array().unwrap()[0];
        assert!((sum - 5000.0 - j["pressure_force"].as_f64().unwrap()).abs() < 1e-3 * sum, "Σ F_S = F_A + Restklemmkraft: {j}");
        assert!(!r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("eingependelt")), "{}", r["warnings"]);
    }
}
