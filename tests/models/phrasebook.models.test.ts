/**
 * F6 against the real Chatterbox and Whisper models (npm run fetch-models
 * first): placeholder recordings are reproducible and say their phrase, and
 * the phrasebook plays the shipped ones as they are.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SPEECH_SAMPLE_RATE, decodeWav, resample, toSpeechInput } from '../../src/core/audio.js'
import { MODEL_CATALOG as M, ttsSpec } from '../../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../../src/core/config.js'
import { qvacSpeaker, qvacTranscriber, type Embedder } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { buildPack, signPack } from '../../src/features/packs/build.js'
import { readPackSource } from '../../src/features/packs/content.js'
import { PackLoader } from '../../src/features/packs/loader.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../../src/features/packs/signing.js'
import { Phrasebook } from '../../src/features/phrasebook/phrasebook.js'
import { MAX_CER, makePlaceholderRecordings } from '../../src/features/phrasebook/placeholders.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'
import { ReadAloud } from '../../src/features/voice/read-aloud.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const stt = new SpeechToText(qvacTranscriber(runtime))
const installed = [M.ttsT3, M.ttsS3gen, M.stt, M.vad].every((n) => store.has(n))
const SAMPLE = path.join(PROJECT_ROOT, 'content/sample')

/** Card vectors play no part here. */
const flat: Embedder = { embed: async (texts) => texts.map(() => [1, 0]) }

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
})

describe.skipIf(!installed)('phrasebook with real Chatterbox and Whisper', { timeout: 180_000 }, () => {
  it('renders the same placeholders as the shipped ones, bit for bit, including a take chosen by ear', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-phrase-models-'))
    try {
      // inst-wait: the default English take says the phrase twice, so another seed is kept.
      await fs.writeFile(
        path.join(dir, 'phrases.csv'),
        'id,category,en,sw,audio_en,audio_sw,vetted_by\n' +
          'sym-fever,symptoms,Do you have a fever?,Una homa?,,,PLACEHOLDER\n' +
          'inst-wait,instructions,Please wait here.,Tafadhali subiri hapa.,,,PLACEHOLDER\n'
      )
      const report = await makePlaceholderRecordings(dir, {
        engine: M.ttsT3,
        readerFor: (seed) => new ReadAloud(qvacSpeaker(runtime, (lang) => ttsSpec(lang, { seed }))),
        listen: async (speech) => (await stt.transcribe(resample(speech.samples, speech.sampleRate, SPEECH_SAMPLE_RATE), speech.lang)).text
      })
      expect(report.made.find((m) => m.id === 'inst-wait' && m.lang === 'en')).toMatchObject({ takes: 2, seed: 1, heard: 'Please wait here.' })
      for (const name of ['sym-fever.en', 'sym-fever.sw', 'inst-wait.en', 'inst-wait.sw']) {
        const ours = await fs.readFile(path.join(dir, `recordings/${name}.wav`))
        expect(ours.equals(await fs.readFile(path.join(SAMPLE, `recordings/${name}.wav`))), name).toBe(true)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('plays the shipped recordings unchanged, and Whisper hears each English one say its phrase', async () => {
    const built = await buildPack(SAMPLE, { embedder: flat, embeddingModel: { name: 'none', sha256: '0'.repeat(64) } })
    const key = generateSigningKey()
    const pack = signPack(built.bytes, loadPrivateKey(key.privateKeyPem)).bytes
    const book = new Phrasebook(await new PackLoader({ trustedKeys: [trustedKey('test', key.publicKeyPem)] }).verifyAndLoad(pack))
    const { audio } = await readPackSource(SAMPLE)

    for (const id of ['sym-fever', 'hist-pregnant', 'inst-drink']) {
      const wav = book.recording(id, 'en')
      expect(Buffer.from(wav).equals(await fs.readFile(audio.get(book.audioPath(id, 'en'))!.file))).toBe(true)
      const heard = await stt.transcribe(toSpeechInput(decodeWav(wav)), 'en')
      const words = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '')
      expect(words(heard.text), id).toBe(words(book.get(id)!.text.en))
    }
    // Swahili Chatterbox is harder for Whisper (F3). The generator kept each take only once
    // Whisper heard it within MAX_CER; that check holds on the shipped bytes.
    for (const id of ['sym-fever', 'hist-vaccines', 'inst-wait']) {
      const record = audio.get(book.audioPath(id, 'sw'))!.synthetic!
      const sw = await stt.transcribe(toSpeechInput(decodeWav(book.recording(id, 'sw'))), 'sw')
      expect(sw.text, id).toBe(record.heard)
      expect(record.cer!, id).toBeLessThanOrEqual(MAX_CER.sw)
    }
  })
})
