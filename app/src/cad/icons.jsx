// Icons der Konstruktion: einheitlich 24 × 24, Linien in Textfarbe, die Wirkung eines Werkzeugs blau hervorgehoben
// (wie in CAD-Programmen üblich: kleiner isometrischer Körper, bearbeitete Fläche/Kante farbig).

const Svg = ({ size = 20, children, title }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} className="cad-ic">
    {title && <title>{title}</title>}
    {children}
  </svg>
)

// Farben über CSS (hell/dunkel): .cad-ic .a = Wirkung, .f = Wirkfläche (halbtransparent), .m = gedämpft
const A = 'a'
const F = 'f'
const M = 'm'

// isometrischer Quader: Oberseite, linke und rechte Seite
const cube = (x = 0, y = 0, s = 1) => {
  const P = (px, py) => `${x + px * s},${y + py * s}`
  return {
    top: `M${P(12, 4)}L${P(20, 8.5)}L${P(12, 13)}L${P(4, 8.5)}Z`,
    left: `M${P(4, 8.5)}L${P(12, 13)}L${P(12, 21)}L${P(4, 16.5)}Z`,
    right: `M${P(12, 13)}L${P(20, 8.5)}L${P(20, 16.5)}L${P(12, 21)}Z`,
  }
}

// --- Bauteil-Werkzeuge -----------------------------------------------------------------------------

export const IcSketch = (p) => (
  <Svg {...p}>
    <path d="M2.5 16.5 11 12l10.5 4.5L13 21z" className={F} />
    <path d="M7 16.2h6.5" className={A} />
    <path d="m15.5 3.5 3 3-7.5 7.5-3.6.6.6-3.6z" />
    <path d="m14 5 3 3" />
  </Svg>
)

export const IcExtrude = (p) => {
  const c = cube(0, 1.5, 1)
  return (
    <Svg {...p}>
      <path d={c.left} />
      <path d={c.right} />
      <path d={c.top} className={F} />
      <path d="M12 9.5V1.5M9.5 4 12 1.5 14.5 4" className={A} />
    </Svg>
  )
}

export const IcRevolve = (p) => (
  <Svg {...p}>
    <path d="M12 1.5v21" strokeDasharray="2 2" className={M} />
    <path d="M12 5h5v3.5h-2.5V14H18v4h-6z" className={F} />
    <path d="M7.2 9.4C4.6 10 3 11 3 12.2c0 2.1 4 3.8 9 3.8" className={A} />
    <path d="m10.4 14.2 1.8 1.8-1.9 1.7" className={A} />
  </Svg>
)

export const IcHole = (p) => {
  const c = cube(0, 0.5, 1)
  return (
    <Svg {...p}>
      <path d={c.left} />
      <path d={c.right} />
      <path d={c.top} />
      <ellipse cx="12" cy="9" rx="3.4" ry="1.9" className={F} />
      <path d="M12 1.5V7" strokeDasharray="1.6 1.6" className={A} />
      <path d="M8.6 9v4.2a3.4 1.9 0 0 0 6.8 0V9" className={A} />
    </Svg>
  )
}

export const IcFillet = (p) => (
  <Svg {...p}>
    <path d="M4 8.5 12 4l8 4.5-8 4.5z" />
    <path d="M4 8.5v8l8 4.5V13" />
    <path d="M12 13v8l4.5-2.5" />
    <path d="M16.5 18.5 20 16.5V12a4 4 0 0 0-3.5-3.97" className={A} />
    <path d="M12 13l4.5-2.6c2 0 3.5 .9 3.5 1.6" className={F} />
  </Svg>
)

export const IcChamfer = (p) => (
  <Svg {...p}>
    <path d="M4 8.5 12 4l5 2.8" />
    <path d="M4 8.5v8l8 4.5V13L4 8.5" />
    <path d="M12 21l8-4.5v-5" />
    <path d="m12 13 5-2.8 3 1.6" />
    <path d="m17 6.8 3 1.7v3.3l-3-1.6z" className={F} />
    <path d="m17 6.8 3 1.7v3.3l-3-1.6z" className={A} fill="none" />
  </Svg>
)

