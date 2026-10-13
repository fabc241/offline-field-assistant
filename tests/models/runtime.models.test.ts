/**
 * Needs downloaded weights (npm run fetch-models). Runs against the real QVAC
 * worker; skips models that are not installed.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { MODEL_CATALOG as M } from '../../src/core/catalog.js'
import { loadConfig } from '../../src/core/config.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown, type ModelSpec } from '../../src/core/qvac.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)

const specs: ModelSpec[] = [
  { name: M.ocrRecognizer, config: { langList: ['en'] }, companions: { detectorModelSrc: M.ocrDetector } },
  { name: M.embedder },
  { name: M.translator, config: { ctx_size: 2048 } },
  { name: M.stt, companions: { vadModelSrc: M.vad } },
  { name: M.ttsT3, config: { ttsEngine: 'chatterbox', language: 'sw' }, companions: { s3genModelSrc: M.ttsS3gen } }
]

const installed = (spec: ModelSpec) => [spec.name, ...Object.values(spec.companions ?? {})].every((n) => store.has(n))

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
})

describe('QvacRuntime with real models', { timeout: 180_000 }, () => {
  for (const spec of specs) {
    it.skipIf(!installed(spec))(`loads ${spec.name} from a local file`, async () => {
      const id = await runtime.use(spec, async (modelId) => modelId)
      expect(typeof id).toBe('string')
      await runtime.unloadAll()
      expect(runtime.loaded()).toHaveLength(0)
    })
  }

  const conversation = specs.slice(2)
  it.skipIf(!conversation.every(installed))('fits the full conversation set (STT + translator + TTS) in the memory budget', async () => {
    for (const spec of conversation) await runtime.use(spec, async () => undefined)
    expect(runtime.loaded()).toHaveLength(3)
  })
})
