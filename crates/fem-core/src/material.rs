use nalgebra::{Matrix3, SMatrix, Vector3};
use serde::{Deserialize, Serialize};

/// Linear-elastischer Werkstoff: isotrop oder – für 3D-Druck – schichtweise aufgebaut (transversal isotrop).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Material {
    #[serde(default)]
    pub name: String,
    /// Elastizitätsmodul E (bei Schichtaufbau: in der Schichtebene)
    #[serde(rename = "E")]
    pub e: f64,
    /// Querkontraktionszahl ν (in der Schichtebene)
    pub nu: f64,
    /// Streckgrenze Re bzw. Rp0,2 (optional, für die Sicherheit gegen Fließen)
    #[serde(default, rename = "yield")]
    pub yield_strength: Option<f64>,
    /// Zugfestigkeit Rm (optional, für die Sicherheit gegen Bruch)
    #[serde(default, rename = "tensile")]
    pub tensile_strength: Option<f64>,
    /// Schichtaufbau (3D-Druck): andere Werte quer zu den Schichten
    #[serde(default)]
    pub layers: Option<Layers>,
    /// Füllung (3D-Druck): volle Wände/Deckschichten außen, Infill innen
    #[serde(default)]
    pub infill: Option<Infill>,
    /// Dichte [g/cm³] (nur für Eigenfrequenzen in Baugruppen mit verschiedenen Werkstoffen nötig)
    #[serde(default, rename = "rho")]
    pub density: Option<f64>,
}

/// Füllmuster des Slicers
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InfillPattern {
    /// Gitter: Wände in zwei Richtungen, in Z durchgehend
    Gitter,
    /// Linien/Rechteck: je Schicht eine Richtung, abwechselnd gekreuzt
    Linien,
    /// Dreiecke: Wände in drei Richtungen, in Z durchgehend
    Dreiecke,
    /// Waben (Sechseck), in Z durchgehend
    Waben,
    /// Gyroid: räumlich, in allen Richtungen ähnlich
    Gyroid,
    /// Kubisch: schräge Ebenen in drei Richtungen
    Kubisch,
    /// Kreuz/Cross: nachgiebig (für flexible Teile gedacht)
    Kreuz,
}

impl InfillPattern {
    /// Näherung der Ersatzwerte als Anteil des vollen Werkstoffs, f(ρ) = k·ρⁿ + (1 − k)·ρ⁸
    /// (der ρ⁸-Anteil sorgt für f(1) = 1, also massiv bei 100 %).
    /// Rückgabe: (E in der Schicht, E quer, R in der Schicht, R quer) jeweils als (k, n).
    fn factors(self) -> [(f64, f64); 4] {
        use InfillPattern::*;
        match self {
            // gestreckte Wände: in der Ebene richtungsgemittelt ~ρ/3, in Z volle Wandfläche ~ρ
            Gitter => [(0.35, 1.0), (1.0, 1.0), (0.35, 1.0), (1.0, 1.0)],
            // nur Kreuzungspunkte verbinden die Schichten → quer ~ρ²
            Linien => [(0.3, 1.0), (1.0, 2.0), (0.3, 1.0), (1.0, 2.0)],
            Dreiecke => [(0.33, 1.0), (1.0, 1.0), (0.33, 1.0), (1.0, 1.0)],
            // Waben: in der Ebene biegedominiert (Gibson/Ashby: E ≈ 1,5·ρ³, σ ≈ 0,5·ρ²)
            Waben => [(1.5, 3.0), (1.0, 1.0), (0.5, 2.0), (1.0, 1.0)],
            Gyroid => [(0.4, 1.8), (0.4, 1.8), (0.4, 1.5), (0.4, 1.5)],
            Kubisch => [(0.25, 1.0), (0.25, 1.0), (0.25, 1.0), (0.25, 1.0)],
            Kreuz => [(0.5, 2.0), (0.5, 2.0), (0.3, 1.5), (0.3, 1.5)],
        }
    }

    /// Anteile (E_xy, E_z, R_xy, R_z) bei Füllgrad ρ (0…1)
    pub fn fractions(self, rho: f64) -> [f64; 4] {
        let rho = rho.clamp(0.0, 1.0);
        self.factors().map(|(k, n)| {
            let k = k.min(1.0);
            k * rho.powf(n) + (1.0 - k) * rho.powi(8)
        })
    }
}

