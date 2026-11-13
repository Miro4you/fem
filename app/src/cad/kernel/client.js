// Zugang zum neuen Geometriekern (Web Worker) – gleiche Aufrufform wie api.cadBuild
import * as api from '../../api.js'

const KEY = 'projekt-fem.kern'
/// Was der neue Kern schon kann (Rest: alter Kern auf dem Server)
const SUPPORTED = new Set(['sketch', 'extrude', 'revolve', 'hole', 'fillet', 'chamfer'])

/// Neuer Kern eingeschaltet? (#kern=neu bzw. #kern=alt in der Adresse merkt sich die Wahl)
export function newKernelWanted() {
  try {
    const m = /[#&]kern=(neu|alt)\b/.exec(location.hash)
    if (m) localStorage.setItem(KEY, m[1])
    return localStorage.getItem(KEY) === 'neu'
  } catch {
    return false
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

/// Für die Anzeige in der Konstruktion: neuer Kern, wenn eingeschaltet und alle Features unterstützt – sonst Server
export function cadBuildView(args) {
  const ok = newKernelWanted() && !args.base && !args.step && (args.features ?? []).every((f) => SUPPORTED.has(f.type))
  return ok ? kernelBuild(args) : api.cadBuild(args)
}

// für Messungen und Browser-Tests
if (typeof window !== 'undefined') window.__kernel = { kernelBuild, kernelReady, kernelInfo }
