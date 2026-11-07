// Werkstoff-Vorlagen (Richtwerte). E, Re/Rp0,2 (yield) und Rm (tensile) in N/mm² (MPa), Dichte rho in g/cm³.
// 3D-Druck: Werte in der Schicht (XY) und quer zu den Schichten (Z, Aufbaurichtung) – typische Datenblattwerte
// bei 100 % Füllung. Sie hängen stark von Drucker, Temperatur, Schichthöhe und Füllung ab: wenn möglich eigene
// Werte bzw. die des Filament-/Pulverherstellers eintragen.
export const MATERIALS = [
  { name: 'S235JR', rho: 7.85, E: 210000, nu: 0.3, yield: 235, tensile: 360, group: 'Stahl' },
  { name: 'S355J2', rho: 7.85, E: 210000, nu: 0.3, yield: 355, tensile: 470, group: 'Stahl' },
  { name: 'C45E (vergütet)', rho: 7.85, E: 210000, nu: 0.3, yield: 490, tensile: 700, group: 'Stahl' },
  { name: '42CrMo4 (vergütet)', rho: 7.85, E: 210000, nu: 0.3, yield: 750, tensile: 1000, group: 'Stahl' },
  { name: '1.4301 (X5CrNi18-10)', rho: 7.9, E: 200000, nu: 0.3, yield: 210, tensile: 520, group: 'Edelstahl' },
  { name: 'EN AW-6082 T6', rho: 2.7, E: 70000, nu: 0.33, yield: 250, tensile: 290, group: 'Aluminium' },
  { name: 'EN AW-7075 T6', rho: 2.81, E: 71000, nu: 0.33, yield: 460, tensile: 530, group: 'Aluminium' },
  { name: 'EN-GJS-400 (Sphäroguss)', rho: 7.1, E: 169000, nu: 0.275, yield: 250, tensile: 400, group: 'Guss' },
  { name: 'Ti-6Al-4V', rho: 4.43, E: 114000, nu: 0.34, yield: 830, tensile: 900, group: 'Titan' },
  { name: 'EN AW-5754 H111', rho: 2.67, E: 70000, nu: 0.33, yield: 80, tensile: 190, group: 'Aluminium' },
  { name: 'CuZn39Pb3 (Messing)', rho: 8.47, E: 96000, nu: 0.34, yield: 250, tensile: 430, group: 'Kupfer' },
  { name: 'POM (spritzgegossen)', rho: 1.41, E: 2800, nu: 0.35, yield: '', tensile: 65, group: 'Kunststoff' },
  { name: 'PA6 (trocken)', rho: 1.14, E: 3000, nu: 0.39, yield: '', tensile: 80, group: 'Kunststoff' },

  // FDM: Haftung zwischen den Schichten ist die Schwachstelle
  { name: 'PLA (FDM)', rho: 1.24, E: 3300, nu: 0.35, yield: '', tensile: 50, group: '3D-Druck FDM', print: { E_z: 2800, yield_z: '', tensile_z: 30 } },
  { name: 'PETG (FDM)', rho: 1.27, E: 2000, nu: 0.38, yield: '', tensile: 45, group: '3D-Druck FDM', print: { E_z: 1800, yield_z: '', tensile_z: 30 } },
  { name: 'ABS (FDM)', rho: 1.04, E: 2100, nu: 0.35, yield: '', tensile: 38, group: '3D-Druck FDM', print: { E_z: 1900, yield_z: '', tensile_z: 22 } },
  { name: 'ASA (FDM)', rho: 1.07, E: 2000, nu: 0.35, yield: '', tensile: 40, group: '3D-Druck FDM', print: { E_z: 1800, yield_z: '', tensile_z: 24 } },
  { name: 'PC (FDM)', rho: 1.2, E: 2300, nu: 0.37, yield: '', tensile: 55, group: '3D-Druck FDM', print: { E_z: 2100, yield_z: '', tensile_z: 32 } },
  { name: 'PA12-CF (FDM)', rho: 1.15, E: 6000, nu: 0.35, yield: '', tensile: 85, group: '3D-Druck FDM', print: { E_z: 2200, yield_z: '', tensile_z: 35 } },
  // SLS / SLA: nahezu gleich in allen Richtungen
  { name: 'PA12 (SLS)', rho: 1.0, E: 1700, nu: 0.39, yield: '', tensile: 48, group: '3D-Druck SLS/SLA', print: { E_z: 1650, yield_z: '', tensile_z: 42 } },
  { name: 'PA11 (SLS)', rho: 1.03, E: 1600, nu: 0.39, yield: '', tensile: 50, group: '3D-Druck SLS/SLA', print: { E_z: 1600, yield_z: '', tensile_z: 45 } },
  { name: 'Standard-Resin (SLA, nachgehärtet)', rho: 1.15, E: 2500, nu: 0.38, yield: '', tensile: 60, group: '3D-Druck SLS/SLA', print: { E_z: 2500, yield_z: '', tensile_z: 55 } },
  // Metall (L-PBF / SLM)
  { name: 'AlSi10Mg (SLM, wie gebaut)', rho: 2.67, E: 75000, nu: 0.33, yield: 270, tensile: 460, group: '3D-Druck Metall', print: { E_z: 70000, yield_z: 240, tensile_z: 460 } },
  { name: '1.4404 / 316L (SLM)', rho: 7.98, E: 185000, nu: 0.3, yield: 530, tensile: 640, group: '3D-Druck Metall', print: { E_z: 180000, yield_z: 470, tensile_z: 590 } },
  { name: 'Ti-6Al-4V (SLM, wärmebehandelt)', rho: 4.41, E: 110000, nu: 0.34, yield: 1000, tensile: 1060, group: '3D-Druck Metall', print: { E_z: 110000, yield_z: 950, tensile_z: 1050 } },
]

