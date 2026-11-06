//! Stabwerke (Phase 4): Balken, Rahmen und Fachwerke im Raum.
//!
//! Balken: Euler-Bernoulli, 6 Freiheitsgrade je Knoten (3 Verschiebungen, 3 Verdrehungen), je Stab intern in
//! Abschnitte geteilt (Schnittgrößen und Biegelinie entlang des Stabs). Fachwerkstäbe übertragen nur Normalkraft.
//! Einheiten wie im übrigen Programm: mm, N, MPa (Momente N·mm).

use faer::linalg::solvers::Solve;
use faer::sparse::{SparseColMat, Triplet};
use faer::{Col, Side};
use nalgebra::{Matrix3, SMatrix, SVector, Vector3};
use serde::{Deserialize, Serialize};

use crate::{FemError, Result};

type M12 = SMatrix<f64, 12, 12>;
type V12 = SVector<f64, 12>;

/// Querschnitt
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Profile {
    /// Rechteck: Breite b (lokal y), Höhe h (lokal z)
    Rect { b: f64, h: f64 },
    Round { d: f64 },
    /// Rohr: Außendurchmesser, Wandstärke
    Tube { d: f64, t: f64 },
    /// Rechteckrohr
    RectTube { b: f64, h: f64, t: f64 },
    /// Kennwerte direkt (z. B. Walzprofile aus der Tabelle): A [mm²], I [mm⁴], W [mm³], It [mm⁴], Wt [mm³]
    Custom { a: f64, iy: f64, iz: f64, wy: f64, wz: f64, it: f64, wt: f64 },
}

/// Querschnittswerte (lokal: y quer, z hoch; My biegt um y)
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Section {
    pub a: f64,
    pub iy: f64,
    pub iz: f64,
    pub wy: f64,
    pub wz: f64,
    pub it: f64,
    pub wt: f64,
    /// rund: Biegespannung aus √(My² + Mz²)/W statt |My|/Wy + |Mz|/Wz
    pub round: bool,
}

