//! CAD-Schnittstelle: Add-ins in Fusion 360, SolidWorks, NX, Solid Edge (und der Onshape-Knopf im Browser)
//! schicken das aktive Teil als STEP an Projekt-FEM und holen die Ergebniswerte zurück.
//!
//! Empfang lokal auf 127.0.0.1:8791 (nur dieser Rechner, ohne Schlüssel) und über die Heimnetz-Freigabe
//! (`/api/cad/...`, mit Schlüssel). Eingegangene Teile liegen unter `~/.config/projekt-fem/cad-eingang/<Name>.step`;
//! dasselbe Teil überschreibt seine Datei, damit Projekt-FEM es als „gleiches Teil, neue Version“ erkennt.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
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
    /// Herkunft, falls bekannt (Onshape: Adresse des Teilestudios – für die Parameterstudie über Variablen)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip)]
    pub at: Option<Instant>,
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
    receive_from(name, source, data, None)
}

/// wie `receive`, mit Herkunft (z. B. Onshape-Adresse)
pub fn receive_from(name: &str, source: &str, data: &[u8], origin: Option<String>) -> Result<Incoming, String> {
    if data.len() < 20 || !String::from_utf8_lossy(&data[..data.len().min(200)]).contains("ISO-10303") {
        return Err("Keine STEP-Datei (ISO-10303) empfangen".into());
    }
    let name = clean_name(name);
    let path = inbox_dir()?.join(format!("{name}.step"));
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    let inc = {
        let mut s = store().lock().unwrap();
        s.seq += 1;
        let inc = Incoming {
            seq: s.seq,
            name,
            source: source.chars().take(40).collect(),
            path: path.display().to_string(),
            origin,
            at: Some(Instant::now()),
        };
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

fn summary_path(name: &str) -> Option<PathBuf> {
    Some(inbox_dir().ok()?.join(format!("{}.ergebnis.json", clean_name(name))))
}

/// Ergebniswerte merken (auch auf der Platte, damit „Ergebnis holen“ nach einem Neustart noch geht)
pub fn set_summary(name: &str, v: serde_json::Value) {
    if let Some(p) = summary_path(name) {
        let _ = std::fs::write(p, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    store().lock().unwrap().summaries.insert(clean_name(name), v);
    crate::solidcraft::on_summary(name);
}

pub fn summary(name: &str) -> Option<serde_json::Value> {
    if let Some(v) = store().lock().unwrap().summaries.get(&clean_name(name)) {
        return Some(v.clone());
    }
    serde_json::from_str(&std::fs::read_to_string(summary_path(name)?).ok()?).ok()
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
    open_impl(q, body)
}

fn open_impl(q: OpenQuery, body: Bytes) -> Response {
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

/// Eingang für den Browser, mit Alter in Sekunden (ein frisch geöffneter Tab übernimmt ein gerade geschicktes Teil)
#[derive(Serialize)]
pub struct InboxItem {
    #[serde(flatten)]
    inc: Incoming,
    age: u64,
}

pub async fn http_inbox(Query(q): Query<AfterQuery>) -> Json<Vec<InboxItem>> {
    Json(
        since(q.after)
            .into_iter()
            .map(|inc| InboxItem { age: inc.at.map(|t| t.elapsed().as_secs()).unwrap_or(0), inc })
            .collect(),
    )
}

pub async fn http_set_summary(Query(q): Query<NameQuery>, Json(v): Json<serde_json::Value>) -> Json<bool> {
    set_summary(&q.name, v);
    Json(true)
}

async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "app": "Projekt-FEM", "version": env!("CARGO_PKG_VERSION") }))
}

/// Lokales Senden: nur mit Kopfzeile `X-FEM-CAD` (Add-ins setzen sie, eine fremde Webseite im Browser kann das nicht)
async fn local_open(headers: HeaderMap, Query(q): Query<OpenQuery>, body: Bytes) -> Response {
    if !headers.contains_key("x-fem-cad") {
        return (StatusCode::FORBIDDEN, "Kopfzeile X-FEM-CAD fehlt").into_response();
    }
    open_impl(q, body)
}

// --- Onshape (Lesezeichen im Browser) ---------------------------------------------------------

/// Schlüssel aus `?k=…`
pub fn query_key(query: Option<&str>) -> Option<String> {
    query?.split('&').find_map(|kv| kv.strip_prefix("k=")).map(String::from)
}

#[derive(Deserialize)]
pub struct UrlQuery {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub k: String,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// kleine Rückmeldeseite für das Lesezeichen-Fenster
fn page(ok: bool, title: &str, text: &str, link: Option<&str>) -> Html<String> {
    let (color, mark) = if ok { ("#3fb950", "✓") } else { ("#f85149", "✗") };
    let link = link.map(|l| format!(r#"<p><a href="{}">Projekt-FEM öffnen</a></p>"#, esc(l))).unwrap_or_default();
    Html(format!(
        r#"<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Projekt-FEM</title>
<style>body{{font:15px system-ui,sans-serif;background:#15171c;color:#e6e6e6;margin:0;padding:32px 20px}}main{{max-width:520px;margin:auto}}
h1{{font-size:18px;color:{color}}}p{{line-height:1.5;color:#b8bcc6}}a{{color:#58a6ff}}code{{color:#e6e6e6}}button{{font:inherit;background:#262a33;color:#e6e6e6;border:1px solid #3a3f4b;border-radius:6px;padding:6px 12px}}</style></head>
<body><main><h1>{mark} {}</h1><p>{}</p>{link}<p><button onclick="window.close()">Fenster schließen</button></p></main></body></html>"#,
        esc(title),
        text
    ))
}

async fn onshape_page(url: String, link: Option<String>) -> Html<String> {
    match tokio::task::spawn_blocking(move || crate::onshape::import(&url)).await {
        Ok(Ok(inc)) => page(
            true,
            &format!("„{}“ an Projekt-FEM geschickt", inc.name),
            "Projekt-FEM öffnet das Teil (gleiches Teil: Lager und Lasten bleiben, es wird neu gerechnet). Dieses Fenster kann zu.",
            link.as_deref(),
        ),
        Ok(Err(e)) => page(false, "Nicht geschickt", &esc(&e), None),
        Err(e) => page(false, "Nicht geschickt", &esc(&e.to_string()), None),
    }
}

async fn onshape_result_page(url: String) -> Html<String> {
    match tokio::task::spawn_blocking(move || crate::onshape::write_result(&url)).await {
        Ok(Ok((name, text, n))) => page(
            true,
            "Ergebnis in Onshape eingetragen",
            &format!(
                "Beschreibung von {n} Teil{} in „{}“ (Onshape: Teil anklicken → Eigenschaften):<br><code>{}</code>",
                if n == 1 { "" } else { "en" },
                esc(&name),
                esc(&text)
            ),
            None,
        ),
        Ok(Err(e)) => page(false, "Nicht eingetragen", &esc(&e), None),
        Err(e) => page(false, "Nicht eingetragen", &esc(&e.to_string()), None),
    }
}

fn local_key_ok(k: &str) -> bool {
    !k.is_empty() && k == crate::server::ServerConfig::load().key
}

async fn local_onshape(Query(q): Query<UrlQuery>) -> Html<String> {
    if !local_key_ok(&q.k) {
        return page(false, "Lesezeichen veraltet", "Bitte das Lesezeichen in Projekt-FEM unter „CAD“ neu anlegen.", None);
    }
    onshape_page(q.url, None).await
}

async fn local_onshape_result(Query(q): Query<UrlQuery>) -> Html<String> {
    if !local_key_ok(&q.k) {
        return page(false, "Lesezeichen veraltet", "Bitte das Lesezeichen in Projekt-FEM unter „CAD“ neu anlegen.", None);
    }
    onshape_result_page(q.url).await
}

/// über die Heimnetz-Freigabe (Schlüssel prüft der Server)
pub async fn http_onshape(Query(q): Query<UrlQuery>) -> Html<String> {
    let link = format!("/#k={}", q.k);
    onshape_page(q.url, Some(link)).await
}

pub async fn http_onshape_result(Query(q): Query<UrlQuery>) -> Html<String> {
    onshape_result_page(q.url).await
}

pub async fn http_onshape_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "configured": crate::onshape::configured(), "usage": crate::onshape::usage() }))
}

#[derive(Deserialize)]
pub struct KeysBody {
    pub access: String,
    pub secret: String,
}

pub async fn http_onshape_keys(Json(b): Json<KeysBody>) -> Response {
    match crate::onshape::save_keys(&b.access, &b.secret) {
        Ok(()) => Json(crate::onshape::configured()).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ImportBody {
    pub url: String,
}

pub async fn http_onshape_import(Json(b): Json<ImportBody>) -> Response {
    match tokio::task::spawn_blocking(move || crate::onshape::import(&b.url)).await {
        Ok(Ok(inc)) => Json(inc).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Routen für den lokalen Empfang (nur 127.0.0.1)
pub fn local_router() -> Router {
    Router::new()
        .route("/cad/ping", get(ping))
        .route("/cad/open", post(local_open))
        .route("/cad/summary", get(http_summary))
        .route("/cad/onshape", get(local_onshape))
        .route("/cad/onshape_result", get(local_onshape_result))
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

    #[test]
    fn schluessel_aus_adresse() {
        assert_eq!(query_key(Some("url=x&k=abc")).as_deref(), Some("abc"));
        assert_eq!(query_key(Some("url=k%3Dx")), None);
        assert_eq!(query_key(None), None);
    }
}