export const IcPattern = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" className={F} />
    <rect x="3" y="3" width="7" height="7" rx="1" className={A} fill="none" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
)

export const IcMirror = (p) => (
  <Svg {...p}>
    <path d="M12 2v20" strokeDasharray="2 2" className={A} />
    <path d="M9.5 6 3 18h6.5z" className={F} />
    <path d="M14.5 6 21 18h-6.5z" />
  </Svg>
)

export const IcShell = (p) => (
  <Svg {...p}>
    <path d="M4 8.5 12 4l8 4.5v8L12 21l-8-4.5z" />
    <path d="M6.5 8.6 12 5.6l5.5 3-5.5 3.1z" className={F} />
    <path d="M6.5 8.6v6.3l5.5 3.2 5.5-3.2V8.6" className={A} />
    <path d="M12 11.7v6.4" className={A} />
  </Svg>
)

export const IcBoolean = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="11" height="11" rx="1.5" />
    <rect x="9.5" y="9.5" width="11" height="11" rx="1.5" className={A} />
    <path d="M9.5 11v3.5h5V9.5H11a1.5 1.5 0 0 0-1.5 1.5z" className={F} />
  </Svg>
)

export const IcMoveBody = (p) => {
  const c = cube(-2, 1, 0.8)
  return (
    <Svg {...p}>
      <path d={c.top} className={F} />
      <path d={c.left} />
      <path d={c.right} />
      <path d="M14 18h7M18.5 15.5 21 18l-2.5 2.5" className={A} />
    </Svg>
  )
}

export const IcImportPart = (p) => {
  const c = cube(0, 3, 0.75)
  return (
    <Svg {...p}>
      <path d={c.top} className={F} />
      <path d={c.left} />
      <path d={c.right} />
      <path d="M18 2.5v7M15.5 7 18 9.5 20.5 7" className={A} />
    </Svg>
  )
}

export const IcAlign = (p) => (
  <Svg {...p}>
    <rect x="3" y="14" width="18" height="6" rx="1" />
    <rect x="7" y="3.5" width="10" height="6" rx="1" className={A} />
    <path d="M12 9.5V14" className={A} strokeDasharray="1.6 1.6" />
    <path d="M10 12l2 2 2-2" className={A} />
  </Svg>
)

export const IcRib = (p) => (
  <Svg {...p}>
    <path d="M3 20h18M3 20V4" />
    <path d="M3 20V4h3v13h15v3z" className={F} />
    <path d="M6 17 18 5M6 13l8-8" className={A} />
  </Svg>
)

export const IcDraft = (p) => (
  <Svg {...p}>
    <path d="M5 20h14" className={M} />
    <path d="M6.5 20 8.5 5h7l2 15" className={A} />
    <path d="M8.5 5v15M15.5 5v15" className={M} strokeDasharray="1.6 1.6" />
    <path d="M12 2.5v4M10.5 4 12 2.5 13.5 4" />
  </Svg>
)

export const IcSweep = (p) => (
  <Svg {...p}>
    <ellipse cx="5.5" cy="17.5" rx="2.5" ry="3" className={F} />
    <path d="M5.5 14.5c4 0 4-9 9-9 2.8 0 4.5 1.6 4.5 3.5" className={A} />
    <path d="M5.5 20.5c5.5 0 6-11 9.5-11 1.5 0 2.5.8 3 1.6" />
    <ellipse cx="19.4" cy="10" rx="1.6" ry="1.1" />
  </Svg>
)

export const IcLoft = (p) => (
  <Svg {...p}>
    <path d="M3 18.5 12 22l9-3.5L12 15z" className={F} />
    <path d="M8 6.5 12 8l4-1.5L12 5z" />
    <path d="M3 18.5 8 6.5M21 18.5l-5-12M12 22V8" className={A} />
  </Svg>
)

