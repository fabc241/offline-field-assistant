/**
 * Dev-time, online: Microsoft's Paza Whisper (large-v3-turbo fine-tuned for
 * Swahili and five Kenyan languages, MIT) as a whisper.cpp model in models/.
 *
 *   npm run import-paza
 *
 * Downloads the pinned safetensors (3.2 GB, resumable) into var/downloads/,
 * converts it with the stock WHISPER_LARGE_V3_TURBO file as template
 * (scripts/convert-whisper.ts) and adds it to models/manifest.json. The
 * conversion is deterministic, so the output hash is pinned too.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { MODEL_CATALOG } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { ModelStore, sha256File, writeManifest, type ManifestEntry } from '../src/core/model-store.js'
import { convertHfWhisper } from './convert-whisper.js'
import { downloadHttp, withRetries } from './http.js'

const NAME = 'WHISPER_PAZA_LARGE_V3_TURBO'
const REPO = 'microsoft/paza-whisper-large-v3-turbo'
const REVISION = '8a0bd24795b298b2f3678fcd8129c0a1c2b4ee22'
const SOURCE = { file: 'model.safetensors', size: 3_235_607_008, sha256: 'ff577f03b2c568ff0c49ff0a6c69278d996e6a95e7fde439d1dad52a67fa171e' }
const OUTPUT = { file: 'ggml-paza-whisper-large-v3-turbo.bin', sha256: '9cf63caad202736c41b2351f1fc6ee7c644309aa71e570c71b8c2d28039fee14' }

const { modelsDir } = loadConfig()
const store = await ModelStore.open(modelsDir)
const downloads = path.join(PROJECT_ROOT, 'var/downloads/paza-whisper-large-v3-turbo')
const safetensors = path.join(downloads, SOURCE.file)
await fs.mkdir(downloads, { recursive: true })

if ((await fs.stat(safetensors).catch(() => null))?.size !== SOURCE.size) {
  console.log(`↓ ${REPO}@${REVISION.slice(0, 7)} ${SOURCE.file} (${(SOURCE.size / 1e9).toFixed(1)} GB)`)
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${SOURCE.file}`
  await withRetries(SOURCE.file, () => downloadHttp(url, safetensors, SOURCE.size), 20)
}
console.log('  checking sha256…')
if ((await sha256File(safetensors)) !== SOURCE.sha256) {
  throw new Error(`${safetensors}: sha256 mismatch; delete it and run again`)
}

const target = path.join(modelsDir, OUTPUT.file)
const tmp = `${target}.tmp`
console.log(`⚙ converting with ${MODEL_CATALOG.stt} as template`)
const res = await convertHfWhisper({ template: store.resolve(MODEL_CATALOG.stt), safetensors, out: tmp })
const unexpected = res.unused.filter((n) => n !== 'proj_out.weight') // tied to embed_tokens in whisper.cpp
if (unexpected.length) throw new Error(`Unused fine-tune tensors: ${unexpected.join(', ')}`)
console.log(`  ${res.tensors} tensors; cut to the stock vocabulary: ${res.truncated.join(', ') || 'none'}`)

const sha256 = await sha256File(tmp)
if (sha256 !== OUTPUT.sha256) {
  await fs.rm(tmp)
  throw new Error(`Converted file hash ${sha256} differs from the pinned ${OUTPUT.sha256}`)
}
await fs.rename(tmp, target)

const stock = store.entry(MODEL_CATALOG.stt)
const entry: ManifestEntry = {
  name: NAME,
  file: OUTPUT.file,
  size: (await fs.stat(target)).size,
  sha256,
  addon: stock.addon,
  engine: stock.engine,
  source: `hf:${REPO}@${REVISION} (MIT), converted by scripts/import-paza.ts with ${stock.file} as template`
}
const models = [...store.manifest.models.filter((m) => m.name !== NAME), entry].sort((a, b) => a.name.localeCompare(b.name))
await writeManifest(modelsDir, { ...store.manifest, models })
console.log(`✓ ${NAME} → ${target} (sha256 ${sha256})`)
