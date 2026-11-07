use nalgebra::{Matrix3, SymmetricEigen};

use crate::material::stress_to_layers;
use crate::Material;

/// Ergebnis einer statischen Rechnung, alle Größen an den Knoten.
#[derive(Debug, Clone)]
pub struct Results {
    pub displacement: Vec<[f64; 3]>,
    /// Spannungstensor (Voigt: xx, yy, zz, xy, yz, zx), über angrenzende Elemente gemittelt
    pub stress: Vec<[f64; 6]>,
    pub von_mises: Vec<f64>,
    /// Hauptspannungen σ1 ≥ σ2 ≥ σ3
    pub principal: Vec<[f64; 3]>,
    /// Summe der Lagerreaktionen je Lagergruppe
    pub reactions: Vec<(String, [f64; 3])>,
    /// Summe aller äußeren Lasten
    pub total_load: [f64; 3],
    /// Summe aller Lagerreaktionen (jeder Knoten einmal) – muss die Last ausgleichen
    pub total_reaction: [f64; 3],
    /// Anzahl der Unbekannten (freie Freiheitsgrade)
    pub n_equations: usize,
    /// Iterationen des iterativen Lösers (`None` = direkter Löser)
    pub iterations: Option<usize>,
    /// Auslastung je Knoten gegen Fließen (Re/Rp, ersatzweise Rm), bei Schichtaufbau richtungsabhängig; 1 = Grenze
    pub utilization: Option<Vec<f64>>,
    /// Anteil Schichthaftung (Zug quer zu den Schichten + Schub zwischen den Schichten)
    pub utilization_layers: Option<Vec<f64>>,
    /// Sicherheit gegen Bruch (Rm), falls angegeben
    pub safety_break: Option<f64>,
    /// 3D-Druck mit Füllung: Auslastung im Infill je Knoten (die Wand steckt in `utilization`)
    pub utilization_infill: Option<Vec<f64>>,
    /// 3D-Druck mit Füllung: Wandanteil je Knoten (1 = volle Wand/Deckschicht, 0 = Infill)
    pub shell_fraction: Option<Vec<f64>>,
    /// tatsächlich mit Material gefülltes Volumen [mm³] (mit Infill: Wand + Kern × Füllgrad)
    pub solid_volume: f64,
    /// Schweißnähte: übertragene Kräfte und Nahtspannungen
    pub welds: Vec<crate::weld::WeldResult>,
    /// Baugruppe: Kennwerte je Körper (leer bei einem Körper)
    pub bodies: Vec<BodyResult>,
    /// Schraubenkräfte
    pub bolts: Vec<crate::bolt::BoltResult>,
    /// Knoten an der Krafteinleitung der Schrauben (örtliche Spitzen, nicht im σv-Nachweis); leer = keine Schrauben
    pub bolt_zone: Vec<bool>,
    /// Kontakt in den Fugen (geschlossen, klafft, rutscht, Klemmkraft)
    pub joints: Vec<crate::contact::JointResult>,
    /// Rechendurchgänge für den Kontakt (1 = ohne Kontakt)
    pub contact_passes: usize,
    /// Kontaktzustände haben sich zuletzt nicht mehr geändert
    pub contact_converged: bool,
}

/// Kennwerte eines Körpers der Baugruppe (Spannungen nur aus seinen eigenen Elementen gemittelt)
#[derive(Debug, Clone, serde::Serialize)]
pub struct BodyResult {
    pub body: i32,
    pub name: String,
    pub material: String,
    /// Volumen [mm³]
    pub volume: f64,
    pub max_von_mises: f64,
    pub max_displacement: f64,
    /// Sicherheit gegen Fließen (bzw. Rm), falls der Werkstoff Festigkeiten hat
    pub safety: Option<f64>,
    /// Kräfte, die andere Körper über gemeinsame (verklebte) Flächen auf diesen Körper übertragen: (Körper, Kraft [N])
    pub interfaces: Vec<(i32, [f64; 3])>,
}

/// Auslastung je Knoten: (gesamt, Schichthaftung). Gesamt = max(σv / R_xy, Schichthaftung).
/// Schichthaftung = √((max(σ_z, 0) / R_z)² + (τ_z / S_z)²) mit Spannungen in Schichtkoordinaten.
pub fn utilization(material: &Material, stress: &[[f64; 6]], brk: bool) -> Option<(Vec<f64>, Option<Vec<f64>>)> {
    let st = Strength::of(material, brk)?;
    let mut total = Vec::with_capacity(stress.len());
    let mut lay = st.layer.map(|_| Vec::with_capacity(stress.len()));
    for s in stress {
        let (u, a) = st.eval(s);
        if let Some(lay) = lay.as_mut() {
            lay.push(a);
        }
        total.push(u);
    }
    Some((total, lay))
}

