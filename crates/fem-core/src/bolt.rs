//! Schrauben als Verbindungselement (ohne Volumennetz der Schraube).
//!
//! Die Schraube koppelt den Mittelwert der Verschiebungen unter dem Kopf (Ring auf der Auflagefläche) mit dem
//! Mittelwert auf der Gewindeseite (Wand der Gewindebohrung bzw. Ring unter der Mutter) – wie ein RBE3-Verbinder.
//! Steifigkeit: längs E·A_s / (l_k + 0,9·d) (Klemmlänge + Anteile Kopf und Gewinde nach VDI 2230), quer
//! 12·E·I / l_k³ (beidseitig eingespannter Schaft). Ergebnis: Schraubenkraft längs (Zug +) und quer.
//! Vorspannung kommt mit dem Kontakt zwischen den verschraubten Teilen (später).

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
    /// globale → lokale Achsen (Zeilen: Schraubenachse, e1, e2)
    pub q: Matrix3<f64>,
    pub k_ax: f64,
    pub clamp: f64,
    pub n_head: usize,
    pub n_thread: usize,
}

impl Prepared {
    /// Steifigkeitsmatrix über alle beteiligten Knoten (3m × 3m): Gᵀ·K·G
    pub fn stiffness(&self) -> DMatrix<f64> {
        self.g.transpose() * &self.kb * &self.g
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
    /// Kraft längs der Achse [N], positiv = Zug
    pub axial: f64,
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
const MAX_SIDE_NODES: usize = 72;

fn pick_ring(mut cand: Vec<(usize, f64)>) -> Vec<usize> {
    // nach Winkel sortieren, gleichmäßig ausdünnen
    cand.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    if cand.len() <= MAX_SIDE_NODES {
        return cand.into_iter().map(|c| c.0).collect();
    }
    let step = cand.len() as f64 / MAX_SIDE_NODES as f64;
    (0..MAX_SIDE_NODES).map(|i| cand[(i as f64 * step) as usize].0).collect()
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
    let ring = |t0: f64, r0: f64, r1: f64| -> Vec<usize> {
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
        pick_ring(cand)
    };
    let head = ring(b.head_t, 0.45 * b.d, 0.5 * b.head_d.max(1.2 * b.d) * 1.05);
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
            let ring: Vec<(usize, f64)> = cand.iter().filter(|c| c.2 <= first + 1.2 * b.d).map(|c| (c.0, c.1)).collect();
            (pick_ring(ring), first)
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
    let nodes: Vec<usize> = head.iter().chain(&thread).copied().collect();
    let m = nodes.len();
    // Mittelpunkt und Verdrehungsschätzung je Seite: θ = I_p⁻¹ Σ wᵢ rᵢ × uᵢ
    let mut g = DMatrix::zeros(12, 3 * m);
    let mut centers = [Vector3::zeros(); 2];
    for (side, (range, off)) in [(0..nh, 0usize), (nh..m, 6usize)].into_iter().enumerate() {
        let k = range.len() as f64;
        let c: Vector3<f64> = range.clone().map(|j| Vector3::from(mesh.nodes[nodes[j]])).sum::<Vector3<f64>>() / k;
        centers[side] = c;
        let mut ip = Matrix3::zeros();
        for j in range.clone() {
            let r = Vector3::from(mesh.nodes[nodes[j]]) - c;
            ip += (Matrix3::identity() * r.norm_squared() - r * r.transpose()) / k;
        }
        let ip_inv = ip.try_inverse().ok_or_else(|| FemError::Input(format!("{}: Auflage zu klein für die Schraube", b.name)))?;
        for j in range {
            let r = Vector3::from(mesh.nodes[nodes[j]]) - c;
            let skew = Matrix3::new(0.0, -r.z, r.y, r.z, 0.0, -r.x, -r.y, r.x, 0.0);
            let t = ip_inv * skew / k;
            for a in 0..3 {
                g[(off + a, 3 * j + a)] = 1.0 / k;
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
    let kb = tm.transpose() * kl * &tm;
    Ok(Prepared { nodes, g, kb, q, k_ax, clamp, n_head: nh, n_thread: nt })
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

/// Schraubenkräfte aus der Lösung
pub fn evaluate(b: &Bolt, p: &Prepared, u: &[f64]) -> BoltResult {
    let l = p.local(u);
    // lokale Endkräfte des Balkens
    let mut tm = DMatrix::<f64>::zeros(12, 12);
    for blk in 0..4 {
        tm.view_mut((3 * blk, 3 * blk), (3, 3)).copy_from(&p.q);
    }
    let kl = &tm * &p.kb * tm.transpose();
    let f = kl * &l;
    let axial = p.k_ax * (l[6] - l[0]);
    let shear = (f[7] * f[7] + f[8] * f[8]).sqrt();
    let moment = (f[4] * f[4] + f[5] * f[5]).sqrt().max((f[10] * f[10] + f[11] * f[11]).sqrt());
    BoltResult {
        name: b.name.clone(),
        d: b.d,
        stress_area: b.stress_area.unwrap_or_else(|| stress_area(b.d)),
        axial,
        shear,
        moment,
        clamp: p.clamp,
        nodes_head: p.n_head,
        nodes_thread: p.n_thread,
    }
}

/// Bohrung eines Körpers (für Vorschläge, wo Schrauben sitzen könnten)
#[derive(Debug, Clone)]
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
        };
        let bolt = if rmin < 0.95 * rmax && (first_small || last_small) {
            // Gewindebohrung am Ende, Kopf an der anderen Seite
            let Some(d) = d_from_tapped(2.0 * rmin).or_else(|| d_from_clearance(2.0 * rmax)) else { continue };
            let k = if last_small { chain.len() - 1 } else { 0 };
            let (th0, th1) = (chain[k].1, chain[k].2);
            if last_small {
                mk(d, n, t_lo, None, (th0, th1))
            } else {
                mk(d, -n, -t_hi, None, (-th1, -th0))
            }
        } else {
            let Some(d) = d_from_clearance(2.0 * rmax) else { continue };
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
    fn spannungsquerschnitt() {
        assert_eq!(stress_area(8.0), 36.6);
        assert_eq!(stress_area(12.0), 84.3);
        assert!((stress_area(7.0) - 31.17).abs() < 0.1);
    }
}
