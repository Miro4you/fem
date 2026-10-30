// Werkstoff-Vorlagen (Richtwerte, Streckgrenze für kleine Abmessungen).
// E und Streckgrenze in N/mm² (MPa). Ausführliche Datenbank folgt in Phase 3.
export const MATERIALS = [
  { name: 'S235JR', E: 210000, nu: 0.3, yield: 235, group: 'Stahl' },
  { name: 'S355J2', E: 210000, nu: 0.3, yield: 355, group: 'Stahl' },
  { name: 'C45E (vergütet)', E: 210000, nu: 0.3, yield: 490, group: 'Stahl' },
  { name: '42CrMo4 (vergütet)', E: 210000, nu: 0.3, yield: 750, group: 'Stahl' },
  { name: '1.4301 (X5CrNi18-10)', E: 200000, nu: 0.3, yield: 210, group: 'Edelstahl' },
  { name: 'EN AW-6082 T6', E: 70000, nu: 0.33, yield: 250, group: 'Aluminium' },
  { name: 'EN AW-7075 T6', E: 71000, nu: 0.33, yield: 460, group: 'Aluminium' },
  { name: 'EN-GJS-400 (Sphäroguss)', E: 169000, nu: 0.275, yield: 250, group: 'Guss' },
  { name: 'Ti-6Al-4V', E: 114000, nu: 0.34, yield: 830, group: 'Titan' },
]
