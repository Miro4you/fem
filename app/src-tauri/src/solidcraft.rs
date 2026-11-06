//! SolidCraft (quelloffenes CAD in Rust, github.com/tangency-labs/solidcraft): Live-Verbindung über seinen
//! Steuerkanal.
//!
//! SolidCraft öffnet beim Start einen Steuerkanal auf 127.0.0.1 (Port 27878 oder den nächsten freien bis 27893)
//! und legt Port und Zugangsschlüssel in seinem Datenordner ab (`control/current.port`, `control/<port>.token`,
//! nur für den Benutzer lesbar). Projekt-FEM liest beides und spricht JSON-Zeilen
//! (`docs/control-protocol.md` in SolidCraft):
//! - `control.subscribe` → `design.changed`-Meldungen bei jeder Änderung → Geometrie als STEP holen
//!   (`file.export_step`) und wie ein Teil aus einem Add-in übernehmen (gleiches Design = neue Version);
//! - Ergebnis zurück: Benutzerparameter `FEM_…` (`parameters.add`/`.change`) und die Design-Eigenschaft
//!   `io.github.miro4you.projekt-fem` (`document.metadata.set`);
//! - Parameterstudie: einen Parameter setzen, exportieren, rechnen – zum Schluss den alten Wert zurück.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// Schlüssel der Design-Eigenschaft (umgekehrter Domainname, wie SolidCraft es für fremde Programme vorsieht)
pub const METADATA_KEY: &str = "io.github.miro4you.projekt-fem";
/// so lange nach der letzten Änderung warten, bevor exportiert wird (Maß wird noch gezogen)
const SETTLE: Duration = Duration::from_millis(1200);

/// Ordner mit Port- und Schlüsseldatei
fn control_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("SOLIDCRAFT_CONTROL_DIR") {
        return Some(PathBuf::from(d));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return Some(home?.join("Library/Application Support/SolidCraft/control"));
    }
    if cfg!(windows) {
        return Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("SolidCraft").join("control"));
    }
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".local/share")))?;
    Some(data.join("solidcraft").join("control"))
}

/// Port und Zugangsschlüssel der laufenden SolidCraft-App
fn discover() -> Result<(u16, String), String> {
    let dir = control_dir().ok_or("Datenordner von SolidCraft nicht gefunden")?;
    let port: u16 = std::fs::read_to_string(dir.join("current.port"))
        .ok()
        .and_then(|t| t.trim().parse().ok())
        .ok_or("SolidCraft läuft nicht (oder „Let AI agents connect“ ist in den SolidCraft-Einstellungen aus)")?;
    let token = match std::env::var("SOLIDCRAFT_CONTROL_TOKEN") {
        Ok(t) if !t.is_empty() => t,
        _ => std::fs::read_to_string(dir.join(format!("{port}.token")))
            .map_err(|_| format!("Zugangsschlüssel von SolidCraft (Port {port}) nicht lesbar"))?
            .trim()
            .to_string(),
    };
    Ok((port, token))
}

/// Verbindung zum Steuerkanal (JSON-Zeilen)
struct Conn {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next: u64,
    token: Option<String>,
    /// angefangene Zeile (Lesen mit Zeitlimit)
    partial: String,
}

impl Conn {
    fn open() -> Result<Conn, String> {
        let (port, token) = discover()?;
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let s = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
            .map_err(|e| format!("SolidCraft (Port {port}) antwortet nicht: {e}"))?;
        let _ = s.set_nodelay(true);
        let writer = s.try_clone().map_err(|e| e.to_string())?;
        Ok(Conn { reader: BufReader::new(s), writer, next: 1, token: Some(token), partial: String::new() })
    }

    fn send(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next;
        self.next += 1;
        let mut req = json!({ "id": id, "method": method, "params": params });
        if let Some(t) = self.token.take() {
            req["token"] = json!(t);
        }
        let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";
        self.writer.write_all(line.as_bytes()).map_err(|e| format!("SolidCraft-Verbindung unterbrochen: {e}"))?;
        Ok(id)
    }

