// Zugang zum neuen Geometriekern (Web Worker) – gleiche Aufrufform wie api.cadBuild
import * as api from '../../api.js'

const KEY = 'projekt-fem.kern'
/// Was der neue Kern schon kann (Rest: alter Kern auf dem Server)
const SUPPORTED = new Set(['sketch', 'extrude', 'revolve', 'hole', 'fillet', 'chamfer', 'pattern', 'mirror', 'moveface', 'shell'])

/// Neuer Kern eingeschaltet? Standard ja; #kern=alt an der Adresse schaltet auf den alten (wird gemerkt, s. api.js)
export function newKernelWanted() {
  try {
    return localStorage.getItem(KEY) !== 'alt'
  } catch {
    return true
  }
}

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

/// Feature-Liste im Worker aufbauen
export function kernelBuild(job) {
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

/// Warum der alte Kern rechnet (null = neuer Kern zuständig)
const NAMES = { pattern: 'Muster', mirror: 'Spiegeln', moveface: 'Fläche verschieben', removefaces: 'Flächen entfernen', refillet: 'Radius ändern', rehole: 'Bohrung ändern' }
export function oldKernelReason(args) {
  if (args.base) return 'Ausgangsteil aus STEP'
  const missing = [...new Set((args.features ?? []).filter((f) => !SUPPORTED.has(f.type)).map((f) => NAMES[f.type] ?? f.type))]
  return missing.length ? `${missing.join(', ')} kann der neue Kern noch nicht` : null
}

/// Für die Anzeige in der Konstruktion: neuer Kern, wenn eingeschaltet und alle Features unterstützt – sonst Server
export function cadBuildView(args) {
  const ok = newKernelWanted() && !args.step && !oldKernelReason(args)
  return ok ? kernelBuild(args) : api.cadBuild(args)
}

// für Messungen und Browser-Tests
if (typeof window !== 'undefined') window.__kernel = { kernelBuild, kernelReady, kernelInfo }

/// STEP-Datei zum Rechnen/Speichern: mit dem neuen Kern im Browser bauen und dem Server nur die fertige Datei geben
/// (gleiche Antwort wie api.cadBuild mit `step`: { status, volume, bodies, bodies_info, step: Pfad })
export async function cadBuildStep(args) {
  if (!newKernelWanted() || oldKernelReason(args)) return api.cadBuild(args)
  const r = await kernelBuild({ ...args, step: true, tess: false })
  const text = r.step_text
  delete r.step_text
  if (!text) return r
  const saved = await api.cadBuild({ features: [], step: args.step, step_text: text, tess: false })
  return { ...r, step: saved.step }
}
