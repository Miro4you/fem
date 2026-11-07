//! Schrauben als Verbindungselement (ohne Volumennetz der Schraube).
//!
//! Die Schraube koppelt den Mittelwert der Verschiebungen unter dem Kopf (Ring auf der Auflagefläche) mit dem
//! Mittelwert auf der Gewindeseite (Wand der Gewindebohrung bzw. Ring unter der Mutter) – wie ein RBE3-Verbinder.
//! Steifigkeit: längs E·A_s / (l_k + 0,9·d) (Klemmlänge + Anteile Kopf und Gewinde nach VDI 2230), quer
//! 12·E·I / l_k³ (beidseitig eingespannter Schaft). Ergebnis: Schraubenkraft längs (Zug +) und quer.
//! Vorspannung in zwei Schritten (siehe Löser): erst anziehen (Kraft F_V vorgegeben, Fuge mit Kontakt), dann ist die
//! Schraubenlänge fest und die Betriebslast kommt dazu. F_V nach VDI 2230 aus Ausnutzung oder Anziehmoment.

use nalgebra::{DMatrix, Matrix3, Vector3};
use serde::{Deserialize, Serialize};

use crate::mesh::{Face, Mesh};
use crate::{FemError, Result};

/// Spannungsquerschnitt A_s [mm²] für Regelgewinde M3 … M30 (ISO 898-1); sonst π/4·(0,9·d)²
pub fn stress_area(d: f64) -> f64 {
    const T: [(f64, f64); 15] = [
        (3.0, 5.03), (4.0, 8.78), (5.0, 14.2), (6.0, 20.1), (8.0, 36.6), (10.0, 58.0), (12.0, 84.3), (14.0, 115.0),
        (16.0, 157.0), (18.0, 192.0), (20.0, 245.0), (22.0, 303.0), (24.0, 353.0), (27.0, 459.0), (30.0, 561.0),
    ];
    T.iter().find(|(m, _)| (m - d).abs() < 0.05).map(|(_, a)| *a).unwrap_or(std::f64::consts::FRAC_PI_4 * (0.9 * d).powi(2))
}

/// Schraube: Achse vom Kopf zur Gewindeseite; Lagen als Abstand `t` entlang der Achse ab `origin`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bolt {
    pub name: String,
    /// Nenndurchmesser d [mm]
    pub d: f64,
    /// Spannungsquerschnitt [mm²]; leer = aus der Tabelle
    #[serde(default)]
    pub stress_area: Option<f64>,
    /// E-Modul der Schraube [MPa]
    #[serde(default = "steel_e")]
    pub e: f64,
    pub origin: [f64; 3],
    pub axis: [f64; 3],
    /// Kopfauflage (Ebene) und deren Außendurchmesser
    pub head_t: f64,
    pub head_d: f64,
    /// Mutterauflage (Ebene) und Außendurchmesser – sonst Gewindebohrung
    #[serde(default)]
    pub nut_t: Option<f64>,
    #[serde(default)]
    pub nut_d: Option<f64>,
    /// Gewindebereich in der Bohrung (von–bis entlang der Achse)
    #[serde(default)]
    pub thread_t0: f64,
    #[serde(default)]
    pub thread_t1: f64,
    /// Vorspannkraft F_V [N] (leer = aus `tighten` bzw. ohne Vorspannung)
    #[serde(default)]
    pub preload: Option<f64>,
    /// Anziehen nach VDI 2230 (Vorspannkraft aus Ausnutzung der Streckgrenze oder aus dem Anziehmoment)
    #[serde(default)]
    pub tighten: Option<Tighten>,
    /// Streckgrenze Rp0,2 der Schraube [MPa] (Festigkeitsklasse) – für Vorspannkraft und Nachweis
    #[serde(default)]
    pub rp: Option<f64>,
    /// Zugfestigkeit Rm der Schraube [MPa] – für die nötige Einschraubtiefe
    #[serde(default)]
    pub rm: Option<f64>,
    /// Streuung beim Anziehen und Setzen (VDI 2230): dann zwei Rechnungen, größte und kleinste Vorspannung
    #[serde(default)]
    pub scatter: Option<Scatter>,
    /// intern: Faktor auf die Montagevorspannkraft und Verlust durch Setzen [N] (für die beiden Rechnungen)
    #[serde(default)]
    pub preload_factor: Option<f64>,
    #[serde(default)]
    pub preload_loss: Option<f64>,
}

/// Streuung der Vorspannkraft (VDI 2230)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Scatter {
    /// Anziehfaktor α_A = F_M,max / F_M,min (Drehmomentschlüssel ≈ 1,6, Schlagschrauber 2,5 … 4)
    pub alpha_a: f64,
    /// Vorspannkraftverlust durch Setzen F_Z abziehen (Setzbetrag nach VDI 2230 Tab. 5.4/1)
    #[serde(default)]
    pub setting: bool,
}

/// Dauerfestigkeit des Gewindes σ_ASV [MPa] (VDI 2230, schlussvergütet, Ausschlag): 0,85·(150/d + 45)
pub fn fatigue_limit(d: f64) -> f64 {
    0.85 * (150.0 / d.max(1.0) + 45.0)
}

/// Setzbetrag f_Z [µm] (VDI 2230 Tab. 5.4/1, Rz < 10 µm, Längskraft): Gewinde 3, Kopf- und Mutterauflage je 2,5,
/// jede innere Trennfuge 1,5
pub fn setting_amount(nut: bool, inner_joints: usize) -> f64 {
    3.0 + 2.5 + if nut { 2.5 } else { 0.0 } + 1.5 * inner_joints as f64
}

/// Wie die Schraube angezogen wird (VDI 2230)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "art", rename_all = "lowercase")]
pub enum Tighten {
    /// Montagevorspannkraft für die Ausnutzung ν der Streckgrenze beim Anziehen (VDI 2230: ν = 0,9)
    Ausnutzung {
        nu: f64,
        #[serde(default = "mu_default")]
        mu_g: f64,
        #[serde(default = "mu_default")]
        mu_k: f64,
    },
    /// Anziehmoment M_A [N·m]
    Moment {
        m_a: f64,
        #[serde(default = "mu_default")]
        mu_g: f64,
        #[serde(default = "mu_default")]
        mu_k: f64,
    },
    /// Vorspannkraft direkt [N]
    Kraft { f_v: f64 },
}

fn mu_default() -> f64 {
    0.12
}

/// Steigung P des Regelgewindes [mm] (ISO 261); sonst etwa 0,15·d
pub fn pitch(d: f64) -> f64 {
    const T: [(f64, f64); 15] = [
        (3.0, 0.5),
        (4.0, 0.7),
        (5.0, 0.8),
        (6.0, 1.0),
        (8.0, 1.25),
        (10.0, 1.5),
        (12.0, 1.75),
        (14.0, 2.0),
        (16.0, 2.0),
        (18.0, 2.5),
        (20.0, 2.5),
        (22.0, 2.5),
        (24.0, 3.0),
        (27.0, 3.0),
        (30.0, 3.5),
    ];
    T.iter().find(|(m, _)| (m - d).abs() < 0.05).map(|(_, p)| *p).unwrap_or(0.15 * d)
}

