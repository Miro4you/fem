use serde::{Deserialize, Serialize};

use crate::mesh::{Face, Mesh};
use crate::{FemError, Material, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
    Z,
}

impl Axis {
    pub fn index(self) -> usize {
        self as usize
    }
}

/// Auswahl von Außenflächen. Eine Fläche gehört dazu, wenn alle ihre Knoten
/// das Kriterium erfüllen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Selection {
    /// Ebene senkrecht zu einer Achse, z. B. x = 0
    Plane { axis: Axis, value: f64 },
    /// Achsparalleler Quader
    Box { min: [f64; 3], max: [f64; 3] },
    /// Explizite Flächenindizes (aus `Mesh::boundary_faces`)
    Faces(Vec<usize>),
    /// CAD-Flächen (Gmsh-Flächennummern), z. B. per Klick in der Oberfläche
    Surfaces(Vec<i32>),
}

impl Selection {
    pub fn select(&self, mesh: &Mesh, faces: &[Face]) -> Vec<usize> {
        let tol = mesh.tolerance();
        let inside = |p: &[f64; 3]| match self {
            Selection::Plane { axis, value } => (p[axis.index()] - value).abs() <= tol,
            Selection::Box { min, max } => (0..3).all(|k| p[k] >= min[k] - tol && p[k] <= max[k] + tol),
            Selection::Faces(_) | Selection::Surfaces(_) => unreachable!(),
        };
        match self {
            Selection::Faces(ids) => ids.iter().copied().filter(|&i| i < faces.len()).collect(),
            Selection::Surfaces(tags) => faces
                .iter()
                .enumerate()
                .filter(|(_, f)| f.tag.is_some_and(|t| tags.contains(&t)))
                .map(|(i, _)| i)
                .collect(),
            _ => faces
                .iter()
                .enumerate()
                .filter(|(_, f)| f.nodes.iter().all(|&n| inside(&mesh.nodes[n])))
                .map(|(i, _)| i)
                .collect(),
        }
    }
}

/// Vorgegebene Verschiebung je Richtung; `None` = frei. Meist `Some(0.0)` (festgehalten).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Fix {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z: Option<f64>,
}

impl Fix {
    /// Feste Einspannung (alle Richtungen 0)
    pub fn all() -> Self {
        Fix { x: Some(0.0), y: Some(0.0), z: Some(0.0) }
    }

    /// Nur eine Richtung festhalten (z. B. Symmetrie- oder Loslager)
    pub fn only(axis: Axis) -> Self {
        let mut f = Fix::default();
        f.set(axis, Some(0.0));
        f
    }

    pub fn set(&mut self, axis: Axis, v: Option<f64>) {
        match axis {
            Axis::X => self.x = v,
            Axis::Y => self.y = v,
            Axis::Z => self.z = v,
        }
    }

    pub fn components(&self) -> [Option<f64>; 3] {
        [self.x, self.y, self.z]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Support {
    pub group: String,
    pub fix: Fix,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Load {
    /// Gesamtkraft, gleichmäßig über die Fläche verteilt
    Force { group: String, force: [f64; 3] },
    /// Flächenlast (Kraft pro Fläche) als Vektor
    Traction { group: String, traction: [f64; 3] },
    /// Druck senkrecht auf die Fläche (positiv = drückt auf das Bauteil)
    Pressure { group: String, pressure: f64 },
}

impl Load {
    pub fn group(&self) -> &str {
        match self {
            Load::Force { group, .. } | Load::Traction { group, .. } | Load::Pressure { group, .. } => group,
        }
    }
}

/// Wahl des Gleichungslösers
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SolverKind {
    /// direkt bei kleinen, iterativ bei großen Modellen (ab `solver::AUTO_ITERATIVE_FROM` Unbekannten)
    #[default]
    Auto,
    /// dünnbesetzte Cholesky-Zerlegung: robust, aber speicherhungrig
    Direct,
    /// PCG: wenig Speicher, für große Netze
    Iterative,
}

#[derive(Debug, Clone)]
pub struct Model {
    pub mesh: Mesh,
    pub material: Material,
    pub groups: Vec<(String, Selection)>,
    pub supports: Vec<Support>,
    pub loads: Vec<Load>,
    pub solver: SolverKind,
}

impl Model {
    pub fn new(mesh: Mesh, material: Material) -> Self {
        Model { mesh, material, groups: vec![], supports: vec![], loads: vec![], solver: SolverKind::Auto }
    }

    pub fn group(mut self, name: &str, sel: Selection) -> Self {
        self.groups.push((name.into(), sel));
        self
    }

    pub fn support(mut self, group: &str, fix: Fix) -> Self {
        self.supports.push(Support { group: group.into(), fix });
        self
    }

    pub fn load(mut self, load: Load) -> Self {
        self.loads.push(load);
        self
    }

    pub fn solver(mut self, kind: SolverKind) -> Self {
        self.solver = kind;
        self
    }

    /// Flächenindizes einer benannten Gruppe.
    pub fn group_faces(&self, name: &str, faces: &[Face]) -> Result<Vec<usize>> {
        let sel = self
            .groups
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, s)| s)
            .ok_or_else(|| FemError::UnknownGroup(name.into()))?;
        let ids = sel.select(&self.mesh, faces);
        if ids.is_empty() {
            return Err(FemError::EmptyGroup(name.into()));
        }
        Ok(ids)
    }
}