/// Slicer-Einstellungen für Wände, Deck-/Bodenschichten und Füllung
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Infill {
    pub pattern: InfillPattern,
    /// Füllgrad 0…1
    pub density: f64,
    /// Anzahl Wandlinien (Perimeter)
    pub walls: u32,
    /// Linienbreite [mm]
    pub line_width: f64,
    /// Schichthöhe [mm]
    pub layer_height: f64,
    /// Anzahl Deckschichten (oben, Fläche zeigt in Aufbaurichtung)
    pub top_layers: u32,
    /// Anzahl Bodenschichten (unten)
    pub bottom_layers: u32,
}

impl Infill {
    pub fn wall_thickness(&self) -> f64 {
        self.walls as f64 * self.line_width
    }
    pub fn top_thickness(&self) -> f64 {
        self.top_layers as f64 * self.layer_height
    }
    pub fn bottom_thickness(&self) -> f64 {
        self.bottom_layers as f64 * self.layer_height
    }
}

/// Werte quer zu den Druckschichten. Die Schichtebene steht senkrecht zur Aufbaurichtung.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layers {
    /// Aufbaurichtung (Z-Achse des Druckers) in Bauteilkoordinaten
    pub build_dir: [f64; 3],
    /// E-Modul quer zu den Schichten
    #[serde(rename = "E_z")]
    pub e_z: f64,
    /// Querkontraktion ν_xz (Dehnung in Aufbaurichtung bei Zug in der Schicht), Standard wie ν
    #[serde(default)]
    pub nu_z: Option<f64>,
    /// Schubmodul zwischen den Schichten, Standard E_z / (2·(1 + ν_xz))
    #[serde(default, rename = "G_z")]
    pub g_z: Option<f64>,
    /// Re/Rp0,2 quer zu den Schichten
    #[serde(default, rename = "yield_z")]
    pub yield_z: Option<f64>,
    /// Rm quer zu den Schichten (Schichthaftung bei Zug)
    #[serde(default, rename = "tensile_z")]
    pub tensile_z: Option<f64>,
    /// Schubfestigkeit zwischen den Schichten, Standard = Festigkeit quer zu den Schichten
    #[serde(default, rename = "shear_z")]
    pub shear_z: Option<f64>,
}

pub type DMat = SMatrix<f64, 6, 6>;

/// Voigt-Index (xx, yy, zz, xy, yz, zx) → Tensorindizes
const VOIGT: [(usize, usize); 6] = [(0, 0), (1, 1), (2, 2), (0, 1), (1, 2), (2, 0)];

fn voigt(i: usize, j: usize) -> usize {
    match (i.min(j), i.max(j)) {
        (0, 0) => 0,
        (1, 1) => 1,
        (2, 2) => 2,
        (0, 1) => 3,
        (1, 2) => 4,
        _ => 5,
    }
}

impl Layers {
    /// Drehung global → Schichtkoordinaten (Zeilen: 1, 2 in der Schicht, 3 = Aufbaurichtung)
    pub fn rotation(&self) -> Matrix3<f64> {
        let z = Vector3::from(self.build_dir).normalize();
        let k = (0..3).min_by(|&i, &j| z[i].abs().partial_cmp(&z[j].abs()).unwrap()).unwrap();
        let mut t = Vector3::zeros();
        t[k] = 1.0;
        let x = (t - z * z.dot(&t)).normalize();
        let y = z.cross(&x);
        Matrix3::from_rows(&[x.transpose(), y.transpose(), z.transpose()])
    }
}

impl Material {
    pub fn steel() -> Self {
        Material {
            name: "Stahl".into(),
            e: 210_000.0,
            nu: 0.3,
            yield_strength: Some(235.0),
            tensile_strength: Some(360.0),
            layers: None,
            infill: None,
            density: None,
        }
    }

    /// Ersatzwerkstoff für den gefüllten Kern (Infill), aus Muster und Füllgrad
    pub fn core_material(&self) -> Option<Material> {
        let inf = self.infill.as_ref()?;
        let [fe, fez, fr, frz] = inf.pattern.fractions(inf.density);
        let min = 1e-6;
        let layers = match &self.layers {
            Some(l) => Layers {
                build_dir: l.build_dir,
                e_z: (l.e_z * fez).max(min * l.e_z),
                nu_z: l.nu_z,
                g_z: l.g_z.map(|g| g * fez.max(min)),
                yield_z: l.yield_z.map(|v| v * frz),
                tensile_z: l.tensile_z.map(|v| v * frz),
                shear_z: l.shear_z.map(|v| v * frz),
            },
            None => Layers {
                build_dir: [0.0, 0.0, 1.0],
                e_z: (self.e * fez).max(min * self.e),
                nu_z: None,
                g_z: None,
                yield_z: self.yield_strength.map(|v| v * frz),
                tensile_z: self.tensile_strength.map(|v| v * frz),
                shear_z: None,
            },
        };
        Some(Material {
            name: format!("{} – Infill", self.name),
            e: (self.e * fe).max(min * self.e),
            nu: self.nu,
            yield_strength: self.yield_strength.map(|v| v * fr),
            tensile_strength: self.tensile_strength.map(|v| v * fr),
            layers: Some(layers),
            infill: None,
            density: None,
        })
    }

