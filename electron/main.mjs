/**
 * Headless Electron main process (no window yet).
 *
 * F0: packaging smoke test — proves the QVAC worker starts inside a packaged
 * Electron app and loads a model from a local file. Exits 0 on success.
 * Models dir: $OFA_MODELS_DIR, else ./models next to the app sources.
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { close, loadModel, unloadModel } from '@qvac/sdk'

app.dock?.hide()

async function smoke() {
  const modelsDir = process.env.OFA_MODELS_DIR ?? path.join(app.getAppPath(), 'models')
  const manifest = JSON.parse(fs.readFileSync(path.join(modelsDir, 'manifest.json'), 'utf8'))
  const local = (name) => {
    const entry = manifest.models.find((m) => m.name === name)
    if (!entry) throw new Error(`${name} missing from ${modelsDir}/manifest.json`)
    return { src: path.join(modelsDir, entry.file), engine: entry.engine }
  }

  const recognizer = local('OCR_LATIN')
  const detector = local('OCR_CRAFT')
  const t0 = performance.now()
  const modelId = await loadModel({
    modelSrc: recognizer.src,
    modelType: recognizer.engine,
    modelConfig: { langList: ['en'], detectorModelSrc: detector.src }
  })
  console.log(`[smoke] OCR model loaded in ${Math.round(performance.now() - t0)} ms (electron ${process.versions.electron})`)
  await unloadModel({ modelId, clearStorage: false })
  await close()
}

app
  .whenReady()
  .then(smoke)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('[smoke] FAILED:', err)
    app.exit(1)
  })