export const IcMoveFace = (p) => {
  const c = cube(0, 3, 1)
  return (
    <Svg {...p}>
      <path d={c.left} />
      <path d={c.right} />
      <path d={c.top} className={F} />
      <path d="M12 11V2.5M10 4.5l2-2 2 2M10 8.5l2 2 2-2" className={A} />
    </Svg>
  )
}

export const IcRemoveFace = (p) => {
  const c = cube(0, 1, 1)
  return (
    <Svg {...p}>
      <path d={c.left} />
      <path d={c.right} />
      <path d={c.top} />
      <ellipse cx="12" cy="9.5" rx="3" ry="1.6" strokeDasharray="1.5 1.5" className={A} />
      <path d="m15.5 2.5 3 3M18.5 2.5l-3 3" className={A} />
    </Svg>
  )
}

export const IcDraftpad = (p) => (
  <Svg {...p}>
    <path d="M5 3h9l5 5v13H5z" />
    <path d="M14 3v5h5" />
    <path d="M8 16.5c2-3 3-1 4.5-3s2.5-.5 3.5-1.5" className={A} />
    <path d="M8 12.5h3" className={M} />
  </Svg>
)

export const IcMeasure = (p) => (
  <Svg {...p}>
    <path d="m3 16 13-13 5 5L8 21z" className={F} />
    <path d="m3 16 13-13 5 5L8 21z" fill="none" />
    <path d="m7 12 2 2M10 9l1.5 1.5M13 6l2 2" className={A} />
  </Svg>
)

export const IcSection = (p) => (
  <Svg {...p}>
    <path d="M4 8.5 12 4l8 4.5v8L12 21l-8-4.5z" />
    <path d="M12 4v17" />
    <path d="M12 4l8 4.5v8L12 21z" className={F} />
    <path d="M14 10.5l4-2.2M14 14l4-2.2M14 17.4l4-2.2" className={A} />
  </Svg>
)

// --- Skizzier-Werkzeuge -----------------------------------------------------------------------------

export const IcSelect = (p) => (
  <Svg {...p}>
    <path d="M5 3l13 6.5-5.6 1.5-2.4 5.5z" className={F} />
    <path d="M5 3l13 6.5-5.6 1.5-2.4 5.5z" fill="none" />
    <path d="m13 12.5 5.5 6.5" />
  </Svg>
)

export const IcLine = (p) => (
  <Svg {...p}>
    <path d="M5.5 18.5 18.5 5.5" className={A} />
    <rect x="3" y="16" width="5" height="5" rx="1" className={F} />
    <rect x="16" y="3" width="5" height="5" rx="1" className={F} />
  </Svg>
)

export const IcRect = (p) => (
  <Svg {...p}>
    <rect x="4" y="6" width="16" height="12" className={A} />
    <circle cx="4" cy="6" r="1.6" className={F} />
    <circle cx="20" cy="18" r="1.6" className={F} />
  </Svg>
)

export const IcCircle = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" className={A} />
    <path d="M10 12h4M12 10v4" />
    <path d="M12 12l6 -6" className={M} strokeDasharray="1.6 1.6" />
  </Svg>
)

export const IcArc = (p) => (
  <Svg {...p}>
    <path d="M5 18A11 11 0 0 1 19 5" className={A} />
    <path d="M19 18H5M19 18V5" className={M} strokeDasharray="1.6 1.6" />
    <circle cx="19" cy="18" r="1.4" className={F} />
  </Svg>
)

export const IcRectCenter = (p) => (
  <Svg {...p}>
    <rect x="4" y="6" width="16" height="12" className={A} />
    <path d="M4 6 20 18" className={M} strokeDasharray="1.6 1.6" />
    <circle cx="12" cy="12" r="1.6" className={F} />
    <circle cx="20" cy="18" r="1.6" className={F} />
  </Svg>
)

