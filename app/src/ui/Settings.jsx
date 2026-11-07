import { useEffect, useState } from 'react'
import { Check, Copy, Download, Loader2, Trash2, X } from 'lucide-react'
import * as api from '../api.js'
import { NAV_PRESETS, usePref, NAV_DEFAULT, DISPLAY_DEFAULT } from '../prefs.js'
import { IcMouse, IcTrackpad } from './icons.jsx'

const TABS = [
  ['nav', 'Maus & Trackpad'],
  ['cad', 'CAD-Verbindungen'],
  ['net', 'Heimnetz'],
  ['look', 'Darstellung'],
]

// Einstellungen: Navigation, CAD-Verbindungen, Heimnetz, Darstellung
export default function Settings({ tab: initial = 'nav', onClose, onError }) {
  const [tab, setTab] = useState(initial)
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings" role="dialog" aria-label="Einstellungen">
        <div className="dialog-head">
          <b>Einstellungen</b>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">
            <X size={16} />
          </button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="dialog-body">
          {tab === 'nav' && <NavSettings />}
          {tab === 'cad' && <CadSettings onError={onError} />}
          {tab === 'net' && <NetSettings onError={onError} />}
          {tab === 'look' && <LookSettings />}
        </div>
      </div>
    </div>
  )
}

// --- Maus & Trackpad -----------------------------------------------------------------------------
function NavSettings() {
  const [nav, setNav] = usePref('nav', NAV_DEFAULT)
  const p = NAV_PRESETS[nav.preset] ?? NAV_PRESETS.classic
  const set = (patch) => setNav({ ...nav, ...patch })
  return (
    <>
      <div className="presets">
        {Object.entries(NAV_PRESETS).map(([k, v]) => (
          <button key={k} className={'preset' + (nav.preset === k ? ' on' : '')} onClick={() => set({ preset: k })}>
            {k === 'track' ? <IcTrackpad /> : <IcMouse />}
            <b>{v.label}</b>
            <span>{v.hint}</span>
          </button>
        ))}
      </div>
      <div className="card gestures">
        {p.gestures.map(([a, b]) => (
          <div key={a} className="gest">
            <b>{a}</b>
            <span>{b}</span>
          </div>
        ))}
      </div>
      <div className="toggles">
        <label className="check">
          <input type="checkbox" checked={nav.pivotAtCursor} onChange={(e) => set({ pivotAtCursor: e.target.checked })} /> Drehpunkt ist der Punkt unter dem
          Zeiger (sonst die Bauteilmitte)
        </label>
        <label className="check">
          <input type="checkbox" checked={nav.zoomToCursor} onChange={(e) => set({ zoomToCursor: e.target.checked })} /> Zoomen zum Zeiger hin
        </label>
        <label className="check">
          <input type="checkbox" checked={nav.invertZoom} onChange={(e) => set({ invertZoom: e.target.checked })} /> Zoomrichtung umkehren
        </label>
        <label className="range-row">
          Drehgeschwindigkeit
          <input type="range" min={0.3} max={2.5} step={0.1} value={nav.speed} onChange={(e) => set({ speed: Number(e.target.value) })} />
          <em>{Math.round(nav.speed * 100)} %</em>
        </label>
      </div>
      <p className="hint">Gilt für dieses Gerät. Auf dem Mac mit Trackpad „Trackpad (Mac)“ wählen, sonst die Maus wie im gewohnten CAD.</p>
    </>
  )
}

