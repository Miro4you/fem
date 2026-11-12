//! Webserver fürs Heimnetz: liefert die Oberfläche an andere Rechner (Browser) aus,
//! gerechnet wird auf dem Rechner, auf dem der Server läuft.
//!
//! Zugriff nur mit Zugangsschlüssel (Kopfzeile `X-FEM-Key`); jede Browser-Sitzung hat ihr eigenes Modell.

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_embed::Embed;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::{
    cad_build_impl, orientation_scan_impl, progress_impl, section_impl, solve_impl, topo_stl_impl, topo_surface_impl,
    topopt_impl, write_vtu_impl, AppState, Setup, TopoArgs, modes_impl,
};
use fem_core::gmsh::Refine;

pub const DEFAULT_PORT: u16 = 8790;
/// Höchstens so viele gleichzeitige Browser-Sitzungen (älteste fliegt raus)
const MAX_SESSIONS: usize = 6;

/// Gebaute Oberfläche (`npm run build` → app/dist), in das Programm eingebettet
#[derive(Embed)]
#[folder = "../dist"]
struct Assets;

/// Gespeicherte Einstellungen (Port und Schlüssel bleiben gleich, damit Lesezeichen gültig bleiben)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub port: u16,
    pub key: String,
    /// Beim Start der Desktop-App automatisch freigeben
    #[serde(default)]
    pub autostart: bool,
}

/// Konfigurationsordner von Projekt-FEM (~/.config/projekt-fem)
pub fn config_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))?;
    Some(base.join("projekt-fem"))
}

fn config_path() -> Option<PathBuf> {
    Some(config_dir()?.join("server.json"))
}

impl ServerConfig {
    pub fn load() -> ServerConfig {
        config_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| ServerConfig { port: DEFAULT_PORT, key: new_key(), autostart: false })
    }

    /// wie `load`, legt die Datei aber an, falls es sie noch nicht gibt (Schlüssel bleibt dann gleich)
    pub fn load_saved() -> ServerConfig {
        let cfg = ServerConfig::load();
        if config_path().is_some_and(|p| !p.exists()) {
            let _ = cfg.save();
        }
        cfg
    }

    pub fn save(&self) -> Result<(), String> {
        let p = config_path().ok_or("Kein Konfigurationsordner gefunden")?;
        std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&p, serde_json::to_string_pretty(self).unwrap()).map_err(|e| e.to_string())
    }
}

/// Zufälliger Schlüssel, 16 Zeichen aus Kleinbuchstaben und Ziffern (ohne verwechselbare Zeichen)
pub fn new_key() -> String {
    const CHARS: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("Zufallszahlen");
    buf.iter().map(|b| CHARS[*b as usize % CHARS.len()] as char).collect()
}

/// Adressen, unter denen der Server im Heimnetz erreichbar ist
#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub port: u16,
    pub key: String,
    pub autostart: bool,
    /// fertige Links inkl. Schlüssel
    pub urls: Vec<String>,
}

pub fn info(cfg: &ServerConfig) -> ServerInfo {
    let mut hosts = Vec::new();
    // eigene Adresse im lokalen Netz (es wird dabei nichts gesendet)
    if let Some(ip) = UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("192.168.0.1:9").map(|_| s))
        .and_then(|s| s.local_addr())
        .ok()
        .map(|a| a.ip())
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
    {
        hosts.push(ip.to_string());
    }
    if let Some(h) = hostname() {
        hosts.push(format!("{h}.local"));
    }
    hosts.push("localhost".into());
    ServerInfo {
        port: cfg.port,
        key: cfg.key.clone(),
        autostart: cfg.autostart,
        urls: hosts.iter().map(|h| format!("http://{h}:{}/#k={}", cfg.port, cfg.key)).collect(),
    }
}

fn hostname() -> Option<String> {
    let h = std::fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| std::process::Command::new("hostname").arg("-s").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()))?;
    let h = h.trim().split('.').next()?.to_string();
    (!h.is_empty()).then_some(h)
}

// --- Laufender Server ----------------------------------------------------------

#[derive(Clone)]
struct Shared {
    key: String,
    sessions: Arc<Mutex<HashMap<String, (AppState, Instant)>>>,
    uploads: PathBuf,
}