/// Flankendurchmesser d₂ [mm]
pub fn d2(d: f64) -> f64 {
    d - 0.649519 * pitch(d)
}

/// Durchmesser zum Spannungsquerschnitt d_S [mm]
fn d_s(a_s: f64) -> f64 {
    (4.0 * a_s / std::f64::consts::PI).sqrt()
}

/// zulässige Montagevorspannkraft F_M,zul [N] (VDI 2230 Gl. R7/1): beim Anziehen erreicht die Vergleichsspannung aus
/// Zug und Gewindetorsion ν·Rp0,2
pub fn assembly_preload(d: f64, a_s: f64, rp: f64, mu_g: f64, nu: f64) -> f64 {
    let (p, d2) = (pitch(d), d2(d));
    let x = 1.5 * d2 / d_s(a_s) * (p / (std::f64::consts::PI * d2) + 1.155 * mu_g);
    nu * rp * a_s / (1.0 + 3.0 * x * x).sqrt()
}

/// Gewindemoment M_G [N·mm] bei Vorspannkraft F (VDI 2230 Gl. R7/2, Teil Gewinde)
pub fn thread_torque(d: f64, f: f64, mu_g: f64) -> f64 {
    f * (0.16 * pitch(d) + 0.58 * d2(d) * mu_g)
}

/// Anziehmoment M_A [N·mm] für Vorspannkraft F; `d_km`: mittlerer Durchmesser der Kopfauflage
pub fn tightening_torque(d: f64, f: f64, mu_g: f64, mu_k: f64, d_km: f64) -> f64 {
    thread_torque(d, f, mu_g) + f * d_km / 2.0 * mu_k
}

/// Vorspannung einer Schraube aus den Angaben
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct Assembly {
    /// Vorspannkraft F_V [N]
    pub f_v: f64,
    /// Anziehmoment M_A [N·m]
    pub m_a: f64,
    /// Gewindemoment M_G [N·mm] (verdreht die Schraube beim Anziehen)
    pub m_g: f64,
}

impl Bolt {
    /// mittlerer Durchmesser der Kopfauflage D_Km = (d_w + d_h)/2, Bohrung d_h ≈ 1,1·d (ISO 273 mittel)
    pub fn d_km(&self) -> f64 {
        (self.head_d.max(1.3 * self.d) + 1.1 * self.d) / 2.0
    }

    /// tragende Fläche unter dem Kopf A_p = π/4·(d_w² − d_h²), Bohrung d_h ≈ 1,1·d
    pub fn bearing_area(&self) -> f64 {
        let dw = self.head_d.max(1.3 * self.d);
        std::f64::consts::FRAC_PI_4 * (dw * dw - (1.1 * self.d).powi(2))
    }

    /// Vorspannkraft, Anziehmoment und Gewindemoment (leer = ohne Vorspannung)
    pub fn assembly(&self) -> Option<Assembly> {
        let a_s = self.stress_area.unwrap_or_else(|| stress_area(self.d));
        let (f_nom, mu) = match (&self.tighten, self.preload) {
            (_, Some(f)) if f > 0.0 => (f, None),
            (Some(Tighten::Kraft { f_v }), _) if *f_v > 0.0 => (*f_v, None),
            (Some(Tighten::Ausnutzung { nu, mu_g, mu_k }), _) if *nu > 0.0 => {
                (assembly_preload(self.d, a_s, self.rp.unwrap_or(640.0), *mu_g, *nu), Some((*mu_g, *mu_k)))
            }
            (Some(Tighten::Moment { m_a, mu_g, mu_k }), _) if *m_a > 0.0 => {
                let per_n = tightening_torque(self.d, 1.0, *mu_g, *mu_k, self.d_km());
                (m_a * 1000.0 / per_n, Some((*mu_g, *mu_k)))
            }
            _ => return None,
        };
        // ohne Reibwerte (Kraft vorgegeben): Gewindemoment und Anziehmoment mit µ = 0,12 abgeschätzt
        let (mu_g, mu_k) = mu.unwrap_or((mu_default(), mu_default()));
        // Streuung: Montagevorspannkraft F_M = Faktor · Nennwert; nach dem Setzen F_V = F_M − F_Z. Das Anziehmoment bleibt
        // das des Nennwerts (so wird angezogen)
        let f_m = f_nom * self.preload_factor.unwrap_or(1.0);
        let f_v = (f_m - self.preload_loss.unwrap_or(0.0)).max(0.0);
        Some(Assembly {
            f_v,
            m_a: tightening_torque(self.d, f_nom, mu_g, mu_k, self.d_km()) / 1000.0,
            m_g: thread_torque(self.d, f_m, mu_g),
        })
    }

    /// Faktoren auf den Nennwert der Montagevorspannkraft für größte und kleinste Vorspannung. Ausnutzung der
    /// Streckgrenze: der Nennwert ist schon F_M,max (F_M,min = F_M,max/α_A); Anziehmoment oder Kraft vorgegeben: Nennwert
    /// ist der Mittelwert (F_M,max = 2α_A/(1+α_A)·F_M, F_M,min = 2/(1+α_A)·F_M)
    pub fn scatter_factors(&self) -> (f64, f64) {
        let a = self.scatter.map(|s| s.alpha_a).unwrap_or(1.0).max(1.0);
        match (&self.tighten, self.preload) {
            (Some(Tighten::Ausnutzung { .. }), None) => (1.0, 1.0 / a),
            _ => (2.0 * a / (1.0 + a), 2.0 / (1.0 + a)),
        }
    }
}

fn steel_e() -> f64 {
    210000.0
}

/// vorbereitete Schraube: Balken zwischen den Mittelpunkten von Kopf- und Gewindeseite. Verschiebung und
/// Verdrehung jeder Seite kommen als gewichtete Mittel aus den Auflageknoten (wie RBE3).
#[derive(Debug, Clone)]
pub struct Prepared {
    pub nodes: Vec<usize>,
    /// 12 × 3m: Knotenverschiebungen → [u, θ] Kopfseite, [u, θ] Gewindeseite (global)
    pub g: DMatrix<f64>,
    /// 12 × 12 Balkensteifigkeit (global)
    pub kb: DMatrix<f64>,
    /// nur der Längsanteil davon (für den Vorspann-Schritt, in dem die Kraft statt der Länge vorgegeben ist)
    pub kb_axial: DMatrix<f64>,
    /// ∂(Längenänderung)/∂u über alle Knoten (3m)
    pub b_ax: nalgebra::DVector<f64>,
    /// Vorspannweg s: Schraube ist um s kürzer als der Abstand der Auflagen → Kraft k·(Δ + s)
    pub offset: f64,
    /// globale → lokale Achsen (Zeilen: Schraubenachse, e1, e2)
    pub q: Matrix3<f64>,
    pub k_ax: f64,
    pub clamp: f64,
    pub n_head: usize,
    pub n_thread: usize,
    /// eingeschraubte Länge in der Gewindebohrung [mm] (leer = mit Mutter)
    pub engagement: Option<f64>,
}

