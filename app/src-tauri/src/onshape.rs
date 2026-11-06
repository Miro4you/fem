//! Onshape: Teilestudio über die Onshape-API als STEP holen und Ergebniswerte zurückschreiben.
//!
//! Onshape läuft im Browser, ein Add-in wie bei Fusion oder SolidWorks gibt es dort nicht. Stattdessen:
//! Lesezeichen „→ Projekt-FEM“ in der Lesezeichenleiste schickt die Adresse des offenen Teilestudios an
//! Projekt-FEM, Projekt-FEM holt die STEP-Datei mit den API-Schlüsseln des Benutzers (Onshape → Developer
//! Portal → API keys). „FEM-Ergebnis → Onshape“ schreibt die Ergebniswerte in die Beschreibung der Teile.
//! Die Schlüssel liegen nur auf dem rechnenden Rechner (`~/.config/projekt-fem/onshape.json`).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Keys {
    pub access: String,
    pub secret: String,
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
        ureq::Error::Status(401, _) => "Onshape lehnt die API-Schlüssel ab – in Projekt-FEM unter „CAD“ neu eintragen".into(),
        ureq::Error::Status(403, _) => "Kein Zugriff auf dieses Dokument (API-Schlüssel ohne Lese- bzw. Schreibrecht?)".into(),
        ureq::Error::Status(404, _) => "Onshape findet das Teilestudio nicht – Adresse prüfen".into(),
        ureq::Error::Status(code, r) => format!("Onshape meldet Fehler {code}: {}", r.into_string().unwrap_or_default().chars().take(300).collect::<String>()),
        ureq::Error::Transport(t) => format!("Onshape nicht erreichbar: {t}"),
    }
}

impl Client {
    fn new(t: &Target) -> Result<Client, String> {
        use base64::Engine;
        let k = load_keys().ok_or("Onshape-API-Schlüssel fehlen – in Projekt-FEM unter „CAD“ eintragen")?;
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", k.access, k.secret)));
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build();
        Ok(Client { base: t.base.clone(), auth, agent })
    }

    fn get(&self, path: &str) -> Result<Value, String> {
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
        let r = self
            .agent
            .get(&format!("{}/api/v6/{path}", self.base))
            .set("Authorization", &self.auth)
            .set("Accept", "application/octet-stream")
            .call()
            .map_err(api_error)?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut r.into_reader(), &mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

/// Teilname in Projekt-FEM: „Dokument - Teilestudio“ (bleibt über Änderungen gleich)
fn part_name(c: &Client, t: &Target) -> Result<String, String> {
    let doc = c.get(&format!("documents/{}", t.did))?;
    let els = c.get(&format!("documents/d/{}/{}/{}/elements?elementId={}", t.did, t.wvm, t.wvmid, t.eid))?;
    let el = els.as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
    let kind = el["elementType"].as_str().unwrap_or("PARTSTUDIO");
    if kind != "PARTSTUDIO" {
        return Err(if kind == "ASSEMBLY" {
            "Baugruppen kann Projekt-FEM noch nicht rechnen – bitte das Teilestudio öffnen".into()
        } else {
            "Bitte ein Teilestudio öffnen (der aktive Reiter ist kein Teilestudio)".into()
        });
    }
    let d = doc["name"].as_str().unwrap_or("Onshape");
    Ok(match el["name"].as_str() {
        Some(e) if !e.is_empty() => format!("{d} - {e}"),
        _ => d.to_string(),
    })
}

/// Teilestudio als STEP holen und wie ein Teil aus dem CAD an Projekt-FEM übergeben
pub fn import(url: &str) -> Result<crate::cad::Incoming, String> {
    let t = parse_url(url)?;
    let c = Client::new(&t)?;
    let name = part_name(&c, &t)?;
    let tr = c.post(
        &format!("partstudios/{}/translations", t.element()),
        json!({ "formatName": "STEP", "storeInDocument": false, "flattenAssemblies": false, "yAxisIsUp": false }),
    )?;
    let id = tr["id"].as_str().ok_or("Onshape hat die STEP-Ausgabe nicht gestartet")?.to_string();
    // Onshape erzeugt die Datei im Hintergrund – nachfragen, bis sie fertig ist
    let start = Instant::now();
    let fid = loop {
        let s = c.get(&format!("translations/{id}"))?;
        match s["requestState"].as_str().unwrap_or("") {
            "DONE" => break s["resultExternalDataIds"][0].as_str().ok_or("Onshape hat keine STEP-Datei geliefert")?.to_string(),
            "FAILED" => return Err(format!("STEP-Ausgabe in Onshape fehlgeschlagen: {}", s["failureReason"].as_str().unwrap_or("unbekannt"))),
            _ if start.elapsed() > Duration::from_secs(180) => return Err("STEP-Ausgabe in Onshape dauert zu lange".into()),
            _ => std::thread::sleep(Duration::from_millis(700)),
        }
    };
    let data = c.bytes(&format!("documents/d/{}/externaldata/{fid}", t.did))?;
    crate::cad::receive(&name, "Onshape", &data)
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
    let name = part_name(&c, &t)?;
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
