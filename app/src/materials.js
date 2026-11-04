// Werkstoff-Vorlagen (Richtwerte). E, Re/Rp0,2 (yield) und Rm (tensile) in N/mm² (MPa).
// 3D-Druck: Werte in der Schicht (XY) und quer zu den Schichten (Z, Aufbaurichtung) – typische Datenblattwerte
// bei 100 % Füllung. Sie hängen stark von Drucker, Temperatur, Schichthöhe und Füllung ab: wenn möglich eigene
// Werte bzw. die des Filament-/Pulverherstellers eintragen.
export const MATERIALS = [
  { name: 'S235JR', E: 210000, nu: 0.3, yield: 235, tensile: 360, group: 'Stahl' },
  { name: 'S355J2', E: 210000, nu: 0.3, yield: 355, tensile: 470, group: 'Stahl' },
  { name: 'C45E (vergütet)', E: 210000, nu: 0.3, yield: 490, tensile: 700, group: 'Stahl' },
  { name: '42CrMo4 (vergütet)', E: 210000, nu: 0.3, yield: 750, tensile: 1000, group: 'Stahl' },
  { name: '1.4301 (X5CrNi18-10)', E: 200000, nu: 0.3, yield: 210, tensile: 520, group: 'Edelstahl' },
  { name: 'EN AW-6082 T6', E: 70000, nu: 0.33, yield: 250, tensile: 290, group: 'Aluminium' },
  { name: 'EN AW-7075 T6', E: 71000, nu: 0.33, yield: 460, tensile: 530, group: 'Aluminium' },
  { name: 'EN-GJS-400 (Sphäroguss)', E: 169000, nu: 0.275, yield: 250, tensile: 400, group: 'Guss' },
  { name: 'Ti-6Al-4V', E: 114000, nu: 0.34, yield: 830, tensile: 900, group: 'Titan' },

  // FDM: Haftung zwischen den Schichten ist die Schwachstelle
  { name: 'PLA (FDM)', E: 3300, nu: 0.35, yield: '', tensile: 50, group: '3D-Druck FDM', print: { E_z: 2800, yield_z: '', tensile_z: 30 } },
  { name: 'PETG (FDM)', E: 2000, nu: 0.38, yield: '', tensile: 45, group: '3D-Druck FDM', print: { E_z: 1800, yield_z: '', tensile_z: 30 } },
  { name: 'ABS (FDM)', E: 2100, nu: 0.35, yield: '', tensile: 38, group: '3D-Druck FDM', print: { E_z: 1900, yield_z: '', tensile_z: 22 } },
  { name: 'ASA (FDM)', E: 2000, nu: 0.35, yield: '', tensile: 40, group: '3D-Druck FDM', print: { E_z: 1800, yield_z: '', tensile_z: 24 } },
  { name: 'PC (FDM)', E: 2300, nu: 0.37, yield: '', tensile: 55, group: '3D-Druck FDM', print: { E_z: 2100, yield_z: '', tensile_z: 32 } },
  { name: 'PA12-CF (FDM)', E: 6000, nu: 0.35, yield: '', tensile: 85, group: '3D-Druck FDM', print: { E_z: 2200, yield_z: '', tensile_z: 35 } },
  // SLS / SLA: nahezu gleich in allen Richtungen
  { name: 'PA12 (SLS)', E: 1700, nu: 0.39, yield: '', tensile: 48, group: '3D-Druck SLS/SLA', print: { E_z: 1650, yield_z: '', tensile_z: 42 } },
  { name: 'PA11 (SLS)', E: 1600, nu: 0.39, yield: '', tensile: 50, group: '3D-Druck SLS/SLA', print: { E_z: 1600, yield_z: '', tensile_z: 45 } },
  { name: 'Standard-Resin (SLA, nachgehärtet)', E: 2500, nu: 0.38, yield: '', tensile: 60, group: '3D-Druck SLS/SLA', print: { E_z: 2500, yield_z: '', tensile_z: 55 } },
  // Metall (L-PBF / SLM)
  { name: 'AlSi10Mg (SLM, wie gebaut)', E: 75000, nu: 0.33, yield: 270, tensile: 460, group: '3D-Druck Metall', print: { E_z: 70000, yield_z: 240, tensile_z: 460 } },
  { name: '1.4404 / 316L (SLM)', E: 185000, nu: 0.3, yield: 530, tensile: 640, group: '3D-Druck Metall', print: { E_z: 180000, yield_z: 470, tensile_z: 590 } },
  { name: 'Ti-6Al-4V (SLM, wärmebehandelt)', E: 110000, nu: 0.34, yield: 1000, tensile: 1060, group: '3D-Druck Metall', print: { E_z: 110000, yield_z: 950, tensile_z: 1050 } },
]

export const MATERIAL_GROUPS = [...new Set(MATERIALS.map((m) => m.group))]

/// Werkstoff-Zustand der Oberfläche aus einer Vorlage (Druckwerkstoffe mit Schichtaufbau)
export function materialFromPreset(m, buildDir = [0, 0, 1]) {
  return {
    name: m.name, E: m.E, nu: m.nu, yield: m.yield ?? '', tensile: m.tensile ?? '',
    layered: !!m.print,
    E_z: m.print?.E_z ?? m.E, yield_z: m.print?.yield_z ?? '', tensile_z: m.print?.tensile_z ?? '',
    buildDir,
  }
}

const n = (v) => (v === '' || v == null ? null : Number(v))

/// Werkstoff für den Rechenkern
export function materialPayload(m) {
  const base = { name: m.name, E: Number(m.E), nu: Number(m.nu), yield: n(m.yield), tensile: n(m.tensile) }
  if (!m.layered) return base
  return { ...base, layers: { build_dir: m.buildDir ?? [0, 0, 1], E_z: Number(m.E_z), yield_z: n(m.yield_z), tensile_z: n(m.tensile_z) } }
}