impl Profile {
    pub fn section(&self) -> Section {
        use std::f64::consts::PI;
        match *self {
            Profile::Rect { b, h } => {
                let (a, c) = (b.max(h), b.min(h));
                let it = a * c.powi(3) * (1.0 / 3.0 - 0.21 * (c / a) * (1.0 - c.powi(4) / (12.0 * a.powi(4))));
                Section { a: b * h, iy: b * h.powi(3) / 12.0, iz: h * b.powi(3) / 12.0, wy: b * h * h / 6.0, wz: h * b * b / 6.0, it, wt: it / c, round: false }
            }
            Profile::Round { d } => {
                let i = PI * d.powi(4) / 64.0;
                Section { a: PI * d * d / 4.0, iy: i, iz: i, wy: 2.0 * i / d, wz: 2.0 * i / d, it: 2.0 * i, wt: 4.0 * i / d, round: true }
            }
            Profile::Tube { d, t } => {
                let di = d - 2.0 * t;
                let i = PI * (d.powi(4) - di.powi(4)) / 64.0;
                Section { a: PI * (d * d - di * di) / 4.0, iy: i, iz: i, wy: 2.0 * i / d, wz: 2.0 * i / d, it: 2.0 * i, wt: 4.0 * i / d, round: true }
            }
            Profile::RectTube { b, h, t } => {
                let (bi, hi) = (b - 2.0 * t, h - 2.0 * t);
                let iy = (b * h.powi(3) - bi * hi.powi(3)) / 12.0;
                let iz = (h * b.powi(3) - hi * bi.powi(3)) / 12.0;
                let am = (b - t) * (h - t);
                let u = 2.0 * ((b - t) + (h - t));
                Section { a: b * h - bi * hi, iy, iz, wy: 2.0 * iy / h, wz: 2.0 * iz / b, it: 4.0 * am * am * t / u, wt: 2.0 * am * t, round: false }
            }
            Profile::Custom { a, iy, iz, wy, wz, it, wt } => Section { a, iy, iz, wy, wz, it, wt, round: false },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub a: usize,
    pub b: usize,
    /// Index in `Frame::profiles`
    pub profile: usize,
    /// Fachwerkstab: nur Normalkraft (gelenkig angeschlossen)
    #[serde(default)]
    pub truss: bool,
    /// Drehung des Profils um die Stabachse [Grad]
    #[serde(default)]
    pub angle: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameSupport {
    pub node: usize,
    /// ux, uy, uz, φx, φy, φz festgehalten
    pub fix: [bool; 6],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeLoad {
    pub node: usize,
    /// Kraft [N]
    #[serde(default)]
    pub f: [f64; 3],
    /// Moment [N·mm]
    #[serde(default)]
    pub m: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberLoad {
    pub member: usize,
    /// Streckenlast global [N/mm]
    pub q: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub nodes: Vec<[f64; 3]>,
    pub members: Vec<Member>,
    pub profiles: Vec<Profile>,
    /// E [MPa], ν, Streckgrenze bzw. Festigkeit [MPa] (optional), Dichte [t/mm³] (für Eigengewicht)
    #[serde(rename = "E")]
    pub e: f64,
    pub nu: f64,
    #[serde(default)]
    pub strength: Option<f64>,
    #[serde(default)]
    pub density: f64,
    /// Eigengewicht in −z mitrechnen
    #[serde(default)]
    pub self_weight: bool,
    /// ebenes System in der xz-Ebene: uy, φx, φz an allen Knoten gesperrt
    #[serde(default)]
    pub planar: bool,
    pub supports: Vec<FrameSupport>,
    #[serde(default)]
    pub node_loads: Vec<NodeLoad>,
    #[serde(default)]
    pub member_loads: Vec<MemberLoad>,
}

/// Schnittgrößen und Spannung an einer Stelle des Stabs
#[derive(Debug, Clone, Serialize)]
pub struct Station {
    /// Abstand vom Stabanfang [mm]
    pub x: f64,
    /// Verschiebung (global) [mm]
    pub u: [f64; 3],
    pub n: f64,
    pub vy: f64,
    pub vz: f64,
    pub t: f64,
    pub my: f64,
    pub mz: f64,
    /// Vergleichsspannung [MPa]
    pub sigma_v: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberResult {
    pub stations: Vec<Station>,
    pub max_sigma_v: f64,
    /// σv / Festigkeit
    pub utilization: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameResults {
    /// Verschiebung und Verdrehung je Knoten
    pub displacement: Vec<[f64; 6]>,
    pub members: Vec<MemberResult>,
    /// Lagerreaktion je Lager (Kräfte [N], Momente [N·mm])
    pub reactions: Vec<[f64; 6]>,
    pub max_displacement: f64,
    pub max_sigma_v: f64,
    pub safety: Option<f64>,
    pub total_load: [f64; 3],
}

/// Teilungen je Balken (Schnittgrößen- und Biegelinienpunkte)
const SUBDIV: usize = 10;

/// Lokale Achsen des Stabs (Zeilen: x entlang, y quer, z „oben“), Profil um `angle` gedreht
fn axes(p: Vector3<f64>, q: Vector3<f64>, angle: f64) -> Result<Matrix3<f64>> {
    let x = q - p;
    let l = x.norm();
    if l <= 1e-12 {
        return Err(FemError::Input("Stab mit Länge 0 (Anfangs- und Endknoten gleich)".into()));
    }
    let x = x / l;
    // „oben“ = globale z-Achse, bei senkrechten Stäben globale x-Achse
    let r = if x.z.abs() > 0.999 { Vector3::x() } else { Vector3::z() };
    let z0 = (r - x * x.dot(&r)).normalize();
    let y0 = z0.cross(&x);
    let (s, c) = angle.to_radians().sin_cos();
    let y = y0 * c + z0 * s;
    let z = x.cross(&y);
    Ok(Matrix3::from_rows(&[x.transpose(), y.transpose(), z.transpose()]))
}

/// Lokale Steifigkeit 12 × 12
fn local_k(e: f64, g: f64, l: f64, s: &Section, truss: bool) -> M12 {
    let mut k = M12::zeros();
    let ea = e * s.a / l;
    k[(0, 0)] = ea;
    k[(6, 6)] = ea;
    k[(0, 6)] = -ea;
    if !truss {
        let gj = g * s.it / l;
        k[(3, 3)] = gj;
        k[(9, 9)] = gj;
        k[(3, 9)] = -gj;
        let (ez, ey) = (e * s.iz, e * s.iy);
        // v–φz (Biegung um z)
        k[(1, 1)] = 12.0 * ez / l.powi(3);
        k[(7, 7)] = k[(1, 1)];
        k[(1, 7)] = -k[(1, 1)];
        k[(1, 5)] = 6.0 * ez / (l * l);
        k[(1, 11)] = k[(1, 5)];
        k[(5, 7)] = -k[(1, 5)];
        k[(7, 11)] = -k[(1, 5)];
        k[(5, 5)] = 4.0 * ez / l;
        k[(11, 11)] = k[(5, 5)];
        k[(5, 11)] = 2.0 * ez / l;
        // w–φy (Biegung um y)
        k[(2, 2)] = 12.0 * ey / l.powi(3);
        k[(8, 8)] = k[(2, 2)];
        k[(2, 8)] = -k[(2, 2)];
        k[(2, 4)] = -6.0 * ey / (l * l);
        k[(2, 10)] = k[(2, 4)];
        k[(4, 8)] = -k[(2, 4)];
        k[(8, 10)] = -k[(2, 4)];
        k[(4, 4)] = 4.0 * ey / l;
        k[(10, 10)] = k[(4, 4)];
        k[(4, 10)] = 2.0 * ey / l;
    }
    for i in 0..12 {
        for j in 0..i {
            k[(i, j)] = k[(j, i)];
        }
    }
    k
}

/// Festeinspannkräfte für gleichmäßige Streckenlast (lokal)
fn local_f0(q: Vector3<f64>, l: f64, truss: bool) -> V12 {
    let mut f = V12::zeros();
    f[0] = q.x * l / 2.0;
    f[6] = q.x * l / 2.0;
    f[1] = q.y * l / 2.0;
    f[7] = q.y * l / 2.0;
    f[2] = q.z * l / 2.0;
    f[8] = q.z * l / 2.0;
    if !truss {
        f[5] = q.y * l * l / 12.0;
        f[11] = -q.y * l * l / 12.0;
        f[4] = -q.z * l * l / 12.0;
        f[10] = q.z * l * l / 12.0;
    }
    f
}

fn transform(r: &Matrix3<f64>) -> M12 {
    let mut t = M12::zeros();
    for b in 0..4 {
        for i in 0..3 {
            for j in 0..3 {
                t[(3 * b + i, 3 * b + j)] = r[(i, j)];
            }
        }
    }
    t
}

struct Elem {
    a: usize,
    b: usize,
    member: usize,
    x0: f64,
    l: f64,
    r: Matrix3<f64>,
    k: M12,
    f0: V12,
    truss: bool,
    sec: Section,
}

pub fn solve_frame(f: &Frame) -> Result<FrameResults> {
    if !(f.e > 0.0) || !(f.nu > -1.0 && f.nu < 0.5) {
        return Err(FemError::Input("Werkstoff: E > 0 und −1 < ν < 0,5".into()));
    }
    if f.members.is_empty() {
        return Err(FemError::Input("Keine Stäbe".into()));
    }
    let g = f.e / (2.0 * (1.0 + f.nu));
    let n_user = f.nodes.len();
    for m in &f.members {
        if m.a >= n_user || m.b >= n_user || m.profile >= f.profiles.len() {
            return Err(FemError::Input("Stab verweist auf einen fehlenden Knoten oder Querschnitt".into()));
        }
    }
    // Knoten: Benutzerknoten + Zwischenknoten der Balken
    let mut pos: Vec<Vector3<f64>> = f.nodes.iter().map(|p| Vector3::from(*p)).collect();
    let mut elems = Vec::new();
    let mut total = Vector3::zeros();
    for (mi, m) in f.members.iter().enumerate() {
        let (p, q) = (pos[m.a], pos[m.b]);
        let r = axes(p, q, m.angle)?;
        let sec = f.profiles[m.profile].section();
        let len = (q - p).norm();
        let mut qg = Vector3::zeros();
        for ml in f.member_loads.iter().filter(|l| l.member == mi) {
            qg += Vector3::from(ml.q);
        }
        if f.self_weight {
            qg += Vector3::new(0.0, 0.0, -f.density * 9810.0 * sec.a); // t/mm³ · mm/s² · mm² = N/mm
        }
        total += qg * len;
        let ql = r * qg;
        let parts = if m.truss { 1 } else { SUBDIV };
        let mut prev = m.a;
        for k in 0..parts {
            let next = if k + 1 == parts {
                m.b
            } else {
                pos.push(p + (q - p) * ((k + 1) as f64 / parts as f64));
                pos.len() - 1
            };
            let l = len / parts as f64;
            elems.push(Elem {
                a: prev,
                b: next,
                member: mi,
                x0: len * k as f64 / parts as f64,
                l,
                r,
                k: local_k(f.e, g, l, &sec, m.truss),
                f0: local_f0(ql, l, m.truss),
                truss: m.truss,
                sec,
            });
            prev = next;
        }
    }
    let nn = pos.len();
    let ndof = 6 * nn;
    // feste Freiheitsgrade: Lager, und Verdrehungen an Knoten nur mit Fachwerkstäben
    let mut fixed = vec![false; ndof];
    for s in &f.supports {
        if s.node >= n_user {
            return Err(FemError::Input("Lager an einem fehlenden Knoten".into()));
        }
        for k in 0..6 {
            fixed[6 * s.node + k] |= s.fix[k];
        }
    }
    let mut has_beam = vec![false; nn];
    for e in &elems {
        if !e.truss {
            has_beam[e.a] = true;
            has_beam[e.b] = true;
        }
    }
    for n in 0..nn {
        if !has_beam[n] {
            for k in 3..6 {
                fixed[6 * n + k] = true;
            }
        }
        if f.planar {
            for k in [1, 3, 5] {
                fixed[6 * n + k] = true;
            }
        }
    }
    // Lastvektor
    let mut fext = vec![0.0; ndof];
    for nl in &f.node_loads {
        if nl.node >= n_user {
            return Err(FemError::Input("Last an einem fehlenden Knoten".into()));
        }
        for k in 0..3 {
            fext[6 * nl.node + k] += nl.f[k];
            fext[6 * nl.node + 3 + k] += nl.m[k];
        }
        total += Vector3::from(nl.f);
    }
    let mut kglob: Vec<M12> = Vec::with_capacity(elems.len());
    for e in &elems {
        let t = transform(&e.r);
        let kg = t.transpose() * e.k * t;
        let fg = t.transpose() * e.f0;
        for (blk, node) in [(0, e.a), (1, e.b)] {
            for k in 0..6 {
                fext[6 * node + k] += fg[6 * blk + k];
            }
        }
        kglob.push(kg);
    }
    // Gleichungsnummern, Assemblierung (untere Hälfte), Cholesky
    let mut eq = vec![usize::MAX; ndof];
    let mut neq = 0;
    for i in 0..ndof {
        if !fixed[i] {
            eq[i] = neq;
            neq += 1;
        }
    }
    let mut trip = Vec::new();
    for (e, kg) in elems.iter().zip(&kglob) {
        let dofs: Vec<usize> = (0..12).map(|i| 6 * if i < 6 { e.a } else { e.b } + i % 6).collect();
        for (i, &gi) in dofs.iter().enumerate() {
            for (j, &gj) in dofs.iter().enumerate() {
                let (r, c) = (eq[gi], eq[gj]);
                if r != usize::MAX && c != usize::MAX && r >= c && kg[(i, j)] != 0.0 {
                    trip.push(Triplet::new(r, c, kg[(i, j)]));
                }
            }
        }
    }
    let kmat = SparseColMat::<usize, f64>::try_new_from_triplets(neq, neq, &trip).map_err(|e| FemError::Input(format!("{e:?}")))?;
    let llt = kmat.sp_cholesky(Side::Lower).map_err(|_| FemError::Underconstrained)?;
    let rhs = Col::<f64>::from_fn(neq, |i| 0.0 * i as f64);
    let mut rhs = rhs;
    for i in 0..ndof {
        if eq[i] != usize::MAX {
            rhs[eq[i]] = fext[i];
        }
    }
    let x = llt.solve(&rhs);
    if x.iter().any(|v| !v.is_finite()) {
        return Err(FemError::Underconstrained);
    }
    let mut u = vec![0.0; ndof];
    for i in 0..ndof {
        if eq[i] != usize::MAX {
            u[i] = x[eq[i]];
        }
    }
    // Schnittgrößen je Abschnitt, Knotenkräfte für die Lagerreaktionen
    let mut fint = vec![0.0; ndof];
    let mut members: Vec<MemberResult> = f.members.iter().map(|_| MemberResult { stations: Vec::new(), max_sigma_v: 0.0, utilization: None }).collect();
    let stress = |sec: &Section, n: f64, t: f64, my: f64, mz: f64| -> f64 {
        let sb = if sec.round { (my * my + mz * mz).sqrt() / sec.wy } else { my.abs() / sec.wy + mz.abs() / sec.wz };
        let s = n.abs() / sec.a + sb;
        let tau = if sec.wt > 0.0 { t.abs() / sec.wt } else { 0.0 };
        (s * s + 3.0 * tau * tau).sqrt()
    };
    for (e, kg) in elems.iter().zip(&kglob) {
        let t = transform(&e.r);
        let ug = V12::from_iterator((0..12).map(|i| u[6 * if i < 6 { e.a } else { e.b } + i % 6]));
        let fl = e.k * (t * ug) - e.f0;
        // K·u (die Ersatzlasten der Streckenlast stecken bereits im Lastvektor)
        let fg = kg * ug;
        for (blk, node) in [(0, e.a), (1, e.b)] {
            for k in 0..6 {
                fint[6 * node + k] += fg[6 * blk + k];
            }
        }
        let mr = &mut members[e.member];
        let disp = |node: usize| [u[6 * node], u[6 * node + 1], u[6 * node + 2]];
        // Schnittgrößen: Anfang = −Stabendkraft, Ende = +Stabendkraft
        let st = |x: f64, node: usize, s: f64, fo: usize| {
            let (n, vy, vz, tt, my, mz) = (s * fl[fo], s * fl[fo + 1], s * fl[fo + 2], s * fl[fo + 3], s * fl[fo + 4], s * fl[fo + 5]);
            Station { x, u: disp(node), n, vy, vz, t: tt, my, mz, sigma_v: stress(&e.sec, n, tt, my, mz) }
        };
        if mr.stations.is_empty() {
            mr.stations.push(st(e.x0, e.a, -1.0, 0));
        }
        mr.stations.push(st(e.x0 + e.l, e.b, 1.0, 6));
    }
    let strength = f.strength.filter(|s| *s > 0.0);
    for m in members.iter_mut() {
        m.max_sigma_v = m.stations.iter().map(|s| s.sigma_v).fold(0.0, f64::max);
        m.utilization = strength.map(|r| m.max_sigma_v / r);
    }
    let reactions = f
        .supports
        .iter()
        .map(|s| {
            let n = s.node;
            let mut r = [0.0; 6];
            for k in 0..6 {
                if fixed[6 * n + k] {
                    r[k] = fint[6 * n + k] - fext[6 * n + k];
                }
            }
            r
        })
        .collect();
    let displacement: Vec<[f64; 6]> = (0..n_user).map(|n| [0, 1, 2, 3, 4, 5].map(|k| u[6 * n + k])).collect();
    let max_displacement = (0..nn).map(|n| (u[6 * n].powi(2) + u[6 * n + 1].powi(2) + u[6 * n + 2].powi(2)).sqrt()).fold(0.0, f64::max);
    let max_sigma_v = members.iter().map(|m| m.max_sigma_v).fold(0.0, f64::max);
    Ok(FrameResults {
        displacement,
        members,
        reactions,
        max_displacement,
        max_sigma_v,
        safety: strength.map(|r| r / max_sigma_v.max(1e-300)),
        total_load: total.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beam(nodes: Vec<[f64; 3]>, members: Vec<(usize, usize, bool)>, profile: Profile) -> Frame {
        Frame {
            nodes,
            members: members.into_iter().map(|(a, b, truss)| Member { a, b, profile: 0, truss, angle: 0.0 }).collect(),
            profiles: vec![profile],
            e: 210_000.0,
            nu: 0.3,
            strength: Some(235.0),
            density: 7.85e-9,
            self_weight: false,
            planar: false,
            supports: vec![],
            node_loads: vec![],
            member_loads: vec![],
        }
    }

    #[test]
    fn einfeldtraeger_einzellast() {
        // L = 2000, Rechteck 40 × 80, F = 5 kN in Feldmitte (−z): w = F·L³/(48·E·I), M = F·L/4
        let mut f = beam(vec![[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0], [2000.0, 0.0, 0.0]], vec![(0, 1, false), (1, 2, false)], Profile::Rect { b: 40.0, h: 80.0 });
        f.supports = vec![FrameSupport { node: 0, fix: [true, true, true, true, false, false] }, FrameSupport { node: 2, fix: [false, true, true, false, false, false] }];
        f.node_loads = vec![NodeLoad { node: 1, f: [0.0, 0.0, -5000.0], m: [0.0; 3] }];
        let r = solve_frame(&f).unwrap();
        let i = 40.0 * 80f64.powi(3) / 12.0;
        let w = 5000.0 * 2000f64.powi(3) / (48.0 * 210_000.0 * i);
        assert!((r.displacement[1][2] + w).abs() < 1e-6 * w, "{} vs {}", r.displacement[1][2], -w);
        let sigma = 5000.0 * 2000.0 / 4.0 / (40.0 * 80.0 * 80.0 / 6.0);
        assert!((r.max_sigma_v - sigma).abs() < 1e-6 * sigma, "{} vs {sigma}", r.max_sigma_v);
        assert!((r.reactions[0][2] - 2500.0).abs() < 1e-6 && (r.reactions[1][2] - 2500.0).abs() < 1e-6);
    }

    #[test]
    fn kragarm_streckenlast() {
        // L = 1000, Rohr 60 × 4, q = 2 N/mm (−z): w = q·L⁴/(8·E·I), M = q·L²/2
        let mut f = beam(vec![[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0]], vec![(0, 1, false)], Profile::Tube { d: 60.0, t: 4.0 });
        f.supports = vec![FrameSupport { node: 0, fix: [true; 6] }];
        f.member_loads = vec![MemberLoad { member: 0, q: [0.0, 0.0, -2.0] }];
        let r = solve_frame(&f).unwrap();
        let s = Profile::Tube { d: 60.0, t: 4.0 }.section();
        let w = 2.0 * 1000f64.powi(4) / (8.0 * 210_000.0 * s.iy);
        assert!((r.displacement[1][2] + w).abs() < 1e-6 * w);
        let sigma = 2.0 * 1000f64.powi(2) / 2.0 / s.wy;
        assert!((r.max_sigma_v - sigma).abs() < 1e-6 * sigma, "{} vs {sigma}", r.max_sigma_v);
        assert!((r.reactions[0][2] - 2000.0).abs() < 1e-6);
    }

    #[test]
    fn fachwerk_dreieck() {
        // Dreieck: Auflager links (fest) und rechts (in x frei), Last 10 kN nach unten in der Spitze.
        // Stäbe 45°: Druckkraft je Diagonale F/(2·sin 45°), Untergurt Zug F/2
        let mut f = beam(
            vec![[0.0, 0.0, 0.0], [2000.0, 0.0, 0.0], [1000.0, 0.0, 1000.0]],
            vec![(0, 1, true), (0, 2, true), (1, 2, true)],
            Profile::Round { d: 20.0 },
        );
        f.supports = vec![
            FrameSupport { node: 0, fix: [true, true, true, false, false, false] },
            FrameSupport { node: 1, fix: [false, true, true, false, false, false] },
            FrameSupport { node: 2, fix: [false, true, false, false, false, false] },
        ];
        f.node_loads = vec![NodeLoad { node: 2, f: [0.0, 0.0, -10_000.0], m: [0.0; 3] }];
        let r = solve_frame(&f).unwrap();
        let n_gurt = r.members[0].stations[0].n;
        let n_diag = r.members[1].stations[0].n;
        assert!((n_gurt - 5000.0).abs() < 1e-6, "Untergurt {n_gurt}");
        assert!((n_diag + 10_000.0 / (2.0 * 0.5f64.sqrt())).abs() < 1e-6, "Diagonale {n_diag}");
    }
}
