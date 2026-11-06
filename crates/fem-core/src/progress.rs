//! Fortschrittsmeldungen langer Rechnungen (für die Anzeige in der Oberfläche).

use std::sync::Arc;

type Callback = Arc<dyn Fn(&str, Option<f64>) + Send + Sync>;

/// Meldet Text und optional einen Anteil 0…1. Ohne Empfänger passiert nichts.
#[derive(Clone, Default)]
pub struct Progress(Option<Callback>);

impl Progress {
    pub fn new(f: impl Fn(&str, Option<f64>) + Send + Sync + 'static) -> Self {
        Progress(Some(Arc::new(f)))
    }

    pub fn report(&self, msg: &str, fraction: Option<f64>) {
        if let Some(f) = &self.0 {
            f(msg, fraction.map(|x| x.clamp(0.0, 1.0)));
        }
    }
}

impl std::fmt::Debug for Progress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() { "Progress(an)" } else { "Progress(aus)" })
    }
}
