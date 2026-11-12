//! Verbindung zum Draftpad-Server (Online-Ablage von Draftpad – z. B. Raspberry Pi im Heimnetz oder eigene Domain).
//!
//! Draftpad-Schnittstelle (`server/server.mjs` im Draftpad-Repo):
//! `GET /api/health` → `{ ok, app: "skizzen-cad", auth }`, `GET /api/drawings` → Liste mit Vorschaubild,
//! `GET /api/drawings/<id>` → Zeichnung, `GET /api/drawings/<id>/meta` (neuere Draftpad-Fassungen).
//! Optionales Passwort: `Authorization: Bearer <token>`.
//!
//! Die Abfragen laufen über den Rechenkern: das Passwort bleibt im Einstellungsordner (nie in der Oberfläche),
//! und es geht auch, wenn Projekt-FEM per https und Draftpad per http erreichbar ist.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    pub url: String,
    #[serde(default)]
    pub token: String,
}

fn config_path() -> Option<PathBuf> {
    Some(crate::server::config_dir()?.join("draftpad.json"))
}

/// Einstellung: Umgebungsvariablen (`PROJEKT_FEM_DRAFTPAD`, `PROJEKT_FEM_DRAFTPAD_PASSWORT`) vor der gespeicherten Datei
pub fn load() -> Option<Config> {
    if let Ok(url) = std::env::var("PROJEKT_FEM_DRAFTPAD") {
        if !url.trim().is_empty() {
            return Some(Config { url: url.trim().into(), token: std::env::var("PROJEKT_FEM_DRAFTPAD_PASSWORT").unwrap_or_default() });
        }
    }
    let c: Config = serde_json::from_str(&std::fs::read_to_string(config_path()?).ok()?).ok()?;
    (!c.url.trim().is_empty()).then_some(c)
}

/// Darf die Adresse über die Oberfläche geändert werden? Nicht auf einem Server im Internet mit Zugangsschlüssel –
/// dort nur über Umgebungsvariablen (sonst könnte man den Server beliebige Adressen abrufen lassen).
pub fn can_configure() -> bool {
    std::env::var("PROJEKT_FEM_DRAFTPAD").map(|v| v.trim().is_empty()).unwrap_or(true) && !(crate::server::public_mode() && !crate::server::without_key())
}

/// Adresse und Passwort speichern. `token: None` = Passwort behalten, `Some("")` = Passwort löschen; leere Adresse = Verbindung entfernen.
pub fn save(url: &str, token: Option<&str>) -> Result<(), String> {
    if !can_configure() {
        return Err("Die Draftpad-Adresse ist auf diesem Server fest eingestellt (PROJEKT_FEM_DRAFTPAD)".into());
    }
    let p = config_path().ok_or("Kein Konfigurationsordner gefunden")?;
    let url = url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        let _ = std::fs::remove_file(&p);
        return Ok(());
    }
    if url.contains(char::is_whitespace) || url.len() > 300 {
        return Err("Ungültige Adresse".into());
    }
    let old = load().map(|c| c.token).unwrap_or_default();
    let token = match token {
        Some(t) => t.trim().to_string(),
        None => old,
    };
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_string_pretty(&Config { url, token }).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Adresse, wie sie im Browser geöffnet wird (ohne /api), mit http:// davor, falls nichts angegeben
pub fn public_url(c: &Config) -> String {
    let u = c.url.trim().trim_end_matches('/');
    if u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else {
        format!("http://{u}")
    }
}

