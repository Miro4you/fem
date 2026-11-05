// Verbindung zum Rechenkern: in der Desktop-App über Tauri, im Browser (Heimnetz) über HTTP.
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

export const isDesktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

// --- Browser: Zugangsschlüssel und Sitzung ------------------------------------------------

const KEY_STORE = 'projekt-fem-key'
const storage = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* privat */ } },
}

if (!isDesktop && typeof window !== 'undefined') {
  // Link aus der Desktop-App: http://rechner:8790/#k=SCHLÜSSEL
  const m = window.location.hash.match(/k=([a-z0-9]+)/i)
  if (m) {
    storage.set(KEY_STORE, m[1])
    history.replaceState(null, '', window.location.pathname)
  }
}

// eigene Sitzung je Browser-Tab (eigenes Modell auf dem Server)
const session = Math.random().toString(36).slice(2) + Date.now().toString(36)

async function http(path, { method = 'GET', json, body, raw = false } = {}) {
  const headers = { 'X-FEM-Key': storage.get(KEY_STORE) ?? '', 'X-FEM-Session': session }
  if (json !== undefined) headers['Content-Type'] = 'application/json'
  let r
  try {
    r = await fetch('/api' + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : body })
  } catch {
    throw new Error('Keine Verbindung zum Rechner – läuft Projekt-FEM dort noch mit Heimnetz-Freigabe?')
  }
  if (r.status === 401) {
    const k = window.prompt('Zugangsschlüssel eingeben (steht in der Desktop-App unter „Heimnetz“):')
    if (k) {
      storage.set(KEY_STORE, k.trim())
      return http(path, { method, json, body, raw })
    }
    throw new Error('Zugangsschlüssel fehlt oder ist falsch')
  }
  if (!r.ok) throw new Error(await r.text())
  return raw ? r.blob() : r.json()
}

// Datei im Browser auswählen
function chooseFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

const baseName = (p) => p.split(/[\\/]/).pop()

async function uploadStep(file) {
  return http('/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// --- Gemeinsame Schnittstelle --------------------------------------------------------------

export const gmshPath = () => (isDesktop ? invoke('gmsh_path') : http('/gmsh'))

export const openStep = (path, size, linear = false, refine = []) =>
  isDesktop ? invoke('open_step', { path, size, linear, refine }) : http('/open_step', { method: 'POST', json: { path, size, linear, refine } })

/// Fortschritt der laufenden Rechnung ({ text, fraction } oder null)
export const progress = () => (isDesktop ? invoke('progress') : http('/progress'))

/// Geometrie ändern: Änderungen auf die Original-STEP anwenden, neu vernetzen
export const modifyGeometry = (base, ops, size, refine = []) =>
  isDesktop
    ? invoke('modify_geometry', { base, ops, size, refine })
    : http('/modify_geometry', { method: 'POST', json: { base, ops, size, refine } })

/// geänderte STEP-Datei speichern
export async function exportStep(path, name) {
  if (isDesktop) {
    const p = await save({ defaultPath: name, filters: [{ name: 'STEP-Geometrie', extensions: ['step', 'stp'] }] })
    if (p) await invoke('copy_step', { from: path, to: p })
    return
  }
  download(await http('/file?path=' + encodeURIComponent(path), { raw: true }), name)
}

export const solve = (setup) => (isDesktop ? invoke('solve', { setup }) : http('/solve', { method: 'POST', json: { setup } }))

/// STEP auswählen → Pfad auf dem rechnenden Rechner (im Browser: hochladen)
export async function pickStep() {
  if (isDesktop)
    return open({ multiple: false, filters: [{ name: 'STEP-Geometrie', extensions: ['step', 'stp', 'STEP', 'STP'] }] })
  const f = await chooseFile('.step,.stp,.STEP,.STP')
  return f ? uploadStep(f) : null
}

/// Projekt speichern. Im Browser als Download, mit eingebetteter STEP-Datei (damit es überall aufgeht).
export async function saveProject(stepPath, data) {
  const name = baseName(stepPath).replace(/\.(step|stp)$/i, '') + '.fem.json'
  if (isDesktop) {
    const p = await save({ defaultPath: stepPath.replace(/\.(step|stp)$/i, '') + '.fem.json', filters: [{ name: 'Projekt-FEM', extensions: ['fem.json'] }] })
    if (p) await invoke('save_text', { path: p, content: JSON.stringify(data, null, 2) })
    return
  }
  const step = await http('/file?path=' + encodeURIComponent(stepPath), { raw: true })
  const full = { ...data, stepName: baseName(stepPath), stepData: toBase64(await step.arrayBuffer()) }
  download(new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }), name)
}

/// Projekt laden → Inhalt; `step` zeigt danach auf eine Datei, die der rechnende Rechner lesen kann
export async function loadProject() {
  let text
  if (isDesktop) {
    const p = await open({ multiple: false, filters: [{ name: 'Projekt-FEM', extensions: ['fem.json', 'json'] }] })
    if (!p) return null
    text = await invoke('load_text', { path: p })
  } else {
    const f = await chooseFile('.json,.fem.json')
    if (!f) return null
    text = await f.text()
  }
  const d = JSON.parse(text)
  if (d.stepData && !isDesktop) {
    const bytes = Uint8Array.from(atob(d.stepData), (c) => c.charCodeAt(0))
    d.step = await uploadStep(new File([bytes], d.stepName ?? 'geometrie.step'))
  }
  return d
}

/// Ergebnis für ParaView speichern
export async function exportVtu(stepPath) {
  const name = (stepPath ?? 'ergebnis').replace(/\.(step|stp)$/i, '') + '.vtu'
  if (isDesktop) {
    const p = await save({ defaultPath: name, filters: [{ name: 'VTK (ParaView)', extensions: ['vtu'] }] })
    if (p) await invoke('export_vtu', { path: p })
    return
  }
  download(await http('/vtu', { raw: true }), baseName(name))
}

// --- Heimnetz-Freigabe (nur Desktop) ----------------------------------------------------------

export const serverStatus = () => invoke('server_status')
export const serverStart = () => invoke('server_start')
export const serverStop = () => invoke('server_stop')
export const serverConfigure = (opts) => invoke('server_configure', opts)
