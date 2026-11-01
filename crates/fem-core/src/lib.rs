//! Projekt-FEM Rechenkern: lineare Statik für 3D-Volumenkörper.
//!
//! Einheiten sind frei wählbar, müssen aber konsistent sein.
//! Empfohlen (wie im Maschinenbau üblich): mm, N, N/mm² (= MPa).

pub mod amg;
pub mod element;
pub mod generate;
pub mod geometry;
pub mod gmsh;
pub mod material;
pub mod mesh;
pub mod model;
pub mod pcg;
pub mod region;
pub mod results;
pub mod solver;
pub mod sparse;
pub mod validate;
pub mod vtk;

pub use material::Material;
pub use mesh::{Mesh, Order};
pub use model::{Axis, Fix, Group, Load, LocalFix, Model, Selection, SolverKind, Support};
pub use region::Region;
pub use results::Results;
pub use solver::solve;

#[derive(Debug, thiserror::Error)]
pub enum FemError {
    #[error("Element {0} ist entartet (Volumen ≈ 0) – Netz prüfen")]
    DegenerateElement(usize),
    #[error("Gruppe „{0}“ ist nicht definiert")]
    UnknownGroup(String),
    #[error("Gruppe „{0}“ enthält keine Flächen – Auswahl prüfen (Koordinate/Toleranz)")]
    EmptyGroup(String),
    #[error("Modell ist nicht ausreichend gelagert – das Bauteil kann sich als Ganzes bewegen oder drehen")]
    Underconstrained,
    #[error("Iterativer Löser nach {0} Schritten nicht konvergiert – Lagerung prüfen oder direkten Löser wählen")]
    NotConverged(usize),
    #[error("Last/Lager „{0}“: {1}")]
    BadLoad(String, String),
    #[error("Gmsh: {0}")]
    Gmsh(String),
    #[error("Ungültige Eingabe: {0}")]
    Input(String),
}

pub type Result<T> = std::result::Result<T, FemError>;
