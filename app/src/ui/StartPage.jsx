import { useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { IcFileUp, IcCloud, IcFolder, IcTruss, IcPart, IcWrench } from './icons.jsx'
import { usePref, savePref } from '../prefs.js'

const KIND_TEXT = { step: 'STEP-Datei', project: 'Projekt', onshape: 'Onshape' }

function ago(t) {
  const d = (Date.now() - t) / 1000
  if (d < 90) return 'gerade eben'
  if (d < 3600) return `vor ${Math.round(d / 60)} min`
  const day = new Date(t)
  const today = new Date()
  if (day.toDateString() === today.toDateString()) return 'heute ' + day.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  return day.toLocaleDateString('de-DE')
}

// Startseite: Teil öffnen (Datei, Onshape, Projekt) oder Stabwerk; zuletzt geöffnet
export default function StartPage({ gmsh, onOpenStep, onOnshape, onProject, onFrame, onNewPart, onDraftpad, onRecent, onDropFile, current, onBack }) {
  const [recent] = usePref('recent', [])
  const [drag, setDrag] = useState(false)
  return (
    <main
      className={'start' + (drag ? ' drag' : '')}
      onDragOver={(e) => {
        if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
          e.preventDefault()
          setDrag(true)
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        const f = e.dataTransfer?.files?.[0]
        if (f) onDropFile(f)
      }}
    >
      <div className="start-inner">
        <div>
          <h1>Was möchtest du rechnen?</h1>
          <p className="start-sub">Teil öffnen, Lager und Lasten setzen, rechnen – Spannungen, Verformung und Sicherheit.</p>
        </div>
        {current && (
          <button className="btn back" onClick={onBack}>
            ← Zurück zu „{current}“
          </button>
        )}
        {gmsh === null && (
          <div className="notice warn">
            <TriangleAlert size={16} />
            <div>
              Gmsh wurde nicht gefunden. Installieren mit <code>uv tool install gmsh</code> (Linux/Mac) oder <code>brew install gmsh</code> (Mac),
              dann Projekt-FEM neu starten. Ohne Gmsh lassen sich keine STEP-Dateien vernetzen (Stabwerke gehen trotzdem).
            </div>
          </div>
        )}
        <div className="tiles">
          <button className="tile" onClick={onOpenStep} disabled={gmsh === null}>
            <IcFileUp size={26} />
            <b>STEP-Datei öffnen</b>
            <span>Oder die Datei einfach hierher ziehen.</span>
          </button>
          <button className="tile" onClick={onOnshape} disabled={gmsh === null}>
            <IcCloud size={26} />
            <b>Aus Onshape</b>
            <span>Deine Dokumente durchblättern und ein Teilestudio holen.</span>
          </button>
          <button className="tile" onClick={onProject} disabled={gmsh === null}>
            <IcFolder size={26} />
            <b>Projekt öffnen</b>
            <span>Gespeicherte Rechnung (.fem.json) weiterbearbeiten.</span>
          </button>
          <button className="tile cad-new" onClick={onNewPart} disabled={gmsh === null}>
            <IcWrench size={26} />
            <b>Neues Teil konstruieren</b>
            <span>Skizzieren, bemaßen, extrudieren – direkt hier, ohne anderes CAD.</span>
          </button>
          <button className="tile cad-new" onClick={onDraftpad} disabled={gmsh === null}>
            <IcFileUp size={26} />
            <b>Aus Draftpad</b>
            <span>Skizze aus der Draftpad-Ablage holen, Teile anlegen, nachrechnen.</span>
          </button>
          <button className="tile" onClick={onFrame}>
            <IcTruss size={26} />
            <b>Stabwerk</b>
            <span>Balken, Rahmen und Fachwerke ohne CAD-Teil.</span>
          </button>
        </div>
        {recent.length > 0 && (
          <div>
            <h2 className="start-h2">Zuletzt geöffnet</h2>
            <div className="card recent">
              {recent.map((r) => (
                <div key={r.kind + r.path} className="doc-row">
                  <button className="doc" onClick={() => onRecent(r)} disabled={gmsh === null}>
                    <span className="thumb">{r.thumb ? <img src={r.thumb} alt="" /> : <IcPart size={18} />}</span>
                    <span className="doc-text">
                      <b>{r.name}</b>
                      <small>
                        {KIND_TEXT[r.kind] ?? r.kind} · {ago(r.at)}
                        {r.info ? ` · ${r.info}` : ''}
                      </small>
                    </span>
                  </button>
                  <button
                    className="icon-btn"
                    title="Aus der Liste entfernen"
                    onClick={() => savePref('recent', recent.filter((x) => !(x.kind === r.kind && x.path === r.path)))}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="hint">
          Teile direkt aus dem CAD schicken (Knopf „In Projekt-FEM rechnen“): Einstellungen › CAD-Verbindungen. Onshape, SolidWorks, Fusion, NX, Solid
          Edge und SolidCraft.
        </p>
      </div>
    </main>
  )
}