    /// nächste vollständige Zeile; `Ok(None)` bei Zeitablauf
    fn line(&mut self, timeout: Duration) -> Result<Option<Value>, String> {
        let _ = self.reader.get_ref().set_read_timeout(Some(timeout));
        match self.reader.read_line(&mut self.partial) {
            Ok(0) => Err("SolidCraft hat die Verbindung beendet".into()),
            Ok(_) if self.partial.ends_with('\n') => {
                let l = std::mem::take(&mut self.partial);
                Ok(serde_json::from_str(l.trim()).ok())
            }
            Ok(_) => Ok(None),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(None),
            Err(e) => Err(format!("SolidCraft-Verbindung unterbrochen: {e}")),
        }
    }

    /// Anfrage senden und auf die Antwort warten (Meldungen dazwischen werden übergangen)
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.send(method, params)?;
        let until = Instant::now() + Duration::from_secs(180);
        while Instant::now() < until {
            let Some(v) = self.line(Duration::from_secs(5))? else { continue };
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if v.get("ok") == Some(&json!(true)) {
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
            let e = v.get("error").and_then(Value::as_str).unwrap_or("unbekannter Fehler");
            return Err(if e.starts_with("unauthorized") {
                "SolidCraft lehnt den Zugangsschlüssel ab – SolidCraft neu starten".into()
            } else {
                format!("SolidCraft: {e}")
            });
        }
        Err(format!("SolidCraft antwortet nicht auf {method}"))
    }

    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        self.call("engine.execute", json!({ "command": command, "params": params }))
    }
}

// --- Zustand der Live-Verbindung ----------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    /// Projekt-FEM folgt dem Design
    pub live: bool,
    /// SolidCraft erreichbar (letzter Versuch)
    pub connected: bool,
    pub name: Option<String>,
    pub document_id: Option<String>,
    pub revision: Option<u64>,
    /// Zeitpunkt der letzten übernommenen Version (ms seit 1970, die Oberfläche zeigt Ortszeit)
    pub last_sync: Option<u64>,
    pub message: Option<String>,
    /// Ergebnis nach jeder Rechnung automatisch eintragen
    pub auto_result: bool,
    /// während einer Parameterstudie: Änderungen nicht übernehmen
    pub paused: bool,
}

struct Live {
    stop: Arc<AtomicBool>,
}

fn status_cell() -> &'static Mutex<Status> {
    static S: OnceLock<Mutex<Status>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn live_cell() -> &'static Mutex<Option<Live>> {
    static L: OnceLock<Mutex<Option<Live>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// Prüfsumme der eigentlichen Geometrie (ohne Kopf mit Zeitstempel)
fn geometry_hash(step: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let text = String::from_utf8_lossy(step);
    let data = text.find("DATA;").map(|i| &text[i..]).unwrap_or(&text);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut h);
    h.finish()
}

fn last_hash() -> &'static Mutex<Option<(String, u64)>> {
    static H: OnceLock<Mutex<Option<(String, u64)>>> = OnceLock::new();
    H.get_or_init(Default::default)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Name des offenen Designs (aus `document.export`; dort steht der Name, unter dem es gespeichert ist)
fn design_name(c: &mut Conn) -> Result<String, String> {
    let d = c.call("document.export", json!({}))?;
    let n = d.get("name").and_then(Value::as_str).unwrap_or("").trim().trim_end_matches(".sc").to_string();
    Ok(if n.is_empty() { "SolidCraft".into() } else { n })
}

fn export_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("projekt-fem-solidcraft-{}.step", crate::cad::clean_name(tag).replace(' ', "_")))
}

