use serde::{Deserialize, Serialize};

use crate::mesh::{Face, Mesh};
use crate::region::Region;
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

/// Lager in lokalen Richtungen je Knoten (schräge oder gekrümmte Flächen)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LocalFix {
    /// Senkrecht zur Fläche festgehalten, in der Fläche frei (reibungsfreie Auflage, Symmetrie) – beliebig orientiert
    Normal,
    /// Zylindrische Lagerung um die Achse durch `origin` in Richtung `axis`, je Richtung fest (`true`) oder frei.
    /// Bolzen/Gelenk: radial und axial fest, tangential frei (dreht um die Achse).
    Cylindrical { origin: [f64; 3], axis: [f64; 3], radial: bool, tangential: bool, axial: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Support {
    pub group: String,
    /// festgehaltene globale Richtungen (bei `local` ignoriert)
    pub fix: Fix,
    /// statt globaler Richtungen: lokale Richtungen je Knoten
    #[serde(default)]
    pub local: Option<LocalFix>,
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
    /// Moment (Vektor, Drehsinn rechte Hand) um den Flächenschwerpunkt, linear über die Fläche verteilt
    /// wie bei einem starren Anschlussteil (Torsion → Schub, Biegung → Zug/Druck)
    Moment { group: String, moment: [f64; 3] },
    /// Lagerlast (Bolzen in Bohrung, Welle in Lager): Kraft wirkt nur auf die Hälfte der Zylinderfläche,
    /// gegen die gedrückt wird, mit kosinusförmiger Druckverteilung
    Bearing { group: String, force: [f64; 3] },
}

impl Load {
    pub fn group(&self) -> &str {
        match self {
            Load::Force { group, .. }
            | Load::Traction { group, .. }
            | Load::Pressure { group, .. }
            | Load::Moment { group, .. }
            | Load::Bearing { group, .. } => group,
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

/// Benannte Flächenauswahl, optional auf einen Wirkbereich eingeschränkt
#[derive(Debug, Clone)]
pub struct Group {
    pub name: String,
    pub selection: Selection,
    pub region: Option<Region>,
}

#[derive(Debug, Clone)]
pub struct Model {
    pub mesh: Mesh,
    pub material: Material,
    pub groups: Vec<Group>,
    pub supports: Vec<Support>,
    pub loads: Vec<Load>,
    pub solver: SolverKind,
}

impl Model {
    pub fn new(mesh: Mesh, material: Material) -> Self {
        Model { mesh, material, groups: vec![], supports: vec![], loads: vec![], solver: SolverKind::Auto }
    }

    pub fn group(mut self, name: &str, sel: Selection) -> Self {
        self.groups.push(Group { name: name.into(), selection: sel, region: None });
        self
    }

    /// Gruppe, die nur innerhalb von `region` wirkt (Last nur auf einem Teil der Fläche)
    pub fn group_in(mut self, name: &str, sel: Selection, region: Option<Region>) -> Self {
        self.groups.push(Group { name: name.into(), selection: sel, region });
        self
    }

    fn find_group(&self, name: &str) -> Result<&Group> {
        self.groups.iter().find(|g| g.name == name).ok_or_else(|| FemError::UnknownGroup(name.into()))
    }

    /// Wirkbereich einer Gruppe (`None` = ganze Fläche)
    pub fn group_region(&self, name: &str) -> Result<Option<&Region>> {
        Ok(self.find_group(name)?.region.as_ref())
    }

    pub fn support(mut self, group: &str, fix: Fix) -> Self {
        self.supports.push(Support { group: group.into(), fix, local: None });
        self
    }

    /// Lager in lokalen Richtungen (z. B. zylindrische Lagerung, reibungsfreie Auflage auf schräger Fläche)
    pub fn support_local(mut self, group: &str, local: LocalFix) -> Self {
        self.supports.push(Support { group: group.into(), fix: Fix::default(), local: Some(local) });
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
        let ids = self.find_group(name)?.selection.select(&self.mesh, faces);
        if ids.is_empty() {
            return Err(FemError::EmptyGroup(name.into()));
        }
        Ok(ids)
    }
}
