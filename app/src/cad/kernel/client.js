// Zugang zum Geometriekern (OpenCASCADE als WebAssembly im Web Worker). Der Server speichert nur noch fertige STEP-Dateien.
import * as api from '../../api.js'

let worker = null
let seq = 0
const pending = new Map()
export const kernelInfo = { loadMs: null, error: null, lastMs: null }
let readyResolve
const readyP = new Promise((r) => (readyResolve = r))

function start() {
  if (worker) return worker
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') {
      kernelInfo.loadMs = data.ms ?? null
      kernelInfo.error = data.error ?? null
      readyResolve(kernelInfo)
      return
    }
    const p = pending.get(data.id)
    if (!p) return
    pending.delete(data.id)
    if (data.ok) p.resolve(data.result)
    else p.reject(new Error(data.error))
  }
  worker.onerror = (e) => {
    kernelInfo.error = e.message || 'Kern konnte nicht geladen werden'
    readyResolve(kernelInfo)
    for (const p of pending.values()) p.reject(new Error(kernelInfo.error))
    pending.clear()
  }
  return worker
}

/// Kern vorab laden (z. B. beim Öffnen der Konstruktion)
export function kernelReady() {
  start()
  return readyP
}

// Ausgangsteile (STEP) für den Worker: Text einmal vom Server holen und einmal schicken, danach nur den Schlüssel
const baseText = new Map() // Pfad → Promise<Text>
const sentBase = new Set()
const sentFiles = new Set()
function stripFiles(job) {
  // eingefügte STEP-Teile: Text nur beim ersten Mal mitschicken
  if (!job.features?.some((f) => f.type === 'import')) return job
  return { ...job, features: job.features.map((f) => (f.type === 'import' && sentFiles.has(f.key) ? { ...f, text: undefined } : f)) }
}
async function withBase(args) {
  if (!args.base) return stripFiles({ ...args, base: undefined })
  if (!baseText.has(args.base)) baseText.set(args.base, api.stepText(args.base).catch((e) => (baseText.delete(args.base), Promise.reject(e))))
  const text = await baseText.get(args.base)
  const job = stripFiles({ ...args, base: undefined, base_key: args.base })
  if (!sentBase.has(args.base)) job.base_text = text
  return job
}

/// Feature-Liste im Worker aufbauen (mit Ausgangsteil: STEP wird im Browser eingelesen)
export async function kernelBuild(args) {
  const job = await withBase(args)
  try {
    const r = await kernelBuildRaw(job)
    if (job.base_key) sentBase.add(job.base_key)
    for (const f of job.features ?? []) if (f.type === 'import' && f.text) sentFiles.add(f.key)
    return r
  } catch (e) {
    // Worker kennt das Ausgangsteil oder ein eingefügtes Teil nicht (mehr): alles mit Text noch einmal
    if (String(e?.message).includes('BASE_MISSING')) {
      sentBase.clear()
      sentFiles.clear()
      const full = { ...job, features: args.features, ...(job.base_key ? { base_text: await baseText.get(args.base) } : {}) }
      const r = await kernelBuildRaw(full)
      if (job.base_key) sentBase.add(job.base_key)
      for (const f of args.features ?? []) if (f.type === 'import') sentFiles.add(f.key)
      return r
    }
    throw e
  }
}

function kernelBuildRaw(job) {
  const w = start()
  const id = ++seq
  const t = performance.now()
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (r) => {
        kernelInfo.lastMs = Math.round(performance.now() - t)
        r.kernel = 'neu'
        resolve(r)
      },
      reject,
    })
    w.postMessage({ id, job })
  })
}

/// Für die Anzeige in der Konstruktion
export function cadBuildView(args) {
  return kernelBuild(args)
}

// für Messungen und Browser-Tests
if (typeof window !== 'undefined') window.__kernel = { kernelBuild, kernelReady, kernelInfo }

/// STEP-Datei zum Rechnen/Speichern: mit dem neuen Kern im Browser bauen und dem Server nur die fertige Datei geben
/// (gleiche Antwort wie api.cadBuild mit `step`: { status, volume, bodies, bodies_info, step: Pfad })
export async function cadBuildStep(args) {
  const r = await kernelBuild({ ...args, step: true, tess: false })
  const text = r.step_text
  delete r.step_text
  if (!text) return r
  const saved = await api.cadBuild({ features: [], step: args.step, step_text: text, tess: false })
  return { ...r, step: saved.step }
}

/// STL-Datei (Blob) der Konstruktion für den 3D-Druck
export async function cadBuildStl(args) {
  const r = await kernelBuild({ ...args, stl: true, tess: false })
  const bad = r.status?.find((x) => !x.ok && !x.skipped)
  if (bad) throw new Error(bad.error)
  if (!r.stlBlob) throw new Error('Die Konstruktion hat noch keinen Körper')
  return r.stlBlob
}

/// Technische Zeichnung (SVG-Text): Vorder-, Seiten-, Draufsicht und Isometrie mit Schriftfeld.
/// info: { title, date, mass } fürs Schriftfeld
export async function cadBuildSvg(args, info = {}) {
  const r = await kernelBuild({ ...args, svg: info, tess: false })
  const bad = r.status?.find((x) => !x.ok && !x.skipped)
  if (bad) throw new Error(bad.error)
  if (!r.svg) throw new Error('Die Konstruktion hat noch keinen Körper')
  return r.svg
}
