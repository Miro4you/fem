use nalgebra::SMatrix;
use serde::{Deserialize, Serialize};

/// Linear-elastischer, isotroper Werkstoff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Material {
    #[serde(default)]
    pub name: String,
    /// Elastizitätsmodul E
    #[serde(rename = "E")]
    pub e: f64,
    /// Querkontraktionszahl ν
    pub nu: f64,
    /// Streckgrenze Re bzw. Rp0,2 (optional, für die Sicherheit gegen Fließen)
    #[serde(default, rename = "yield")]
    pub yield_strength: Option<f64>,
}

pub type DMat = SMatrix<f64, 6, 6>;

impl Material {
    pub fn steel() -> Self {
        Material { name: "Stahl".into(), e: 210_000.0, nu: 0.3, yield_strength: Some(235.0) }
    }

    pub fn shear_modulus(&self) -> f64 {
        self.e / (2.0 * (1.0 + self.nu))
    }

    /// Elastizitätsmatrix in Voigt-Notation (xx, yy, zz, xy, yz, zx), Gleitungen γ = 2ε.
    pub fn d_matrix(&self) -> DMat {
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

    pub fn check(&self) -> crate::Result<()> {
        if !(self.e > 0.0) {
            return Err(crate::FemError::Input("E-Modul muss positiv sein".into()));
        }
        if !(self.nu > -1.0 && self.nu < 0.5) {
            return Err(crate::FemError::Input("Querkontraktionszahl ν muss zwischen -1 und 0,5 liegen".into()));
        }
        Ok(())
    }
}
