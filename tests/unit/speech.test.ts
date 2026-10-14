import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav } from '../../src/core/audio.js'
import { sttSpec } from '../../src/core/catalog.js'
import { qvacTranscriber, type Lang, type Transcriber, type TranscriptSegment } from '../../src/core/engines.js'
import { ModelStore, writeManifest } from '../../src/core/model-store.js'
import { QvacRuntime } from '../../src/core/qvac.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'
import { hasRepetitionLoop, joinSegments } from '../../src/features/speech/transcript.js'
import { FakeSdk } from './fake-sdk.js'

const seg = (text: string, startMs = 0, endMs = 1000): TranscriptSegment => ({ text, startMs, endMs })
const second = (n = 1) => new Float32Array(16_000 * n).fill(0.1)

class FakeTranscriber implements Transcriber {
  calls: [number, Lang][] = []
  constructor(private readonly segments: TranscriptSegment[]) {}
  async transcribe(samples: Float32Array, lang: Lang) {
    this.calls.push([samples.length, lang])
    return this.segments
  }
}

describe('joinSegments', () => {
  it('joins segment text, normalizes spacing and drops sound annotations', () => {
    expect(joinSegments([seg(' Mtoto ana homa'), seg(' [Music]'), seg(' , tangu jana .'), seg('(coughs)')])).toBe(
      'Mtoto ana homa, tangu jana.'
    )
    expect(joinSegments([])).toBe('')
  })
})

describe('hasRepetitionLoop', () => {
  it('flags decoding loops', () => {
    expect(hasRepetitionLoop('na na na na na na')).toBe(true)
    expect(hasRepetitionLoop('Asante sana. Asante sana. Asante sana.')).toBe(true)
    expect(hasRepetitionLoop('I have pain here and here, I have pain here and here, I have pain here and here')).toBe(true)
  })

  it('accepts ordinary emphatic repetition', () => {
    expect(hasRepetitionLoop('No, no, no, I did not take it.')).toBe(false)
    expect(hasRepetitionLoop('Pole pole, kunywa maji kidogo kidogo.')).toBe(false)
    expect(hasRepetitionLoop('')).toBe(false)
  })
})

describe('SpeechToText', () => {
  it('transcribes samples in the forced language and reports timing', async () => {
    const tr = new FakeTranscriber([seg(' Mtoto ana homa.')])
    const t = await new SpeechToText(tr).transcribe(second(2), 'sw')
    expect(tr.calls).toEqual([[32_000, 'sw']])
    expect(t).toMatchObject({ lang: 'sw', text: 'Mtoto ana homa.', audioMs: 2000, flags: [] })
    expect(t.realTimeFactor).toBeGreaterThanOrEqual(0)
  })

  it('normalizes the level before the model sees it', async () => {
    const tr = new FakeTranscriber([seg(' Hello.')])
    let peak = 0
    tr.transcribe = async (samples) => {
      peak = Math.max(...samples.map(Math.abs))
      return []
    }
    await new SpeechToText(tr).transcribe(new Float32Array(16_000).fill(0.002), 'sw')
    expect(peak).toBeCloseTo(0.7)
  })

  it('reads a WAV file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-stt-'))
    const file = path.join(dir, 'clip.wav')
    await fs.writeFile(file, encodeWav(second(1), 16_000))
    const tr = new FakeTranscriber([seg(' Hello.')])
    expect((await new SpeechToText(tr).transcribe(file, 'en')).text).toBe('Hello.')
    expect(tr.calls).toEqual([[16_000, 'en']])
    await fs.rm(dir, { recursive: true })
  })

  it('skips the model for an accidental tap and flags no speech', async () => {
    const tr = new FakeTranscriber([seg(' Thank you.')])
    const t = await new SpeechToText(tr).transcribe(new Float32Array(1600), 'en')
    expect(tr.calls).toEqual([])
    expect(t.flags).toEqual(['no-speech'])
  })

  it('flags empty output and repetition loops', async () => {
    expect((await new SpeechToText(new FakeTranscriber([seg(' [Music]')])).transcribe(second(), 'en')).flags).toEqual([
      'no-speech'
    ])
    const loop = new FakeTranscriber([seg(' Asante sana.'), seg(' Asante sana.'), seg(' Asante sana.')])
    expect((await new SpeechToText(loop).transcribe(second(), 'sw')).flags).toEqual(['repetition'])
  })
})

describe('qvacTranscriber', () => {
  let dir: string
  let runtime: QvacRuntime
  let sdk: FakeSdk

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-tr-'))
    const entry = (name: string) => ({ name, file: `${name}.bin`, size: 1, sha256: 'x', addon: 'whisper', engine: 'whispercpp-transcription' })
    await writeManifest(dir, {
      sdkVersion: '0.21.0',
      createdAt: '',
      models: [entry('WHISPER_LARGE_V3_TURBO'), entry('VAD_SILERO_5_1_2')]
    })
    sdk = new FakeSdk()
    sdk.stableIds = true
    runtime = new QvacRuntime(await ModelStore.open(dir), sdk, { memoryBudgetBytes: 10 })
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('loads Whisper once with f32le audio, VAD and GPU', async () => {
    await qvacTranscriber(runtime).transcribe(second(), 'en')
    expect(sdk.loads).toHaveLength(1)
    expect(sdk.loads[0]!.modelType).toBe('whispercpp-transcription')
    expect(sdk.loads[0]!.modelConfig).toMatchObject({
      audio_format: 'f32le',
      language: 'en',
      vadModelSrc: path.join(dir, 'VAD_SILERO_5_1_2.bin'),
      contextParams: { use_gpu: true }
    })
    expect(sdk.transcribed[0]!.audio).toHaveLength(16_000)
  })

  it('switches language with a config hot-reload only when it changes', async () => {
    const tr = qvacTranscriber(runtime, sttSpec())
    for (const lang of ['en', 'sw', 'sw', 'en'] as Lang[]) await tr.transcribe(second(), lang)
    expect(sdk.loads).toHaveLength(1)
    expect(sdk.reconfigures.map((r) => r.modelConfig)).toEqual([{ language: 'sw' }, { language: 'en' }])
    expect(sdk.reconfigures[0]!.modelType).toBe('whispercpp-transcription')
  })

  it('forces the language again after the model was evicted and reloaded under the same id', async () => {
    const tr = qvacTranscriber(runtime)
    await tr.transcribe(second(), 'sw')
    await runtime.unloadAll()
    await tr.transcribe(second(), 'sw')
    expect(sdk.loads).toHaveLength(2)
    expect(sdk.reconfigures.map((r) => r.modelConfig)).toEqual([{ language: 'sw' }, { language: 'sw' }])
  })
})
