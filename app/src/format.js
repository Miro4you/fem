// Zahlen deutsch formatiert, 4 signifikante Stellen
export function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '–'
  if (Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-3 && v !== 0)) return v.toExponential(3).replace('.', ',')
  return v.toLocaleString('de-DE', { maximumSignificantDigits: 4 })
}

export function fmtVec(v) {
  return v.map(fmt).join(' / ')
}
