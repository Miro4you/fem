use nalgebra::{Matrix3, SymmetricEigen};

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

    /// Sicherheit gegen Fließen S = Re / σv,max (falls Streckgrenze bekannt)
    pub fn safety_factor(&self, material: &Material) -> Option<f64> {
        let (_, s) = self.max_von_mises();
        material.yield_strength.map(|re| re / s.max(1e-300))
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