export const MATERIAL_GROUPS = [...new Set(MATERIALS.map((m) => m.group))]

/// Eigener Werkstoff aus dem Zustand der Oberfläche (ohne Aufbaurichtung/Füllung, die gehören zum Bauteil)
export function presetFromMaterial(m, name) {
  const p = { name, group: 'Eigene Werkstoffe', E: m.E, nu: m.nu, yield: m.yield, tensile: m.tensile, rho: m.rho }
  if (m.layered) p.print = { E_z: m.E_z, yield_z: m.yield_z, tensile_z: m.tensile_z }
  return p
}

/// Werkstoff-Zustand der Oberfläche aus einer Vorlage (Druckwerkstoffe mit Schichtaufbau)
export function materialFromPreset(m, buildDir = [0, 0, 1]) {
  return {
    name: m.name, E: m.E, nu: m.nu, yield: m.yield ?? '', tensile: m.tensile ?? '', rho: m.rho ?? '',
    layered: !!m.print,
    E_z: m.print?.E_z ?? m.E, yield_z: m.print?.yield_z ?? '', tensile_z: m.print?.tensile_z ?? '',
    buildDir,
    infill: { ...DEFAULT_INFILL },
  }
}

const n = (v) => (v === '' || v == null ? null : Number(v))

/// Werkstoff für den Rechenkern
export function materialPayload(m) {
  const base = { name: m.name, E: Number(m.E), nu: Number(m.nu), yield: n(m.yield), tensile: n(m.tensile), rho: n(m.rho) }
  if (!m.layered) return base
  const inf = m.infill
  return {
    ...base,
    layers: { build_dir: m.buildDir ?? [0, 0, 1], E_z: Number(m.E_z), yield_z: n(m.yield_z), tensile_z: n(m.tensile_z) },
    infill: inf?.on
      ? {
          pattern: inf.pattern, density: Number(inf.percent) / 100, walls: Number(inf.walls), line_width: Number(inf.lineWidth),
          layer_height: Number(inf.layerHeight), top_layers: Number(inf.top), bottom_layers: Number(inf.bottom),
        }
      : null,
  }
}

// --- Füllung (Infill) --------------------------------------------------------------------
// Gleiche Näherung wie im Rechenkern (fem-core/material.rs): Anteil f(ρ) = k·ρⁿ + (1 − k)·ρ⁸
// je (E in der Schicht, E quer, R in der Schicht, R quer).
export const INFILL_PATTERNS = {
  gitter: { label: 'Gitter (Grid)', f: [[0.35, 1], [1, 1], [0.35, 1], [1, 1]] },
  linien: { label: 'Linien (Rectilinear)', f: [[0.3, 1], [1, 2], [0.3, 1], [1, 2]] },
  dreiecke: { label: 'Dreiecke (Triangles)', f: [[0.33, 1], [1, 1], [0.33, 1], [1, 1]] },
  waben: { label: 'Waben (Honeycomb)', f: [[1.5, 3], [1, 1], [0.5, 2], [1, 1]] },
  gyroid: { label: 'Gyroid', f: [[0.4, 1.8], [0.4, 1.8], [0.4, 1.5], [0.4, 1.5]] },
  kubisch: { label: 'Kubisch (Cubic)', f: [[0.25, 1], [0.25, 1], [0.25, 1], [0.25, 1]] },
  kreuz: { label: 'Kreuz (Cross)', f: [[0.5, 2], [0.5, 2], [0.3, 1.5], [0.3, 1.5]] },
}

// Voreinstellung ähnlich PrusaSlicer/OrcaSlicer (0,4-mm-Düse, 0,2 mm Schicht)
export const DEFAULT_INFILL = { on: false, pattern: 'gyroid', percent: 20, walls: 2, lineWidth: 0.45, layerHeight: 0.2, top: 5, bottom: 4 }

export function infillFractions(pattern, percent) {
  const rho = Math.min(Math.max(Number(percent) / 100, 0), 1)
  return INFILL_PATTERNS[pattern].f.map(([k, n]) => {
    const kk = Math.min(k, 1)
    return kk * rho ** n + (1 - kk) * rho ** 8
  })
}

/// Dicke von Wand, Deck- und Bodenschicht [mm]
export function shellThickness(inf) {
  return {
    wall: Number(inf.walls) * Number(inf.lineWidth),
    top: Number(inf.top) * Number(inf.layerHeight),
    bottom: Number(inf.bottom) * Number(inf.layerHeight),
  }
}
