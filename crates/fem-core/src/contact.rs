//! Kontakt in geöffneten Fugen (Knoten-zu-Knoten, die Fuge ist vernetzt wie verklebt und dann aufgetrennt):
//! Druck wird übertragen, Zug nicht (Fuge klafft); tangential haften die Teile, bis die Reibkraft µ·p erreicht ist,
//! dann rutschen sie (Coulomb, je Lastschritt auf den Zuwachs bezogen, Rückprojektion auf den Reibkegel mit
//! konsistenter Tangente: in Rutschrichtung feste Kraft µ·p, quer dazu Feder). Gelöst mit aktiver Menge: rechnen → Zustände prüfen → neu rechnen, bis sich nichts
//! mehr ändert. Federn (Penalty) mit erweitertem Lagrange-Verfahren: der Kontaktdruck wird je Durchgang
//! nachgeführt, bis die Durchdringung vernachlässigbar ist (Federanteil < 5 % des größten Drucks).

use nalgebra::{DMatrix, Matrix3, Vector3};
use serde::Serialize;

use crate::mesh::Mesh;

/// Reibung in der Fuge
#[derive(Debug, Clone, Copy, PartialEq, Serialize, serde::Deserialize, Default)]
#[serde(tag = "art", rename_all = "lowercase")]
pub enum Friction {
    /// Haftet immer (kein Rutschen) – Fuge kann aber klaffen
    #[default]
    Haftend,
    /// Coulomb-Reibung mit Reibwert µ (0 = reibungsfrei)
    Coulomb { mu: f64 },
}

#[derive(Debug, Clone)]
struct Pair {
    a: usize,
    b: usize,
    /// Normale aus Körper A heraus (zeigt zu B)
    n: Vector3<f64>,
    area: f64,
    kn: f64,
    kt: f64,
    closed: bool,
    /// rutscht: linearisierte Reibkraft (sonst haftet das Paar)
    slip: Option<Slip>,
    /// so oft im Schritt vom Rutschen wieder ins Haften gewechselt
    restick: u8,
    /// so oft im Schritt die Rutschkraft nachgeführt (danach gedämpft gegen Hin- und Herpendeln)
    slip_updates: u8,
    /// Druckkraft der letzten Rechnung [N]
    p: f64,
    /// nachgeführter Kontaktdruck (Lagrange-Anteil) [N], in der letzten Rechnung angesetzt
    lam: f64,
    /// Tangentialkraft auf B der letzten Rechnung (global) [N]
    ft: Vector3<f64>,
    /// so oft schon zwischen offen und zu gewechselt (springt ein Knoten am Rand hin und her, bleibt er zu)
    flips: u8,
    /// Stand am Beginn des Lastschritts: Tangentialkraft auf B und tangentiale Relativverschiebung
    f0: Vector3<f64>,
    d0: Vector3<f64>,
    /// tangentiale Relativverschiebung der letzten Rechnung
    dt: Vector3<f64>,
    /// lag nach dem Anziehen (Ende des ersten Schritts) auf
    closed0: bool,
}

/// rutschendes Paar, linearisiert um den Stand der letzten Rechnung
#[derive(Debug, Clone)]
struct Slip {
    /// Reibkraft auf B (auf dem Reibkegel)
    f: Vector3<f64>,
    /// Rutschrichtung der Kraft (Einheitsvektor)
    t: Vector3<f64>,
    /// Quersteifigkeit µ·p·k_t / |Probekraft|
    ks: f64,
    /// tangentiale Relativverschiebung, um die linearisiert ist
    d: Vector3<f64>,
}

/// Tangentialfeder bei Reibung relativ zur Normalfeder (elastischer Schlupf bis µ·p/k_t, wenige Promille der Elementgröße)
const KT_FACTOR: f64 = 0.01;

/// Stabilisierung: Federsteifigkeit in allen Richtungen relativ zur Kontaktfeder (Kräfte darin vernachlässigbar)
const STAB: f64 = 1e-9;

