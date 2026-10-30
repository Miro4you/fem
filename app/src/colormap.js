import * as THREE from 'three'

export const BANDS = 9

// Klassische FEM-Farbskala: blau (niedrig) → rot (hoch), in festen Bändern
export function bandColor(i, bands = BANDS) {
  const t = bands === 1 ? 1 : i / (bands - 1)
  return new THREE.Color().setHSL(((1 - t) * 240) / 360, 0.85, 0.5, THREE.SRGBColorSpace)
}

export function bandTexture(bands = BANDS) {
  const data = new Uint8Array(bands * 4)
  const rgb = { r: 0, g: 0, b: 0 }
  for (let i = 0; i < bands; i++) {
    bandColor(i, bands).getRGB(rgb, THREE.SRGBColorSpace)
    data.set([Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255), 255], i * 4)
  }
  const tex = new THREE.DataTexture(data, bands, 1, THREE.RGBAFormat)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export function cssBandColor(i, bands = BANDS) {
  return '#' + bandColor(i, bands).getHexString()
}
