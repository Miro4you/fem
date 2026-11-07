// Eigene Symbole (Lagerarten, Lastarten, Werkzeugleiste) – technische Zeichen wie im Maschinenbau üblich
const S = ({ size = 24, sw = 1.6, children, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    {children}
  </svg>
)

// --- Lager (Bauteil leicht gefüllt, daran das technische Zeichen) ---
const body = { fill: 'currentColor', fillOpacity: 0.18 }
export const IcFixed = (p) => (
  <S {...p}>
    <path d="M5 3v18" />
    <path d="M5 5.5 2.5 8M5 9.5 2.5 12M5 13.5 2.5 16M5 17.5 2.5 20" opacity=".7" />
    <rect x="5" y="8" width="15" height="8" rx="1.5" {...body} />
  </S>
)
export const IcSlide = (p) => (
  <S {...p}>
    <rect x="4" y="5" width="16" height="7" rx="1.5" {...body} />
    <circle cx="8" cy="14.6" r="2" />
    <circle cx="16" cy="14.6" r="2" />
    <path d="M3 17.6h18" />
    <path d="M5 17.6 3.5 20M9 17.6 7.5 20M13 17.6 11.5 20M17 17.6 15.5 20M21 17.6 19.5 20" opacity=".7" />
  </S>
)
export const IcPin = (p) => (
  <S {...p}>
    <path d="M4 21V12a8 8 0 0 1 16 0v9" {...body} />
    <circle cx="12" cy="12" r="3.6" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
  </S>
)
export const IcAxes = (p) => (
  <S {...p}>
    <rect x="3.5" y="10" width="11" height="10" rx="1.5" {...body} />
    <path d="M9 15V3.5" />
    <path d="m6.8 5.7 2.2-2.2 2.2 2.2" />
    <path d="M9 15h11.5" />
    <path d="m18.3 12.8 2.2 2.2-2.2 2.2" />
    <path d="M14.5 2.8h6v4.8h-6z" fill="currentColor" fillOpacity=".9" stroke="none" />
    <path d="M15.8 2.8V1.9a1.7 1.7 0 0 1 3.4 0v.9" />
  </S>
)

// --- Lasten ---
export const IcForce = (p) => (
  <S {...p}>
    <rect x="3" y="15" width="18" height="6" rx="1.5" {...body} />
    <path d="M12 2.5v10" />
    <path d="m8 9 4 4.2L16 9" />
  </S>
)
export const IcPressure = (p) => (
  <S {...p}>
    <rect x="3" y="16" width="18" height="5" rx="1.5" {...body} />
    <path d="M6 3v9.5M12 3v9.5M18 3v9.5" />
    <path d="m4.3 10.8 1.7 2.2 1.7-2.2M10.3 10.8 12 13l1.7-2.2M16.3 10.8 18 13l1.7-2.2" />
    <path d="M4 3h16" opacity=".55" />
  </S>
)
export const IcMoment = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="4" {...body} />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M17.8 2.6v4.4h-4.4" />
  </S>
)
// Bolzen drückt auf die untere Lochhälfte (Lochleibung)
export const IcBearing = (p) => (
  <S {...p}>
    <path d="M3 21v-8a9 9 0 0 1 18 0v8z" {...body} />
    <circle cx="12" cy="13" r="4.4" />
    <circle cx="12" cy="14.2" r="2.6" fill="currentColor" fillOpacity=".55" />
    <path d="M12 1.5v6" />
    <path d="m9.7 5.3 2.3 2.3 2.3-2.3" />
    <path d="M16.9 16.1l1.5.8M12 18.9v1.7M7.1 16.1l-1.5.8" opacity=".75" />
  </S>
)