/// zulässige Durchdringung: Federanteil der Druckkraft höchstens dieser Bruchteil des größten Drucks
const PEN_TOL: f64 = 0.05;
/// Schwelle für Öffnen/Schließen, bezogen auf den größten Druck (verhindert Hin- und Herspringen am Rand)
const SWITCH_TOL: f64 = 5e-3;
/// nach so vielen Wechseln offen ↔ zu bleibt ein Paar zu
const MAX_FLIPS: u8 = 4;
/// so oft darf ein rutschendes Paar je Schritt wieder anhaften
const MAX_RESTICK: u8 = 2;
/// fertig, wenn die Zustandsänderungen zusammen weniger als diesen Anteil der Klemmkraft ausmachen (0,2 %)
const CONV_TOL: f64 = 2e-3;

/// Kontakt aller geöffneten Fugen eines Modells
#[derive(Debug, Clone)]
pub struct Contact {
    pairs: Vec<Pair>,
    pub friction: Friction,
    /// Körper je Fuge: (A, B) je Paar
    bodies: Vec<(i32, i32)>,
    /// Fugenflächen (für die Flächenpressung)
    faces: Vec<JointFace>,
    /// ein Schritt (Anziehen) wurde abgeschlossen
    committed: bool,
    /// Federn haben sich seit der letzten Abfrage geändert (sonst nur der Kontaktdruck → Zerlegung wiederverwenden)
    pub matrix_dirty: bool,
}

/// Dreieck der Fuge: Paare seiner Knoten, deren Flächenanteile und Fläche
#[derive(Debug, Clone)]
struct JointFace {
    pairs: Vec<usize>,
    w: Vec<f64>,
    area: f64,
}

/// Ergebnis je Fuge (Körperpaar)
#[derive(Debug, Clone, Serialize)]
pub struct JointResult {
    pub body_a: i32,
    pub body_b: i32,
    /// Fugenfläche [mm²]
    pub area: f64,
    /// Anteil der Fläche, der aufliegt (Rest klafft)
    pub closed: f64,
    /// Anteil der aufliegenden Fläche, der rutscht
    pub slipping: f64,
    /// Summe der Druckkräfte in der Fuge [N] (Restklemmkraft)
    pub pressure_force: f64,
    /// größte Flächenpressung [MPa] (Mittel je Dreieck der Fuge)
    pub max_pressure: f64,
    /// Querkraft, die die Fuge über Reibung überträgt [N]
    pub friction_force: f64,
    /// Reibschluss µ·Σp: so viel Querkraft hält die Fuge höchstens [N] (leer = haftet immer)
    pub friction_limit: Option<f64>,
    /// Anteil der Fläche, der nach dem Anziehen (vor der Last) auflag (leer = ohne Vorspannung)
    pub closed_preload: Option<f64>,
}

