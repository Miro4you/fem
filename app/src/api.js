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
  const m = window.location.hash.match(/^#k=([a-z0-9]+)/i)
  if (m) {
    storage.set(KEY_STORE, m[1])
    history.replaceState(null, '', window.location.pathname)
  }
}

// eigene Sitzung je Browser-Tab (eigenes Modell auf dem Server)
const session = Math.random().toString(36).slice(2) + Date.now().toString(36)

// mehrere Anfragen gleichzeitig abgewiesen → nur einmal nachfragen
let keyPrompt = null
function askKey() {
  keyPrompt ??= Promise.resolve().then(() => {
    const k = window.prompt(
      'Zugangsschlüssel eingeben.\n\nDesktop-App: steht unter Einstellungen → Heimnetz.\n' +
        'Server/NAS: steht im Container-Protokoll („Im Browser öffnen: …#k=…“) bzw. in PROJEKT_FEM_SCHLUESSEL.',
    )
    keyPrompt = null
    if (!k?.trim()) return false
    storage.set(KEY_STORE, k.trim())
    return true
  })
  return keyPrompt
}

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
    if (await askKey()) return http(path, { method, json, body, raw })
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

/// keepFasteners: Schrauben/Muttern/Scheiben aus dem CAD als Körper rechnen (sonst als Schraubenelement)
export const openStep = (path, size, linear = false, refine = [], keepFasteners = false, preview = false) =>
  isDesktop
    ? invoke('open_step', { path, size, linear, refine, keepFasteners, preview })
    : http('/open_step', { method: 'POST', json: { path, size, linear, refine, keep_fasteners: keepFasteners, preview } })

/// Laufendes Vernetzen bzw. Rechnen abbrechen
export const cancel = () => (isDesktop ? invoke('cancel') : http('/cancel', { method: 'POST' }))

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

/// Schnitt durch das aktuelle Ergebnis (Ebene durch point mit Normale normal)
export const section = (point, normal) =>
  isDesktop ? invoke('section', { point, normal }) : http('/section', { method: 'POST', json: { point, normal } })

/// 3D-Druck: ~400 Aufbaurichtungen bewerten (Sicherheit aus letzter Rechnung, Stützmaterial)
export const orientationScan = (material) =>
  isDesktop ? invoke('orientation_scan', { material }) : http('/orientation_scan', { method: 'POST', json: { material } })

/// Leichtbau: Topologieoptimierung
export const topopt = (setup, args) => (isDesktop ? invoke('topopt', { setup, args }) : http('/topopt', { method: 'POST', json: { setup, args } }))
export const topoSurface = (threshold) =>
  isDesktop ? invoke('topo_surface', { threshold }) : http('/topo_surface', { method: 'POST', json: { threshold } })
export async function exportTopoStl(threshold, name) {
  if (isDesktop) {
    const p = await save({ defaultPath: name, filters: [{ name: 'STL', extensions: ['stl'] }] })
    if (p) await invoke('topo_stl', { path: p, threshold })
    return
  }
  download(await http('/topo_stl?threshold=' + threshold, { raw: true }), name)
}

/// eigene Werkstoffe (Datei auf dem rechnenden Rechner)
export const loadUserMaterials = () => (isDesktop ? invoke('load_user_materials') : http('/materials'))
export const saveUserMaterials = (list) =>
  isDesktop ? invoke('save_user_materials', { list }) : http('/materials', { method: 'POST', json: list })

/// Datei (Blob) speichern: Desktop mit Dialog, Browser als Download
export async function saveBlob(blob, name, filterName, ext) {
  if (isDesktop) {
    const p = await save({ defaultPath: name, filters: [{ name: filterName, extensions: [ext] }] })
    if (!p) return
    const buf = new Uint8Array(await blob.arrayBuffer())
    await invoke('save_bytes', { path: p, data: toBase64(buf) })
    return
  }
  download(blob, name)
}

/// Eigenfrequenzen ('modal') bzw. Knicken ('buckling'); density in g/cm³
export const modes = (setup, kind, count, density) =>
  isDesktop ? invoke('modes', { setup, kind, count, density }) : http('/modes', { method: 'POST', json: { setup, kind, count, density } })

