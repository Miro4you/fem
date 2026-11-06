// Einstellungen dieser Oberfläche (je Gerät/Browser): Navigation, Darstellung, zuletzt geöffnet
import { useEffect, useState } from 'react'

const PREFIX = 'projekt-fem-'

export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key)
    if (v == null) return fallback
    const parsed = JSON.parse(v)
    return fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? { ...fallback, ...parsed } : parsed
  } catch {
    return fallback
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* privater Modus */
  }
  window.dispatchEvent(new CustomEvent('projekt-fem-pref', { detail: { key, value } }))
}

/// Einstellung als Zustand; Änderungen an anderer Stelle (Einstellungen-Dialog) kommen hier an
export function usePref(key, fallback) {
  const [v, setV] = useState(() => loadPref(key, fallback))
  useEffect(() => {
    const on = (e) => e.detail.key === key && setV(e.detail.value)
    window.addEventListener('projekt-fem-pref', on)
    return () => window.removeEventListener('projekt-fem-pref', on)
  }, [key])
  return [v, (next) => savePref(key, typeof next === 'function' ? next(loadPref(key, fallback)) : next)]
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// --- Navigation (Maus/Trackpad) -------------------------------------------------------------
export const NAV_DEFAULT = { preset: isMac ? 'track' : 'classic', pivotAtCursor: true, zoomToCursor: true, invertZoom: false, speed: 1 }

export const NAV_PRESETS = {
  track: {
    label: 'Trackpad (Mac)',
    hint: 'zwei Finger drehen',
    help: 'Zwei Finger: drehen · Spreizen: zoomen · ⇧ + zwei Finger: verschieben · Klick: wählen',
    gestures: [
      ['Zwei Finger wischen', 'Drehen um den Punkt unter dem Zeiger'],
      ['Spreizen / Zusammenziehen', 'Zoomen zum Zeiger hin'],
      ['⇧ + zwei Finger wischen', 'Verschieben'],
      ['Ein Finger tippen / klicken', 'Fläche auswählen (dreht nicht)'],
      ['Doppelklick auf eine Fläche', 'Ansicht senkrecht auf die Fläche'],
    ],
  },
  sw: {
    label: 'Maus wie SolidWorks',
    hint: 'mittlere Taste drehen',
    help: 'Mitte: drehen · Strg + Mitte: verschieben · Rad: zoomen · Links: wählen',
    gestures: [
      ['Mittlere Taste ziehen', 'Drehen um den Punkt unter dem Zeiger'],
      ['Strg + mittlere Taste ziehen', 'Verschieben'],
      ['Mausrad', 'Zoomen zum Zeiger hin'],
      ['Linke Taste klicken', 'Fläche auswählen'],
      ['Doppelklick auf eine Fläche', 'Ansicht senkrecht auf die Fläche'],
    ],
  },
  os: {
    label: 'Maus wie Onshape',
    hint: 'rechte Taste drehen',
    help: 'Rechts: drehen · Mitte oder Strg + Rechts: verschieben · Rad: zoomen · Links: wählen',
    gestures: [
      ['Rechte Taste ziehen', 'Drehen um den Punkt unter dem Zeiger'],
      ['Mittlere Taste oder Strg + rechte Taste ziehen', 'Verschieben'],
      ['Mausrad', 'Zoomen zum Zeiger hin'],
      ['Linke Taste klicken', 'Fläche auswählen'],
      ['Doppelklick auf eine Fläche', 'Ansicht senkrecht auf die Fläche'],
    ],
  },
  fu: {
    label: 'Maus wie Fusion',
    hint: '⇧ + mittlere Taste',
    help: '⇧ + Mitte: drehen · Mitte: verschieben · Rad: zoomen · Links: wählen',
    gestures: [
      ['⇧ + mittlere Taste ziehen', 'Drehen um den Punkt unter dem Zeiger'],
      ['Mittlere Taste ziehen', 'Verschieben'],
      ['Mausrad', 'Zoomen zum Zeiger hin'],
      ['Linke Taste klicken', 'Fläche auswählen'],
      ['Doppelklick auf eine Fläche', 'Ansicht senkrecht auf die Fläche'],
    ],
  },
  classic: {
    label: 'Maus einfach',
    hint: 'linke Taste drehen',
    help: 'Links ziehen: drehen · Rechts/Mitte: verschieben · Rad: zoomen · Klick: wählen',
    gestures: [
      ['Linke Taste ziehen', 'Drehen um den Punkt unter dem Zeiger'],
      ['Rechte/mittlere Taste oder ⇧ + links ziehen', 'Verschieben'],
      ['Mausrad', 'Zoomen zum Zeiger hin'],
      ['Klicken (ohne Ziehen)', 'Fläche auswählen'],
      ['Doppelklick auf eine Fläche', 'Ansicht senkrecht auf die Fläche'],
    ],
  },
}

// --- Darstellung ------------------------------------------------------------------------------
export const DISPLAY_DEFAULT = { bands: true, ghost: true, theme: 'auto' }

/// Erscheinungsbild auf die Seite anwenden (auto = wie das Betriebssystem)
export function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
  else delete root.dataset.theme
}

// --- Zuletzt geöffnet -------------------------------------------------------------------------
// { kind: 'step' | 'project' | 'onshape', path, name, info, at }
export function addRecent(entry) {
  const all = loadPref('recent', [])
  const same = (r) => r.kind === entry.kind && r.path === entry.path
  const prev = all.find(same) ?? {}
  const given = Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null && v !== ''))
  savePref('recent', [{ ...prev, ...given, at: Date.now() }, ...all.filter((r) => !same(r))].slice(0, 8))
}

export function updateRecent(kind, path, patch) {
  const list = loadPref('recent', [])
  if (!list.some((r) => r.kind === kind && r.path === path)) return
  savePref('recent', list.map((r) => (r.kind === kind && r.path === path ? { ...r, ...patch } : r)))
}