// --- Richtung ---
export const IcNormal = (p) => (
  <S sw={2} size={18} {...p}>
    <path d="M4 20h16" />
    <path d="M12 3v13" />
    <path d="m8 12 4 4 4-4" />
  </S>
)
export const IcFlip = (p) => (
  <S sw={2} size={18} {...p}>
    <path d="m21 16-4 4-4-4" />
    <path d="M17 20V4" />
    <path d="m3 8 4-4 4 4" />
    <path d="M7 4v16" />
  </S>
)
export const IcDrag = (p) => (
  <S sw={2} size={18} {...p}>
    <path d="M5 9l-3 3 3 3" />
    <path d="M9 5l3-3 3 3" />
    <path d="M15 19l-3 3-3-3" />
    <path d="M19 9l3 3-3 3" />
    <path d="M2 12h20" />
    <path d="M12 2v20" />
  </S>
)
export const IcFacePick = (p) => (
  <S sw={2} size={18} {...p}>
    <path d="M3 17 12 21l9-4-9-4Z" />
    <path d="M12 3v8" />
    <path d="m9 8 3 3 3-3" />
  </S>
)

// --- Werkzeugleiste und Baum ---
export const IcPart = (p) => (
  <S sw={1.8} {...p}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </S>
)
export const IcWrench = (p) => (
  <S sw={1.8} {...p}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </S>
)
export const IcFeather = (p) => (
  <S sw={1.8} {...p}>
    <path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z" />
    <path d="M16 8 2 22" />
    <path d="M17.5 15H9" />
  </S>
)
export const IcChart = (p) => (
  <S sw={1.8} {...p}>
    <path d="M3 3v18h18" />
    <path d="m19 9-5 5-4-4-3 3" />
  </S>
)
export const IcTruss = (p) => (
  <S sw={1.8} {...p}>
    <path d="M3 20h18" />
    <path d="M5 20 12 6l7 14" />
    <path d="M8.5 13h7" />
  </S>
)
export const IcMaterial = (p) => (
  <S sw={1.8} {...p}>
    <path d="m12 2 10 5-10 5L2 7Z" />
    <path d="m2 17 10 5 10-5" />
    <path d="m2 12 10 5 10-5" />
  </S>
)
export const IcMesh = (p) => (
  <S sw={1.8} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </S>
)
export const IcSupportTree = (p) => (
  <S sw={1.8} {...p}>
    <path d="M12 22V8" />
    <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
    <circle cx="12" cy="5" r="3" />
  </S>
)
export const IcLink = (p) => (
  <S sw={1.8} {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </S>
)
export const IcSplit = (p) => (
  <S sw={2} size={15} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 14 21 8" />
  </S>
)
export const IcSliders = (p) => (
  <S sw={2} size={18} {...p}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" />
  </S>
)
export const IcCut = (p) => (
  <S sw={2} size={15} {...p}>
    <circle cx="6" cy="6" r="3" />
    <path d="M8.12 8.12 12 12" />
    <path d="M20 4 8.12 15.88" />
    <circle cx="6" cy="18" r="3" />
    <path d="M14.8 14.8 20 20" />
  </S>
)
export const IcIso = (p) => (
  <S sw={2} size={15} {...p}>
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </S>
)
export const IcProbe = (p) => (
  <S sw={2} size={15} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" />
  </S>
)
export const IcHome = (p) => (
  <S sw={2} size={15} {...p}>
    <path d="m3 10 9-7 9 7" />
    <path d="M5 9v11h14V9" />
  </S>
)
export const IcFit = (p) => (
  <S sw={2} size={15} {...p}>
    <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
  </S>
)
export const IcCloud = (p) => (
  <S sw={1.8} {...p}>
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </S>
)
export const IcFileUp = (p) => (
  <S sw={1.8} {...p}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M12 12v6" />
    <path d="m15 15-3-3-3 3" />
  </S>
)
export const IcFolder = (p) => (
  <S sw={1.8} {...p}>
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </S>
)
export const IcPlay = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <polygon points="6 3 20 12 6 21 6 3" />
  </svg>
)
export const IcPause = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
)
export const IcTrackpad = (p) => (
  <S sw={1.8} size={22} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
  </S>
)
export const IcMouse = (p) => (
  <S sw={1.8} size={22} {...p}>
    <rect x="6" y="3" width="12" height="18" rx="6" />
    <path d="M12 7v4" />
  </S>
)