    pub fn shear_modulus(&self) -> f64 {
        self.e / (2.0 * (1.0 + self.nu))
    }

    /// Elastizitätsmatrix in Voigt-Notation (xx, yy, zz, xy, yz, zx), Gleitungen γ = 2ε.
    pub fn d_matrix(&self) -> DMat {
        match &self.layers {
            None => {
                let (e, nu) = (self.e, self.nu);
                let lambda = e * nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
                let mu = self.shear_modulus();
                let mut d = DMat::zeros();
                for i in 0..3 {
                    for j in 0..3 {
                        d[(i, j)] = lambda;
                    }
                    d[(i, i)] += 2.0 * mu;
                    d[(i + 3, i + 3)] = mu;
                }
                d
            }
            Some(l) => rotate_stiffness(&self.layered_local(l), &l.rotation()),
        }
    }

    /// Steifigkeit in Schichtkoordinaten (3 = Aufbaurichtung), aus der Nachgiebigkeit
    fn layered_local(&self, l: &Layers) -> DMat {
        let (e1, nu12, e3) = (self.e, self.nu, l.e_z);
        let nu13 = l.nu_z.unwrap_or(nu12);
        let g12 = e1 / (2.0 * (1.0 + nu12));
        let g13 = l.g_z.unwrap_or(e3 / (2.0 * (1.0 + nu13)));
        let mut s = DMat::zeros();
        s[(0, 0)] = 1.0 / e1;
        s[(1, 1)] = 1.0 / e1;
        s[(2, 2)] = 1.0 / e3;
        s[(0, 1)] = -nu12 / e1;
        s[(1, 0)] = -nu12 / e1;
        for k in 0..2 {
            s[(k, 2)] = -nu13 / e1;
            s[(2, k)] = -nu13 / e1;
        }
        s[(3, 3)] = 1.0 / g12; // xy in der Schicht
        s[(4, 4)] = 1.0 / g13; // yz zwischen den Schichten
        s[(5, 5)] = 1.0 / g13; // zx zwischen den Schichten
        s.try_inverse().unwrap_or_else(DMat::zeros)
    }

    pub fn check(&self) -> crate::Result<()> {
        let err = |m: &str| Err(crate::FemError::Input(m.into()));
        if !(self.e > 0.0) {
            return err("E-Modul muss positiv sein");
        }
        if !(self.nu > -1.0 && self.nu < 0.5) {
            return err("Querkontraktionszahl ν muss zwischen -1 und 0,5 liegen");
        }
        if let Some(l) = &self.layers {
            if !(l.e_z > 0.0) {
                return err("E-Modul quer zu den Schichten muss positiv sein");
            }
            if Vector3::from(l.build_dir).norm() == 0.0 {
                return err("Aufbaurichtung fehlt");
            }
            // Stabilität: Steifigkeitsmatrix positiv definit
            if nalgebra::linalg::Cholesky::new(self.layered_local(l)).is_none() {
                return err("Diese Kombination aus E, E_z und ν ist physikalisch nicht möglich (ν_z zu groß)");
            }
        }
        Ok(())
    }

    /// Festigkeiten in der Schicht und quer dazu: (R_xy, R_z, S_z) – für die Auslastung.
    /// `brk`: Bruch (Rm) statt Fließen (Re/Rp, ersatzweise Rm).
    pub fn strengths(&self, brk: bool) -> Option<(f64, Option<(f64, f64)>)> {
        let pick = |y: Option<f64>, t: Option<f64>| if brk { t } else { y.or(t) };
        let r_xy = pick(self.yield_strength, self.tensile_strength)?;
        let layer = self.layers.as_ref().and_then(|l| {
            let r_z = pick(l.yield_z, l.tensile_z)?;
            Some((r_z, l.shear_z.unwrap_or(r_z)))
        });
        Some((r_xy, layer))
    }
}

/// Steifigkeit von Schicht- in globale Koordinaten drehen: C_ijkl = R_pi R_qj R_rk R_sl C'_pqrs
fn rotate_stiffness(local: &DMat, r: &Matrix3<f64>) -> DMat {
    let c = |p: usize, q: usize, rr: usize, s: usize| local[(voigt(p, q), voigt(rr, s))];
    let mut d = DMat::zeros();
    for (a, &(i, j)) in VOIGT.iter().enumerate() {
        for (b, &(k, l)) in VOIGT.iter().enumerate() {
            let mut sum = 0.0;
            for p in 0..3 {
                for q in 0..3 {
                    let f = r[(p, i)] * r[(q, j)];
                    if f == 0.0 {
                        continue;
                    }
                    for rr in 0..3 {
                        for s in 0..3 {
                            sum += f * r[(rr, k)] * r[(s, l)] * c(p, q, rr, s);
                        }
                    }
                }
            }
            d[(a, b)] = sum;
        }
    }
    d
}

