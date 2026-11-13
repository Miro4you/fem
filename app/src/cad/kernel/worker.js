// Web Worker: OpenCASCADE (WebAssembly) laden und Feature-Listen aufbauen, ohne die Oberfläche zu blockieren
import opencascade from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import { setOC } from 'replicad'
import { build } from './build.js'

const t0 = performance.now()
const ready = opencascade({ locateFile: () => wasmUrl }).then((oc) => {
  setOC(oc)
  return Math.round(performance.now() - t0)
})

ready.then(
  (ms) => postMessage({ type: 'ready', ms }),
  (e) => postMessage({ type: 'ready', error: String(e?.message ?? e) }),
)

self.onmessage = async ({ data }) => {
  const { id, job } = data
  try {
    await ready
    const r = build(job)
    if (r.stepBlob) {
      r.step_text = await r.stepBlob.text()
      delete r.stepBlob
    }
    postMessage({ id, ok: true, result: r })
  } catch (e) {
    postMessage({ id, ok: false, error: String(e?.message ?? e) })
  }
}