impl Prepared {
    /// Steifigkeitsmatrix über alle beteiligten Knoten (3m × 3m): Gᵀ·K·G
    pub fn stiffness(&self) -> DMatrix<f64> {
        self.g.transpose() * &self.kb * &self.g
    }

    /// Steifigkeit ohne Längsfeder (Vorspann-Schritt mit vorgegebener Kraft)
    pub fn stiffness_without_axial(&self) -> DMatrix<f64> {
        self.g.transpose() * (&self.kb - &self.kb_axial) * &self.g
    }

    /// Längenänderung zwischen den Auflagen (+ = länger)
    pub fn axial_delta(&self, u: &[f64]) -> f64 {
        self.nodes.iter().enumerate().map(|(j, &n)| (0..3).map(|c| self.b_ax[3 * j + c] * u[3 * n + c]).sum::<f64>()).sum()
    }

    /// Knotenkräfte (je beteiligtem Knoten, 3m) einer Schraubenkraft F (Zug): Kopf zur Mutter hin, Mutter zum Kopf
    pub fn tension_forces(&self, f: f64) -> nalgebra::DVector<f64> {
        -&self.b_ax * f
    }

    /// Endverschiebungen [u, θ]×2 im lokalen System
    fn local(&self, u: &[f64]) -> nalgebra::DVector<f64> {
        let ue: Vec<f64> = self.nodes.iter().flat_map(|&n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect();
        let d = &self.g * nalgebra::DVector::from_column_slice(&ue);
        let mut l = nalgebra::DVector::zeros(12);
        for blk in 0..4 {
            let v = self.q * Vector3::new(d[3 * blk], d[3 * blk + 1], d[3 * blk + 2]);
            l.fixed_rows_mut::<3>(3 * blk).copy_from(&v);
        }
        l
    }
}

/// Ergebnis je Schraube
#[derive(Debug, Clone, Serialize)]
pub struct BoltResult {
    pub name: String,
    pub d: f64,
    pub stress_area: f64,
    /// Kraft längs der Achse [N], positiv = Zug (mit Vorspannung: Betriebskraft)
    pub axial: f64,
    /// Vorspannkraft F_V [N] (0 = ohne)
    pub preload: f64,
    /// Anziehmoment M_A [N·m] (0 = ohne Vorspannung)
    pub torque: f64,
    /// Vergleichsspannung im Betrieb [MPa]: √((F_S/A_s + M_b/W)² + 3·(k_τ·M_G/W_p + Q/A_s)²), k_τ = 0,5 (VDI 2230)
    pub sigma_red: f64,
    /// Ausnutzung σ_red / Rp0,2 (leer = Festigkeitsklasse unbekannt)
    pub utilization: Option<f64>,
    /// Flächenpressung unter dem Kopf p = F_S / A_p, A_p = π/4·(d_w² − d_h²) [MPa]
    pub bearing_pressure: f64,
    /// Grenzflächenpressung p_G des Teils unter dem Kopf [MPa] und Herkunft des Werts
    pub bearing_limit: Option<f64>,
    pub bearing_limit_source: Option<String>,
    /// Flächenpressung unter der Mutter [MPa] und p_G des Teils darunter
    pub nut_pressure: Option<f64>,
    pub nut_limit: Option<f64>,
    /// eingeschraubte Länge in der Gewindebohrung [mm] und die nötige, damit das Innengewinde nicht vor der Schraube
    /// ausreißt: l_e,min = Rm_S·A_s / (0,6·Rm_M · 0,75·π·d)
    pub engagement: Option<f64>,
    pub engagement_min: Option<f64>,
    /// mit Streuung: kleinste Vorspannkraft nach dem Setzen F_V,min [N] und Schraubenkraft in diesem Fall
    pub preload_min: Option<f64>,
    pub axial_min: Option<f64>,
    /// Vorspannkraftverlust durch Setzen F_Z [N]
    pub setting_loss: Option<f64>,
    /// Kraftverhältnis Φ_K = δ_P / (δ_S + δ_P) aus den Nachgiebigkeiten von Schraube und verspannten Teilen (FEM)
    pub phi_k: Option<f64>,
    /// Spannungsausschlag σ_a [MPa], wenn die Last zwischen 0 und dem Wert schwellt: (ΔF/A_s + ΔM/W)/2
    pub stress_amplitude: f64,
    /// Dauerfestigkeit σ_ASV [MPa] (VDI 2230, schlussvergütet)
    pub fatigue_limit: f64,
    /// Querkraft [N]
    pub shear: f64,
    /// größtes Biegemoment im Schaft [N·mm]
    pub moment: f64,
    /// Klemmlänge [mm]
    pub clamp: f64,
    pub nodes_head: usize,
    pub nodes_thread: usize,
}

/// höchstens so viele Knoten je Seite (gleichmäßig über den Umfang verteilt)
const MAX_SIDE_NODES: usize = 96;

/// Auflageknoten mit Gewicht (Flächenanteil) auswählen: Randflächen, deren Knoten alle die Bedingung erfüllen.
/// Gewichte wie eine gleichmäßige Pressung (quadratische Dreiecke: Ecken 0, Kanten je A/3), damit die Schraubenkraft
/// ohne künstliche Spitzen eingeleitet wird. Mehr als MAX_SIDE_NODES Knoten: je Winkelabschnitt einer, mit dem Gewicht
/// des ganzen Abschnitts.
fn weighted_side(mesh: &Mesh, faces: &[Face], cand: &[(usize, f64)]) -> Vec<(usize, f64)> {
    let mut angle = std::collections::HashMap::new();
    for &(k, a) in cand {
        angle.insert(k, a);
    }
    let mut w: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
    for f in faces {
        if !f.nodes.iter().all(|k| angle.contains_key(k)) {
            continue;
        }
        let p: Vec<Vector3<f64>> = f.nodes[..3].iter().map(|&k| Vector3::from(mesh.nodes[k])).collect();
        let af = (p[1] - p[0]).cross(&(p[2] - p[0])).norm() * 0.5;
        if f.nodes.len() == 6 {
            for &k in &f.nodes[3..] {
                *w.entry(k).or_default() += af / 3.0;
            }
        } else {
            for &k in &f.nodes {
                *w.entry(k).or_default() += af / f.nodes.len() as f64;
            }
        }
    }
    let mut out: Vec<(usize, f64, f64)> = w.into_iter().filter(|(_, v)| *v > 0.0).map(|(k, v)| (k, v, angle[&k])).collect();
    if out.len() < 3 {
        // keine ganze Fläche in der Auflage (sehr grobes Netz): alle Knoten gleich gewichtet
        out = cand.iter().map(|&(k, a)| (k, 1.0, a)).collect();
    }
    out.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap().then(a.0.cmp(&b.0)));
    if out.len() <= MAX_SIDE_NODES {
        return out.into_iter().map(|(k, v, _)| (k, v)).collect();
    }
    let mut bins: Vec<(usize, f64, f64)> = Vec::new(); // (Knoten, Gewicht des Knotens, Summe des Abschnitts)
    let bin_of = |a: f64| (((a + std::f64::consts::PI) / std::f64::consts::TAU * MAX_SIDE_NODES as f64) as usize).min(MAX_SIDE_NODES - 1);
    let mut cur = usize::MAX;
    for (k, v, a) in out {
        let bi = bin_of(a);
        if bi != cur {
            bins.push((k, v, 0.0));
            cur = bi;
        }
        let last = bins.last_mut().unwrap();
        last.2 += v;
        if v > last.1 {
            last.0 = k;
            last.1 = v;
        }
    }
    bins.into_iter().map(|(k, _, sum)| (k, sum)).collect()
}

