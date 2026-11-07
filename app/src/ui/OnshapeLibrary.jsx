import { useEffect, useRef, useState } from 'react'
import { Loader2, Search, X, Download } from 'lucide-react'
import * as api from '../api.js'
import { IcCloud, IcPart } from './icons.jsx'
import { OnshapeKeys } from './Settings.jsx'
import { addRecent } from '../prefs.js'

// Vorschaubilder einmal je Sitzung holen, höchstens drei gleichzeitig
const thumbCache = new Map()
let running = 0
const waiting = []
function loadThumb(key, args) {
  if (thumbCache.has(key)) return thumbCache.get(key)
  const p = new Promise((resolve) => {
    const go = () => {
      running++
      api
        .onshapeThumbnail(args)
        .then(resolve, () => resolve(null))
        .finally(() => {
          running--
          waiting.shift()?.()
        })
    }
    if (running < 3) go()
    else waiting.push(go)
  })
  thumbCache.set(key, p)
  return p
}

function Thumb({ k, args }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    let stop = false
    if (args) loadThumb(k, args).then((s) => !stop && setSrc(s))
    return () => {
      stop = true
    }
  }, [k]) // eslint-disable-line react-hooks/exhaustive-deps
  return <span className="thumb">{src ? <img src={src} alt="" /> : <IcPart size={16} />}</span>
}

