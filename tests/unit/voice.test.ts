import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav } from '../../src/core/audio.js'
import { ttsSpec } from '../../src/core/catalog.js'
import { loadConfig } from '../../src/core/config.js'
import { qvacSpeaker, type Lang, type Speaker, type SpeechAudio } from '../../src/core/engines.js'
import { ModelStore, writeManifest } from '../../src/core/model-store.js'
import { QvacRuntime } from '../../src/core/qvac.js'
import {
  MAX_PART_CHARS,
  ReadAloud,
  durationFlags,
  planSpeech,
  playbackStall,
  splitLong
} from '../../src/features/voice/read-aloud.js'
import { checkReferenceVoice, consentFile, speakerSpecs } from '../../src/features/voice/voices.js'
import { FakeSdk } from './fake-sdk.js'

const RATE = 24_000

/** Speaks 80 ms per letter, in chunks of `chunkMs`, and records what it was asked. */
class FakeSpeaker implements Speaker {
  calls: [string, Lang][] = []
  constructor(private readonly chunkMs = 1000) {}
  async speak(text: string, lang: Lang, onAudio: (chunk: SpeechAudio) => void) {
    this.calls.push([text, lang])
    let left = Math.round(((text.match(/\p{L}/gu)?.length ?? 0) * 80 * RATE) / 1000)
    const step = Math.round((this.chunkMs * RATE) / 1000)
    while (left > 0) {
      onAudio({ samples: new Float32Array(Math.min(step, left)).fill(0.5), sampleRate: RATE })
      left -= step
    }
  }
}

describe('planSpeech', () => {
  it('speaks sentence by sentence, numbers spelled out, with pauses between sentences and lines', () => {
    expect(planSpeech('Take 2 tablets. Drink water.\nCome back in 3 days.', 'en')).toEqual([
      { text: 'Take 2 tablets.', spoken: 'Take two tablets.', pauseAfterMs: 250 },
      { text: 'Drink water.', spoken: 'Drink water.', pauseAfterMs: 500 },
      { text: 'Come back in 3 days.', spoken: 'Come back in three days.', pauseAfterMs: 0 }
    ])
  })

  it('keeps the text as written when raw', () => {
    expect(planSpeech('Meza mg 500.', 'sw', { raw: true })[0]!.spoken).toBe('Meza mg 500.')
    expect(planSpeech('Meza mg 500.', 'sw')[0]!.spoken).toBe('Meza miligramu mia tano.')
  })

  it('skips blank lines and text with nothing to say', () => {
    expect(planSpeech('\n\n — … \n', 'en')).toEqual([])
    expect(planSpeech('Hello.\n\n—\nBye.', 'en').map((p) => p.text)).toEqual(['Hello.', 'Bye.'])
  })

  it('splits sentences longer than one call can take', () => {
    const long = `${'The nurse will check your weight, '.repeat(6)}and then you can go home.`
    const parts = planSpeech(long, 'en')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.text.length <= MAX_PART_CHARS)).toBe(true)
    expect(parts.map((p) => p.text).join(' ')).toBe(long)
  })
})

describe('splitLong', () => {
  it('cuts at a clause break when there is one, else at a space', () => {
    expect(splitLong('aaaa bbbb, cccc dddd eeee', 14)).toEqual(['aaaa bbbb,', 'cccc dddd eeee'])
    expect(splitLong('aaaa bbbb cccc dddd', 12)).toEqual(['aaaa bbbb', 'cccc dddd'])
    expect(splitLong('short', 12)).toEqual(['short'])
  })
})

describe('durationFlags', () => {
  it('flags audio far longer or shorter than the text, and no audio at all', () => {
    const text = 'Drink plenty of clean water.' // 23 letters
    expect(durationFlags(text, 1800, 'en')).toEqual([])
    expect(durationFlags(text, 10_000, 'en')).toEqual(['too-long'])
    expect(durationFlags(text, 300, 'en')).toEqual(['too-short'])
    expect(durationFlags(text, 0, 'en')).toEqual(['no-audio'])
  })
})

describe('playbackStall', () => {
  it('adds up the waits for audio that arrives after the previous audio finished playing', () => {
    expect(playbackStall([])).toBe(0)
    expect(playbackStall([{ atMs: 1000, audioMs: 2000 }, { atMs: 2500, audioMs: 1000 }])).toBe(0)
    expect(playbackStall([{ atMs: 1000, audioMs: 500 }, { atMs: 2000, audioMs: 1000 }, { atMs: 3200, audioMs: 100 }])).toBe(700)
  })
})