impl Contact {
    /// Kontaktpaare aus den getrennten Knoten (Original in A, Kopie in B). `e`: E-Modul für die Federsteifigkeit.
    pub fn new(mesh: &Mesh, pairs: &[(usize, usize)], e: f64, friction: Friction) -> Contact {
        let n_nodes = mesh.nodes.len();
        let mut is_orig = vec![false; n_nodes];
        for &(a, _) in pairs {
            is_orig[a] = true;
        }
        // Fugenflächen: Randflächen, deren Ecken alle Originalknoten sind (Seite A). Flächenanteile je Knoten
        // nach HRZ (quadratisch: Ecke 3/57, Kante 16/57 – entspricht der Massenverteilung, Ecken behalten Federn)
        let mut normal = vec![Vector3::zeros(); n_nodes];
        let mut area = vec![0.0; n_nodes];
        let mut faces_raw: Vec<(Vec<usize>, Vec<f64>, f64)> = Vec::new();
        for f in mesh.boundary_faces() {
            if !f.nodes.iter().all(|&k| is_orig[k]) {
                continue;
            }
            let p: Vec<Vector3<f64>> = f.nodes[..3].iter().map(|&k| Vector3::from(mesh.nodes[k])).collect();
            let nf = (p[1] - p[0]).cross(&(p[2] - p[0])) * 0.5;
            let af = nf.norm();
            let shares: Vec<f64> = if f.nodes.len() == 6 {
                (0..6).map(|i| if i < 3 { 3.0 / 57.0 } else { 16.0 / 57.0 } * af).collect()
            } else {
                vec![af / f.nodes.len() as f64; f.nodes.len()]
            };
            for (&k, &w) in f.nodes.iter().zip(&shares) {
                normal[k] += nf;
                area[k] += w;
            }
            faces_raw.push((f.nodes.clone(), shares, af));
        }
        // typische Elementgröße für die Federsteifigkeit
        let vol: f64 = (0..mesh.n_elems()).map(|e| crate::element::tet_volume(&mesh.elem_coords(e)[..4]).abs()).sum();
        let h = (vol / mesh.n_elems().max(1) as f64 * 8.5).cbrt().max(1e-6);
        let mut body_of_node = vec![0i32; n_nodes];
        for e in 0..mesh.n_elems() {
            let b = mesh.body_of(e);
            for &k in mesh.elem(e) {
                body_of_node[k] = b;
            }
        }
        let mut out = Vec::new();
        let mut bodies = Vec::new();
        let mut pair_of = vec![usize::MAX; n_nodes];
        for &(a, b) in pairs {
            let n = normal[a];
            if n.norm() == 0.0 || area[a] <= 0.0 || pair_of[a] != usize::MAX {
                continue;
            }
            let kn = 10.0 * e * area[a] / h;
            // Tangentialfeder: bei Reibung weicher (kleiner elastischer Schlupf, weniger Springen zwischen Haften und Rutschen)
            let kt = match friction {
                Friction::Coulomb { .. } => KT_FACTOR * kn,
                Friction::Haftend => kn,
            };
            pair_of[a] = out.len();
            out.push(Pair {
                a,
                b,
                n: n.normalize(),
                area: area[a],
                kn,
                kt,
                closed: true,
                slip: None,
                restick: 0,
                slip_updates: 0,
                p: 0.0,
                lam: 0.0,
                ft: Vector3::zeros(),
                flips: 0,
                f0: Vector3::zeros(),
                d0: Vector3::zeros(),
                dt: Vector3::zeros(),
                closed0: true,
            });
            bodies.push((body_of_node[a], body_of_node[b]));
        }
        let faces = faces_raw
            .into_iter()
            .filter_map(|(nodes, w, af)| {
                let idx: Vec<usize> = nodes.iter().map(|&k| pair_of[k]).collect();
                idx.iter().all(|&i| i != usize::MAX).then_some(JointFace { pairs: idx, w, area: af })
            })
            .collect();
        Contact { pairs: out, friction, bodies, faces, committed: false, matrix_dirty: true }
    }

    /// Lastschritt abschließen: Tangentialkräfte und -verschiebungen werden Ausgangsstand des nächsten Schritts,
    /// alle Paare beginnen haftend (Reibung wirkt auf den Zuwachs – Rückprojektion auf den Reibkegel)
    pub fn commit_step(&mut self) {
        self.committed = true;
        self.matrix_dirty = true;
        for p in &mut self.pairs {
            p.closed0 = p.closed;
            p.d0 = p.dt;
            p.f0 = if p.closed { p.ft } else { Vector3::zeros() };
            p.slip = None;
            p.flips = 0;
            p.restick = 0;
            p.slip_updates = 0;
        }
    }

    /// Tangentialfeder (global, 3 × 3) und deren Ausgangskraft auf B: Kraft auf B = f − K·Δu_t
    fn tangential(&self, p: &Pair) -> (Matrix3<f64>, Vector3<f64>) {
        let pt = Matrix3::identity() - p.n * p.n.transpose();
        match (self.friction, &p.slip) {
            (Friction::Coulomb { mu }, _) if mu <= 0.0 => (Matrix3::zeros(), Vector3::zeros()),
            (_, None) => (pt * p.kt, p.f0 + p.d0 * p.kt),
            (_, Some(sl)) => {
                // rutscht: in Rutschrichtung feste Kraft µ·p, quer dazu Feder (konsistente Tangente)
                let k = (pt - sl.t * sl.t.transpose()) * sl.ks;
                (k, sl.f + k * sl.d)
            }
        }
    }