/// Geometrie des offenen Designs als STEP holen (Datei auf diesem Rechner)
fn export_step(c: &mut Conn, path: &std::path::Path) -> Result<Vec<u8>, String> {
    let _ = std::fs::remove_file(path);
    c.execute("file.export_step", json!({ "path": path.display().to_string() })).map_err(|e| {
        if e.contains("bod") {
            format!("{e} (hat das Design schon einen Körper?)")
        } else {
            e
        }
    })?;
    std::fs::read(path).map_err(|e| format!("STEP-Datei von SolidCraft nicht lesbar: {e}"))
}

/// Design holen und an Projekt-FEM geben; `force` = auch wenn sich die Geometrie nicht geändert hat
fn sync(c: &mut Conn, force: bool) -> Result<Option<crate::cad::Incoming>, String> {
    let name = design_name(c)?;
    let data = export_step(c, &export_path(&name))?;
    let h = geometry_hash(&data);
    {
        let mut last = last_hash().lock().unwrap();
        if !force && last.as_ref() == Some(&(name.clone(), h)) {
            return Ok(None);
        }
        *last = Some((name.clone(), h));
    }
    let inc = crate::cad::receive(&name, "SolidCraft", &data)?;
    let mut st = status_cell().lock().unwrap();
    st.name = Some(name);
    st.last_sync = Some(now_ms());
    st.message = None;
    Ok(Some(inc))
}

fn set_message(m: Option<String>, connected: bool) {
    let mut st = status_cell().lock().unwrap();
    st.message = m;
    st.connected = connected;
}