/// Knoten auf der Oberfläche finden und die Schraube vorbereiten
pub fn prepare(mesh: &Mesh, faces: &[Face], b: &Bolt) -> Result<Prepared> {
    let n = Vector3::from(b.axis);
    if !(n.norm() > 0.0) || !(b.d > 0.0) {
        return Err(FemError::Input(format!("{}: Achse oder Durchmesser fehlt", b.name)));
    }
    let n = n.normalize();
    let o = Vector3::from(b.origin);
    // Hilfsrichtungen für den Winkel um die Achse
    let e1 = if n.x.abs() < 0.9 { Vector3::x() } else { Vector3::y() };
    let e1 = (e1 - n * n.dot(&e1)).normalize();
    let e2 = n.cross(&e1);
    let mut on_surface = vec![false; mesh.nodes.len()];
    for f in faces {
        for &k in &f.nodes {
            on_surface[k] = true;
        }
    }
    let tol_t = (0.02 * b.d).max(0.05);
    let polar = |p: &[f64; 3]| {
        let v = Vector3::from(*p) - o;
        let t = v.dot(&n);
        let r = v - n * t;
        (t, r.norm(), r.dot(&e2).atan2(r.dot(&e1)))
    };
    let ring = |t0: f64, r0: f64, r1: f64| -> Vec<(usize, f64)> {
        let cand: Vec<(usize, f64)> = mesh
            .nodes
            .iter()
            .enumerate()
            .filter(|(k, _)| on_surface[*k])
            .filter_map(|(k, p)| {
                let (t, r, a) = polar(p);
                ((t - t0).abs() < tol_t && r >= r0 && r <= r1).then_some((k, a))
            })
            .collect();
        weighted_side(mesh, faces, &cand)
    };
    let head = ring(b.head_t, 0.45 * b.d, 0.5 * b.head_d.max(1.2 * b.d) * 1.05);
    let mut engagement = None;
    let (thread, t_thread) = match b.nut_t {
        Some(tn) => (ring(tn, 0.45 * b.d, 0.5 * b.nut_d.unwrap_or(1.6 * b.d).max(1.2 * b.d) * 1.05), tn),
        None => {
            let (t0, t1) = (b.thread_t0.min(b.thread_t1), b.thread_t0.max(b.thread_t1));
            let cand: Vec<(usize, f64, f64)> = mesh
                .nodes
                .iter()
                .enumerate()
                .filter(|(k, _)| on_surface[*k])
                .filter_map(|(k, p)| {
                    let (t, r, a) = polar(p);
                    // Gewindebohrung: Kernloch ≈ 0,42·d bis Nenn-Ø 0,5·d; Durchgangslöcher (≥ 0,52·d) nicht
                    (t >= t0 - tol_t && t <= t1 + tol_t && r >= 0.3 * b.d && r <= 0.515 * b.d).then_some((k, a, t))
                })
                .collect();
            // tragende Gewindegänge: die ersten 1,2·d ab Beginn der Gewindebohrung
            let first = cand.iter().map(|c| c.2).fold(f64::MAX, f64::min);
            // eingeschraubte Länge: von der ersten bis zur letzten Stelle der Gewindebohrung bis zum Schraubenende
            let last = cand.iter().map(|c| c.2).fold(f64::MIN, f64::max).min(t1);
            engagement = (last > first).then_some(last - first);
            let ring: Vec<(usize, f64)> = cand.iter().filter(|c| c.2 <= first + 1.2 * b.d + tol_t).map(|c| (c.0, c.1)).collect();
            (weighted_side(mesh, faces, &ring), first)
        }
    };
    if head.len() < 3 {
        return Err(FemError::Input(format!("{}: keine Kopfauflage gefunden – liegt der Kopf auf einer Fläche auf?", b.name)));
    }
    if thread.len() < 3 {
        return Err(FemError::Input(format!(
            "{}: keine Gewindebohrung bzw. Mutterauflage gefunden – Gewinde- oder Mutterseite prüfen",
            b.name
        )));
    }
    let clamp = (t_thread - b.head_t).abs().max(0.5 * b.d);
    let a_s = b.stress_area.unwrap_or_else(|| stress_area(b.d));
    // längs: Klemmlänge + Anteile Kopf und Gewinde (VDI 2230, vereinfacht)
    let k_ax = b.e * a_s / (clamp + 0.9 * b.d);
    let d_s = (4.0 * a_s / std::f64::consts::PI).sqrt();
    let i = std::f64::consts::PI * d_s.powi(4) / 64.0;
    let g_mod = b.e / 2.6;
    let (nh, nt) = (head.len(), thread.len());
    let nodes: Vec<usize> = head.iter().chain(&thread).map(|x| x.0).collect();
    let weights: Vec<f64> = head.iter().chain(&thread).map(|x| x.1).collect();
    let m = nodes.len();
    // Mittelpunkt und Verdrehungsschätzung je Seite (gewichtet wie RBE3): θ = I_p⁻¹ Σ wᵢ rᵢ × uᵢ
    let mut g = DMatrix::zeros(12, 3 * m);
    let mut centers = [Vector3::zeros(); 2];
    for (side, (range, off)) in [(0..nh, 0usize), (nh..m, 6usize)].into_iter().enumerate() {
        let wsum: f64 = range.clone().map(|j| weights[j]).sum();
        let c: Vector3<f64> = range.clone().map(|j| Vector3::from(mesh.nodes[nodes[j]]) * weights[j]).sum::<Vector3<f64>>() / wsum;
        centers[side] = c;
        let mut ip = Matrix3::zeros();
        for j in range.clone() {
            let r = Vector3::from(mesh.nodes[nodes[j]]) - c;
            ip += (Matrix3::identity() * r.norm_squared() - r * r.transpose()) * (weights[j] / wsum);
        }
        let ip_inv = ip.try_inverse().ok_or_else(|| FemError::Input(format!("{}: Auflage zu klein für die Schraube", b.name)))?;
        for j in range {
            let r = Vector3::from(mesh.nodes[nodes[j]]) - c;
            let skew = Matrix3::new(0.0, -r.z, r.y, r.z, 0.0, -r.x, -r.y, r.x, 0.0);
            let wj = weights[j] / wsum;
            let t = ip_inv * skew * wj;
            for a in 0..3 {
                g[(off + a, 3 * j + a)] = wj;
                for c2 in 0..3 {
                    g[(off + 3 + a, 3 * j + c2)] = t[(a, c2)];
                }
            }
        }
    }
    // Balken im lokalen System (x = Achse), Länge = Abstand der Mittelpunkte
    let len = (centers[1] - centers[0]).dot(&n).abs().max(0.5 * b.d);
    let ei = b.e * i;
    let mut kl = DMatrix::<f64>::zeros(12, 12);
    let mut put = |r: usize, c: usize, v: f64| kl[(r, c)] += v;
    for (r, c, v) in [(0, 0, k_ax), (0, 6, -k_ax), (6, 0, -k_ax), (6, 6, k_ax)] {
        put(r, c, v);
    }
    let kt = g_mod * 2.0 * i / len;
    for (r, c, v) in [(3, 3, kt), (3, 9, -kt), (9, 3, -kt), (9, 9, kt)] {
        put(r, c, v);
    }
    let (l1, l2, l3) = (len, len * len, len * len * len);
    // Biegung in der x-y-Ebene (u_y, θ_z) und x-z-Ebene (u_z, θ_y)
    let bend = |ids: [usize; 4], sgn: f64| -> Vec<(usize, usize, f64)> {
        let k = [
            [12.0 / l3, sgn * 6.0 / l2, -12.0 / l3, sgn * 6.0 / l2],
            [sgn * 6.0 / l2, 4.0 / l1, -sgn * 6.0 / l2, 2.0 / l1],
            [-12.0 / l3, -sgn * 6.0 / l2, 12.0 / l3, -sgn * 6.0 / l2],
            [sgn * 6.0 / l2, 2.0 / l1, -sgn * 6.0 / l2, 4.0 / l1],
        ];
        let mut v = Vec::new();
        for a in 0..4 {
            for c in 0..4 {
                v.push((ids[a], ids[c], ei * k[a][c]));
            }
        }
        v
    };
    for (r, c, v) in bend([1, 5, 7, 11], 1.0).into_iter().chain(bend([2, 4, 8, 10], -1.0)) {
        put(r, c, v);
    }
    let q = Matrix3::from_rows(&[n.transpose(), e1.transpose(), e2.transpose()]);
    let mut tm = DMatrix::<f64>::zeros(12, 12);
    for blk in 0..4 {
        tm.view_mut((3 * blk, 3 * blk), (3, 3)).copy_from(&q);
    }
    let kb = tm.transpose() * &kl * &tm;
    let mut kla = DMatrix::<f64>::zeros(12, 12);
    for (r, c, v) in [(0, 0, k_ax), (0, 6, -k_ax), (6, 0, -k_ax), (6, 6, k_ax)] {
        kla[(r, c)] = v;
    }
    let kb_axial = tm.transpose() * kla * &tm;
    let gn = |r0: usize| -> nalgebra::DVector<f64> { (g.rows(r0, 3).transpose() * n).into_owned() };
    let b_ax = gn(6) - gn(0);
    Ok(Prepared { nodes, g, kb, kb_axial, b_ax, offset: 0.0, q, k_ax, clamp, n_head: nh, n_thread: nt, engagement })
}

