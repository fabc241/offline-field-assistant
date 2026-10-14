/**
 * F2 against the real Whisper model (npm run fetch-models first). Decoding is
 * greedy; assertions check key words rather than exact strings.
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MODEL_CATALOG as M } from '../../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../../src/core/config.js'
import { qvacTranscriber } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const stt = new SpeechToText(qvacTranscriber(runtime))
const installed = store.has(M.stt) && store.has(M.vad)
const fixture = (name: string) => path.join(PROJECT_ROOT, 'tests/fixtures', name)
const SW = fixture('fleurs-sw-1941-quiet.wav')
const EN = fixture('fleurs-en-1953.wav')

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
})

describe.skipIf(!installed)('SpeechToText with real Whisper', { timeout: 120_000 }, () => {
  it('transcribes a quiet Swahili recording', async () => {
    const t = await stt.transcribe(SW, 'sw')
    expect(t.text.toLowerCase()).toMatch(/wanandoa.*mpango.*mtoto/)
    expect(t.flags).toEqual([])
  })

  it('transcribes English', async () => {
    const t = await stt.transcribe(EN, 'en')
    expect(t.text.toLowerCase()).toMatch(/relocated.*hospital.*cambridge/)
    expect(t.realTimeFactor).toBeLessThan(1)
  })

  it('switches language on one loaded model, both ways', async () => {
    const sw = await stt.transcribe(SW, 'sw')
    const en = await stt.transcribe(EN, 'en')
    expect(sw.text.toLowerCase()).toMatch(/wanandoa/)
    expect(en.text.toLowerCase()).toMatch(/hospital/)
    expect(runtime.loaded().filter((m) => m.name === M.stt)).toHaveLength(1)
  })

  it('forcing the wrong language does not produce the right transcript', async () => {
    // Shows the language really is forced: Swahili speech decoded as English comes out different.
    const t = await stt.transcribe(SW, 'en')
    expect(t.text.toLowerCase()).not.toMatch(/wanandoa hawa wanaweza/)
  })

  it('returns no speech for silence and noise instead of inventing text', async () => {
    const noise = Float32Array.from({ length: 48_000 }, () => (Math.random() * 2 - 1) * 0.01)
    for (const audio of [new Float32Array(48_000), noise]) {
      for (const lang of ['en', 'sw'] as const) {
        expect((await stt.transcribe(audio, lang)).flags).toEqual(['no-speech'])
      }
    }
  })
})