export const IcSlot = (p) => (
  <Svg {...p}>
    <path d="M8 7.5h8a4.5 4.5 0 0 1 0 9H8a4.5 4.5 0 0 1 0-9z" className={A} />
    <path d="M8 12h8" className={M} strokeDasharray="1.6 1.6" />
    <circle cx="8" cy="12" r="1.3" className={F} />
    <circle cx="16" cy="12" r="1.3" className={F} />
  </Svg>
)

export const IcPolygon = (p) => (
  <Svg {...p}>
    <path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" className={A} />
    <circle cx="12" cy="12" r="8.5" className={M} strokeDasharray="1.6 1.6" />
    <circle cx="12" cy="12" r="1.3" className={F} />
  </Svg>
)

export const IcSketchFillet = (p) => (
  <Svg {...p}>
    <path d="M4 20V11a7 7 0 0 1 7-7h9" className={A} />
    <path d="M4 11V4h7" className={M} strokeDasharray="1.6 1.6" />
    <path d="M9.2 9.2 6.2 6.2" />
  </Svg>
)

export const IcTangentArc = (p) => (
  <Svg {...p}>
    <path d="M3 17h7" />
    <path d="M10 17a6 6 0 0 0 6-6V5" className={A} />
    <circle cx="10" cy="17" r="1.4" className={F} />
    <path d="M10 17h4" className={M} strokeDasharray="1.6 1.6" />
  </Svg>
)

export const IcPoint = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" className={F} />
    <circle cx="12" cy="12" r="3" className={A} fill="none" />
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" className={M} />
  </Svg>
)

export const IcDimension = (p) => (
  <Svg {...p}>
    <path d="M4 5v14M20 5v14" className={M} />
    <path d="M4 12h16M7 9.5 4 12l3 2.5M17 9.5l3 2.5-3 2.5" className={A} />
  </Svg>
)

export const IcExtend = (p) => (
  <Svg {...p}>
    <path d="M20 3v18" />
    <path d="M3 12h8" />
    <path d="M11 12h8M15.5 9l3 3-3 3" className={A} strokeDasharray="0" />
  </Svg>
)

export const IcTrim = (p) => (
  <Svg {...p}>
    <path d="M7 3v18" />
    <path d="M17 3v18" />
    <path d="M2.5 12H7M17 12h4.5" />
    <path d="M7 12h10" className={A} strokeDasharray="2 2" />
    <path d="m10.5 9.5 3 5M13.5 9.5l-3 5" className={A} />
  </Svg>
)

export const IcConstruction = (p) => (
  <Svg {...p}>
    <path d="M4 20 20 4" strokeDasharray="3 2 1 2" className={A} />
  </Svg>
)

export const IcUseEdge = (p) => (
  <Svg {...p}>
    <path d="M3 7.5 12 3l9 4.5" />
    <path d="M3 7.5 12 12l9-4.5" className={A} />
    <path d="M3 17 12 21.5 21 17" strokeDasharray="2 2" className={M} />
    <path d="M12 12v9.5" strokeDasharray="1.5 1.5" className={M} />
  </Svg>
)

export const IcBoxSelect = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" strokeDasharray="2.5 2.5" />
    <path d="M8 16 16 8" className={A} />
  </Svg>
)

export const IcConstraints = (p) => (
  <Svg {...p}>
    <path d="M4 18 15 7M8 20 19 9" />
    <path d="m3 4 3 3M6.5 3.5 9.5 6.5" className={A} />
  </Svg>
)

export const IcLayers = (p) => (
  <Svg {...p}>
    <path d="m12 3 9 4.5-9 4.5-9-4.5z" className={F} />
    <path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" />
  </Svg>
)

export const IcMore = (p) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="1.4" className={F} />
    <circle cx="12" cy="12" r="1.4" className={F} />
    <circle cx="18" cy="12" r="1.4" className={F} />
  </Svg>
)
