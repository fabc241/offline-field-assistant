/**
 * Dev-time, online: downloads the app's models into models/ and writes
 * models/manifest.json. The app itself never downloads.
 *
 *   npm run fetch-models                     # every model in the catalog
 *   npm run fetch-models -- --only OCR_LATIN,VAD_SILERO_5_1_2
 *
 * Smallest models first; the manifest is saved after each model and
 * interrupted Hugging Face downloads resume from their .part file.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ALL_MODEL_NAMES } from '../src/core/catalog.js'
import { loadConfig } from '../src/core/config.js'
import { ModelStore, sha256File, writeManifest, type ManifestEntry } from '../src/core/model-store.js'
import { downloadRegistryModel, registryModel, sdkVersion } from '../src/core/qvac.js'
import { downloadHttp, progress, withRetries } from './http.js'

const { values } = parseArgs({ options: { only: { type: 'string' } } })
const names = values.only ? values.only.split(',').map((s) => s.trim()) : ALL_MODEL_NAMES

const { modelsDir } = loadConfig()
await fs.mkdir(modelsDir, { recursive: true })
const existing = await ModelStore.open(modelsDir)
const entries = new Map(existing.manifest.models.map((m) => [m.name, m]))
const version = await sdkVersion()

const metas = (await Promise.all(names.map(registryModel))).sort((a, b) => a.expectedSize - b.expectedSize)

for (const meta of metas) {
  const { name } = meta
  const target = path.join(modelsDir, meta.modelId)
  const entry: ManifestEntry = {
    name,
    file: meta.modelId,
    size: meta.expectedSize,
    sha256: meta.sha256Checksum,
    addon: meta.addon,
    engine: meta.engine
  }

  const stat = await fs.stat(target).catch(() => null)
  if (stat?.size === entry.size && entries.get(name)?.sha256 === entry.sha256) {
    console.log(`✓ ${name} already present`)
    continue
  }

  console.log(`↓ ${name} (${(entry.size / 1e6).toFixed(0)} MB, ${meta.registrySource})`)
  await fs.rm(target, { force: true })
  if (meta.registrySource === 'hf') {
    // The registry pins these to a Hugging Face commit; fetching that URL
    // directly is more reliable than the registry relay for multi-GB files.
    await withRetries(name, () => downloadHttp(`https://huggingface.co/${meta.registryPath}`, target, entry.size))
  } else {
    const cached = await withRetries(name, () => downloadRegistryModel(name, progress(entry.size)))
    const source = cached.find((p) => path.basename(p) === meta.modelId) ?? cached[0]
    if (!source) throw new Error(`${name}: download finished but no cached file was reported`)
    // Hard link avoids a second copy when the SDK cache and project share a volume.
    await fs.link(source, target).catch(() => fs.copyFile(source, target))
  }

  const actual = await sha256File(target)
  if (actual !== entry.sha256) {
    await fs.rm(target, { force: true })
    throw new Error(`${name}: sha256 mismatch (expected ${entry.sha256}, got ${actual})`)
  }
  entries.set(name, entry)
  await saveManifest()
  console.log(`✓ ${name} verified`)
}

await saveManifest()
console.log(`Manifest written to ${path.join(modelsDir, 'manifest.json')}`)
process.exit(0)

async function saveManifest() {
  await writeManifest(modelsDir, {
    sdkVersion: version,
    createdAt: new Date().toISOString(),
    models: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
}
