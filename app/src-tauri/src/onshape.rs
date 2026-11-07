//! Onshape: Teilestudio über die Onshape-API als STEP holen und Ergebniswerte zurückschreiben.
//!
//! Onshape läuft im Browser, ein Add-in wie bei Fusion oder SolidWorks gibt es dort nicht. Stattdessen:
//! Lesezeichen „→ Projekt-FEM“ in der Lesezeichenleiste schickt die Adresse des offenen Teilestudios an
//! Projekt-FEM, Projekt-FEM holt die STEP-Datei mit den API-Schlüsseln des Benutzers (Onshape → Developer
//! Portal → API keys). „FEM-Ergebnis → Onshape“ schreibt die Ergebniswerte in die Beschreibung der Teile.
//! Die Schlüssel liegen nur auf dem rechnenden Rechner (`~/.config/projekt-fem/onshape.json`).

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Keys {
    pub access: String,
    pub secret: String,
}

// --- Verbrauch: Onshape zählt API-Aufrufe (kostenlose Konten: 2500 im Jahr) ------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    /// Jahr, für das `year_count` gilt
    pub year: i32,
    pub year_count: u64,
    /// Aufrufe insgesamt seit `since` (Datum der ersten Zählung)
    pub total: u64,
    pub since: String,
}

static USAGE_LOCK: Mutex<()> = Mutex::new(());

fn usage_path() -> Option<PathBuf> {
    Some(crate::server::config_dir()?.join("onshape-aufrufe.json"))
}

fn today() -> (i32, String) {
    // Tage seit 1970 → Datum (ohne zusätzliche Bibliothek)
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86400).unwrap_or(0) as i64;
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y as i32, format!("{d:02}.{m:02}.{y}"))
}

pub fn usage() -> Usage {
    let (year, date) = today();
    let mut u: Usage = usage_path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if u.since.is_empty() {
        u.since = date;
    }
    if u.year != year {
        u.year = year;
        u.year_count = 0;
    }
    u
}

/// einen Aufruf zählen (vor dem Senden, damit auch fehlgeschlagene mitzählen)
fn count_call() {
    let _g = USAGE_LOCK.lock();
    let mut u = usage();
    u.year_count += 1;
    u.total += 1;
    if let Some(p) = usage_path() {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string(&u).unwrap_or_default());
    }
}

fn keys_path() -> Option<PathBuf> {
    Some(crate::server::config_dir()?.join("onshape.json"))
}

pub fn load_keys() -> Option<Keys> {
    let k: Keys = serde_json::from_str(&std::fs::read_to_string(keys_path()?).ok()?).ok()?;
    (!k.access.is_empty() && !k.secret.is_empty()).then_some(k)
}

pub fn configured() -> bool {
    load_keys().is_some()
}

