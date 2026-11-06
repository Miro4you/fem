//! CAD-Schnittstelle: Add-ins in Fusion 360, SolidWorks, NX, Solid Edge (und der Onshape-Knopf im Browser)
//! schicken das aktive Teil als STEP an Projekt-FEM und holen die Ergebniswerte zurück.
//!
//! Empfang lokal auf 127.0.0.1:8791 (nur dieser Rechner, ohne Schlüssel) und über die Heimnetz-Freigabe
//! (`/api/cad/...`, mit Schlüssel). Eingegangene Teile liegen unter `~/.config/projekt-fem/cad-eingang/<Name>.step`;
//! dasselbe Teil überschreibt seine Datei, damit Projekt-FEM es als „gleiches Teil, neue Version“ erkennt.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use axum::body::Bytes;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

pub const LOCAL_PORT: u16 = 8791;

/// Ein vom CAD geschicktes Teil
#[derive(Debug, Clone, Serialize)]
pub struct Incoming {
    /// fortlaufende Nummer (für das Abfragen im Browser)
    pub seq: u64,
    /// Teilname (ohne Endung)
    pub name: String,
    /// z. B. „Fusion 360“
    pub source: String,
    /// Datei auf dem rechnenden Rechner
    pub path: String,
}

struct Store {
    seq: u64,
    queue: Vec<Incoming>,
    /// letzte Ergebniswerte je Teilname (für „Ergebnis holen“)
    summaries: HashMap<String, serde_json::Value>,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store { seq: 0, queue: Vec::new(), summaries: HashMap::new() }))
}

type Notify = Box<dyn Fn(&Incoming) + Send + Sync>;
static NOTIFY: OnceLock<Notify> = OnceLock::new();

/// Benachrichtigung der Desktop-Oberfläche (setzt die App beim Start)
pub fn on_incoming(f: impl Fn(&Incoming) + Send + Sync + 'static) {
    let _ = NOTIFY.set(Box::new(f));
}

fn notify(inc: &Incoming) {
    if let Some(f) = NOTIFY.get() {
        f(inc);
    }
}

fn inbox_dir() -> Result<PathBuf, String> {
    let d = crate::server::config_dir().ok_or("Kein Konfigurationsordner gefunden")?.join("cad-eingang");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Dateiname aus dem Teilnamen (nur unbedenkliche Zeichen)
pub fn clean_name(name: &str) -> String {
    let n: String = name
        .trim()
        .trim_end_matches(".step")
        .trim_end_matches(".stp")
        .chars()
        .map(|c| if c.is_alphanumeric() || " ._-()".contains(c) { c } else { '_' })
        .collect();
    let n = n.trim().trim_matches('.').to_string();
    if n.is_empty() { "Teil".into() } else { n.chars().take(80).collect() }
}

/// Teil ablegen und melden
pub fn receive(name: &str, source: &str, data: &[u8]) -> Result<Incoming, String> {
    if data.len() < 20 || !String::from_utf8_lossy(&data[..data.len().min(200)]).contains("ISO-10303") {
        return Err("Keine STEP-Datei (ISO-10303) empfangen".into());
    }
    let name = clean_name(name);
    let path = inbox_dir()?.join(format!("{name}.step"));
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    let inc = {
        let mut s = store().lock().unwrap();
        s.seq += 1;
        let inc = Incoming { seq: s.seq, name, source: source.chars().take(40).collect(), path: path.display().to_string() };
        s.queue.push(inc.clone());
        if s.queue.len() > 50 {
            s.queue.remove(0);
        }
        inc
    };
    notify(&inc);
    Ok(inc)
}

/// Teile seit Nummer `after` (Browser fragt regelmäßig ab)
pub fn since(after: u64) -> Vec<Incoming> {
    store().lock().unwrap().queue.iter().filter(|i| i.seq > after).cloned().collect()
}

pub fn set_summary(name: &str, v: serde_json::Value) {
    store().lock().unwrap().summaries.insert(clean_name(name), v);
}

pub fn summary(name: &str) -> Option<serde_json::Value> {
    store().lock().unwrap().summaries.get(&clean_name(name)).cloned()
}

// --- HTTP ------------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct OpenQuery {
    pub name: String,
    #[serde(default)]
    pub source: String,
}

#[derive(Deserialize)]
pub struct NameQuery {
    pub name: String,
}

#[derive(Deserialize)]
pub struct AfterQuery {
    #[serde(default)]
    pub after: u64,
}

pub async fn http_open(Query(q): Query<OpenQuery>, body: Bytes) -> Response {
    match receive(&q.name, if q.source.is_empty() { "CAD" } else { &q.source }, &body) {
        Ok(inc) => Json(inc).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub async fn http_summary(Query(q): Query<NameQuery>) -> Response {
    match summary(&q.name) {
        Some(v) => Json(v).into_response(),
        None => (StatusCode::NOT_FOUND, "Für dieses Teil gibt es noch kein Ergebnis – in Projekt-FEM rechnen").into_response(),
    }
}

pub async fn http_inbox(Query(q): Query<AfterQuery>) -> Json<Vec<Incoming>> {
    Json(since(q.after))
}

pub async fn http_set_summary(Query(q): Query<NameQuery>, Json(v): Json<serde_json::Value>) -> Json<bool> {
    set_summary(&q.name, v);
    Json(true)
}

async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "app": "Projekt-FEM", "version": env!("CARGO_PKG_VERSION") }))
}

/// Routen ohne Schlüssel – nur für den lokalen Empfang (127.0.0.1)
pub fn local_router() -> Router {
    Router::new()
        .route("/cad/ping", get(ping))
        .route("/cad/open", post(http_open))
        .route("/cad/summary", get(http_summary))
        .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024))
}

/// Lokalen Empfang starten (Desktop-App). Fehler, wenn der Port belegt ist (z. B. zweite App).
pub async fn start_local() -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", LOCAL_PORT))
        .await
        .map_err(|e| format!("CAD-Schnittstelle: Port {LOCAL_PORT} belegt ({e})"))?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, local_router()).await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_bereinigen() {
        assert_eq!(clean_name("Hebel v3.step"), "Hebel v3");
        assert!(!clean_name("../../etc/passwd").contains('/'));
        assert_eq!(clean_name("  "), "Teil");
    }
}