/// Körper, die eine Schraube zusammenhält: Körper an Kopf- und Gewindeseite sowie alle Körper, deren Elemente
/// dazwischen nahe an der Achse liegen
pub fn clamped_bodies(mesh: &Mesh, p: &Prepared, b: &Bolt) -> Vec<i32> {
    let mut set: Vec<i32> = Vec::new();
    let n = Vector3::from(b.axis).normalize();
    let o = Vector3::from(b.origin);
    let mut node_side = vec![false; mesh.nodes.len()];
    for &k in &p.nodes {
        node_side[k] = true;
    }
    let t_end = p.clamp + b.head_t;
    for e in 0..mesh.n_elems() {
        let nodes = mesh.elem(e);
        let touches = nodes.iter().any(|&k| node_side[k]);
        let c: Vector3<f64> = nodes[..4].iter().map(|&k| Vector3::from(mesh.nodes[k])).sum::<Vector3<f64>>() / 4.0;
        let v = c - o;
        let t = v.dot(&n);
        let near = t > b.head_t && t < t_end && (v - n * t).norm() < 1.6 * b.d;
        if touches || near {
            let body = mesh.body_of(e);
            if !set.contains(&body) {
                set.push(body);
            }
        }
    }
    set.sort_unstable();
    set
}

/// Fugen zwischen verschraubten Körpern öffnen (Netz auftrennen), damit die Schrauben die Last tragen.
/// Rückgabe: Knotenpaare der getrennten Fugen (Original, Kopie) – für die Prüfung, ob sich Teile durchdringen.
pub fn open_joints(model: &mut crate::Model) -> Result<Vec<(usize, usize)>> {
    if model.bolts.is_empty() || model.mesh.bodies().len() < 2 {
        return Ok(vec![]);
    }
    let faces = model.mesh.boundary_faces();
    let mut pairs: Vec<(i32, i32)> = Vec::new();
    for b in &model.bolts {
        let p = prepare(&model.mesh, &faces, b)?;
        let set = clamped_bodies(&model.mesh, &p, b);
        for i in 0..set.len() {
            for j in i + 1..set.len() {
                if !pairs.contains(&(set[i], set[j])) {
                    pairs.push((set[i], set[j]));
                }
            }
        }
    }
    let mut nodes = Vec::new();
    for (a, b) in pairs {
        nodes.extend(model.mesh.split_bodies(a, b));
    }
    Ok(nodes)
}