// --- Darstellung -----------------------------------------------------------------------------------
function LookSettings() {
  const [d, setD] = usePref('display', DISPLAY_DEFAULT)
  const set = (patch) => setD({ ...d, ...patch })
  return (
    <div className="toggles">
      <label className="check">
        <input type="checkbox" checked={d.bands} onChange={(e) => set({ bands: e.target.checked })} /> Farbstufen statt fließender Verlauf
      </label>
      <label className="check">
        <input type="checkbox" checked={d.ghost} onChange={(e) => set({ ghost: e.target.checked })} /> Unverformte Kontur anzeigen
      </label>
      <div className="field">
        <span>Erscheinungsbild</span>
        <div className="segmented small">
          {[['auto', 'wie das System'], ['light', 'hell'], ['dark', 'dunkel']].map(([k, l]) => (
            <button key={k} className={d.theme === k ? 'on' : ''} onClick={() => set({ theme: k })}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// --- Onshape-Schlüssel ------------------------------------------------------------------------------
export function OnshapeKeys({ onSaved, onError, configured }) {
  const [access, setAccess] = useState('')
  const [secret, setSecret] = useState('')
  const save = async (a, s) => {
    try {
      const ok = await api.onshapeSetKeys(a, s)
      setAccess('')
      setSecret('')
      onSaved?.(ok)
    } catch (e) {
      onError?.(e)
    }
  }
  return (
    <div className="keys">
      <p className="hint">
        Schlüssel anlegen unter <code>dev-portal.onshape.com</code> → API keys (Rechte: lesen, für „Ergebnis → Onshape“ und Variablen-Studien auch
        schreiben). Access Key und Secret Key hier eintragen – nicht dein Onshape-Passwort.
      </p>
      <div className="grid2">
        <label className="field">
          <span>Access Key</span>
          <input value={access} onChange={(e) => setAccess(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>Secret Key</span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={!access.trim() || !secret.trim()} onClick={() => save(access, secret)}>
          <Check size={14} /> Speichern
        </button>
        {configured && (
          <button className="btn ghost" onClick={() => save('', '')}>
            <Trash2 size={14} /> Schlüssel entfernen
          </button>
        )}
      </div>
    </div>
  )
}

// Lesezeichen für die Lesezeichenleiste (React lässt javascript:-Links nicht zu → Attribut direkt setzen)
function Bookmarklet({ code, children }) {
  return (
    <a
      className="bookmarklet"
      ref={(el) => el?.setAttribute('href', code)}
      onClick={(e) => {
        e.preventDefault()
        window.alert('In die Lesezeichenleiste des Browsers ziehen (nicht anklicken). Danach im offenen Onshape-Teilestudio anklicken.')
      }}
      title="In die Lesezeichenleiste ziehen"
    >
      {children}
    </a>
  )
}

const bookmarkletCode = (base, key, path) =>
  `javascript:void(window.open('${base}/${path}?k=${key}&url='+encodeURIComponent(location.href),'projekt-fem','width=600,height=420'))`

// --- CAD-Verbindungen ------------------------------------------------------------------------------
function CadSettings({ onError }) {
  const [info, setInfo] = useState(null)
  const [net, setNet] = useState(null)
  const [cadAuto, setCadAuto] = usePref('cadAuto', true)
  const [changeKeys, setChangeKeys] = useState(false)
  const [msg, setMsg] = useState(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    api.cadInfo().then(setInfo).catch(onError)
    if (api.isDesktop) api.serverStatus().then(setNet).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Einstellungsdatei für Add-ins auf einem anderen Rechner (Desktop: nur mit Heimnetz-Freigabe)
  const remoteBase = info && (api.isDesktop ? net?.running && net.urls?.[0] && new URL(net.urls[0]).origin : info.web)
  const remote = remoteBase ? `adresse = ${remoteBase}/api/cad\nschluessel = ${info.key}` : null
  const targets = []
  if (info) {
    if (api.isDesktop) {
      targets.push(['dieser Rechner', `http://127.0.0.1:${info.localPort}/cad`])
      if (net?.running && net.urls?.[0]) targets.push(['andere Rechner im Heimnetz', new URL(net.urls[0]).origin + '/api/cad'])
    } else targets.push([null, info.web + '/api/cad'])
  }
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={cadAuto} onChange={(e) => setCadAuto(e.target.checked)} /> Neue Version aus dem CAD automatisch übernehmen und neu
        rechnen (Lager und Lasten bleiben)
      </label>

      <div className="card cad-card">
        <div className="kv">
          <span>Onshape</span>
          {info && <b className={info.onshape ? 'ok-text' : 'warn-text'}>{info.onshape ? 'API-Schlüssel hinterlegt' : 'API-Schlüssel fehlen'}</b>}
        </div>
        {info && (!info.onshape || changeKeys) ? (
          <OnshapeKeys
            configured={info.onshape}
            onError={onError}
            onSaved={(ok) => {
              setInfo({ ...info, onshape: ok })
              setChangeKeys(false)
              setMsg(ok ? 'Onshape-Schlüssel gespeichert' : 'Onshape-Schlüssel entfernt')
            }}
          />
        ) : (
          info && (
            <>
              <p className="hint">
                Teile holst du über Datei › Aus Onshape. Für den Knopf direkt im Browser: Lesezeichen in die Lesezeichenleiste ziehen, dann im offenen
                Teilestudio anklicken.
              </p>
              {targets.map(([label, base]) => (
                <div key={base} className="bookmarks">
                  {label && <span className="hint">{label}:</span>}
                  <Bookmarklet code={bookmarkletCode(base, info.key, 'onshape')}>→ Projekt-FEM</Bookmarklet>
                  <Bookmarklet code={bookmarkletCode(base, info.key, 'onshape_result')}>FEM-Ergebnis → Onshape</Bookmarklet>
                </div>
              ))}
              <button className="link" onClick={() => setChangeKeys(true)}>
                Schlüssel ändern oder entfernen
              </button>
            </>
          )
        )}
        {info?.onshapeUsage && (
          <p className="hint">
            API-Aufrufe {info.onshapeUsage.year}: <b>{info.onshapeUsage.year_count}</b> (seit {info.onshapeUsage.since} insgesamt {info.onshapeUsage.total}). Kostenlose
            Onshape-Konten haben 2500 im Jahr. Teil holen ≈ 6 Aufrufe, Variablen-Studie ≈ 7 je Wert, Bibliothek öffnen ≈ 1 (Liste und Vorschaubilder
            werden gespeichert).
          </p>
        )}
        {msg && <p className="hint cad-msg">{msg}</p>}
      </div>

      <div className="card cad-card">
        <SolidCraftLink />
      </div>

      <div className="card cad-card">
        <div className="kv">
          <span>SolidWorks, Fusion, NX, Solid Edge</span>
          <b>Add-ins</b>
        </div>
        <p className="hint">
          Knöpfe im CAD: <b>In Projekt-FEM rechnen</b> schickt das aktive Teil hierher (gleiches Teil: Lager und Lasten bleiben), <b>Ergebnis holen</b> trägt
          Sicherheit, Spannung, Verformung und Masse als Eigenschaften ins Teil ein. Add-ins und Anleitung: Ordner <code>cad-addins</code> im Projekt.
        </p>
        {api.isDesktop && net && !net.running && <p className="hint">CAD auf einem anderen Rechner? Dann zusätzlich unter Heimnetz freigeben.</p>}
        {remote && (
          <>
            <p className="hint">
              {api.isDesktop ? 'CAD auf einem anderen Rechner im Heimnetz' : 'CAD auf diesem Rechner'}: Datei <code>projekt-fem-cad.txt</code> im
              Benutzerordner anlegen ({api.isDesktop ? 'dort' : 'hier'}), Inhalt:
            </p>
            <div className="share-url">
              <code className="cad-settings">{remote}</code>
              <button
                className="icon-btn"
                title="Kopieren"
                onClick={() => {
                  navigator.clipboard?.writeText(remote + '\n')
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

// SolidCraft: live mitlaufen, holen, Ergebnis zurück (Steuerkanal auf dem rechnenden Rechner)
function SolidCraftLink() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const s = await api.scStatus()
        if (!stop) setSt(s)
      } catch {
        /* ältere Gegenstelle */
      }
      if (!stop) setTimeout(tick, 2000)
    }
    tick()
    return () => {
      stop = true
    }
  }, [])
  const run = async (label, f) => {
    setBusy(label)
    setMsg(null)
    try {
      return await f()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy(null)
    }
  }
  if (!st)
    return (
      <div className="kv">
        <span>SolidCraft</span>
        <b>…</b>
      </div>
    )
  const time = st.last_sync ? new Date(st.last_sync).toLocaleTimeString('de-DE') : null
  return (
    <>
      <div className="kv">
        <span>SolidCraft</span>
        <b className={st.connected ? 'ok-text' : 'warn-text'}>{st.connected ? (st.live ? 'verbunden, läuft mit' : 'gefunden') : 'nicht erreichbar'}</b>
      </div>
      <p className="hint">
        Projekt-FEM folgt dem offenen SolidCraft-Design: Nach jeder Änderung wird die neue Version übernommen und neu gerechnet. SolidCraft muss auf dem
        rechnenden Rechner laufen (Einstellungen › Assistent › „Let AI agents connect“ an, Standard).
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={st.live}
          disabled={!!busy}
          onChange={(e) => {
            const on = e.target.checked
            setSt({ ...st, live: on })
            run('', async () => setSt(await api.scLive(on)))
          }}
        />
        Live mitlaufen{st.name ? ` – „${st.name}“` : ''}
        {time ? ` (zuletzt ${time})` : ''}
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={st.auto_result}
          onChange={(e) =>
            run('', async () => {
              await api.scAuto(e.target.checked)
              setSt({ ...st, auto_result: e.target.checked })
            })
          }
        />
        Ergebnis nach jeder Rechnung in SolidCraft eintragen
      </label>
      <div className="row">
        <button
          className="btn"
          disabled={!st.connected || !!busy}
          onClick={() =>
            run('holen', async () => {
              const inc = await api.scFetch()
              setMsg(`„${inc.name}“ geholt – wird geöffnet`)
            })
          }
        >
          {busy === 'holen' ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Jetzt holen
        </button>
        <button className="btn" disabled={!st.connected || !!busy} onClick={() => run('ergebnis', async () => setMsg('In SolidCraft eingetragen (Parameter FEM_…): ' + (await api.scResult())))}>
          {busy === 'ergebnis' ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Ergebnis → SolidCraft
        </button>
      </div>
      {(msg || (st.message && st.live)) && <p className="hint cad-msg">{msg ?? st.message}</p>}
    </>
  )
}

// --- Heimnetz-Freigabe: Oberfläche für andere Rechner im Browser bereitstellen --------------------
function NetSettings({ onError }) {
  const [st, setSt] = useState(null)
  const [copied, setCopied] = useState(null)
  useEffect(() => {
    if (api.isDesktop) api.serverStatus().then(setSt).catch(() => {})
  }, [])
  if (!api.isDesktop)
    return (
      <p className="hint">
        Diese Oberfläche läuft im Browser. Gerechnet wird auf <b>{window.location.hostname}</b> – dort lässt sich die Freigabe in der Desktop-App ein- und
        ausschalten.
      </p>
    )
  if (!st) return <Loader2 size={16} className="spin" />
  const run = (p) => p.then(setSt).catch(onError)
  const copy = (u) => {
    navigator.clipboard?.writeText(u)
    setCopied(u)
    setTimeout(() => setCopied(null), 1500)
  }
  return (
    <>
      <p className="hint">
        Andere Rechner (Laptop, Arbeits-PC, Tablet) öffnen Projekt-FEM dann im Browser. Gerechnet wird auf diesem Rechner. Der Link enthält einen
        Zugangsschlüssel – nur an eigene Geräte geben.
      </p>
      <label className="check">
        <input type="checkbox" checked={st.running} onChange={(e) => run(e.target.checked ? api.serverStart() : api.serverStop())} />
        Im Heimnetz freigeben (Port {st.port})
      </label>
      <label className="check">
        <input type="checkbox" checked={st.autostart} onChange={(e) => run(api.serverConfigure({ autostart: e.target.checked }))} />
        Beim Start von Projekt-FEM automatisch freigeben
      </label>
      {st.running && (
        <>
          <div className="share-urls">
            {st.urls.map((u) => (
              <div key={u} className="share-url">
                <code>{u}</code>
                <button className="icon-btn" title="Kopieren" onClick={() => copy(u)}>
                  {copied === u ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            ))}
          </div>
          <p className="hint">Der erste Link funktioniert meist überall im Heimnetz. Falls nicht: Firewall auf diesem Rechner für Port {st.port} öffnen.</p>
        </>
      )}
      <button
        className="link"
        onClick={() =>
          window.confirm('Neuer Schlüssel – bisherige Links und Lesezeichen funktionieren dann nicht mehr. Fortfahren?') && run(api.serverConfigure({ newKey: true }))
        }
      >
        Neuen Zugangsschlüssel erzeugen
      </button>
    </>
  )
}