impl Shared {
    fn session(&self, headers: &HeaderMap) -> AppState {
        let id = headers.get("x-fem-session").and_then(|v| v.to_str().ok()).unwrap_or("standard").to_string();
        let mut s = self.sessions.lock().unwrap();
        if !s.contains_key(&id) && s.len() >= MAX_SESSIONS {
            if let Some(oldest) = s.iter().min_by_key(|(_, (_, t))| *t).map(|(k, _)| k.clone()) {
                s.remove(&oldest);
            }
        }
        let e = s.entry(id).or_insert_with(|| (AppState::default(), Instant::now()));
        e.1 = Instant::now();
        e.0.clone()
    }
}

pub struct Running {
    stop: oneshot::Sender<()>,
}

impl Running {
    pub fn stop(self) {
        let _ = self.stop.send(());
    }
}

fn router(shared: Shared) -> Router {
    let api = Router::new()
        .route("/gmsh", get(api_gmsh))
        .route("/cad/open", post(crate::cad::http_open))
        .route("/cad/summary", get(crate::cad::http_summary).post(crate::cad::http_set_summary))
        .route("/cad/inbox", get(crate::cad::http_inbox))
        .route("/cad/onshape", get(crate::cad::http_onshape))
        .route("/cad/onshape_result", get(crate::cad::http_onshape_result))
        .route("/draftpad/status", get(dp_status))
        .route("/draftpad/config", post(dp_config))
        .route("/draftpad/list", post(dp_list))
        .route("/draftpad/get", post(dp_get))
        .route("/draftpad/meta", post(dp_meta))
        .route("/onshape/status", get(crate::cad::http_onshape_status))
        .route("/onshape/keys", post(crate::cad::http_onshape_keys))
        .route("/onshape/import", post(crate::cad::http_onshape_import))
        .route("/onshape/variables", post(os_variables))
        .route("/onshape/set_variable", post(os_set_variable))
        .route("/onshape/study", post(os_study))
        .route("/onshape/documents", post(os_documents))
        .route("/onshape/elements", post(os_elements))
        .route("/onshape/thumbnail", post(os_thumbnail))
        .route("/onshape/write_result", post(os_write_result))
        .route("/materials", get(api_materials_get).post(api_materials_set))
        .route("/progress", get(api_progress))
        .route("/cancel", post(api_cancel))
        .route("/upload", post(api_upload))
        .route("/file", get(api_file))
        .route("/open_step", post(api_open_step))
        .route("/cad_build", post(api_cad_build))
        .route("/solve", post(api_solve))
        .route("/section", post(api_section))
        .route("/find_gaps", post(api_find_gaps))
        .route("/bolt_at_hole", post(api_bolt_at_hole))
        .route("/solidcraft/status", get(sc_status))
        .route("/solidcraft/live", post(sc_live))
        .route("/solidcraft/auto", post(sc_auto))
        .route("/solidcraft/fetch", post(sc_fetch))
        .route("/solidcraft/result", post(sc_result))
        .route("/solidcraft/params", get(sc_params))
        .route("/solidcraft/pause", post(sc_pause))
        .route("/solidcraft/study", post(sc_study))
        .route("/orientation_scan", post(api_orientation_scan))
        .route("/topopt", post(api_topopt))
        .route("/modes", post(api_modes))
        .route("/frame_solve", post(api_frame_solve))
        .route("/topo_surface", post(api_topo_surface))
        .route("/topo_stl", get(api_topo_stl))
        .route("/vtu", get(api_vtu))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(shared.clone(), check_key));
    Router::new()
        .nest("/api", api)
        .fallback(get(static_file))
        .layer(tower_http::compression::CompressionLayer::new())
        .with_state(shared)
}

/// Startet den Server (im laufenden Tokio-Laufzeitsystem). Fehler, wenn der Port belegt ist.
pub async fn start(cfg: &ServerConfig) -> Result<Running, String> {
    let uploads = std::env::temp_dir().join("projekt-fem-uploads");
    std::fs::create_dir_all(&uploads).map_err(|e| e.to_string())?;
    let shared = Shared { key: cfg.key.clone(), sessions: Default::default(), uploads };
    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Port {} lässt sich nicht öffnen: {e}", cfg.port))?;
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(shared))
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(Running { stop: tx })
}