/// Draftpad-Kennungen: Kleinbuchstaben, Ziffern, Bindestriche (wie `ID` in Draftpads server.mjs)
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn call(c: &Config, path: &str) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
    let mut req = agent.get(&format!("{}/api{path}", public_url(c))).set("Accept", "application/json");
    if !c.token.is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", c.token));
    }
    match req.call() {
        Ok(r) => r.into_json::<Value>().map_err(|_| "Keine gültige Antwort vom Draftpad-Server".to_string()),
        Err(ureq::Error::Status(401, _)) => Err("Draftpad: Passwort fehlt oder ist falsch".into()),
        Err(ureq::Error::Status(404, _)) => Err("Draftpad: nicht gefunden".into()),
        Err(ureq::Error::Status(code, _)) => Err(format!("Draftpad meldet Fehler {code}")),
        Err(ureq::Error::Transport(t)) => Err(format!("Draftpad-Server nicht erreichbar ({})", t.kind())),
    }
}

#[derive(Serialize, Default)]
pub struct Status {
    pub configured: bool,
    /// Adresse zum Öffnen im Browser (ohne Passwort)
    pub url: Option<String>,
    pub password: bool,
    pub can_configure: bool,
    pub reachable: bool,
    pub auth_ok: bool,
    pub error: Option<String>,
}

pub fn status() -> Status {
    let Some(c) = load() else {
        return Status { can_configure: can_configure(), ..Default::default() };
    };
    let mut s = Status { configured: true, url: Some(public_url(&c)), password: !c.token.is_empty(), can_configure: can_configure(), ..Default::default() };
    match call(&c, "/health") {
        Ok(h) if h["app"] == "skizzen-cad" => {
            s.reachable = true;
            if h["auth"] == true {
                match call(&c, "/drawings?thumbs=0") {
                    Ok(_) => s.auth_ok = true,
                    Err(e) => s.error = Some(e),
                }
            } else {
                s.auth_ok = true;
            }
        }
        Ok(_) => s.error = Some("Unter dieser Adresse läuft kein Draftpad-Server".into()),
        Err(e) => s.error = Some(e),
    }
    s
}

fn config() -> Result<Config, String> {
    load().ok_or_else(|| "Draftpad ist nicht verbunden – Adresse unter Einstellungen › CAD-Verbindungen eintragen".to_string())
}

/// Zeichnungen der Online-Ablage (neueste zuerst); ohne Vorschaubilder, wenn `thumbs` aus ist
pub fn list(thumbs: bool) -> Result<Value, String> {
    let c = config()?;
    let mut v = call(&c, if thumbs { "/drawings" } else { "/drawings?thumbs=0" })?;
    if !thumbs {
        // ältere Draftpad-Fassungen kennen ?thumbs=0 nicht
        if let Some(a) = v.as_array_mut() {
            for e in a {
                if let Some(o) = e.as_object_mut() {
                    o.remove("thumb");
                }
            }
        }
    }
    Ok(v)
}

/// Eine Zeichnung (Format „skizzen-cad“)
pub fn get(id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("Ungültige Draftpad-Kennung".into());
    }
    let d = call(&config()?, &format!("/drawings/{id}"))?;
    if d["format"] != "skizzen-cad" {
        return Err("Keine Draftpad-Zeichnung".into());
    }
    Ok(d)
}

/// Name und Änderungszeit einer Zeichnung (zum Erkennen von Änderungen)
pub fn meta(id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("Ungültige Draftpad-Kennung".into());
    }
    let c = config()?;
    match call(&c, &format!("/drawings/{id}/meta")) {
        Ok(m) if m.get("updated").is_some() => Ok(m),
        // ältere Draftpad-Fassung: aus der Liste
        _ => list(false)?
            .as_array()
            .and_then(|a| a.iter().find(|e| e["id"] == id).cloned())
            .ok_or_else(|| "Draftpad: Zeichnung nicht gefunden".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kennungen() {
        assert!(valid_id("welle-3x9k2a"));
        assert!(!valid_id("../geheim"));
        assert!(!valid_id("-a"));
        assert!(!valid_id("A1"));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(65)));
        assert_eq!(public_url(&Config { url: "192.168.1.20:8080/".into(), token: String::new() }), "http://192.168.1.20:8080");
        assert_eq!(public_url(&Config { url: "https://draftpad.example.de".into(), token: String::new() }), "https://draftpad.example.de");
    }
}
