import { useEffect, useRef, useState } from 'react'
import { Loader2, Search, X, Download, FileUp } from 'lucide-react'
import * as api from '../api.js'

const when = (s) => {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  const min = (Date.now() - d.getTime()) / 60000
  if (min < 2) return 'gerade eben'
  if (min < 60) return `vor ${Math.round(min)} min`
  if (min < 24 * 60 && d.toDateString() === new Date().toDateString()) return 'heute ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Verbindung zum Draftpad-Server eintragen (Adresse, optional Passwort). Das Passwort wird nie zurück angezeigt.
export function DraftpadConnect({ status, onSaved, onError }) {
  const [url, setUrl] = useState(status?.url ?? '')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  if (status && !status.can_configure)
    return <p className="hint">Die Draftpad-Adresse ist auf diesem Server fest eingestellt (Umgebungsvariable PROJEKT_FEM_DRAFTPAD).</p>
  return (
    <form
      className="dp-connect"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await api.draftpadConfig(url, pw ? pw : undefined)
          setPw('')
          onSaved?.(await api.draftpadStatus())
        } catch (err) {
          onError?.(String(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label className="field">
        <span>Adresse des Draftpad-Servers</span>
        <input value={url} placeholder="z. B. 192.168.1.20:8080 oder https://draftpad.example.de" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="field">
        <span>Passwort (nur wenn Draftpad mit TOKEN läuft){status?.password ? ' – gespeichert, leer lassen = behalten' : ''}</span>
        <input type="password" value={pw} autoComplete="new-password" onChange={(e) => setPw(e.target.value)} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={busy || !url.trim()}>
          {busy ? <Loader2 size={14} className="spin" /> : null} Verbinden
        </button>
        {status?.configured && (
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await api.draftpadConfig('', '')
              setUrl('')
              onSaved?.(await api.draftpadStatus())
            }}
          >
            Trennen
          </button>
        )}
      </div>
    </form>
  )
}

export function DraftpadStatusLine({ status }) {
  if (!status) return <Loader2 size={14} className="spin" />
  if (!status.configured) return <b className="warn-text">nicht verbunden</b>
  if (status.error) return <b className="warn-text">{status.error}</b>
  return <b className="ok-text">verbunden{status.password ? ' (mit Passwort)' : ''}</b>
}

// Draftpad-Bibliothek: Zeichnungen der Online-Ablage, eine wählen → als Skizze übernehmen
export default function DraftpadLibrary({ onClose, onPick, onFile }) {
  const [status, setStatus] = useState(null)
  const [list, setList] = useState(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const input = useRef(null)

  const load = async (s) => {
    setStatus(s)
    if (!s.configured || s.error) return setList(null)
    try {
      const l = await api.draftpadList(true)
      setList(l)
      setSel((old) => old ?? l[0]?.id ?? null)
    } catch (e) {
      setMsg(String(e))
      setList([])
    }
  }
  useEffect(() => {
    api
      .draftpadStatus()
      .then(load)
      .catch((e) => setMsg(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (list) input.current?.focus()
  }, [list])

  const shown = (list ?? []).filter((e) => !q.trim() || (e.name ?? e.id).toLowerCase().includes(q.trim().toLowerCase()))
  async function take(id) {
    const e = list.find((x) => x.id === id)
    if (!e) return
    setBusy(true)
    setMsg(null)
    try {
      const doc = await api.draftpadGet(id)
      onPick({ doc, source: { kind: 'draftpad', id, name: e.name ?? id, updated: e.updated } })
      onClose()
    } catch (err) {
      setMsg(String(err))
    } finally {
      setBusy(false)
    }
  }

  const ready = status?.configured && !status.error
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog library" role="dialog" aria-label="Aus Draftpad holen">
        <div className="dialog-head">
          <FileUp size={20} />
          <b>Skizze aus Draftpad</b>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">
            <X size={16} />
          </button>
        </div>
        {status && !ready && (
          <div className="dialog-body">
            <p className="hint">
              Projekt-FEM holt Zeichnungen aus der Online-Ablage von Draftpad. Adresse des Draftpad-Servers eintragen (z. B. der Raspberry Pi im
              Heimnetz). {status.error ? `Zuletzt: ${status.error}.` : ''}
            </p>
            <DraftpadConnect status={status} onSaved={load} onError={(e) => setMsg(e)} />
            {msg && <p className="error-text">{msg}</p>}
          </div>
        )}
        {ready && (
          <>
            <div className="dialog-search">
              <div className="search">
                <Search size={15} />
                <input ref={input} value={q} placeholder="Zeichnungen durchsuchen" aria-label="Zeichnungen durchsuchen" onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            <div className="dp-grid">
              {list == null && (
                <div className="lib-wait">
                  <Loader2 size={16} className="spin" /> Lade Zeichnungen …
                </div>
              )}
              {list?.length === 0 && <p className="hint pad">In der Online-Ablage liegen noch keine Zeichnungen. In Draftpad: Menü › Online-Ablage › Speichern.</p>}
              {shown.map((e) => (
                <button key={e.id} className={'dp-tile' + (sel === e.id ? ' on' : '')} onClick={() => setSel(e.id)} onDoubleClick={() => take(e.id)}>
                  <span className="dp-thumb">{e.thumb ? <img src={e.thumb} alt="" /> : <FileUp size={22} />}</span>
                  <b>{e.name ?? e.id}</b>
                  <small>{when(e.updated)}</small>
                </button>
              ))}
            </div>
          </>
        )}
        {!status && (
          <div className="lib-wait pad">
            <Loader2 size={16} className="spin" />
          </div>
        )}
        <div className="dialog-foot">
          {ready && msg && <span className="error-text">{msg}</span>}
          <button className="btn" onClick={onFile} title="Eine .draftpad.json-Datei vom Rechner wählen">
            Datei vom Rechner …
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          {ready && (
            <button className="btn primary" disabled={!sel || busy} onClick={() => take(sel)}>
              {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Übernehmen
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
