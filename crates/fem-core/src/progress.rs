//! Fortschrittsmeldungen langer Rechnungen (für die Anzeige in der Oberfläche) und Abbrechen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

type Callback = Arc<dyn Fn(&str, Option<f64>) + Send + Sync>;

/// Meldet Text und optional einen Anteil 0…1. Ohne Empfänger passiert nichts. Trägt außerdem ein Abbruch-Kennzeichen,
/// das lange Schritte (Gmsh, Kontakt-Durchgänge, iterativer Löser) regelmäßig prüfen.
#[derive(Clone, Default)]
pub struct Progress {
    cb: Option<Callback>,
    cancel: Arc<AtomicBool>,
}

impl Progress {
    pub fn new(f: impl Fn(&str, Option<f64>) + Send + Sync + 'static) -> Self {
        Progress { cb: Some(Arc::new(f)), cancel: Arc::default() }
    }

    /// mit gemeinsamem Abbruch-Kennzeichen (die Oberfläche setzt es)
    pub fn with_cancel(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel = flag;
        self
    }

    pub fn report(&self, msg: &str, fraction: Option<f64>) {
        if let Some(f) = &self.cb {
            f(msg, fraction.map(|x| x.clamp(0.0, 1.0)));
        }
    }

    /// Abbruch angefordert?
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Fehler „abgebrochen“, falls angefordert
    pub fn check(&self) -> crate::Result<()> {
        if self.cancelled() {
            Err(crate::FemError::Cancelled)
        } else {
            Ok(())
        }
    }
}

impl std::fmt::Debug for Progress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.cb.is_some() { "Progress(an)" } else { "Progress(aus)" })
    }
}