// --- Anfragen -------------------------------------------------------------------

type ApiResult<T> = Result<T, (StatusCode, String)>;

fn bad(e: impl ToString) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, e.to_string())
}

async fn check_key(
    State(s): State<Shared>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let ok = without_key()
        || req.headers().get("x-fem-key").and_then(|v| v.to_str().ok()) == Some(s.key.as_str())
        || crate::cad::query_key(req.uri().query()).as_deref() == Some(s.key.as_str());
    if !ok {
        return (StatusCode::UNAUTHORIZED, "Zugangsschlüssel fehlt oder ist falsch").into_response();
    }
    next.run(req).await
}

async fn api_cancel(State(s): State<Shared>, headers: HeaderMap) -> Json<bool> {
    crate::cancel_impl(&s.session(&headers));
    Json(true)
}

async fn api_progress(State(s): State<Shared>, headers: HeaderMap) -> Json<Option<crate::ProgressView>> {
    Json(progress_impl(&s.session(&headers)))
}

async fn api_materials_get() -> ApiResult<Json<serde_json::Value>> {
    crate::user_materials_load().map(Json).map_err(bad)
}

async fn api_materials_set(Json(v): Json<serde_json::Value>) -> ApiResult<Json<bool>> {
    crate::user_materials_save(&v).map(|_| Json(true)).map_err(bad)
}

async fn api_gmsh() -> Json<Option<String>> {
    Json(fem_core::gmsh::find_gmsh().map(|p| p.display().to_string()))
}

#[derive(Deserialize)]
struct UploadQuery {
    name: String,
}