/// Schweißnaht-Vorschläge: einander zugewandte ebene Flächen mit Spalt ≤ maxGap [mm]
export const boltAtHole = (holes, pick, d = null, flip = false) =>
  isDesktop ? invoke('bolt_at_hole', { holes, pick, d, flip }) : http('/bolt_at_hole', { method: 'POST', json: { holes, pick, d, flip } })
export const findGaps = (maxGap) => (isDesktop ? invoke('find_gaps', { maxGap }) : http('/find_gaps', { method: 'POST', json: { max_gap: maxGap } }))

/// Stabwerk rechnen
export const frameSolve = (frame) => (isDesktop ? invoke('frame_solve', { frame }) : http('/frame_solve', { method: 'POST', json: frame }))

/// JSON-Datei öffnen (Desktop: Dialog, Browser: Dateiauswahl) → Inhalt als Objekt
export async function openJson(filterName, ext) {
  if (isDesktop) {
    const p = await open({ multiple: false, filters: [{ name: filterName, extensions: [ext, 'json'] }] })
    if (!p) return null
    return JSON.parse(await invoke('load_text', { path: p }))
  }
  const f = await chooseFile('.json')
  return f ? JSON.parse(await f.text()) : null
}

// --- CAD-Schnittstelle (Add-ins schicken Teile, holen Ergebnisse) ---------------------------------
/// Angaben für den Dialog „CAD“: Schlüssel, Adressen, Onshape eingerichtet?
export async function cadInfo() {
  if (isDesktop) return invoke('cad_info')
  const st = await http('/onshape/status')
  return { key: storage.get(KEY_STORE) ?? '', onshape: st.configured, onshapeUsage: st.usage, web: window.location.origin }
}
export const onshapeSetKeys = (access, secret) =>
  isDesktop ? invoke('onshape_set_keys', { access, secret }) : http('/onshape/keys', { method: 'POST', json: { access, secret } })
/// Onshape-Teilestudio holen (Adresse aus dem Browser); das Teil kommt wie aus einem Add-in an
/// Onshape-Variablen des Teilestudios (`#dicke` …), ändern, und für die Studie: setzen + STEP holen
export const onshapeVariables = (url) => (isDesktop ? invoke('onshape_variables', { url }) : http('/onshape/variables', { method: 'POST', json: { url } }))
export const onshapeSetVariable = (url, name, expression) =>
  isDesktop ? invoke('onshape_set_variable', { url, name, expression }) : http('/onshape/set_variable', { method: 'POST', json: { url, name, expression } })
export const onshapeStudy = (url, name, expression) =>
  isDesktop ? invoke('onshape_study', { url, name, expression }) : http('/onshape/study', { method: 'POST', json: { url, name, expression } })
export const onshapeImport = (url) => (isDesktop ? invoke('onshape_import', { url }) : http('/onshape/import', { method: 'POST', json: { url } }))
/// Bibliothek: eigene Onshape-Dokumente, Teilestudios eines Dokuments, Vorschaubilder (data:-Adresse)
export const onshapeDocuments = (q = '', fresh = false) =>
  isDesktop ? invoke('onshape_documents', { q, fresh }) : http('/onshape/documents', { method: 'POST', json: { q, fresh } })
export const onshapeElements = (did, wid) =>
  isDesktop ? invoke('onshape_elements', { did, wid }) : http('/onshape/elements', { method: 'POST', json: { did, wid } })
export const onshapeThumbnail = ({ href = null, did = '', wid = '', eid = '' }) =>
  isDesktop ? invoke('onshape_thumbnail', { href, did, wid, eid }) : http('/onshape/thumbnail', { method: 'POST', json: { href, did, wid, eid } })
/// Ergebniswerte in die Beschreibung der Teile im Onshape-Teilestudio schreiben → Text
export const onshapeWriteResult = (url) =>
  isDesktop ? invoke('onshape_write_result', { url }) : http('/onshape/write_result', { method: 'POST', json: { url } })