describe('ReadAloud', () => {
  it('passes the audio on in playback order, with the pauses, and returns all of it', async () => {
    const speaker = new FakeSpeaker()
    const heard: number[] = []
    const speech = await new ReadAloud(speaker).speak('Hello there. Goodbye.', 'en', {
      onAudio: (c) => heard.push(c.samples.length)
    })
    expect(speaker.calls).toEqual([
      ['Hello there.', 'en'],
      ['Goodbye.', 'en']
    ])
    // 10 letters → 800 ms, 250 ms pause, 7 letters → 560 ms
    expect(heard).toEqual([19_200, 6000, 13_440])
    expect(speech.samples.length).toBe(19_200 + 6000 + 13_440)
    expect(speech.sampleRate).toBe(RATE)
    expect(speech.audioMs).toBeCloseTo(1610)
    expect(speech.parts.map((p) => [p.startMs, Math.round(p.audioMs)])).toEqual([
      [0, 800],
      [1050, 560]
    ])
    expect(speech.samples[19_200 + 100]).toBe(0) // the pause is silence
    expect(speech.flags).toEqual([])
    expect(speech.firstAudioMs).toBeGreaterThanOrEqual(0)
    expect(speech.firstAudioMs).toBeLessThanOrEqual(speech.synthMs)
  })

  it('speaks sentences as they arrive, with the same parts, pauses and audio as the whole text', async () => {
    const text = 'Take 2 tablets. Drink water.\nCome back in 3 days.'
    const whole = await new ReadAloud(new FakeSpeaker()).speak(text, 'en')

    const speaker = new FakeSpeaker()
    let arrive!: (s: string) => void
    const late = new Promise<string>((resolve) => (arrive = resolve))
    const lines = [
      { sentences: [Promise.resolve('Take 2 tablets.'), Promise.resolve('Drink water.')], eol: '\n' },
      { sentences: [late], eol: '' }
    ]
    const speaking = new ReadAloud(speaker).speak(lines, 'en')
    await new Promise((r) => setTimeout(r, 0))
    expect(speaker.calls.map((c) => c[0])).toEqual(['Take two tablets.', 'Drink water.'])
    arrive('Come back in 3 days.')
    const streamed = await speaking

    expect(streamed.text).toBe(text)
    expect(streamed.samples).toEqual(whole.samples)
    const shape = (p: { text: string; spoken: string; pauseAfterMs: number; startMs: number }) => [p.text, p.spoken, p.pauseAfterMs, p.startMs]
    expect(streamed.parts.map(shape)).toEqual(whole.parts.map(shape))
    expect(streamed.parts.map((p) => p.pauseAfterMs)).toEqual(planSpeech(text, 'en').map((p) => p.pauseAfterMs))
  })

  it('spells numbers out before the speaker sees them', async () => {
    const speaker = new FakeSpeaker()
    await new ReadAloud(speaker).speak('Mpe ml 5.', 'sw')
    expect(speaker.calls).toEqual([['Mpe mililita tano.', 'sw']])
  })

  it('flags a sentence that produced no audio', async () => {
    const silent: Speaker = { speak: async () => undefined }
    const speech = await new ReadAloud(silent).speak('Hello.', 'en')
    expect(speech.flags).toEqual(['no-audio'])
    expect(speech.samples).toHaveLength(0)
  })

  it('refuses audio whose sample rate changes mid-text', async () => {
    let rate = 24_000
    const speaker: Speaker = {
      speak: async (_t, _l, onAudio) => onAudio({ samples: new Float32Array(10), sampleRate: rate++ })
    }
    await expect(new ReadAloud(speaker).speak('One. Two.', 'en')).rejects.toThrow(/sample rate changed/)
  })
})