/// Schlüssel speichern (leer = löschen)
pub fn save_keys(access: &str, secret: &str) -> Result<(), String> {
    let p = keys_path().ok_or("Kein Konfigurationsordner gefunden")?;
    if access.trim().is_empty() || secret.trim().is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let k = Keys { access: access.trim().into(), secret: secret.trim().into() };
    std::fs::write(&p, serde_json::to_string_pretty(&k).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Teilestudio aus der Onshape-Adresse: https://cad.onshape.com/documents/<d>/w/<w>/e/<e>
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub base: String,
    pub did: String,
    /// w (Arbeitsbereich), v (Version) oder m (Mikroversion)
    pub wvm: String,
    pub wvmid: String,
    pub eid: String,
}

impl Target {
    fn element(&self) -> String {
        format!("d/{}/{}/{}/e/{}", self.did, self.wvm, self.wvmid, self.eid)
    }
}

pub fn parse_url(url: &str) -> Result<Target, String> {
    let bad = || "Das ist keine Onshape-Adresse eines Teilestudios (…/documents/…/w/…/e/…)".to_string();
    let url = url.trim();
    let (scheme, rest) = url.split_once("://").ok_or_else(bad)?;
    if scheme != "https" && scheme != "http" {
        return Err(bad());
    }
    let (host, path) = rest.split_once('/').ok_or_else(bad)?;
    // Die API-Schlüssel gehen an diesen Rechner – nur Onshape zulassen (cad.onshape.com, firma.onshape.com).
    // Für Tests gegen einen Nachbau: Umgebungsvariable PROJEKT_FEM_ONSHAPE_HOST=rechner:port
    let host = host.to_ascii_lowercase();
    let onshape = scheme == "https"
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && (host == "onshape.com" || host.ends_with(".onshape.com"));
    let test = std::env::var("PROJEKT_FEM_ONSHAPE_HOST").is_ok_and(|h| !h.is_empty() && h == host);
    if !onshape && !test {
        return Err("Nur Adressen von Onshape (…onshape.com) sind erlaubt".into());
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let p: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let i = p.iter().position(|s| *s == "documents").ok_or_else(bad)?;
    let g = |k: usize| p.get(i + k).copied().ok_or_else(bad);
    let (did, wvm, wvmid, e, eid) = (g(1)?, g(2)?, g(3)?, g(4)?, g(5)?);
    let id_ok = |s: &str| s.len() >= 8 && s.chars().all(|c| c.is_ascii_alphanumeric());
    if !["w", "v", "m"].contains(&wvm) || e != "e" || !id_ok(did) || !id_ok(wvmid) || !id_ok(eid) {
        return Err(bad());
    }
    Ok(Target { base: format!("{scheme}://{host}"), did: did.into(), wvm: wvm.into(), wvmid: wvmid.into(), eid: eid.into() })
}

struct Client {
    base: String,
    auth: String,
    agent: ureq::Agent,
}

fn api_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => "Onshape lehnt die API-Schlüssel ab – in Projekt-FEM unter Einstellungen › CAD-Verbindungen neu eintragen".into(),
        ureq::Error::Status(403, _) => "Kein Zugriff auf dieses Dokument (API-Schlüssel ohne Lese- bzw. Schreibrecht?)".into(),
        ureq::Error::Status(404, _) => "Onshape findet das Teilestudio nicht – Adresse prüfen".into(),
        ureq::Error::Status(code, r) => format!("Onshape meldet Fehler {code}: {}", r.into_string().unwrap_or_default().chars().take(300).collect::<String>()),
        ureq::Error::Transport(t) => format!("Onshape nicht erreichbar: {t}"),
    }
}

impl Client {
    fn new(t: &Target) -> Result<Client, String> {
        Client::with_base(&t.base)
    }

    fn with_base(base: &str) -> Result<Client, String> {
        use base64::Engine;
        let k = load_keys().ok_or("Onshape-API-Schlüssel fehlen – in Projekt-FEM unter Einstellungen › CAD-Verbindungen eintragen")?;
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", k.access, k.secret)));
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build();
        Ok(Client { base: base.to_string(), auth, agent })
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        count_call();
        self.agent
            .get(&format!("{}/api/v6/{path}", self.base))
            .set("Authorization", &self.auth)
            .set("Accept", "application/json")
            .call()
            .map_err(api_error)?
            .into_json()
            .map_err(|e| e.to_string())
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        count_call();
        self.agent
            .post(&format!("{}/api/v6/{path}", self.base))
            .set("Authorization", &self.auth)
            .set("Accept", "application/json")
            .send_json(body)
            .map_err(api_error)?
            .into_json()
            .map_err(|e| e.to_string())
    }

    fn bytes(&self, path: &str) -> Result<Vec<u8>, String> {
        self.fetch(&format!("{}/api/v6/{path}", self.base), "application/octet-stream").map(|(b, _)| b)
    }

    /// Rohdaten von einer Adresse dieses Onshape-Servers → (Bytes, Inhaltstyp)
    fn fetch(&self, url: &str, accept: &str) -> Result<(Vec<u8>, String), String> {
        count_call();
        let r = self.agent.get(url).set("Authorization", &self.auth).set("Accept", accept).call().map_err(api_error)?;
        let kind = r.content_type().to_string();
        let mut buf = Vec::new();
        std::io::Read::take(r.into_reader(), 8 << 20).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok((buf, kind))
    }
}