/// STEP-Datei vom Browser entgegennehmen; Antwort: Pfad auf diesem Rechner
async fn api_upload(State(s): State<Shared>, Query(q): Query<UploadQuery>, body: Bytes) -> ApiResult<Json<String>> {
    let name: String = Path::new(&q.name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("geometrie.step")
        .chars()
        .map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    if !is_step(Path::new(&name)) {
        return Err(bad("Nur STEP-Dateien (.step, .stp)"));
    }
    // eigener Unterordner je Upload, damit der Dateiname erhalten bleibt
    let dir = s.uploads.join(new_key());
    std::fs::create_dir_all(&dir).map_err(bad)?;
    let path = dir.join(name);
    std::fs::write(&path, &body).map_err(bad)?;
    Ok(Json(path.display().to_string()))
}

/// Heimnetz ohne Zugangsschlüssel (`PROJEKT_FEM_OHNE_SCHLUESSEL=1`): jeder, der den Server erreicht, darf rechnen.
/// Nur für ein abgeschottetes Heimnetz gedacht – nie mit Portfreigabe ins Internet.
pub fn without_key() -> bool {
    std::env::var("PROJEKT_FEM_OHNE_SCHLUESSEL").is_ok_and(|v| !v.is_empty() && v != "0")
}

/// Öffentlicher Betrieb (Server im Internet, `PROJEKT_FEM_OEFFENTLICH=1`): nur Dateien, die Projekt-FEM selbst
/// angelegt hat (Hochgeladenes, CAD-Eingang, geänderte Geometrie im Temp-Ordner) – keine beliebigen Pfade des Servers.
pub fn public_mode() -> bool {
    std::env::var("PROJEKT_FEM_OEFFENTLICH").is_ok_and(|v| !v.is_empty() && v != "0")
}

fn path_allowed(p: &str) -> bool {
    if !public_mode() {
        return true;
    }
    let Ok(p) = Path::new(p).canonicalize() else { return false };
    let mut roots = vec![std::env::temp_dir()];
    if let Some(c) = config_dir() {
        roots.push(c);
    }
    roots.iter().filter_map(|r| r.canonicalize().ok()).any(|r| p.starts_with(r))
}

fn is_step(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("step") || e.eq_ignore_ascii_case("stp"))
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

/// STEP-Datei zurückgeben (zum Einbetten ins Projekt beim Speichern im Browser)
async fn api_file(Query(q): Query<FileQuery>) -> ApiResult<Response> {
    let p = PathBuf::from(&q.path);
    if !is_step(&p) || !path_allowed(&q.path) {
        return Err(bad("Nur STEP-Dateien"));
    }
    let data = tokio::fs::read(&p).await.map_err(bad)?;
    Ok(([(header::CONTENT_TYPE, "application/step")], data).into_response())
}

#[derive(Deserialize)]
struct OpenStep {
    path: String,
    size: Option<f64>,
    linear: Option<bool>,
    #[serde(default)]
    refine: Vec<Refine>,
    #[serde(default)]
    keep_fasteners: bool,
    #[serde(default)]
    preview: bool,
}

async fn api_open_step(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<OpenStep>) -> ApiResult<Response> {
    if !is_step(Path::new(&a.path)) {
        return Err(bad("Nur STEP-Dateien (.step, .stp)"));
    }
    if !path_allowed(&a.path) {
        return Err(bad("Datei nicht gefunden – bitte neu hochladen"));
    }
    let state = s.session(&headers);
    let view = tokio::task::spawn_blocking(move || crate::open_step_full(&state, &a.path, a.size, a.linear == Some(true), &a.refine, a.keep_fasteners, a.preview))
        .await
        .map_err(bad)?
        .map_err(bad)?;
    Ok(Json(view).into_response())
}

async fn api_cad_build(Json(a): Json<crate::CadArgs>) -> ApiResult<Response> {
    if let Some(b) = &a.base {
        if !is_step(Path::new(b)) || !path_allowed(b) {
            return Err(bad("Nur STEP-Dateien (.step, .stp)"));
        }
    }
    let v = tokio::task::spawn_blocking(move || cad_build_impl(a)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(v).into_response())
}

#[derive(Deserialize)]
struct SolveArgs {
    setup: Setup,
}

async fn api_solve(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<SolveArgs>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let view = tokio::task::spawn_blocking(move || solve_impl(&state, a.setup)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(view).into_response())
}

#[derive(Deserialize)]
struct SectionArgs {
    point: [f64; 3],
    normal: [f64; 3],
}

// --- Onshape-Variablen (Parameterstudie) ---

#[derive(Deserialize)]
struct OsUrl {
    url: String,
}

#[derive(Deserialize)]
struct OsVar {
    url: String,
    name: String,
    expression: String,
}

async fn os_variables(Json(a): Json<OsUrl>) -> ApiResult<Response> {
    sc_blocking(move || crate::onshape::variables(&a.url)).await
}

async fn os_set_variable(Json(a): Json<OsVar>) -> ApiResult<Response> {
    sc_blocking(move || crate::onshape::set_variable(&a.url, &a.name, &a.expression)).await
}

async fn os_study(Json(a): Json<OsVar>) -> ApiResult<Response> {
    sc_blocking(move || crate::onshape::study_value(&a.url, &a.name, &a.expression)).await
}

#[derive(Deserialize)]
struct OsQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    fresh: bool,
}

#[derive(Deserialize)]
struct OsDoc {
    did: String,
    wid: String,
    #[serde(default)]
    eid: String,
    #[serde(default)]
    href: Option<String>,
}

// --- Draftpad ---------------------------------------------------------------------------------

async fn dp_status() -> Json<crate::draftpad::Status> {
    Json(tokio::task::spawn_blocking(crate::draftpad::status).await.unwrap_or_default())
}

#[derive(Deserialize)]
struct DpConfig {
    url: String,
    #[serde(default)]
    token: Option<String>,
}

async fn dp_config(Json(a): Json<DpConfig>) -> ApiResult<Response> {
    crate::draftpad::save(&a.url, a.token.as_deref()).map_err(bad)?;
    Ok(Json(true).into_response())
}

#[derive(Deserialize)]
struct DpList {
    #[serde(default)]
    thumbs: bool,
}

async fn dp_list(Json(a): Json<DpList>) -> ApiResult<Response> {
    sc_blocking(move || crate::draftpad::list(a.thumbs)).await
}

#[derive(Deserialize)]
struct DpId {
    id: String,
}

async fn dp_get(Json(a): Json<DpId>) -> ApiResult<Response> {
    sc_blocking(move || crate::draftpad::get(&a.id)).await
}

async fn dp_meta(Json(a): Json<DpId>) -> ApiResult<Response> {
    sc_blocking(move || crate::draftpad::meta(&a.id)).await
}