/// Hintergrund-Schleife: Änderungen abonnieren, nach einer Ruhepause übernehmen; bei Abbruch neu verbinden
fn run(stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        let session = (|| -> Result<(), String> {
            let mut sub = Conn::open()?;
            let first = sub.call("control.subscribe", json!({}))?;
            let mut cmd = Conn::open()?;
            {
                let mut st = status_cell().lock().unwrap();
                st.connected = true;
                st.message = None;
                st.document_id = first.get("document_id").and_then(Value::as_str).map(String::from);
                st.revision = first.get("revision").and_then(Value::as_u64);
            }
            // gleich zu Beginn das offene Design übernehmen
            let mut pending: Option<Instant> = Some(Instant::now() - SETTLE);
            while !stop.load(Ordering::Relaxed) {
                if let Some(ev) = sub.line(Duration::from_millis(300))? {
                    if ev.get("event").and_then(Value::as_str) == Some("design.changed") {
                        let p = ev.get("params").cloned().unwrap_or(Value::Null);
                        let mut st = status_cell().lock().unwrap();
                        st.document_id = p.get("document_id").and_then(Value::as_str).map(String::from);
                        st.revision = p.get("revision").and_then(Value::as_u64);
                        drop(st);
                        pending = Some(Instant::now());
                    }
                }
                let paused = status_cell().lock().unwrap().paused;
                if let Some(t) = pending {
                    if !paused && t.elapsed() >= SETTLE {
                        pending = None;
                        if let Err(e) = sync(&mut cmd, false) {
                            if e.contains("unterbrochen") || e.contains("beendet") {
                                return Err(e);
                            }
                            set_message(Some(e), true);
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = session {
            set_message(Some(e), false);
            // SolidCraft beendet oder noch nicht gestartet: später erneut versuchen
            for _ in 0..30 {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

// --- Schnittstelle für die Oberfläche --------------------------------------------------------------

/// Zustand; prüft dabei, ob SolidCraft erreichbar ist (falls nicht live verbunden)
pub fn status() -> Status {
    let live = live_cell().lock().unwrap().is_some();
    if !live {
        let ok = discover().and_then(|(port, _)| {
            TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(500)).map_err(|e| e.to_string())
        });
        let mut st = status_cell().lock().unwrap();
        st.connected = ok.is_ok();
        st.message = ok.err();
    }
    let mut st = status_cell().lock().unwrap().clone();
    st.live = live;
    st
}

/// Live-Verbindung ein-/ausschalten
pub fn set_live(on: bool) -> Status {
    let mut l = live_cell().lock().unwrap();
    if on && l.is_none() {
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        *last_hash().lock().unwrap() = None;
        std::thread::spawn(move || run(s));
        *l = Some(Live { stop });
    } else if !on {
        if let Some(live) = l.take() {
            live.stop.store(true, Ordering::Relaxed);
        }
    }
    drop(l);
    status()
}

pub fn set_auto_result(on: bool) {
    status_cell().lock().unwrap().auto_result = on;
}

/// einmal holen (ohne Live-Verbindung)
pub fn fetch_now() -> Result<crate::cad::Incoming, String> {
    let mut c = Conn::open()?;
    let inc = sync(&mut c, true)?.ok_or("nichts übernommen")?;
    set_message(None, true);
    Ok(inc)
}

/// Text- und Zahlenparameter für das Ergebnis
fn result_params(s: &Value) -> Vec<(&'static str, String, &'static str)> {
    let mut out = Vec::new();
    let num = |k: &str| s.get(k).and_then(Value::as_f64);
    for (k, unit) in [
        ("FEM_Sicherheit", ""),
        ("FEM_Sicherheit_Bruch", ""),
        ("FEM_SigmaV_MPa", ""),
        ("FEM_Verformung_mm", "mm"),
        ("FEM_Masse_g", ""),
    ] {
        if let Some(v) = num(k) {
            out.push((k, format!("{v}"), unit));
        }
    }
    for k in ["FEM_Nachweis", "FEM_Werkstoff", "FEM_Datum"] {
        if let Some(t) = s.get(k).and_then(Value::as_str) {
            // Text ohne Anführungszeichen (SolidCraft nimmt den Text wie er ist)
            out.push((k, t.replace('"', "'"), "text"));
        }
    }
    out
}

/// Ergebniswerte in das offene SolidCraft-Design schreiben: Parameter FEM_… und Design-Eigenschaft.
/// `name` = Teilname in Projekt-FEM (sonst der Name des offenen Designs).
pub fn write_result(name: Option<&str>) -> Result<String, String> {
    let mut c = Conn::open()?;
    let design = design_name(&mut c)?;
    let name = name.map(String::from).unwrap_or_else(|| design.clone());
    if crate::cad::clean_name(&name) != crate::cad::clean_name(&design) {
        return Err(format!("In SolidCraft ist „{design}“ offen, das Ergebnis gehört zu „{name}“"));
    }
    let summary = crate::cad::summary(&name).ok_or(format!("Für „{name}“ gibt es noch kein Ergebnis – erst in Projekt-FEM rechnen"))?;
    let existing: Vec<String> = c
        .execute("parameters.list", json!({ "filter": "user" }))?
        .get("parameters")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|p| p.get("name").and_then(Value::as_str).map(String::from)).collect())
        .unwrap_or_default();
    let mut steps = Vec::new();
    for (k, expr, unit) in result_params(&summary) {
        if existing.iter().any(|e| e == k) {
            steps.push(json!({ "command": "parameters.change", "params": { "name": k, "expression": expr } }));
        } else {
            steps.push(json!({ "command": "parameters.add", "params": { "name": k, "expression": expr, "unit": unit, "comment": "Projekt-FEM" } }));
        }
    }
    let mut meta = summary.clone();
    meta["programm"] = json!("Projekt-FEM");
    steps.push(json!({ "command": "document.metadata.set", "params": { "key": METADATA_KEY, "value": meta } }));
    let r = c.call("engine.batch", json!({ "commands": steps, "rollback": true, "verbose": false }))?;
    if let Some(f) = r.get("failed") {
        return Err(format!(
            "SolidCraft: {} ({})",
            f.get("error").and_then(Value::as_str).unwrap_or("Fehler"),
            f.get("command").and_then(Value::as_str).unwrap_or("")
        ));
    }
    Ok(crate::onshape::result_text(&summary))
}

/// nach einer Rechnung (Ergebnis gemerkt): bei „automatisch eintragen“ an SolidCraft geben
pub fn on_summary(name: &str) {
    let (auto, live, current) = {
        let st = status_cell().lock().unwrap();
        (st.auto_result, live_cell().lock().unwrap().is_some(), st.name.clone())
    };
    if auto && live && current.is_some_and(|c| crate::cad::clean_name(&c) == crate::cad::clean_name(name)) {
        let name = name.to_string();
        std::thread::spawn(move || {
            if let Err(e) = write_result(Some(&name)) {
                set_message(Some(e), true);
            }
        });
    }
}

/// Parameter des offenen Designs (für die Parameterstudie): Name, Ausdruck, Einheit, Wert
#[derive(Debug, Clone, Serialize)]
pub struct Param {
    pub name: String,
    pub expression: String,
    pub unit: String,
    pub value: Option<f64>,
}

pub fn params() -> Result<Vec<Param>, String> {
    let mut c = Conn::open()?;
    let r = c.execute("parameters.list", json!({ "filter": "all" }))?;
    Ok(r.get("parameters")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let name = p.get("name")?.as_str()?.to_string();
                    let unit = p.get("unit").and_then(Value::as_str).unwrap_or("").to_string();
                    if unit == "text" || name.starts_with("FEM_") {
                        return None;
                    }
                    Some(Param {
                        name,
                        expression: p.get("expression").and_then(Value::as_str).unwrap_or("").to_string(),
                        unit,
                        value: p.get("display_value").or_else(|| p.get("value")).and_then(Value::as_f64),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Parameterstudie: Übernahme neuer Versionen anhalten (während der Studie) bzw. wieder aufnehmen
pub fn pause(on: bool) {
    status_cell().lock().unwrap().paused = on;
}

/// Parameterstudie: Parameter setzen und die Geometrie dazu als STEP holen (Pfad auf diesem Rechner)
pub fn study_value(name: &str, expression: &str) -> Result<String, String> {
    let mut c = Conn::open()?;
    c.execute("parameters.change", json!({ "name": name, "expression": expression }))?;
    let path = std::env::temp_dir().join("projekt-fem-solidcraft-studie.step");
    export_step(&mut c, &path)?;
    // jede Studie hat ihre eigene Datei, damit sich Netze nicht vermischen
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let keep = std::env::temp_dir().join(format!("projekt-fem-solidcraft-studie-{stamp}.step"));
    std::fs::rename(&path, &keep).map_err(|e| e.to_string())?;
    Ok(keep.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pruefsumme_ohne_kopf() {
        let a = b"ISO-10303-21;\nHEADER;\nFILE_NAME('a','2026-11-06T10:00:00');\nENDSEC;\nDATA;\n#1=X();\nENDSEC;";
        let b = b"ISO-10303-21;\nHEADER;\nFILE_NAME('a','2026-11-06T11:11:11');\nENDSEC;\nDATA;\n#1=X();\nENDSEC;";
        let c = b"ISO-10303-21;\nHEADER;\nFILE_NAME('a','2026-11-06T11:11:11');\nENDSEC;\nDATA;\n#1=Y();\nENDSEC;";
        assert_eq!(geometry_hash(a), geometry_hash(b));
        assert_ne!(geometry_hash(a), geometry_hash(c));
    }

    #[test]
    fn ergebnis_als_parameter() {
        let s = json!({ "FEM_Sicherheit": 1.213, "FEM_Verformung_mm": 0.1952, "FEM_Massgeblich": null, "FEM_Nachweis": "nicht erfüllt" });
        let p = result_params(&s);
        assert!(p.contains(&("FEM_Sicherheit", "1.213".into(), "")));
        assert!(p.contains(&("FEM_Verformung_mm", "0.1952".into(), "mm")));
        assert!(p.contains(&("FEM_Nachweis", "nicht erfüllt".into(), "text")));
        assert_eq!(p.len(), 3);
    }
}