// --- Bibliothek: eigene Dokumente durchblättern ------------------------------------------------

/// Onshape-Server für die Bibliothek: cad.onshape.com (Test: PROJEKT_FEM_ONSHAPE_HOST)
fn library_base() -> String {
    match std::env::var("PROJEKT_FEM_ONSHAPE_HOST") {
        Ok(h) if !h.is_empty() => format!("http://{h}"),
        _ => "https://cad.onshape.com".into(),
    }
}

fn id_ok(s: &str) -> bool {
    s.len() >= 8 && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Dokument in der Bibliothek
#[derive(Debug, Clone, Serialize)]
pub struct Document {
    pub id: String,
    pub name: String,
    /// Arbeitsbereich (Standard), in dem die Teilestudios liegen
    pub workspace: String,
    pub modified: String,
    pub owner: String,
    /// Vorschaubild über `onshape_thumbnail` holen (Adresse beim Onshape-Server)
    pub thumbnail: Option<String>,
}

/// Teilestudio oder Baugruppe eines Dokuments
#[derive(Debug, Clone, Serialize)]
pub struct Element {
    pub id: String,
    pub name: String,
    /// PARTSTUDIO oder ASSEMBLY
    pub kind: String,
    /// Adresse wie im Browser – damit holt Projekt-FEM das Teilestudio
    pub url: String,
}

fn thumb_href(v: &Value) -> Option<String> {
    let sizes = v["thumbnail"]["sizes"].as_array()?;
    // kleines Bild genügt für die Liste
    let pick = sizes.iter().find(|s| s["size"] == "300x170").or_else(|| sizes.iter().find(|s| s["size"] == "70x40")).or(sizes.first())?;
    pick["href"].as_str().map(String::from)
}

// Zwischenspeicher, damit Blättern und erneutes Öffnen der Bibliothek keine Aufrufe kostet
type Cache<T> = Mutex<Option<HashMap<String, (Instant, T)>>>;
static DOCS: Cache<Vec<Document>> = Mutex::new(None);
static ELEMENTS: Cache<Vec<Element>> = Mutex::new(None);
static NAMES: Cache<(String, bool)> = Mutex::new(None);
const LIST_TTL: Duration = Duration::from_secs(600);

fn cached<T: Clone>(c: &Cache<T>, key: &str, ttl: Duration) -> Option<T> {
    let g = c.lock().ok()?;
    let (at, v) = g.as_ref()?.get(key)?;
    (at.elapsed() < ttl).then(|| v.clone())
}

fn remember<T>(c: &Cache<T>, key: &str, v: T) {
    if let Ok(mut g) = c.lock() {
        g.get_or_insert_with(HashMap::new).insert(key.to_string(), (Instant::now(), v));
    }
}

/// Eigene und geteilte Dokumente, zuletzt geänderte zuerst; `q` sucht im Namen. `fresh` = Zwischenspeicher übergehen.
pub fn documents(q: &str, fresh: bool) -> Result<Vec<Document>, String> {
    let q = q.trim();
    if !fresh {
        if let Some(d) = cached(&DOCS, q, LIST_TTL) {
            return Ok(d);
        }
    }
    let c = Client::with_base(&library_base())?;
    let mut path = "documents?sortColumn=modifiedAt&sortOrder=desc&offset=0&limit=20".to_string();
    if !q.is_empty() {
        path += &format!("&q={}", urlencode(q));
    }
    let r = c.get(&path)?;
    let list: Vec<Document> = r["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let id = d["id"].as_str()?;
            let ws = d["defaultWorkspace"]["id"].as_str()?;
            (id_ok(id) && id_ok(ws)).then(|| Document {
                id: id.into(),
                name: d["name"].as_str().unwrap_or("(ohne Namen)").into(),
                workspace: ws.into(),
                modified: d["modifiedAt"].as_str().unwrap_or("").into(),
                owner: d["owner"]["name"].as_str().unwrap_or("").into(),
                thumbnail: thumb_href(d),
            })
        })
        .collect();
    remember(&DOCS, q, list.clone());
    Ok(list)
}