/// Durchdringung an geöffneten Fugen: größte Annäherung der Knotenpaare gegen die Fugennormale [mm]
/// (positiv = Teile schieben sich ineinander; ohne Kontakt nicht verhindert)
pub fn penetration(mesh: &Mesh, pairs: &[(usize, usize)], u: &[[f64; 3]]) -> f64 {
    if pairs.is_empty() {
        return 0.0;
    }
    // Normale je Originalknoten aus den Randflächen (zeigt aus dem Körper der Originalknoten heraus)
    let faces = mesh.boundary_faces();
    let mut normal: std::collections::HashMap<usize, Vector3<f64>> = pairs.iter().map(|&(o, _)| (o, Vector3::zeros())).collect();
    for f in &faces {
        let p: Vec<Vector3<f64>> = f.nodes[..3].iter().map(|&k| Vector3::from(mesh.nodes[k])).collect();
        let nf = (p[1] - p[0]).cross(&(p[2] - p[0]));
        for &k in &f.nodes {
            if let Some(v) = normal.get_mut(&k) {
                *v += nf;
            }
        }
    }
    let mut worst = 0.0f64;
    for &(o, c) in pairs {
        let nv = normal[&o];
        if nv.norm() == 0.0 {
            continue;
        }
        let nv = nv.normalize();
        // Kopie bewegt sich in Richtung −Normale (in den Originalkörper hinein) → Durchdringung
        let rel = Vector3::from(u[o]) - Vector3::from(u[c]);
        worst = worst.max(rel.dot(&nv));
    }
    worst
}

/// Knoten im Bereich der Krafteinleitung (Kopf- bzw. Mutterauflage, tragendes Gewinde). Dort entstehen örtliche
/// Spannungsspitzen aus der Modellierung als Verbinder (Kraft auf eine Fläche bzw. Bohrungswand, Kante zur Fuge);
/// der Nachweis gilt dort über Flächenpressung und Einschraubtiefe (VDI 2230), nicht über σv.
pub fn load_zone(mesh: &Mesh, bolts: &[Bolt], prepared: &[Prepared]) -> Vec<bool> {
    let mut zone = vec![false; mesh.nodes.len()];
    if bolts.is_empty() {
        return zone;
    }
    let vol: f64 = (0..mesh.n_elems()).map(|e| crate::element::tet_volume(&mesh.elem_coords(e)[..4]).abs()).sum();
    let h = (vol / mesh.n_elems().max(1) as f64 * 8.5).cbrt();
    for (b, p) in bolts.iter().zip(prepared) {
        let n = Vector3::from(b.axis).normalize();
        let o = Vector3::from(b.origin);
        let pad = (0.6 * b.d).max(1.2 * h);
        // Lage und Ausdehnung der beiden Seiten aus den Auflageknoten
        let side = |nodes: &[usize]| -> (f64, f64, f64) {
            let (mut t0, mut t1, mut r1) = (f64::MAX, f64::MIN, 0.0f64);
            for &k in nodes {
                let v = Vector3::from(mesh.nodes[k]) - o;
                let t = v.dot(&n);
                t0 = t0.min(t);
                t1 = t1.max(t);
                r1 = r1.max((v - n * t).norm());
            }
            (t0, t1, r1)
        };
        let sides = [side(&p.nodes[..p.n_head]), side(&p.nodes[p.n_head..])];
        for (k, x) in mesh.nodes.iter().enumerate() {
            let v = Vector3::from(*x) - o;
            let t = v.dot(&n);
            let r = (v - n * t).norm();
            if sides.iter().any(|&(t0, t1, r1)| t >= t0 - pad && t <= t1 + pad && r <= r1 + pad) {
                zone[k] = true;
            }
        }
    }
    zone
}

/// Schraubenkräfte aus der Lösung
/// Werkstoffe der Teile an Kopf- und Gewinde- bzw. Mutterseite (für Flächenpressung und Einschraubtiefe)
#[derive(Default, Clone, Copy)]
pub struct SideMaterials<'a> {
    pub head: Option<&'a crate::Material>,
    pub thread: Option<&'a crate::Material>,
}

/// nötige Einschraubtiefe [mm]: Innengewinde (Scherfläche ≈ 0,75·π·d·l_e, τ_B ≈ 0,6·Rm) soll mindestens die
/// Bruchkraft der Schraube Rm·A_s tragen
pub fn engagement_min(d: f64, a_s: f64, rm_bolt: f64, rm_part: f64) -> f64 {
    rm_bolt * a_s / (0.6 * rm_part * 0.75 * std::f64::consts::PI * d)
}

pub fn evaluate(b: &Bolt, p: &Prepared, u: &[f64], mats: SideMaterials) -> BoltResult {
    let l = p.local(u);
    // lokale Endkräfte des Balkens
    let mut tm = DMatrix::<f64>::zeros(12, 12);
    for blk in 0..4 {
        tm.view_mut((3 * blk, 3 * blk), (3, 3)).copy_from(&p.q);
    }
    let kl = &tm * &p.kb * tm.transpose();
    let f = kl * &l;
    let axial = p.k_ax * (l[6] - l[0] + p.offset);
    let shear = (f[7] * f[7] + f[8] * f[8]).sqrt();
    let moment = (f[4] * f[4] + f[5] * f[5]).sqrt().max((f[10] * f[10] + f[11] * f[11]).sqrt());
    let a_s = b.stress_area.unwrap_or_else(|| stress_area(b.d));
    let asm = b.assembly().unwrap_or_default();
    let ds = d_s(a_s);
    let w = std::f64::consts::PI * ds.powi(3) / 32.0;
    let sigma = axial.max(0.0) / a_s + moment / w;
    // Torsion aus dem Anziehen klingt im Betrieb teilweise ab (k_τ = 0,5); Querkraft dazu, falls die Fuge rutscht
    let tau = 0.5 * asm.m_g / (2.0 * w) + shear / a_s;
    let sigma_red = (sigma * sigma + 3.0 * tau * tau).sqrt();
    BoltResult {
        name: b.name.clone(),
        d: b.d,
        stress_area: a_s,
        axial,
        preload: asm.f_v,
        torque: asm.m_a,
        sigma_red,
        utilization: b.rp.filter(|r| *r > 0.0).map(|r| sigma_red / r),
        bearing_pressure: axial.max(0.0).max(asm.f_v) / b.bearing_area(),
        bearing_limit: mats.head.and_then(|m| m.limiting_pressure()).map(|x| x.0),
        bearing_limit_source: mats.head.and_then(|m| m.limiting_pressure()).map(|x| x.1.to_string()),
        nut_pressure: b.nut_t.map(|_| {
            let dw = b.nut_d.unwrap_or(1.6 * b.d).max(1.3 * b.d);
            axial.max(0.0).max(asm.f_v) / (std::f64::consts::FRAC_PI_4 * (dw * dw - (1.1 * b.d).powi(2)))
        }),
        nut_limit: b.nut_t.and(mats.thread).and_then(|m| m.limiting_pressure()).map(|x| x.0),
        engagement: p.engagement,
        preload_min: None,
        axial_min: None,
        setting_loss: None,
        phi_k: None,
        stress_amplitude: 0.0,
        fatigue_limit: fatigue_limit(b.d),
        engagement_min: p.engagement.and(mats.thread.and_then(|m| m.tensile_strength)).filter(|r| *r > 0.0).map(|rm_part| {
            let rm_bolt = b.rm.or(b.rp.map(|r| r / 0.8)).unwrap_or(800.0);
            engagement_min(b.d, a_s, rm_bolt, rm_part)
        }),
        shear,
        moment,
        clamp: p.clamp,
        nodes_head: p.n_head,
        nodes_thread: p.n_thread,
    }
}