async fn os_documents(Json(a): Json<OsQuery>) -> ApiResult<Response> {
    sc_blocking(move || crate::onshape::documents(&a.q, a.fresh)).await
}

async fn os_elements(Json(a): Json<OsDoc>) -> ApiResult<Response> {
    sc_blocking(move || crate::onshape::elements(&a.did, &a.wid)).await
}

async fn os_thumbnail(Json(a): Json<OsDoc>) -> ApiResult<Response> {
    sc_blocking(move || crate::onshape::thumbnail(a.href.as_deref(), &a.did, &a.wid, &a.eid)).await
}

async fn os_write_result(Json(a): Json<OsUrl>) -> ApiResult<Response> {
    sc_blocking(move || {
        crate::onshape::write_result(&a.url).map(|(name, text, n)| format!("„{name}“: {text} ({n} Teil{})", if n == 1 { "" } else { "e" }))
    })
    .await
}

// --- SolidCraft ---

#[derive(Deserialize)]
struct OnArgs {
    on: bool,
}

#[derive(Deserialize)]
struct ScResultArgs {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct ScStudyArgs {
    name: String,
    expression: String,
}

async fn sc_blocking<T: Serialize + Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> ApiResult<Response> {
    let v = tokio::task::spawn_blocking(f).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(v).into_response())
}

async fn sc_status() -> ApiResult<Response> {
    sc_blocking(|| Ok(crate::solidcraft::status())).await
}

async fn sc_live(Json(a): Json<OnArgs>) -> ApiResult<Response> {
    sc_blocking(move || Ok(crate::solidcraft::set_live(a.on))).await
}

async fn sc_auto(Json(a): Json<OnArgs>) -> Json<bool> {
    crate::solidcraft::set_auto_result(a.on);
    Json(true)
}

async fn sc_fetch() -> ApiResult<Response> {
    sc_blocking(crate::solidcraft::fetch_now).await
}

async fn sc_result(Json(a): Json<ScResultArgs>) -> ApiResult<Response> {
    sc_blocking(move || crate::solidcraft::write_result(a.name.as_deref())).await
}

async fn sc_params() -> ApiResult<Response> {
    sc_blocking(crate::solidcraft::params).await
}

async fn sc_pause(Json(a): Json<OnArgs>) -> Json<bool> {
    crate::solidcraft::pause(a.on);
    Json(true)
}

async fn sc_study(Json(a): Json<ScStudyArgs>) -> ApiResult<Response> {
    sc_blocking(move || crate::solidcraft::study_value(&a.name, &a.expression)).await
}

#[derive(Deserialize)]
struct GapArgs {
    max_gap: f64,
}

async fn api_find_gaps(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<GapArgs>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let v = tokio::task::spawn_blocking(move || crate::find_gaps_impl(&state, a.max_gap)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(v).into_response())
}

#[derive(Deserialize)]
struct BoltAtArgs {
    holes: Vec<fem_core::bolt::Hole>,
    pick: usize,
    #[serde(default)]
    d: Option<f64>,
    #[serde(default)]
    flip: bool,
}

async fn api_bolt_at_hole(Json(a): Json<BoltAtArgs>) -> ApiResult<Response> {
    let b = fem_core::bolt::bolt_at(&a.holes, a.pick, a.d, a.flip).map_err(bad)?;
    Ok(Json(b).into_response())
}

async fn api_section(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<SectionArgs>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let view = tokio::task::spawn_blocking(move || section_impl(&state, a.point, a.normal)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(view).into_response())
}

#[derive(Deserialize)]
struct ScanArgs {
    material: fem_core::Material,
}

async fn api_orientation_scan(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<ScanArgs>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let v = tokio::task::spawn_blocking(move || orientation_scan_impl(&state, a.material)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(v).into_response())
}

async fn api_frame_solve(Json(f): Json<fem_core::frame::Frame>) -> ApiResult<Response> {
    let r = tokio::task::spawn_blocking(move || fem_core::frame::solve_frame(&f)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(r).into_response())
}

#[derive(Deserialize)]
struct ModesReq {
    setup: Setup,
    kind: String,
    count: usize,
    density: Option<f64>,
}