/// Teilestudios (und Baugruppen) im Arbeitsbereich eines Dokuments
pub fn elements(did: &str, wid: &str) -> Result<Vec<Element>, String> {
    if !id_ok(did) || !id_ok(wid) {
        return Err("Ungültige Dokumentkennung".into());
    }
    let key = format!("{did}/{wid}");
    if let Some(e) = cached(&ELEMENTS, &key, LIST_TTL) {
        return Ok(e);
    }
    let base = library_base();
    let c = Client::with_base(&base)?;
    let r = c.get(&format!("documents/d/{did}/w/{wid}/elements"))?;
    let list: Vec<Element> = r.as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let id = e["id"].as_str()?;
            let kind = e["elementType"].as_str()?;
            (id_ok(id) && (kind == "PARTSTUDIO" || kind == "ASSEMBLY")).then(|| Element {
                id: id.into(),
                name: e["name"].as_str().unwrap_or("").into(),
                kind: kind.into(),
                url: format!("{base}/documents/{did}/w/{wid}/e/{id}"),
            })
        })
        .collect();
    remember(&ELEMENTS, &key, list.clone());
    Ok(list)
}

/// Bildadresse prüfen: nur der Onshape-Server selbst (dorthin gehen die Schlüssel mit). Im Test gegen einen Nachbau
/// (`base` = http://…) wird dieselbe Adresse dort abgefragt.
fn thumb_url(h: &str, base: &str) -> Result<String, String> {
    let bad = || "Vorschaubild nicht vom Onshape-Server".to_string();
    let (scheme, rest) = h.split_once("://").ok_or_else(bad)?;
    let (host, path) = rest.split_once('/').ok_or_else(bad)?;
    let host = host.to_ascii_lowercase();
    let onshape = scheme == "https"
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && (host == "onshape.com" || host.ends_with(".onshape.com"));
    let same = format!("{scheme}://{host}") == base;
    if !(onshape || same) || !path.starts_with("api/") || path.contains("..") || path.contains("//") || path.contains('@') {
        return Err(bad());
    }
    Ok(if base.starts_with("http://") { format!("{base}/{path}") } else { h.to_string() })
}

/// Vorschaubild als data:-Adresse. `href` ist eine Bildadresse aus `documents`; ohne `href` das Bild eines
/// Teilestudios (`did`, `wid`, `eid`). Die Schlüssel gehen nur an den Onshape-Server selbst.
pub fn thumbnail(href: Option<&str>, did: &str, wid: &str, eid: &str) -> Result<String, String> {
    use base64::Engine;
    let base = library_base();
    let url = match href {
        Some(h) => thumb_url(h, &base)?,
        None => {
            if !id_ok(did) || !id_ok(wid) || !id_ok(eid) {
                return Err("Ungültige Kennung".into());
            }
            format!("{base}/api/v6/thumbnails/d/{did}/w/{wid}/e/{eid}/s/300x170")
        }
    };
    let c = Client::with_base(&base)?;
    let file = crate::server::config_dir().map(|d| d.join("onshape-vorschau").join(format!("{:016x}.txt", fnv(&url))));
    if let Some(t) = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
        return Ok(t);
    }
    let (data, kind) = c.fetch(&url, "image/*")?;
    let kind = if kind.starts_with("image/") { kind } else { "image/png".into() };
    let out = format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(data));
    if let Some(f) = file {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        let _ = std::fs::write(f, &out);
    }
    Ok(out)
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