// --- SolidCraft (Live-Verbindung über seinen Steuerkanal, läuft auf dem rechnenden Rechner) ---
const sc = (cmd, args, path, method = 'POST', json) =>
  isDesktop ? invoke(cmd, args) : http('/solidcraft/' + path, method === 'GET' ? {} : { method, json: json ?? args ?? {} })
export const scStatus = () => sc('solidcraft_status', undefined, 'status', 'GET')
export const scLive = (on) => sc('solidcraft_live', { on }, 'live')
export const scAuto = (on) => sc('solidcraft_auto', { on }, 'auto')
export const scFetch = () => sc('solidcraft_fetch', undefined, 'fetch')
export const scResult = (name = null) => sc('solidcraft_result', { name }, 'result')
export const scParams = () => sc('solidcraft_params', undefined, 'params', 'GET')
export const scPause = (on) => sc('solidcraft_pause', { on }, 'pause')
export const scStudy = (name, expression) => sc('solidcraft_study', { name, expression }, 'study')

export const startupFile = () => (isDesktop ? invoke('startup_file') : Promise.resolve(null))
export const cadSetSummary = (name, summary) =>
  isDesktop ? invoke('cad_set_summary', { name, summary }) : http('/cad/summary?name=' + encodeURIComponent(name), { method: 'POST', json: summary })
/// Rückruf bei eingehendem Teil; gibt eine Abmeldefunktion zurück
export function onCadOpen(cb) {
  if (isDesktop) {
    let off = null
    let stop = false
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen('cad-open', (e) => cb(e.payload)).then((f) => (stop ? f() : (off = f))),
    )
    return () => {
      stop = true
      off?.()
    }
  }
  // Browser: regelmäßig beim rechnenden Rechner nachfragen
  let after = null
  let stop = false
  const tick = async () => {
    try {
      const list = await http('/cad/inbox?after=' + (after ?? 0))
      if (after === null) {
        // erster Abruf: nur ein gerade eben geschicktes Teil übernehmen (Tab über „Projekt-FEM öffnen“ aufgerufen)
        after = list.length ? list[list.length - 1].seq : 0
        const fresh = list.filter((i) => i.age < 120).pop()
        if (fresh) cb(fresh)
      } else
        for (const inc of list) {
          after = Math.max(after, inc.seq)
          cb(inc)
        }
    } catch {
      /* Server noch nicht bereit */
    }
    if (!stop) setTimeout(tick, 3000)
  }
  tick()
  return () => {
    stop = true
  }
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
    return p
  }
  const step = await http('/file?path=' + encodeURIComponent(stepPath), { raw: true })
  const full = { ...data, stepName: baseName(stepPath), stepData: toBase64(await step.arrayBuffer()) }
  download(new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }), name)
}

/// Projekt laden → Inhalt; `step` zeigt danach auf eine Datei, die der rechnende Rechner lesen kann
export async function loadProject(path = null) {
  let text
  let file = null
  if (isDesktop) {
    const p = path ?? (await open({ multiple: false, filters: [{ name: 'Projekt-FEM', extensions: ['fem.json', 'json'] }] }))
    if (!p) return null
    file = p
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
  d.file = file
  return d
}

/// Projekt aus Text (z. B. hergezogene Datei im Browser)
export async function projectFromText(text) {
  const d = JSON.parse(text)
  if (d.stepData && !isDesktop) {
    const bytes = Uint8Array.from(atob(d.stepData), (c) => c.charCodeAt(0))
    d.step = await uploadStep(new File([bytes], d.stepName ?? 'geometrie.step'))
  }
  return d
}

/// hergezogene STEP-Datei: Browser lädt hoch, Desktop bekommt den Pfad über das Fensterereignis
export const uploadStepFile = (file) => uploadStep(file)

/// Desktop: Dateien, die auf das Fenster gezogen werden → Pfade
export function onFileDrop(cb) {
  if (!isDesktop) return () => {}
  let off = null
  let stop = false
  import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'drop' && e.payload.paths?.length) cb(e.payload.paths)
      }),
    )
    .then((f) => (stop ? f() : (off = f)))
    .catch(() => {})
  return () => {
    stop = true
    off?.()
  }
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