/// Spannung (Voigt, global) in Schichtkoordinaten: (σ11, σ22, σ33, τ12, τ23, τ31)
pub fn stress_to_layers(s: &[f64; 6], r: &Matrix3<f64>) -> [f64; 6] {
    let [xx, yy, zz, xy, yz, zx] = *s;
    let m = Matrix3::new(xx, xy, zx, xy, yy, yz, zx, yz, zz);
    let l = r * m * r.transpose();
    [l[(0, 0)], l[(1, 1)], l[(2, 2)], l[(0, 1)], l[(1, 2)], l[(2, 0)]]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn printed(dir: [f64; 3]) -> Material {
        Material {
            name: "PLA".into(),
            e: 3300.0,
            nu: 0.35,
            yield_strength: None,
            tensile_strength: Some(50.0),
            layers: Some(Layers { build_dir: dir, e_z: 2500.0, nu_z: None, g_z: None, yield_z: None, tensile_z: Some(28.0), shear_z: None }),
            infill: None,
            density: None,
        }
    }

    #[test]
    fn schichtaufbau_mit_gleichen_werten_ist_isotrop() {
        let mut m = Material::steel();
        let iso = m.d_matrix();
        m.layers = Some(Layers { build_dir: [0.3, -0.5, 0.8], e_z: m.e, nu_z: None, g_z: None, yield_z: None, tensile_z: None, shear_z: None });
        let d = m.d_matrix();
        assert!((d - iso).abs().max() < 1e-6 * iso.abs().max(), "{d}");
    }

    #[test]
    fn steifigkeit_in_aufbaurichtung_und_symmetrisch() {
        // Zug in Aufbaurichtung: Nachgiebigkeit S = D⁻¹, Dehnung ε = S·σ → E = σ/ε = E_z
        let dir = Vector3::new(1.0, 2.0, -0.5).normalize();
        let m = printed(dir.into());
        let d = m.d_matrix();
        assert!((d - d.transpose()).abs().max() < 1e-9 * d.abs().max());
        let s = d.try_inverse().unwrap();
        let sig = dir * dir.transpose(); // einachsig 1 MPa in Aufbaurichtung
        let sv = SMatrix::<f64, 6, 1>::from_column_slice(&[sig[(0, 0)], sig[(1, 1)], sig[(2, 2)], sig[(0, 1)], sig[(1, 2)], sig[(2, 0)]]);
        let e = s * sv;
        let strain = Matrix3::new(e[0], e[3] / 2.0, e[5] / 2.0, e[3] / 2.0, e[1], e[4] / 2.0, e[5] / 2.0, e[4] / 2.0, e[2]);
        let eps_dir = dir.dot(&(strain * dir));
        assert!((1.0 / eps_dir - 2500.0).abs() < 1e-6, "{}", 1.0 / eps_dir);
        assert!(m.check().is_ok());
    }

    #[test]
    fn infill_anteile() {
        for p in [InfillPattern::Gitter, InfillPattern::Linien, InfillPattern::Waben, InfillPattern::Gyroid, InfillPattern::Kreuz] {
            let full = p.fractions(1.0);
            assert!(full.iter().all(|f| (f - 1.0).abs() < 1e-12), "{p:?} bei 100 %");
            let low = p.fractions(0.2);
            assert!(low.iter().all(|f| *f > 0.0 && *f < 0.25), "{p:?}: {low:?}");
        }
        // Gitter 20 %: E in Z ≈ ρ, in der Schicht ≈ 0,35·ρ
        let g = InfillPattern::Gitter.fractions(0.2);
        assert!((g[1] - 0.2).abs() < 1e-3 && (g[0] - 0.07).abs() < 1e-3);
    }

    #[test]
    fn spannung_in_schichtkoordinaten() {
        let m = printed([0.0, 1.0, 0.0]);
        let r = m.layers.as_ref().unwrap().rotation();
        // σyy = 10 → quer zu den Schichten (Komponente 3)
        let l = stress_to_layers(&[0.0, 10.0, 0.0, 0.0, 0.0, 0.0], &r);
        assert!((l[2] - 10.0).abs() < 1e-12 && l[0].abs() < 1e-12 && l[1].abs() < 1e-12);
    }
}