/// Teilname in Projekt-FEM: „Dokument - Teilestudio“ (bleibt über Änderungen gleich) und ob es eine Baugruppe ist
fn part_name(c: &Client, t: &Target) -> Result<(String, bool), String> {
    let key = format!("{}/{}", t.did, t.eid);
    if let Some(n) = cached(&NAMES, &key, Duration::from_secs(24 * 3600)) {
        return Ok(n);
    }
    let n = part_name_fetch(c, t)?;
    remember(&NAMES, &key, n.clone());
    Ok(n)
}

fn part_name_fetch(c: &Client, t: &Target) -> Result<(String, bool), String> {
    let doc = c.get(&format!("documents/{}", t.did))?;
    let els = c.get(&format!("documents/d/{}/{}/{}/elements?elementId={}", t.did, t.wvm, t.wvmid, t.eid))?;
    let el = els.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
    let kind = el["elementType"].as_str().unwrap_or("PARTSTUDIO");
    if kind != "PARTSTUDIO" && kind != "ASSEMBLY" {
        return Err("Bitte ein Teilestudio oder eine Baugruppe öffnen (der aktive Reiter ist keins von beiden)".into());
    }
    let d = doc["name"].as_str().unwrap_or("Onshape");
    let name = match el["name"].as_str() {
        Some(e) if !e.is_empty() => format!("{d} - {e}"),
        _ => d.to_string(),
    };
    Ok((name, kind == "ASSEMBLY"))
}

/// Teilestudio als STEP holen und wie ein Teil aus dem CAD an Projekt-FEM übergeben
pub fn import(url: &str) -> Result<crate::cad::Incoming, String> {
    let t = parse_url(url)?;
    let c = Client::new(&t)?;
    let (name, assembly) = part_name(&c, &t)?;
    let data = export_step(&c, &t, assembly)?;
    crate::cad::receive_from(&name, "Onshape", &data, Some(url.trim().to_string()))
}

/// Teilestudio bzw. Baugruppe als STEP (Onshape erzeugt die Datei im Hintergrund). Baugruppen behalten ihre
/// Teilenamen; jedes Teil wird ein Körper.
fn export_step(c: &Client, t: &Target, assembly: bool) -> Result<Vec<u8>, String> {
    let tr = c.post(
        &format!("{}/{}/translations", if assembly { "assemblies" } else { "partstudios" }, t.element()),
        json!({ "formatName": "STEP", "storeInDocument": false, "flattenAssemblies": false, "yAxisIsUp": false }),
    )?;
    let id = tr["id"].as_str().ok_or("Onshape hat die STEP-Ausgabe nicht gestartet")?.to_string();
    // Onshape erzeugt die Datei im Hintergrund – nachfragen, bis sie fertig ist
    let start = Instant::now();
    let mut polls = 0u64;
    // die Ausgabe dauert meist ein paar Sekunden – erst warten, dann nachfragen
    std::thread::sleep(Duration::from_millis(2000));
    let fid = loop {
        polls += 1;
        let s = c.get(&format!("translations/{id}"))?;
        match s["requestState"].as_str().unwrap_or("") {
            "DONE" => break s["resultExternalDataIds"][0].as_str().ok_or("Onshape hat keine STEP-Datei geliefert")?.to_string(),
            "FAILED" => return Err(format!("STEP-Ausgabe in Onshape fehlgeschlagen: {}", s["failureReason"].as_str().unwrap_or("unbekannt"))),
            _ if start.elapsed() > Duration::from_secs(180) => return Err("STEP-Ausgabe in Onshape dauert zu lange".into()),
            // seltener nachfragen: jede Abfrage zählt bei Onshape (1,5 s, dann länger)
            _ => std::thread::sleep(Duration::from_millis((1500 + 500 * polls).min(4000))),
        }
    };
    c.bytes(&format!("documents/d/{}/externaldata/{fid}", t.did))
}

// --- Variablen (Parameterstudie) ---------------------------------------------------------------

/// Variable eines Teilestudios (`#dicke`)
#[derive(Debug, Clone, Serialize)]
pub struct Variable {
    pub name: String,
    pub expression: String,
    /// LENGTH, ANGLE, NUMBER oder ANY
    pub kind: String,
    /// Zahl und Einheit, wenn der Ausdruck einfach ist („5 mm“ → 5, „mm“)
    pub value: Option<f64>,
    pub unit: String,
}

