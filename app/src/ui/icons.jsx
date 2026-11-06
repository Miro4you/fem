// Eigene Symbole (Lagerarten, Lastarten, Werkzeugleiste) – technische Zeichen wie im Maschinenbau üblich
const S = ({ size = 24, sw = 1.6, children, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    {children}
  </svg>
)

// --- Lager ---
export const IcFixed = (p) => (
  <S {...p}>
    <path d="M6 4v16" />
    <path d="M6 6 3.5 8.5M6 10 3.5 12.5M6 14 3.5 16.5M6 18 3.5 20.5" />
    <rect x="6" y="10" width="14" height="4" rx="1" />
  </S>
)
export const IcSlide = (p) => (
  <S {...p}>
    <path d="M12 6 7.5 13.5h9Z" />
    <circle cx="9.5" cy="16" r="1.4" />
    <circle cx="14.5" cy="16" r="1.4" />
    <path d="M4 18.5h16" />
    <path d="M6 18.5 4.5 21M10 18.5 8.5 21M14 18.5 12.5 21M18 18.5 16.5 21" />
  </S>
)
export const IcPin = (p) => (
  <S {...p}>
    <circle cx="12" cy="7" r="2.6" />
    <path d="M10.6 9.2 7 16h10l-3.6-6.8" />
    <path d="M4 16h16" />
    <path d="M6 16 4.5 18.5M10 16 8.5 18.5M14 16 12.5 18.5M18 16 16.5 18.5" />
  </S>
)
export const IcAxes = (p) => (
  <S {...p}>
    <path d="M6 18V5" />
    <path d="M6 18h13" />
    <path d="m3.5 7.5 2.5-2.5 2.5 2.5" />
    <path d="m16.5 15.5 2.5 2.5-2.5 2.5" />
    <path d="m6 18-3 3" />
    <rect x="12" y="7" width="6" height="5" rx="1" />
    <path d="M13.5 7V5.5a1.5 1.5 0 0 1 3 0V7" />
  </S>
)

// --- Lasten ---
export const IcForce = (p) => (
  <S {...p}>
    <path d="M4 20h16" />
    <path d="M12 3v13" />
    <path d="m8 12 4 4 4-4" />
  </S>
)
export const IcPressure = (p) => (
  <S {...p}>
    <path d="M3 20h18" />
    <path d="M6 5v10M12 5v10M18 5v10" />
    <path d="m4.5 13 1.5 2 1.5-2M10.5 13l1.5 2 1.5-2M16.5 13l1.5 2 1.5-2" />
  </S>
)
export const IcMoment = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="1.5" />
    <path d="M19 12a7 7 0 1 1-2.05-4.95" />
    <path d="M17.2 3.2v3.9h-3.9" />
  </S>
)
export const IcBearing = (p) => (
  <S {...p}>
    <circle cx="12" cy="15" r="5.5" />
    <path d="M12 2v8" />
    <path d="m9 7 3 3 3-3" />
  </S>
)
export const IcWind = (p) => (
  <S {...p}>
    <path d="M3 8h11a3 3 0 1 0-3-3" />
    <path d="M3 16h15a3 3 0 1 1-3 3" />
    <path d="M3 12h8" />
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