async fn api_modes(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<ModesReq>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let v = tokio::task::spawn_blocking(move || modes_impl(&state, a.setup, &a.kind, a.count, a.density)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(v).into_response())
}

#[derive(Deserialize)]
struct TopoReq {
    setup: Setup,
    args: TopoArgs,
}

async fn api_topopt(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<TopoReq>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let v = tokio::task::spawn_blocking(move || topopt_impl(&state, a.setup, a.args)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(v).into_response())
}

#[derive(Deserialize)]
struct ThresholdArgs {
    threshold: f64,
}

async fn api_topo_surface(State(s): State<Shared>, headers: HeaderMap, Json(a): Json<ThresholdArgs>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let v = tokio::task::spawn_blocking(move || topo_surface_impl(&state, a.threshold)).await.map_err(bad)?.map_err(bad)?;
    Ok(Json(v).into_response())
}

async fn api_topo_stl(State(s): State<Shared>, headers: HeaderMap, Query(a): Query<ThresholdArgs>) -> ApiResult<Response> {
    let state = s.session(&headers);
    let data = tokio::task::spawn_blocking(move || topo_stl_impl(&state, a.threshold)).await.map_err(bad)?.map_err(bad)?;
    Ok(([(header::CONTENT_TYPE, "model/stl")], data).into_response())
}

async fn api_vtu(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<Response> {
    let state = s.session(&headers);
    let data = tokio::task::spawn_blocking(move || {
        let mut buf = Vec::new();
        write_vtu_impl(&state, &mut buf).map(|_| buf)
    })
    .await
    .map_err(bad)?
    .map_err(bad)?;
    Ok(([(header::CONTENT_TYPE, "application/xml")], data).into_response())
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (file, path) = match Assets::get(path) {
        Some(f) if !path.is_empty() => (f, path),
        _ => match Assets::get("index.html") {
            Some(f) => (f, "index.html"),
            None => {
                return (StatusCode::NOT_FOUND, "Oberfläche nicht eingebaut – vorher `npm run build` im Ordner app ausführen")
                    .into_response()
            }
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path == "index.html" { "no-cache" } else { "public, max-age=31536000, immutable" };
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}

/// Ohne Fenster: Server starten und laufen lassen (`projekt-fem-app --server [--port N]`)
pub fn run_headless(port: Option<u16>) {
    let mut cfg = ServerConfig::load();
    if let Some(p) = port {
        cfg.port = p;
    }
    // fester Zugangsschlüssel für den Server (sonst der gespeicherte bzw. ein neuer)
    if let Ok(k) = std::env::var("PROJEKT_FEM_SCHLUESSEL") {
        let k: String = k.trim().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if k.len() >= 12 {
            cfg.key = k;
        } else if !k.is_empty() {
            eprintln!("PROJEKT_FEM_SCHLUESSEL zu kurz (mindestens 12 Buchstaben/Ziffern) – nehme den gespeicherten");
        }
    }
    let _ = cfg.save();
    let rt = tokio::runtime::Runtime::new().expect("Tokio");
    rt.block_on(async {
        match start(&cfg).await {
            Ok(_running) => {
                if let Err(e) = crate::cad::start_local().await {
                    eprintln!("{e}");
                }
                if without_key() {
                    println!("Achtung: PROJEKT_FEM_OHNE_SCHLUESSEL ist gesetzt – kein Zugangsschlüssel nötig. Nur im Heimnetz verwenden!");
                }
                if public_mode() {
                    println!("Projekt-FEM läuft als Server (öffentlicher Modus). Im Browser öffnen: https://<Adresse>/#k={}", cfg.key);
                } else {
                    println!("Projekt-FEM läuft im Heimnetz. Im Browser öffnen:");
                    for u in info(&cfg).urls {
                        println!("  {u}");
                    }
                }
                println!("Beenden mit Strg+C.");
                // Strg+C oder (Docker) SIGTERM
                #[cfg(unix)]
                {
                    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("Signal");
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => {}
                        _ = term.recv() => {}
                    }
                }
                #[cfg(not(unix))]
                let _ = tokio::signal::ctrl_c().await;
            }
            Err(e) => {
                eprintln!("Fehler: {e}");
                std::process::exit(1);
            }
        }
    });
}