/// Festigkeiten eines Werkstoffs für die Auslastung an einem Punkt
#[derive(Debug, Clone)]
pub struct Strength {
    r_xy: f64,
    layer: Option<(f64, f64)>,
    rot: Option<nalgebra::Matrix3<f64>>,
}

impl Strength {
    pub fn of(material: &Material, brk: bool) -> Option<Strength> {
        let (r_xy, layer) = material.strengths(brk)?;
        Some(Strength { r_xy, layer, rot: material.layers.as_ref().map(|l| l.rotation()) })
    }

    /// (Auslastung gesamt, Anteil Schichthaftung)
    pub fn eval(&self, s: &[f64; 6]) -> (f64, f64) {
        let mut u = von_mises(s) / self.r_xy;
        let mut a = 0.0;
        if let (Some((r_z, s_z)), Some(r)) = (self.layer, self.rot.as_ref()) {
            let l = stress_to_layers(s, r);
            a = ((l[2].max(0.0) / r_z).powi(2) + (l[4] * l[4] + l[5] * l[5]) / (s_z * s_z)).sqrt();
            u = u.max(a);
        }
        (u, a)
    }
}

pub fn von_mises(s: &[f64; 6]) -> f64 {
    let [xx, yy, zz, xy, yz, zx] = *s;
    (0.5 * ((xx - yy).powi(2) + (yy - zz).powi(2) + (zz - xx).powi(2)) + 3.0 * (xy * xy + yz * yz + zx * zx)).sqrt()
}

pub fn principal(s: &[f64; 6]) -> [f64; 3] {
    let [xx, yy, zz, xy, yz, zx] = *s;
    let m = Matrix3::new(xx, xy, zx, xy, yy, yz, zx, yz, zz);
    let mut ev: Vec<f64> = SymmetricEigen::new(m).eigenvalues.iter().copied().collect();
    ev.sort_by(|a, b| b.partial_cmp(a).unwrap());
    [ev[0], ev[1], ev[2]]
}

impl Results {
    /// (Knoten, Betrag) der größten Verschiebung
    pub fn max_displacement(&self) -> (usize, f64) {
        argmax(self.displacement.iter().map(|u| (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt()))
    }

    /// (Knoten, Wert) der größten Vergleichsspannung nach von Mises
    pub fn max_von_mises(&self) -> (usize, f64) {
        argmax(self.von_mises.iter().copied())
    }

    /// Knoten zählt für den Nachweis (nicht an der Krafteinleitung einer Schraube)
    pub fn rated(&self, n: usize) -> bool {
        !self.bolt_zone.get(n).copied().unwrap_or(false)
    }

    /// (Knoten, Wert) der größten Vergleichsspannung außerhalb der Krafteinleitung der Schrauben
    pub fn max_von_mises_rated(&self) -> (usize, f64) {
        argmax(self.von_mises.iter().enumerate().map(|(n, &v)| if self.rated(n) { v } else { f64::NEG_INFINITY }))
    }

    /// Sicherheit gegen Fließen: 1 / größte Auslastung (isotrop: Re / σv,max; ohne Re mit Rm), ohne die
    /// Krafteinleitung der Schrauben
    pub fn safety_factor(&self, _material: &Material) -> Option<f64> {
        self.max_utilization().map(|(_, u)| 1.0 / u.max(1e-300))
    }

    /// (Knoten, Wert) der größten Auslastung (ohne die Krafteinleitung der Schrauben)
    pub fn max_utilization(&self) -> Option<(usize, f64)> {
        self.utilization.as_ref().map(|u| argmax(u.iter().enumerate().map(|(n, &v)| if self.rated(n) { v } else { f64::NEG_INFINITY })))
    }
}

fn argmax(it: impl Iterator<Item = f64>) -> (usize, f64) {
    it.enumerate().fold((0, f64::NEG_INFINITY), |acc, (i, v)| if v > acc.1 { (i, v) } else { acc })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vergleichsspannung_einachsig_und_schub() {
        assert!((von_mises(&[100.0, 0.0, 0.0, 0.0, 0.0, 0.0]) - 100.0).abs() < 1e-12);
        assert!((von_mises(&[0.0, 0.0, 0.0, 10.0, 0.0, 0.0]) - 10.0 * 3f64.sqrt()).abs() < 1e-12);
        let p = principal(&[0.0, 0.0, 0.0, 10.0, 0.0, 0.0]);
        assert!((p[0] - 10.0).abs() < 1e-12 && p[1].abs() < 1e-12 && (p[2] + 10.0).abs() < 1e-12);
    }
}