const date = (s) => {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Onshape-Bibliothek: eigene Dokumente durchblättern, Teilestudio wählen, holen
export default function OnshapeLibrary({ onClose, onError }) {
  const [keys, setKeys] = useState(null) // null = prüfen, true/false
  const [q, setQ] = useState('')
  const [docs, setDocs] = useState(null)
  const [doc, setDoc] = useState(null)
  const [els, setEls] = useState(null)
  const [el, setEl] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const [url, setUrl] = useState('')
  const [usage, setUsage] = useState(null)
  const [fresh, setFresh] = useState(0)
  const input = useRef(null)

  useEffect(() => {
    api
      .cadInfo()
      .then((i) => {
        setKeys(!!i.onshape)
        setUsage(i.onshapeUsage ?? null)
      })
      .catch(() => setKeys(false))
  }, [])

  // Dokumente laden (Suche verzögert)
  useEffect(() => {
    if (!keys) return
    // Suche erst ab 2 Zeichen – jede Abfrage zählt bei Onshape
    if (q.trim().length === 1) return
    let stop = false
    const t = setTimeout(
      async () => {
        setMsg(null)
        try {
          const d = await api.onshapeDocuments(q, fresh > 0)
          if (stop) return
          setDocs(d)
          if (!doc && d.length) pickDoc(d[0])
        } catch (e) {
          if (!stop) setMsg(String(e))
          if (!stop) setDocs([])
        }
      },
      q ? 700 : 0,
    )
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [keys, q, fresh]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (keys) input.current?.focus()
  }, [keys])

  async function pickDoc(d) {
    setDoc(d)
    setEls(null)
    setEl(null)
    try {
      const list = await api.onshapeElements(d.id, d.workspace)
      setEls(list)
      setEl(list.find((x) => x.kind === 'PARTSTUDIO') ?? list[0] ?? null)
    } catch (e) {
      setMsg(String(e))
      setEls([])
    }
  }

  async function fetchPart(target, name, thumb) {
    setBusy('Hole Teilestudio aus Onshape …')
    setMsg(null)
    try {
      const inc = await api.onshapeImport(target)
      addRecent({ kind: 'onshape', path: target, name: inc?.name ?? name, thumb: thumb ?? null })
      onClose()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog library" role="dialog" aria-label="Aus Onshape holen">
        <div className="dialog-head">
          <IcCloud size={20} />
          <b>Aus Onshape holen</b>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">
            <X size={16} />
          </button>
        </div>
        {keys === false && (
          <div className="dialog-body">
            <p className="hint">
              Damit Projekt-FEM deine Dokumente sehen und Teilestudios als STEP holen kann, braucht es einmalig einen API-Schlüssel von Onshape. Er bleibt
              auf dem rechnenden Rechner.
            </p>
            <OnshapeKeys onSaved={(ok) => setKeys(ok)} onError={onError} />
          </div>
        )}
        {keys && (
          <>
            <div className="dialog-search">
              <div className="search">
                <Search size={15} />
                <input ref={input} value={q} placeholder="Dokumente durchsuchen" aria-label="Dokumente durchsuchen" onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            <div className="lib-cols">
              <div className="lib-docs">
                <div className="lib-head row">
                  <span className="grow">{q ? 'Suchergebnis' : 'Zuletzt geändert'}</span>
                  <button className="link" title="Liste neu von Onshape holen (sonst bis zu 10 min zwischengespeichert)" onClick={() => setFresh(fresh + 1)}>
                    aktualisieren
                  </button>
                </div>
                {docs == null && (
                  <div className="lib-wait">
                    <Loader2 size={16} className="spin" /> Lade Dokumente …
                  </div>
                )}
                {docs?.length === 0 && <p className="hint pad">Keine Dokumente gefunden.</p>}
                {docs?.map((d) => (
                  <button key={d.id} className={'doc' + (doc?.id === d.id ? ' on' : '')} onClick={() => pickDoc(d)}>
                    <Thumb k={'d' + d.id} args={d.thumbnail ? { href: d.thumbnail, did: d.id, wid: d.workspace } : null} />
                    <span className="doc-text">
                      <b>{d.name}</b>
                      <small>
                        {date(d.modified)}
                        {d.owner ? ` · ${d.owner}` : ''}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <div className="lib-els">
                {doc ? (
                  <>
                    <b className="lib-doc">{doc.name}</b>
                    {els == null && (
                      <div className="lib-wait">
                        <Loader2 size={16} className="spin" /> Lade Teilestudios …
                      </div>
                    )}
                    {els?.length === 0 && <p className="hint">Keine Teilestudios oder Baugruppen in diesem Dokument.</p>}
                    {els?.map((x) => (
                      <button
                        key={x.id}
                        className={'doc' + (el?.id === x.id ? ' on' : '')}
                        title={x.kind === 'ASSEMBLY' ? 'Baugruppe: jedes Teil wird ein Körper (Werkstoff je Körper, Teile an Berührflächen verbunden)' : ''}
                        onClick={() => setEl(x)}
                        onDoubleClick={() => fetchPart(x.url, `${doc.name} - ${x.name}`)}
                      >
                        <span className="thumb">
                          <IcPart size={16} />
                        </span>
                        <span className="doc-text">
                          <b>{x.name}</b>
                          <small>{x.kind === 'PARTSTUDIO' ? 'Teilestudio' : 'Baugruppe'}</small>
                        </span>
                      </button>
                    ))}
                  </>
                ) : (
                  <p className="hint">Links ein Dokument wählen.</p>
                )}
                <span className="spacer" />
                {msg && <p className="error-text">{msg}</p>}
                <div className="row end">
                  <button className="btn" onClick={onClose}>
                    Abbrechen
                  </button>
                  <button
                    className="btn primary"
                    disabled={!el || !!busy}
                    onClick={async () => fetchPart(el.url, `${doc.name} - ${el.name}`, await thumbCache.get('d' + doc.id))}
                  >
                    {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {busy ? 'Hole …' : 'Holen'}
                  </button>
                </div>
              </div>
            </div>
            <div className="dialog-foot">
              {usage && (
                <span className="hint" title={`Seit ${usage.since}: ${usage.total} Aufrufe insgesamt. Kostenlose Onshape-Konten haben 2500 im Jahr.`}>
                  {usage.year_count} Onshape-Aufrufe {usage.year} ·
                </span>
              )}
              <span className="hint">oder Adresse einfügen:</span>
              <input value={url} placeholder="https://cad.onshape.com/documents/…" onChange={(e) => setUrl(e.target.value)} />
              <button className="btn" disabled={!url.trim() || !!busy} onClick={() => fetchPart(url.trim(), 'Onshape')}>
                Holen
              </button>
            </div>
          </>
        )}
        {keys === null && (
          <div className="lib-wait pad">
            <Loader2 size={16} className="spin" />
          </div>
        )}
      </div>
    </div>
  )
}