    /// alle Paare aufliegend und haftend (linearisiert, z. B. für Eigenfrequenzen einer vorgespannten Verbindung)
    pub fn stuck(mut self) -> Self {
        for p in &mut self.pairs {
            p.closed = true;
            p.slip = None;
        }
        self.friction = Friction::Haftend;
        self
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    /// Federn der aufliegenden Paare (global, 6 × 6 je Paar)
    pub fn elements(&self) -> Vec<(Vec<usize>, DMatrix<f64>)> {
        let mut out = Vec::new();
        // alle Paare, offene mit Nullen: gleiches Besetzungsmuster in jedem Durchgang (Zerlegung wiederverwendbar)
        for p in &self.pairs {
            let nn = p.n * p.n.transpose();
            // winzige Feder in alle Richtungen: ein Teil, das nur über Kontakt hängt, macht das System nicht singulär
            let stab = Matrix3::identity() * (STAB * p.kn);
            let k3: Matrix3<f64> = stab + if p.closed { nn * p.kn + self.tangential(p).0 } else { Matrix3::zeros() };
            let mut k = DMatrix::zeros(6, 6);
            for r in 0..3 {
                for c in 0..3 {
                    k[(r, c)] = k3[(r, c)];
                    k[(3 + r, 3 + c)] = k3[(r, c)];
                    k[(r, 3 + c)] = -k3[(r, c)];
                    k[(3 + r, c)] = -k3[(r, c)];
                }
            }
            out.push((vec![p.a, p.b], k));
        }
        out
    }

    /// nachgeführter Kontaktdruck und Reibkräfte der rutschenden Paare als Knotenkräfte (global)
    pub fn forces(&self, ndof: usize) -> Vec<f64> {
        let mut f = vec![0.0; ndof];
        for p in self.pairs.iter().filter(|p| p.closed) {
            // Normaldruck (nachgeführt) + Ausgangskraft der Tangentialfeder
            let fb = p.n * p.lam + self.tangential(p).1;
            for c in 0..3 {
                f[3 * p.b + c] += fb[c];
                f[3 * p.a + c] -= fb[c];
            }
        }
        f
    }

    fn rel(p: &Pair, u: &[f64]) -> Vector3<f64> {
        Vector3::new(u[3 * p.b] - u[3 * p.a], u[3 * p.b + 1] - u[3 * p.a + 1], u[3 * p.b + 2] - u[3 * p.a + 2])
    }

    /// Zustände nach einer Rechnung prüfen; Rückgabe: Anzahl Änderungen (0 = fertig). Zählt auch einen
    /// weiteren Durchgang, wenn die Durchdringung noch zu groß ist (dann wird der Kontaktdruck nachgeführt).
    pub fn update(&mut self, u: &[f64]) -> usize {
        let mut changes = 0;
        let friction = self.friction;
        // erst alle Spalte und Drücke, dann entscheiden – mit kleiner Schwelle gegen Hin- und Herspringen am Rand
        let state: Vec<(f64, Vector3<f64>)> = self
            .pairs
            .iter()
            .map(|p| {
                let d = Self::rel(p, u);
                let g = d.dot(&p.n); // < 0: B dringt in A ein
                (g, d - p.n * g)
            })
            .collect();
        let pn_of = |p: &Pair, g: f64| p.lam - p.kn * g;
        let max_p = self.pairs.iter().zip(&state).filter(|(p, _)| p.closed).map(|(p, (g, _))| pn_of(p, *g)).fold(0.0f64, f64::max);
        let total_p: f64 = self.pairs.iter().zip(&state).filter(|(p, _)| p.closed).map(|(p, (g, _))| pn_of(p, *g).max(0.0)).sum();
        let switch = SWITCH_TOL * max_p;
        // Stand vor den Änderungen (falls nur noch Kleinigkeiten pendeln, gilt die letzte Rechnung)
        let saved: Vec<Pair> = self.pairs.clone();
        let mut max_pen = 0.0f64;
        // Summe der Kraftänderungen, die die neuen Zustände bringen würden
        let mut delta = 0.0f64;
        let mut structural = false;
        let mut kinds = [(0usize, 0.0f64); 5];
        for (p, &(g, dt)) in self.pairs.iter_mut().zip(&state) {
            p.dt = dt;
            if !p.closed {
                p.p = 0.0;
                p.ft = Vector3::zeros();
                if -p.kn * g > switch {
                    // setzt auf: haftet ab hier (Bezug für die Reibung ist der Ort des Aufsetzens)
                    p.closed = true;
                    p.flips = p.flips.saturating_add(1);
                    p.d0 = dt;
                    p.f0 = Vector3::zeros();
                    p.slip = None;
                    changes += 1;
                    delta += -p.kn * g;
                    kinds[0].0 += 1;
                    kinds[0].1 += -p.kn * g;
                    structural = true;
                }
                continue;
            }
            let pn = pn_of(p, g); // Druck > 0
                                  // Kräfte der letzten Rechnung (Summe mit Vorzeichen fürs Gleichgewicht, Reibgrenze nur aus Druck)
            p.p = pn;
            let trial = p.f0 - (dt - p.d0) * p.kt;
            let used = match (friction, &p.slip) {
                (Friction::Haftend, _) => trial,
                (Friction::Coulomb { mu }, _) if mu <= 0.0 => Vector3::zeros(),
                (_, None) => trial,
                (_, Some(sl)) => sl.f - (Matrix3::identity() - p.n * p.n.transpose() - sl.t * sl.t.transpose()) * (dt - sl.d) * sl.ks,
            };
            p.ft = used;
            if pn < -switch && p.flips < MAX_FLIPS {
                // Fuge klafft hier
                p.flips = p.flips.saturating_add(1);
                p.closed = false;
                p.slip = None;
                p.lam = 0.0;
                changes += 1;
                delta += -pn + used.norm();
                kinds[1].0 += 1;
                kinds[1].1 += -pn + used.norm();
                structural = true;
                continue;
            }
            let pn = pn.max(0.0);
            max_pen = max_pen.max(p.kn * (-g).max(0.0));
            if let Friction::Coulomb { mu } = friction {
                if mu <= 0.0 {
                    continue;
                }
                // Rückprojektion auf den Reibkegel
                let limit = mu * pn;
                let tn = trial.norm();
                // ein rutschendes Paar darf je Schritt nur zweimal wieder anhaften (sonst Hin und Her)
                let may_stick = p.slip.is_none() || p.restick < MAX_RESTICK;
                let (target, slip) = if tn > 0.0 && (tn > limit || !may_stick) {
                    let t = trial / tn;
                    (t * limit, Some(Slip { f: t * limit, t, ks: limit * p.kt / tn, d: dt }))
                } else {
                    (trial, None)
                };
                let off = (used - target).norm();
                // rutscht weiter, schon mehrfach nachgeführt: nur halb so weit gehen (dämpft Zweitakt-Pendeln)
                let (target, slip) = match (&p.slip, slip) {
                    (Some(_), Some(sl)) if p.slip_updates >= 3 => {
                        let f = used + (target - used) * 0.5;
                        let fl = f.norm().max(1e-300);
                        (f, Some(Slip { f, t: f / fl, ks: sl.ks, d: dt }))
                    }
                    (_, sl) => (target, sl),
                };
                let _ = target;
                if off > 0.02 * limit + switch * mu {
                    if p.slip.is_some() && slip.is_some() {
                        p.slip_updates = p.slip_updates.saturating_add(1);
                    }
                    let kind = match (&p.slip, &slip) {
                        (None, Some(_)) => 2,
                        (Some(_), None) => 3,
                        _ => 4,
                    };
                    kinds[kind].0 += 1;
                    kinds[kind].1 += off;
                    if p.slip.is_some() && slip.is_none() {
                        p.restick += 1;
                    }
                    p.slip = slip;
                    changes += 1;
                    delta += off;
                    structural = true;
                }
            }
        }
        // Durchdringung noch zu groß → Kontaktdruck nachführen und noch einmal rechnen
        let pen = max_p > 0.0 && max_pen > PEN_TOL * max_p;
        if std::env::var("FEM_KONTAKT_DEBUG").is_ok() {
            let closed = self.pairs.iter().filter(|p| p.closed).count();
            let slip = self.pairs.iter().filter(|p| p.closed && p.slip.is_some()).count();
            eprintln!(
                "Kontakt: {changes} Änderungen ({:.2} ‰ der Klemmkraft) {kinds:.1?}, Durchdringung {:.4} von max {:.1}, {closed}/{} zu, {slip} rutschen",
                1000.0 * delta / total_p.max(1e-300),
                max_pen / max_p.max(1e-300),
                max_p,
                self.pairs.len()
            );
        }
        if changes > 0 && !pen && delta <= CONV_TOL * total_p {
            // nur noch kleine Änderungen an wenigen Knoten: fertig, die letzte Rechnung gilt
            for (p, old) in self.pairs.iter_mut().zip(saved) {
                let (pp, ft, dt) = (p.p, p.ft, p.dt);
                *p = old;
                p.p = pp;
                p.ft = ft;
                p.dt = dt;
            }
            return 0;
        }
        if changes > 0 || pen {
            for p in self.pairs.iter_mut().filter(|p| p.closed) {
                p.lam = p.p.max(0.0);
            }
        }
        self.matrix_dirty |= structural;
        changes + pen as usize
    }

    /// Kräfte der Kontaktfedern und Reibung je Knoten (für innere Kräfte / Lagerkräfte)
    pub fn add_internal(&self, u: &[f64], f_int: &mut [f64]) {
        for (nodes, k) in self.elements() {
            let ue: Vec<f64> = nodes.iter().flat_map(|&n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect();
            let fe = k * nalgebra::DVector::from_column_slice(&ue);
            for (a, &n) in nodes.iter().enumerate() {
                for c in 0..3 {
                    f_int[3 * n + c] += fe[3 * a + c];
                }
            }
        }
        // Reibkräfte sind innere Kräfte zwischen A und B (im Gleichungssystem als Last angesetzt)
        let fr = self.forces(f_int.len());
        for (i, v) in fr.iter().enumerate() {
            f_int[i] -= v;
        }
    }

    /// Ergebnis je Fuge (Körperpaar)
    pub fn results(&self) -> Vec<JointResult> {
        let mut out: Vec<JointResult> = Vec::new();
        let mut sum_ft: Vec<Vector3<f64>> = Vec::new();
        for (p, &(a, b)) in self.pairs.iter().zip(&self.bodies) {
            let r = match out.iter_mut().position(|r| r.body_a == a && r.body_b == b) {
                Some(i) => {
                    sum_ft[i] += p.ft;
                    &mut out[i]
                }
                None => {
                    sum_ft.push(p.ft);
                    out.push(JointResult {
                        body_a: a,
                        body_b: b,
                        area: 0.0,
                        closed: 0.0,
                        slipping: 0.0,
                        pressure_force: 0.0,
                        max_pressure: 0.0,
                        friction_force: 0.0,
                        friction_limit: None,
                        closed_preload: self.committed.then_some(0.0),
                    });
                    out.last_mut().unwrap()
                }
            };
            r.area += p.area;
            if p.closed0 {
                if let Some(c) = r.closed_preload.as_mut() {
                    *c += p.area;
                }
            }
            if p.closed {
                r.closed += p.area;
                if p.slip.is_some() {
                    r.slipping += p.area;
                }
                r.pressure_force += p.p;
            }
        }
        // Flächenpressung je Dreieck: Knotenkräfte nach Flächenanteil auf die anliegenden Dreiecke verteilt
        for f in &self.faces {
            let force: f64 = f.pairs.iter().zip(&f.w).map(|(&i, &w)| self.pairs[i].p * w / self.pairs[i].area).sum();
            let (a, b) = self.bodies[f.pairs[0]];
            if let Some(r) = out.iter_mut().find(|r| r.body_a == a && r.body_b == b) {
                r.max_pressure = r.max_pressure.max(force / f.area);
            }
        }
        for (r, ft) in out.iter_mut().zip(sum_ft) {
            r.friction_force = ft.norm();
            r.friction_limit = match self.friction {
                Friction::Haftend => None,
                Friction::Coulomb { mu } => Some(mu.max(0.0) * r.pressure_force.max(0.0)),
            };
            if let Some(c) = r.closed_preload.as_mut() {
                *c /= r.area.max(1e-300);
            }
            if r.closed > 0.0 {
                r.slipping /= r.closed;
            }
            r.closed /= r.area.max(1e-300);
        }
        out
    }
}
