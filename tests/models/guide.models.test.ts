/**
 * F7 against the real EmbeddingGemma, Whisper and Chatterbox (npm run
 * fetch-models first): the guide on the signed sample pack, typed and spoken.
 * Queries come from the tuning set (eval/datasets/guide-dev.csv), not the eval set.
 */
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MODEL_CATALOG as M, MODEL_SPECS } from '../../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../../src/core/config.js'
import { qvacEmbedder, qvacSpeaker, qvacTranscriber } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { SPEECH_SAMPLE_RATE, resample } from '../../src/core/audio.js'
import { Guide, type GuideResult } from '../../src/features/guide/guide.js'
import { buildPack, signPack } from '../../src/features/packs/build.js'
import { PackLoader } from '../../src/features/packs/loader.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../../src/features/packs/signing.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'
import { ReadAloud } from '../../src/features/voice/read-aloud.js'
import { speakerSpecs } from '../../src/features/voice/voices.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const spec = MODEL_SPECS.embedder
const installed = [spec.name, M.stt, M.vad, M.ttsT3, M.ttsS3gen].every((n) => store.has(n))

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
})

const top = (r: GuideResult) => (r.status === 'match' ? r.hits[0].card.id : undefined)

describe.skipIf(!installed)('guide with real EmbeddingGemma and Whisper', { timeout: 180_000 }, () => {
  let guide: Guide
  beforeAll(async () => {
    const embedder = qvacEmbedder(runtime, spec)
    const built = await buildPack(path.join(PROJECT_ROOT, 'content/sample'), { embedder, embeddingModel: { name: spec.name, sha256: store.entry(spec.name).sha256 } })
    const key = generateSigningKey()
    const pack = await new PackLoader({ trustedKeys: [trustedKey('test', key.publicKeyPem)] }).verifyAndLoad(signPack(built.bytes, loadPrivateKey(key.privateKeyPem)).bytes)
    guide = new Guide(pack, { embedder, speech: new SpeechToText(qvacTranscriber(runtime, MODEL_SPECS.stt)) })
  }, 120_000)

  it('finds the card for typed questions in both languages, danger signs first', async () => {
    const dehydration = await guide.search('what are the danger signs for dehydration in a child', 'en')
    expect(dehydration).toMatchObject({ status: 'match', mode: 'hybrid' })
    expect(top(dehydration)).toBe('dehydration-child')
    if (dehydration.status === 'match') expect(dehydration.hits[0].card.dangerSigns[0]).toBe('Very sleepy or hard to wake')
    // Meaning alone ranks malnutrition first here; the keywords carry it.
    expect(top(await guide.search('mtoto ana homa na kutapika', 'sw'))).toBe('fever-child')
    expect(top(await guide.search('adult with loose stools for 4 days', 'en'))).toBe('diarrhoea-adult')
    expect(top(await guide.search('my baby has a high temperature', 'en'))).toBe('fever-child')
  })

  it('answers "no match — see a clinician" outside the pack', async () => {
    for (const [query, lang] of [['dog bite', 'en'], ['how do I change a tyre', 'en'], ['bei ya mbolea', 'sw'], ['mguu umevunjika', 'sw']] as const) {
      expect(await guide.search(query, lang), query).toMatchObject({ status: 'no-match' })
    }
  })

  it('answers a spoken question: Chatterbox reads it, Whisper hears it, the guide finds the card', async () => {
    const reader = new ReadAloud(qvacSpeaker(runtime, await speakerSpecs({})))
    const speech = await reader.speak('My child has a fever and a stiff neck.', 'en')
    const { transcript, result } = await guide.searchByVoice(resample(speech.samples, speech.sampleRate, SPEECH_SAMPLE_RATE), 'en')
    expect(transcript.text.toLowerCase()).toContain('stiff neck')
    expect(top(result)).toBe('fever-child')
  })
})