/// „5 mm“ → (5, „mm“), „12.5“ → (12,5, „“), „#a*2“ → None
pub fn split_expression(expr: &str) -> Option<(f64, String)> {
    let e = expr.trim();
    let i = e.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')).unwrap_or(e.len());
    let (num, rest) = e.split_at(i);
    let v: f64 = num.parse().ok()?;
    let unit = rest.trim();
    (unit.is_empty() || unit.chars().all(|c| c.is_ascii_alphabetic())).then(|| (v, unit.to_string()))
}

fn default_unit(kind: &str) -> &'static str {
    match kind {
        "LENGTH" => "mm",
        "ANGLE" => "deg",
        _ => "",
    }
}

/// Variablen, die im Teilestudio selbst angelegt sind (Variablen-Studios: noch nicht)
pub fn variables(url: &str) -> Result<Vec<Variable>, String> {
    let t = parse_url(url)?;
    let c = Client::new(&t)?;
    let groups = c.get(&format!("variables/{}/variables", t.element()))?;
    let mut out = Vec::new();
    for g in groups.as_array().into_iter().flatten() {
        if !g["variableStudioReference"].is_null() {
            continue;
        }
        for v in g["variables"].as_array().into_iter().flatten() {
            let (Some(name), Some(expr)) = (v["name"].as_str(), v["expression"].as_str()) else { continue };
            let kind = v["type"].as_str().unwrap_or("ANY").to_string();
            let (value, unit) = match split_expression(expr) {
                Some((x, u)) => (Some(x), if u.is_empty() { default_unit(&kind).to_string() } else { u }),
                None => (None, default_unit(&kind).to_string()),
            };
            out.push(Variable { name: name.into(), expression: expr.into(), kind, value, unit });
        }
    }
    Ok(out)
}

/// Variable im Teilestudio ändern (Variablen-Feature anpassen); Fehler, wenn das Teilestudio danach nicht aufgeht
pub fn set_variable(url: &str, name: &str, expression: &str) -> Result<(), String> {
    let t = parse_url(url)?;
    if t.wvm != "w" {
        return Err("Variablen lassen sich nur im Arbeitsbereich ändern, nicht in einer gespeicherten Version".into());
    }
    let c = Client::new(&t)?;
    let fs = c.get(&format!("partstudios/{}/features", t.element()))?;
    let feat = fs["features"]
        .as_array()
        .and_then(|a| {
            a.iter().rev().find(|f| {
                f["featureType"] == "assignVariable"
                    && f["parameters"].as_array().is_some_and(|ps| ps.iter().any(|p| p["parameterId"] == "name" && p["value"] == name))
            })
        })
        .cloned()
        .ok_or(format!("Variable #{name} im Teilestudio nicht gefunden"))?;
    let mut feat = feat;
    let ps = feat["parameters"].as_array_mut().ok_or("Variablen-Feature ohne Parameter")?;
    let slot = ps
        .iter_mut()
        .find(|p| matches!(p["parameterId"].as_str(), Some("lengthValue" | "angleValue" | "numberValue" | "anyValue")) && p.get("expression").is_some())
        .ok_or("Wert der Variablen nicht gefunden")?;
    slot["expression"] = json!(expression);
    let fid = feat["featureId"].as_str().ok_or("Variablen-Feature ohne Kennung")?.to_string();
    let r = c.post(
        &format!("partstudios/{}/features/featureid/{fid}", t.element()),
        json!({ "feature": feat, "serializationVersion": fs["serializationVersion"], "sourceMicroversion": fs["sourceMicroversion"] }),
    )?;
    match r["featureState"]["featureStatus"].as_str() {
        Some("ERROR") => Err(format!("Onshape: #{name} = {expression} ergibt einen Fehler im Teilestudio")),
        _ => Ok(()),
    }
}