/// Bohrung eines Körpers (für Vorschläge, wo Schrauben sitzen könnten)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hole {
    pub body: i32,
    pub cyl: crate::region::Cylinder,
}

/// Nenndurchmesser aus einer Durchgangsbohrung (ISO 273 mittel: M8 → Ø9)
fn d_from_clearance(dia: f64) -> Option<f64> {
    const T: [(f64, f64); 12] = [(3.0, 3.4), (4.0, 4.5), (5.0, 5.5), (6.0, 6.6), (8.0, 9.0), (10.0, 11.0), (12.0, 13.5), (14.0, 15.5), (16.0, 17.5), (20.0, 22.0), (24.0, 26.0), (30.0, 33.0)];
    T.iter().find(|(_, h)| (dia - h).abs() <= 0.06 * h).map(|(m, _)| *m)
}

/// Nenndurchmesser aus einer Gewindebohrung (Kernloch, z. B. M8 → Ø6,8, oder Nenn-Ø bei Gewindedarstellung)
fn d_from_tapped(dia: f64) -> Option<f64> {
    const T: [(f64, f64); 12] = [(3.0, 2.5), (4.0, 3.3), (5.0, 4.2), (6.0, 5.0), (8.0, 6.8), (10.0, 8.5), (12.0, 10.2), (14.0, 12.0), (16.0, 14.0), (20.0, 17.5), (24.0, 21.0), (30.0, 26.5)];
    T.iter().find(|(_, h)| (dia - h).abs() <= 0.04 * h).map(|(m, _)| *m).or_else(|| {
        let m = crate::fastener::nominal(dia);
        ((m - dia).abs() < 0.03 * m && T.iter().any(|(x, _)| *x == m)).then_some(m)
    })
}

/// Schraube von Hand an einer angeklickten Bohrung: alle Bohrungen auf derselben Achse, die (mit Lücken bis 1 mm)
/// an die gewählte anschließen. Engere Bohrung am Ende = Gewinde (Kopf auf der anderen Seite), sonst Durchsteckschraube
/// mit Mutter. Nenngröße aus der Bohrung (ISO 273 bzw. Kernloch) oder vorgegeben; `flip`: Kopf auf der anderen Seite.
pub fn bolt_at(holes: &[Hole], pick: usize, d: Option<f64>, flip: bool) -> std::result::Result<Bolt, String> {
    let h0 = holes.get(pick).ok_or("Fläche ist keine Bohrung")?;
    if !h0.cyl.hole {
        return Err("Das ist eine Welle bzw. ein Zapfen, keine Bohrung – bitte die Innenfläche einer Bohrung anklicken.".into());
    }
    let n = Vector3::from(h0.cyl.axis).normalize();
    let o = Vector3::from(h0.cyl.origin);
    let span = |h: &Hole| {
        let t0 = (Vector3::from(h.cyl.origin) - o).dot(&n);
        let t1 = t0 + h.cyl.length * Vector3::from(h.cyl.axis).normalize().dot(&n);
        (t0.min(t1), t0.max(t1))
    };
    let mut all: Vec<(usize, f64, f64)> = holes
        .iter()
        .enumerate()
        .filter(|(_, h)| {
            let a = Vector3::from(h.cyl.axis).normalize();
            let v = Vector3::from(h.cyl.origin) - o;
            h.cyl.hole && a.dot(&n).abs() > 0.999 && (v - n * v.dot(&n)).norm() < 0.1 * h0.cyl.radius.max(0.5)
        })
        .map(|(j, h)| {
            let (a, b) = span(h);
            (j, a, b)
        })
        .collect();
    all.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    // zusammenhängende Gruppe um die gewählte Bohrung
    let k = all.iter().position(|c| c.0 == pick).ok_or("Bohrung nicht gefunden")?;
    let (mut lo, mut hi) = (k, k);
    while lo > 0 && all[lo].1 - all[lo - 1].2 <= 1.0 {
        lo -= 1;
    }
    while hi + 1 < all.len() && all[hi + 1].1 - all[hi].2 <= 1.0 {
        hi += 1;
    }
    let chain = &all[lo..=hi];
    let mut bodies: Vec<i32> = chain.iter().map(|c| holes[c.0].body).collect();
    bodies.sort_unstable();
    bodies.dedup();
    if bodies.len() < 2 {
        return Err("Die Bohrung geht nur durch ein Teil – eine Schraube braucht mindestens zwei Teile, die sie zusammenhält.".into());
    }
    let radii: Vec<f64> = chain.iter().map(|c| holes[c.0].cyl.radius).collect();
    let rmax = radii.iter().copied().fold(0.0, f64::max);
    let (first_small, last_small) = (radii[0] < 0.95 * rmax, radii[radii.len() - 1] < 0.95 * rmax);
    let tapped = first_small || last_small;
    let (t_lo, t_hi) = (chain[0].1, chain[chain.len() - 1].2);
    let d = match d.filter(|d| *d > 0.0) {
        Some(d) => d,
        None if tapped => {
            let r = if last_small { radii[radii.len() - 1] } else { radii[0] };
            d_from_tapped(2.0 * r).or_else(|| d_from_clearance(2.0 * rmax)).unwrap_or_else(|| crate::fastener::nominal(2.0 * rmax / 1.1))
        }
        None => d_from_clearance(2.0 * rmax).unwrap_or_else(|| crate::fastener::nominal(2.0 * rmax / 1.1)),
    };
    let mk = |axis: Vector3<f64>, head_t: f64, nut: Option<f64>, thread: (f64, f64)| Bolt {
        name: String::new(),
        d,
        stress_area: None,
        e: 210000.0,
        origin: o.into(),
        axis: axis.into(),
        head_t,
        head_d: 1.6 * d,
        nut_t: nut,
        nut_d: nut.map(|_| 1.6 * d),
        thread_t0: thread.0,
        thread_t1: thread.1,
        preload: None,
        tighten: None,
        rp: None,
        rm: None,
        scatter: None,
        preload_factor: None,
        preload_loss: None,
    };
    Ok(if tapped {
        // Gewinde in der engeren Bohrung am Ende, Kopf auf der anderen Seite
        let c = if last_small { chain[chain.len() - 1] } else { chain[0] };
        if last_small { mk(n, t_lo, None, (c.1, c.2)) } else { mk(-n, -t_hi, None, (-c.2, -c.1)) }
    } else {
        // Durchsteckschraube: Kopf oben (Achse zeigt nach unten), sonst am Anfang; `flip` dreht um
        let down = (n.z > 0.1) != flip;
        if down { mk(-n, -t_hi, Some(-t_lo), (0.0, 0.0)) } else { mk(n, t_lo, Some(t_hi), (0.0, 0.0)) }
    })
}

