use std::collections::HashMap;

use crate::element::{edge_index, tet_volume, TET_FACES};
use crate::{FemError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    /// TET4 – lineare Ansatzfunktionen (steif bei Biegung, nur für Tests/Grobes)
    Linear,
    /// TET10 – quadratische Ansatzfunktionen (Standard)
    Quadratic,
}

/// Tetraedernetz. Alle Elemente haben dieselbe Ordnung.
#[derive(Debug, Clone)]
pub struct Mesh {
    pub nodes: Vec<[f64; 3]>,
    /// Knoten pro Element (4 oder 10)
    pub npe: usize,
    /// Konnektivität, flach: Element e = conn[e*npe .. (e+1)*npe]
    pub conn: Vec<usize>,
    /// CAD-Fläche je Randdreieck (sortierte Eckknoten → Flächennummer), leer bei eingebauten Netzen
    pub surface_tags: HashMap<[usize; 3], i32>,
    /// Körper (CAD-Volumen) je Element; leer = ein Körper (eingebaute Netze)
    pub elem_body: Vec<i32>,
    /// Namen der Körper aus der STEP-Datei (Körpernummer → Name), soweit vorhanden
    pub body_names: Vec<(i32, String)>,
}

/// Randfläche eines Elements (3 oder 6 Knoten, Normale nach außen).
#[derive(Debug, Clone)]
pub struct Face {
    pub elem: usize,
    pub nodes: Vec<usize>,
    /// Nummer der CAD-Fläche (aus Gmsh), falls bekannt
    pub tag: Option<i32>,
}

impl Mesh {
    pub fn order(&self) -> Order {
        if self.npe == 10 { Order::Quadratic } else { Order::Linear }
    }

    /// Körper des Elements (1, wenn das Netz keine Körper kennt)
    pub fn body_of(&self, e: usize) -> i32 {
        self.elem_body.get(e).copied().unwrap_or(1)
    }

    /// Alle Körper, aufsteigend
    pub fn bodies(&self) -> Vec<i32> {
        let mut b: Vec<i32> = if self.elem_body.is_empty() { vec![1] } else { self.elem_body.clone() };
        b.sort_unstable();
        b.dedup();
        b
    }

    /// Name eines Körpers (aus der STEP-Datei) oder „Körper n“
    pub fn body_name(&self, b: i32) -> String {
        self.body_names.iter().find(|(t, _)| *t == b).map(|(_, n)| n.clone()).unwrap_or_else(|| format!("Körper {b}"))
    }

    pub fn n_elems(&self) -> usize {
        self.conn.len() / self.npe
    }

    pub fn elem(&self, e: usize) -> &[usize] {
        &self.conn[e * self.npe..(e + 1) * self.npe]
    }

    pub fn elem_coords(&self, e: usize) -> Vec<[f64; 3]> {
        self.elem(e).iter().map(|&n| self.nodes[n]).collect()
    }

    pub fn bbox(&self) -> ([f64; 3], [f64; 3]) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in &self.nodes {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        (lo, hi)
    }

    /// Typische Längentoleranz für Koordinatenvergleiche.
    pub fn tolerance(&self) -> f64 {
        let (lo, hi) = self.bbox();
        let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
        1e-6 * diag.max(1e-12)
    }

    /// Dreht Elemente mit negativem Volumen um und prüft auf entartete Elemente.
    pub fn fix_orientation(&mut self) -> Result<()> {
        let tol = self.tolerance().powi(3);
        for e in 0..self.n_elems() {
            let v = tet_volume(&self.elem_coords(e)[..4]);
            if v.abs() <= tol {
                return Err(FemError::DegenerateElement(e));
            }
            if v < 0.0 {
                let c = &mut self.conn[e * self.npe..(e + 1) * self.npe];
                c.swap(1, 2);
                if self.npe == 10 {
                    c.swap(4, 6);
                    c.swap(8, 9);
                }
            }
        }
        Ok(())
    }

    /// Erzeugt aus einem TET4-Netz ein TET10-Netz (gerade Kanten, Mittelknoten).
    pub fn to_quadratic(&self) -> Mesh {
        if self.npe == 10 {
            return self.clone();
        }
        let mut nodes = self.nodes.clone();
        let mut mids: HashMap<(usize, usize), usize> = HashMap::new();
        let mut conn = Vec::with_capacity(self.n_elems() * 10);
        for e in 0..self.n_elems() {
            let c = self.elem(e).to_vec();
            conn.extend_from_slice(&c);
            for &(a, b) in &crate::element::TET_EDGES {
                let key = (c[a].min(c[b]), c[a].max(c[b]));
                let id = *mids.entry(key).or_insert_with(|| {
                    let (p, q) = (self.nodes[key.0], self.nodes[key.1]);
                    nodes.push([(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, (p[2] + q[2]) / 2.0]);
                    nodes.len() - 1
                });
                conn.push(id);
            }
        }
        Mesh { nodes, npe: 10, conn, surface_tags: self.surface_tags.clone(), elem_body: self.elem_body.clone(), body_names: self.body_names.clone() }
    }

    /// Alle Außenflächen (Flächen, die nur zu einem Element gehören).
    pub fn boundary_faces(&self) -> Vec<Face> {
        let mut seen: HashMap<[usize; 3], (usize, usize)> = HashMap::new();
        let mut count: HashMap<[usize; 3], u8> = HashMap::new();
        for e in 0..self.n_elems() {
            let c = self.elem(e);
            for (f, lf) in TET_FACES.iter().enumerate() {
                let mut key = [c[lf[0]], c[lf[1]], c[lf[2]]];
                key.sort_unstable();
                *count.entry(key).or_insert(0) += 1;
                seen.insert(key, (e, f));
            }
        }
        let mut faces: Vec<Face> = count
            .into_iter()
            .filter(|&(_, n)| n == 1)
            .map(|(key, _)| {
                let (e, f) = seen[&key];
                let c = self.elem(e);
                let lf = TET_FACES[f];
                let mut nodes: Vec<usize> = lf.iter().map(|&i| c[i]).collect();
                if self.npe == 10 {
                    for k in 0..3 {
                        nodes.push(c[edge_index(lf[k], lf[(k + 1) % 3])]);
                    }
                }
                Face { elem: e, nodes, tag: self.surface_tags.get(&key).copied() }
            })
            .collect();
        // deterministische Reihenfolge (HashMap ist ungeordnet)
        faces.sort_by_key(|f| (f.elem, f.nodes[0]));
        faces
    }

    pub fn volume(&self) -> f64 {
        (0..self.n_elems()).map(|e| tet_volume(&self.elem_coords(e)[..4])).sum()
    }
}