/// Parameterstudie: Variable setzen und die Geometrie dazu als STEP holen (Pfad auf diesem Rechner)
pub fn study_value(url: &str, name: &str, expression: &str) -> Result<String, String> {
    set_variable(url, name, expression)?;
    let t = parse_url(url)?;
    let c = Client::new(&t)?;
    let data = export_step(&c, &t, false)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = std::env::temp_dir().join(format!("projekt-fem-onshape-studie-{stamp}.step"));
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Zahl mit Komma, wie im Datenblatt
fn de(v: &Value, digits: usize) -> Option<String> {
    let x = v.as_f64()?;
    Some(format!("{x:.digits$}").replace('.', ","))
}

/// Kurzer Ergebnistext für die Beschreibung, z. B. „[FEM 06.11.2026: S = 1,21 (Bruch 1,86) · σv 194 MPa · …]“
pub fn result_text(s: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(v) = de(&s["FEM_Sicherheit"], 2) {
        parts.push(match de(&s["FEM_Sicherheit_Bruch"], 2) {
            Some(b) => format!("S = {v} (Bruch {b})"),
            None => format!("S = {v}"),
        });
    }
    if let Some(v) = de(&s["FEM_SigmaV_MPa"], 1) {
        parts.push(format!("σv {v} MPa"));
    }
    if let Some(v) = de(&s["FEM_Verformung_mm"], 3) {
        parts.push(format!("u {v} mm"));
    }
    if let Some(v) = de(&s["FEM_Masse_g"], 1) {
        parts.push(format!("{v} g"));
    }
    if let Some(v) = s["FEM_Werkstoff"].as_str() {
        parts.push(v.to_string());
    }
    if let Some(v) = s["FEM_Nachweis"].as_str() {
        parts.push(format!("Nachweis {v}"));
    }
    let date = s["FEM_Datum"].as_str().and_then(|d| d.split(',').next()).unwrap_or("").trim().to_string();
    format!("[FEM {date}: {}]", parts.join(" · "))
}

/// vorhandenen FEM-Eintrag in einer Beschreibung ersetzen, übrigen Text behalten
pub fn merge_description(old: &str, fem: &str) -> String {
    let mut base = old.to_string();
    if let Some(i) = base.find("[FEM ") {
        let end = base[i..].find(']').map(|j| i + j + 1).unwrap_or(base.len());
        base.replace_range(i..end, "");
    }
    let base = base.trim();
    if base.is_empty() { fem.to_string() } else { format!("{base} {fem}") }
}

/// Ergebniswerte in die Beschreibung der Teile des Teilestudios schreiben. Gibt (Teilname, Text, Anzahl Teile) zurück.
pub fn write_result(url: &str) -> Result<(String, String, usize), String> {
    let t = parse_url(url)?;
    if t.wvm != "w" {
        return Err("Ergebnisse lassen sich nur in den Arbeitsbereich schreiben, nicht in eine gespeicherte Version".into());
    }
    let c = Client::new(&t)?;
    let (name, assembly) = part_name(&c, &t)?;
    if assembly {
        return Err("Ergebnisse zurück nach Onshape gehen bisher nur für Teilestudios, nicht für Baugruppen".into());
    }
    let summary = crate::cad::summary(&name).ok_or(format!("Für „{name}“ gibt es noch kein Ergebnis – erst in Projekt-FEM rechnen"))?;
    let text = result_text(&summary);
    let parts = c.get(&format!("parts/{}", t.element()))?;
    let parts: Vec<String> = parts
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|p| p["bodyType"].as_str().is_none_or(|b| b == "solid"))
                .filter_map(|p| p["partId"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if parts.is_empty() {
        return Err("Im Teilestudio ist kein Volumenteil".into());
    }
    for pid in &parts {
        let path = format!("metadata/{}/p/{}", t.element(), urlencode(pid));
        let meta = c.get(&path)?;
        let prop = meta["properties"]
            .as_array()
            .and_then(|a| a.iter().find(|p| p["name"].as_str() == Some("Description")))
            .ok_or("Onshape liefert keine Eigenschaft „Description“")?;
        let id = prop["propertyId"].as_str().ok_or("Eigenschaft ohne Kennung")?;
        let value = merge_description(prop["value"].as_str().unwrap_or(""), &text);
        c.post(&path, json!({ "properties": [{ "propertyId": id, "value": value }] }))?;
    }
    Ok((name, text, parts.len()))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adresse_lesen() {
        let t = parse_url("https://cad.onshape.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98?renderMode=0").unwrap();
        assert_eq!(t.base, "https://cad.onshape.com");
        assert_eq!(t.wvm, "w");
        assert_eq!(t.element(), "d/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98");
        assert!(parse_url("https://cad.onshape.com/documents/abc").is_err());
        assert!(parse_url("https://example.com/").is_err());
        // Schlüssel dürfen nie an fremde Rechner gehen
        for evil in [
            "https://evil.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
            "https://evil.com#.onshape.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
            "https://cad.onshape.com@evil.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
            "https://evil.com?.onshape.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
            "http://cad.onshape.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
            "https://cad.onshape.com:444/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
            "https://xonshape.com/documents/0123456789abcdef01234567/w/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98",
        ] {
            assert!(parse_url(evil).is_err(), "{evil}");
        }
        assert!(parse_url("https://firma.onshape.com/documents/0123456789abcdef01234567/v/89abcdef0123456789abcdef/e/fedcba9876543210fedcba98").is_ok());
    }

    #[test]
    fn ausdruck_zerlegen() {
        assert_eq!(split_expression("5 mm"), Some((5.0, "mm".into())));
        assert_eq!(split_expression("12.5"), Some((12.5, "".into())));
        assert_eq!(split_expression("30deg"), Some((30.0, "deg".into())));
        assert_eq!(split_expression("#a * 2"), None);
        assert_eq!(split_expression("2 * #a"), None);
    }

    #[test]
    fn vorschaubild_nur_von_onshape() {
        let b = "https://cad.onshape.com";
        assert!(thumb_url("https://cad.onshape.com/api/thumbnails/d/abc/w/def/s/70x40?t=1", b).is_ok());
        assert!(thumb_url("https://firma.onshape.com/api/thumbnails/x", b).is_ok());
        for evil in [
            "https://evil.example.com/api/x",
            "https://cad.onshape.com.evil.com/api/x",
            "http://cad.onshape.com/api/x",
            "https://cad.onshape.com/../api/x",
            "https://cad.onshape.com/static/x",
            "https://user@evil.com/api/x",
            "https://cad.onshape.com//evil.com/api",
            "javascript:alert(1)",
        ] {
            assert!(thumb_url(evil, b).is_err(), "{evil}");
        }
        // Test gegen den Nachbau: gleicher Pfad beim Nachbau
        assert_eq!(thumb_url("https://cad.onshape.com/api/t/1", "http://127.0.0.1:9912").unwrap(), "http://127.0.0.1:9912/api/t/1");
    }

    #[test]
    fn beschreibung() {
        let s = json!({ "FEM_Sicherheit": 1.213, "FEM_Sicherheit_Bruch": 1.858, "FEM_SigmaV_MPa": 193.7, "FEM_Verformung_mm": 0.1952,
            "FEM_Masse_g": 106.5, "FEM_Werkstoff": "S235JR", "FEM_Nachweis": "nicht erfüllt", "FEM_Datum": "6.11.2026, 10:00:21" });
        let t = result_text(&s);
        assert_eq!(t, "[FEM 6.11.2026: S = 1,21 (Bruch 1,86) · σv 193,7 MPa · u 0,195 mm · 106,5 g · S235JR · Nachweis nicht erfüllt]");
        assert_eq!(merge_description("", &t), t);
        let once = merge_description("Hebel für Presse", &t);
        assert_eq!(merge_description(&once, "[FEM neu]"), "Hebel für Presse [FEM neu]");
    }
}