describe('qvacSpeaker', () => {
  let dir: string
  let sdk: FakeSdk
  let runtime: QvacRuntime

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-tts-'))
    const entry = (name: string) => ({ name, file: `${name}.gguf`, size: 1, sha256: 'x', addon: 'tts', engine: 'tts-ggml' })
    await writeManifest(dir, {
      sdkVersion: '0.21.0',
      createdAt: '',
      models: [entry('TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0'), entry('TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0')]
    })
    sdk = new FakeSdk()
    runtime = new QvacRuntime(await ModelStore.open(dir), sdk, { memoryBudgetBytes: 10 })
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('loads Chatterbox on the GPU once per language and scales PCM to [-1, 1]', async () => {
    const speaker = qvacSpeaker(runtime)
    const chunks: SpeechAudio[] = []
    await speaker.speak('Habari.', 'sw', (c) => chunks.push(c))
    await speaker.speak('Asante.', 'sw', () => undefined)
    await speaker.speak('Hello.', 'en', () => undefined)
    expect(sdk.loads.map((l) => l.modelConfig.language)).toEqual(['sw', 'en'])
    expect(sdk.loads[0]!).toMatchObject({
      modelType: 'tts-ggml',
      modelConfig: {
        ttsEngine: 'chatterbox',
        useGPU: true,
        s3genModelSrc: path.join(dir, 'TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0.gguf')
      }
    })
    expect(sdk.loads[0]!.modelConfig).not.toHaveProperty('streamChunkTokens')
    expect(sdk.synthesized.map((s) => s.text)).toEqual(['Habari.', 'Asante.', 'Hello.'])
    expect(chunks.map((c) => [...c.samples])).toEqual([[0, 0.5], [-0.5]])
  })

  it('passes chunk streaming, speed and a reference voice through to the engine', async () => {
    const voice = path.join(dir, 'voice.wav')
    const speaker = qvacSpeaker(runtime, (lang) => ttsSpec(lang, { chunkTokens: 50, speed: 0.9, referenceAudio: voice }))
    await speaker.speak('Habari.', 'sw', () => undefined)
    expect(sdk.loads[0]!.modelConfig).toMatchObject({
      streamChunkTokens: 50,
      streamFirstChunkTokens: 20,
      ttsSpeed: 0.9,
      referenceAudioSrc: voice
    })
  })

  it('refuses a reference voice that is not a local file', async () => {
    const speaker = qvacSpeaker(runtime, (lang) => ttsSpec(lang, { referenceAudio: 'https://example.com/voice.wav' }))
    await expect(speaker.speak('Habari.', 'sw', () => undefined)).rejects.toThrow(/non-local/)
    expect(sdk.loads).toEqual([])
  })
})

describe('reference voices', () => {
  let dir: string
  const consent = { speaker: 'Test speaker', consentDate: '2026-10-01', scope: 'unit tests' }
  const wav = (seconds: number, channels = 1) => {
    const mono = encodeWav(new Float32Array(16_000 * seconds).fill(0.1), 16_000)
    if (channels === 1) return mono
    // Patch the header to claim two channels; the data halves in length, which is fine here.
    const stereo = Uint8Array.from(mono)
    new DataView(stereo.buffer).setUint16(22, 2, true)
    return stereo
  }
  const write = async (name: string, audio: Uint8Array, record?: unknown) => {
    const file = path.join(dir, name)
    await fs.writeFile(file, audio)
    if (record !== undefined) await fs.writeFile(consentFile(file), typeof record === 'string' ? record : JSON.stringify(record))
    return file
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-voice-'))
  })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('accepts a mono recording of at least 5 s with a consent record', async () => {
    expect(await checkReferenceVoice(await write('ok.wav', wav(6), consent))).toEqual(consent)
  })

  it('refuses to clone without consent', async () => {
    await expect(checkReferenceVoice(await write('none.wav', wav(6)))).rejects.toThrow(/no consent record/)
    await expect(checkReferenceVoice(await write('bad.wav', wav(6), '{'))).rejects.toThrow(/not valid JSON/)
    await expect(checkReferenceVoice(await write('who.wav', wav(6), { ...consent, speaker: ' ' }))).rejects.toThrow(/"speaker"/)
    await expect(checkReferenceVoice(await write('when.wav', wav(6), { ...consent, consentDate: 'soon' }))).rejects.toThrow(/not a date/)
  })

  it('refuses recordings the engine cannot use', async () => {
    await expect(checkReferenceVoice(await write('short.wav', wav(3), consent))).rejects.toThrow(/at least 5 s/)
    await expect(checkReferenceVoice(await write('stereo.wav', wav(12, 2), consent))).rejects.toThrow(/mono/)
    await expect(checkReferenceVoice('relative.wav')).rejects.toThrow(/absolute/)
  })

  it('builds per-language specs with the checked voices', async () => {
    const sw = await write('sw.wav', wav(6), consent)
    const spec = await speakerSpecs({ sw })
    expect(spec('sw').config).toMatchObject({ language: 'sw', referenceAudioSrc: sw })
    expect(spec('en').config).not.toHaveProperty('referenceAudioSrc')
    await expect(speakerSpecs({ en: await write('x.wav', wav(6)) })).rejects.toThrow(/consent/)
  })

  it('reads the voices from the environment', () => {
    expect(loadConfig({ OFA_VOICE_SW: '/v/sw.wav' }).voices).toEqual({ sw: '/v/sw.wav' })
    expect(loadConfig({}).voices).toEqual({})
  })
})
