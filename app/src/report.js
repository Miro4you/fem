// PDF-Bericht der Rechnung (jsPDF). Texte in Latin-1 (Standardschrift), griechische Zeichen werden ersetzt.
import { jsPDF } from 'jspdf'
import { cssBandColor, BANDS } from './colormap.js'
import { fmt, fmtVec } from './format.js'

const GREEK = { σ: 's', ν: 'nu', ε: 'eps', τ: 'tau', ρ: 'rho', Δ: 'Delta', '≤': '<=', '≥': '>=', '≈': '~', '→': '->', '⇄': '', '★': '*', '₀': '0', '₁': '1', '⁺': '+' }
const latin = (t) => String(t ?? '').replace(/[σνετρΔ≤≥≈→⇄★₀₁⁺]/g, (c) => GREEK[c] ?? '')

/// Erzeugt den Bericht und gibt ihn als Blob zurück.
/// data: { title, file, date, mesh, material, materialLines, supports, loads, result, resultLines, proofRows, warnings, images, notes }
export function buildReport(data) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210, M = 18, CW = W - 2 * M
  let y = M
  const page = () => {
    doc.addPage()
    y = M
  }
  const need = (h) => {
    if (y + h > 297 - M) page()
  }
  const text = (t, size = 10, style = 'normal', color = [30, 32, 36]) => {
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    doc.setTextColor(...color)
    const lines = doc.splitTextToSize(latin(t), CW)
    need(lines.length * size * 0.42 + 1)
    doc.text(lines, M, y + size * 0.35)
    y += lines.length * size * 0.42 + 1.2
  }
  const heading = (t) => {
    need(14)
    y += 3
    text(t, 13, 'bold', [20, 60, 140])
    doc.setDrawColor(200, 205, 212)
    doc.line(M, y, W - M, y)
    y += 2
  }
  // Tabelle aus Zeilen [Bezeichnung, Wert]
  const table = (rows, widths = [62, CW - 62]) => {
    doc.setFontSize(9.5)
    for (const r of rows) {
      const cells = r.map((c, i) => doc.splitTextToSize(latin(c), widths[i] - 2))
      const h = Math.max(...cells.map((c) => c.length)) * 4.1 + 1.6
      need(h)
      let x = M
      cells.forEach((c, i) => {
        doc.setFont('helvetica', i === 0 ? 'normal' : 'bold')
        doc.setTextColor(i === 0 ? 90 : 30, i === 0 ? 96 : 32, i === 0 ? 106 : 36)
        doc.text(c, x + 1, y + 3.6)
        x += widths[i]
      })
      doc.setDrawColor(230, 232, 236)
      doc.line(M, y + h, W - M, y + h)
      y += h
    }
    y += 2
  }

  // Kopf
  doc.setFillColor(20, 60, 140)
  doc.rect(0, 0, W, 10, 'F')
  y = 18
  text(data.title, 18, 'bold')
  text(`${data.file} · ${data.date} · Projekt-FEM (lineare Statik, Tetraeder TET10)`, 9, 'normal', [100, 106, 116])
  y += 2

  if (data.verdict) {
    need(14)
    const ok = data.verdict.ok
    doc.setFillColor(...(ok ? [225, 243, 230] : [250, 228, 228]))
    doc.roundedRect(M, y, CW, 12, 2, 2, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(...(ok ? [27, 127, 59] : [198, 40, 40]))
    doc.text(latin(data.verdict.text), M + 4, y + 7.8)
    y += 16
  }

  heading('1  Bauteil und Netz')
  table(data.meshLines)
  heading('2  Werkstoff')
  table(data.materialLines)
  heading('3  Lager')
  table(data.supports.length ? data.supports : [['–', 'keine']])
  heading('4  Lasten')
  table(data.loads.length ? data.loads : [['–', 'keine']])
  heading('5  Ergebnisse')
  table(data.resultLines)
  let sec = 6
  if (data.proofRows.length) {
    heading(`${sec++}  Festigkeitsnachweis`)
    table(
      [['Nachweis', 'vorhanden', 'erforderlich', 'Ausnutzung'], ...data.proofRows],
      [CW * 0.34, CW * 0.22, CW * 0.22, CW * 0.22],
    )
  }
  if (data.weldRows?.length) {
    heading(`${sec++}  Schweißnähte`)
    table(
      [['Naht', 'Kraft', 'Länge / a', 'τw max', 'Ausnutzung'], ...data.weldRows],
      [CW * 0.16, CW * 0.2, CW * 0.22, CW * 0.2, CW * 0.22],
    )
    if (data.weldNote) text(data.weldNote, 8.5)
  }
  if (data.warnings.length) {
    heading('Hinweise')
    for (const w of data.warnings) text('• ' + w, 9.5)
  }

  // Bilder mit Farbskala
  for (const img of data.images) {
    // höchstens ~45 % der Seitenhöhe je Bild, damit zwei auf eine Seite passen
    let w = CW
    let h = (CW * img.height) / img.width
    if (h > 110) {
      h = 110
      w = (h * img.width) / img.height
    }
    need(h + 24)
    text(img.title, 12, 'bold')
    doc.addImage(img.data, 'JPEG', M + (CW - w) / 2, y, w, h)
    y += h + 3
    if (img.legend) {
      const { min, max, reverse, unit, label } = img.legend
      const bw = CW / BANDS
      for (let i = 0; i < BANDS; i++) {
        const hex = cssBandColor(reverse ? BANDS - 1 - i : i)
        const col = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16))
        doc.setFillColor(col[0], col[1], col[2])
        doc.rect(M + i * bw, y, bw, 4, 'F')
      }
      y += 4
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
      doc.setTextColor(60, 64, 70)
      doc.text(latin(`${fmt(reverse ? max : min)}`), M, y + 3.5)
      doc.text(latin(`${fmt(reverse ? min : max)} ${unit}`), W - M, y + 3.5, { align: 'right' })
      doc.text(latin(label), W / 2, y + 3.5, { align: 'center' })
      y += 7
    }
  }

  heading('Annahmen und Grenzen')
  for (const n of data.notes) text('• ' + n, 9)

  // Seitenzahlen
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(140, 146, 156)
    doc.text(latin(`${data.file} – Seite ${i} von ${pages}`), W - M, 297 - 8, { align: 'right' })
  }
  return doc.output('blob')
}

export { fmtVec }