/// Vorschläge: Bohrungen verschiedener Körper auf einer Achse, die aneinander anschließen – dort könnte eine Schraube
/// sitzen. Eine engere Bohrung am Ende = Gewinde (Kopf auf der anderen Seite), sonst Durchsteckschraube mit Mutter.
pub fn suggest(holes: &[Hole], existing: &[Bolt]) -> Vec<Bolt> {
    let mut used = vec![false; holes.len()];
    let mut out = Vec::new();
    for i in 0..holes.len() {
        if used[i] || !holes[i].cyl.hole {
            continue;
        }
        let n = Vector3::from(holes[i].cyl.axis).normalize();
        let o = Vector3::from(holes[i].cyl.origin);
        let on_axis = |h: &Hole| {
            let a = Vector3::from(h.cyl.axis).normalize();
            let v = Vector3::from(h.cyl.origin) - o;
            h.cyl.hole && a.dot(&n).abs() > 0.999 && (v - n * v.dot(&n)).norm() < 0.1 * holes[i].cyl.radius.max(0.5)
        };
        // Bereich entlang der Achse je Bohrung
        let mut chain: Vec<(usize, f64, f64)> = holes
            .iter()
            .enumerate()
            .filter(|(j, h)| !used[*j] && on_axis(h))
            .map(|(j, h)| {
                let t0 = (Vector3::from(h.cyl.origin) - o).dot(&n);
                let t1 = t0 + h.cyl.length * Vector3::from(h.cyl.axis).normalize().dot(&n);
                (j, t0.min(t1), t0.max(t1))
            })
            .collect();
        chain.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        for c in &chain {
            used[c.0] = true;
        }
        let bodies: Vec<i32> = chain.iter().map(|c| holes[c.0].body).collect();
        let mut distinct = bodies.clone();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() < 2 {
            continue;
        }
        // lückenlos aneinander (Platten liegen aufeinander)
        if chain.windows(2).any(|w| w[1].1 - w[0].2 > 0.5) {
            continue;
        }
        let radii: Vec<f64> = chain.iter().map(|c| holes[c.0].cyl.radius).collect();
        let (rmin, rmax) = radii.iter().fold((f64::MAX, 0.0f64), |(a, b), &r| (a.min(r), b.max(r)));
        let (t_lo, t_hi) = (chain[0].1, chain[chain.len() - 1].2);
        let first_small = radii[0] < 0.95 * rmax;
        let last_small = radii[radii.len() - 1] < 0.95 * rmax;
        let mk = |d: f64, axis: Vector3<f64>, head_t: f64, nut: Option<f64>, thread: (f64, f64)| Bolt {
            name: String::new(),
            d,
            stress_area: None,
            e: 210000.0,
            origin: o.into(),
            axis: axis.into(),
            head_t,
            head_d: 1.6 * d,
            nut_t: nut,
            nut_d: nut.map(|_| 1.6 * d),
            thread_t0: thread.0,
            thread_t1: thread.1,
            preload: None,
            tighten: None,
            rp: None,
            rm: None,
            scatter: None,
            preload_factor: None,
            preload_loss: None,
        };
        let bolt = if rmin < 0.95 * rmax && (first_small || last_small) {
            // Gewindebohrung am Ende, Kopf an der anderen Seite
            let Some(d) = d_from_tapped(2.0 * rmin).or_else(|| d_from_clearance(2.0 * rmax)) else {
                continue;
            };
            let k = if last_small { chain.len() - 1 } else { 0 };
            let (th0, th1) = (chain[k].1, chain[k].2);
            if last_small {
                mk(d, n, t_lo, None, (th0, th1))
            } else {
                mk(d, -n, -t_hi, None, (-th1, -th0))
            }
        } else {
            let Some(d) = d_from_clearance(2.0 * rmax) else {
                continue;
            };
            // Kopf oben (Achse zeigt nach unten), sonst am Anfang
            if n.z > 0.1 { mk(d, -n, -t_hi, Some(-t_lo), (0.0, 0.0)) } else { mk(d, n, t_lo, Some(t_hi), (0.0, 0.0)) }
        };
        // schon als Schraube vorhanden?
        let dup = existing.iter().any(|b| {
            let a = Vector3::from(b.axis).normalize();
            let v = Vector3::from(b.origin) - o;
            a.dot(&n).abs() > 0.999 && (v - n * v.dot(&n)).norm() < 0.25 * b.d
        });
        if !dup {
            out.push(bolt);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vorspannung_vdi2230() {
        // VDI 2230 Tab. A1: M8 8.8, µ_G = 0,12, ν = 0,9 → F_M,Tab = 18,6 kN; M_A = 25 N·m (µ_K = 0,12, d_w 11,6, d_h 9)
        let f = super::assembly_preload(8.0, 36.6, 640.0, 0.12, 0.9);
        assert!((f - 18600.0).abs() < 100.0, "{f}");
        let m = super::tightening_torque(8.0, f, 0.12, 0.12, (11.6 + 9.0) / 2.0) / 1000.0;
        assert!((m - 24.6).abs() < 0.6, "{m}");
        // M12 10.9: F_M,Tab = 63,4 kN (µ_G = 0,12)
        let f = super::assembly_preload(12.0, 84.3, 940.0, 0.12, 0.9);
        assert!((f - 63400.0).abs() < 700.0, "{f}");
        // Anziehmoment vorgegeben → dieselbe Kraft zurück
        let mut b = super::Bolt {
            name: "M8".into(),
            d: 8.0,
            stress_area: None,
            e: 210000.0,
            origin: [0.0; 3],
            axis: [0.0, 0.0, 1.0],
            head_t: 0.0,
            head_d: 13.0,
            nut_t: None,
            nut_d: None,
            thread_t0: 0.0,
            thread_t1: 0.0,
            preload: None,
            tighten: Some(super::Tighten::Ausnutzung { nu: 0.9, mu_g: 0.12, mu_k: 0.12 }),
            rp: Some(640.0),
            rm: None,
            scatter: None,
            preload_factor: None,
            preload_loss: None,
        };
        let a = b.assembly().unwrap();
        b.tighten = Some(super::Tighten::Moment { m_a: a.m_a, mu_g: 0.12, mu_k: 0.12 });
        let a2 = b.assembly().unwrap();
        assert!((a2.f_v - a.f_v).abs() < 1e-6 * a.f_v);
        b.tighten = None;
        assert!(b.assembly().is_none());
    }

    #[test]
    fn spannungsquerschnitt() {
        assert_eq!(stress_area(8.0), 36.6);
        assert_eq!(stress_area(12.0), 84.3);
        assert!((stress_area(7.0) - 31.17).abs() < 0.1);
    }
}
