import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeWav } from '../../src/core/audio.js'
import { MODEL_CATALOG as M } from '../../src/core/catalog.js'
import { loadConfig } from '../../src/core/config.js'
import type {
  EmbedTask,
  Embedder,
  Lang,
  Speaker,
  SpeechAudio,
  Transcriber,
  TranscriptSegment,
  Translator
} from '../../src/core/engines.js'
import { ModelStore, writeManifest } from '../../src/core/model-store.js'
import { QvacRuntime } from '../../src/core/qvac.js'
import {
  ConversationService,
  type ConversationOptions,
  type TurnEvent
} from '../../src/features/conversation/conversation-service.js'
import { createConversation } from '../../src/features/conversation/setup.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'
import { TranslationService } from '../../src/features/translate/translation-service.js'
import { ReadAloud } from '../../src/features/voice/read-aloud.js'
import { FakeSdk } from './fake-sdk.js'

const RATE = 24_000
const second = (n = 1) => new Float32Array(16_000 * n).fill(0.1)
const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0

/** Hears the text set for each language. */
class FakeTranscriber implements Transcriber {
  calls: Lang[] = []
  constructor(private readonly heard: Partial<Record<Lang, string>>) {}
  async transcribe(_samples: Float32Array, lang: Lang): Promise<TranscriptSegment[]> {
    this.calls.push(lang)
    const text = this.heard[lang]
    return text ? [{ text: ` ${text}`, startMs: 0, endMs: 1000 }] : []
  }
}

/** Waits at `wait()` for texts in `held`, from `hold()` until `release()`. */
class Gate {
  private gate: Promise<void> = Promise.resolve()
  release = () => {}
  constructor(private readonly held: string[] = []) {}
  hold(): void {
    this.gate = new Promise((resolve) => (this.release = resolve))
  }
  async wait(text: string): Promise<void> {
    if (this.held.includes(text)) await this.gate
  }
}

/**
 * Looks translations up in a table and logs each one as it completes, in one
 * timeline with the speaker's calls.
 */
class TableTranslator extends Gate implements Translator {
  constructor(
    private readonly table: Record<string, string>,
    private readonly log: string[],
    held?: string[]
  ) {
    super(held)
  }
  async translate(text: string, from: Lang, to: Lang) {
    await this.wait(text)
    this.log.push(`translate ${from}→${to}: ${text}`)
    return this.table[text] ?? text
  }
}

class FakeEmbedder implements Embedder {
  async embed(texts: string[], _task: EmbedTask) {
    return texts.map(() => [1, 0])
  }
}

/** Speaks 80 ms of audio per letter, logging each sentence when it is spoken. */
class GatedSpeaker extends Gate implements Speaker {
  constructor(
    private readonly log: string[],
    held?: string[]
  ) {
    super(held)
  }
  async speak(text: string, lang: Lang, onAudio: (chunk: SpeechAudio) => void) {
    await this.wait(text)
    this.log.push(`speak ${lang}: ${text}`)
    onAudio({ samples: new Float32Array(letters(text) * 80 * (RATE / 1000)).fill(0.25), sampleRate: RATE })
  }
}

const TABLE = {
  'Take two tablets.': 'Meza vidonge viwili.',
  'Meza vidonge viwili.': 'Take two tablets.',
  'Come back tomorrow.': 'Rudi kesho.',
  'Rudi kesho.': 'Come back tomorrow.',
  'Take 500 mg.': 'Meza mg 50.',
  'Meza mg 50.': 'Take 50 mg.',
  'Mtoto ana homa.': 'The child has a fever.',
  'The child has a fever.': 'Mtoto ana homa.'
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-conv-'))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

type SetupOptions = ConversationOptions & { held?: string[]; heldTranslations?: string[]; speaker?: Speaker }

function setup(heard: Partial<Record<Lang, string>>, opts: SetupOptions = {}) {
  const log: string[] = []
  const transcriber = new FakeTranscriber(heard)
  const speaker = new GatedSpeaker(log, opts.held)
  const translator = new TableTranslator(TABLE, log, opts.heldTranslations)
  const service = new ConversationService(
    new SpeechToText(transcriber),
    new TranslationService(translator, new FakeEmbedder()),
    new ReadAloud(opts.speaker ?? speaker),
    { audioDir: dir, ...opts }
  )
  return { service, log, transcriber, speaker, translator }
}

describe('ConversationService.turn', () => {
  it('transcribes, translates, speaks and checks a clinician turn', async () => {
    const { service, transcriber } = setup({ en: 'Take two tablets.' })
    const events: TurnEvent['type'][] = []
    const turn = await service.turn({ audio: second(2), speakerSide: 'clinician', onEvent: (e) => events.push(e.type) })

    expect(transcriber.calls).toEqual(['en'])
    expect(turn).toMatchObject({
      speakerSide: 'clinician',
      sourceLang: 'en',
      targetLang: 'sw',
      sourceText: 'Take two tablets.',
      translation: 'Meza vidonge viwili.',
      backTranslation: 'Take two tablets.',
      fidelity: 1,
      flags: []
    })
    expect(turn.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(events[0]).toBe('transcript')
    expect([...events].sort()).toEqual(['audio', 'check', 'transcript', 'translation'])
    expect(events.at(-1)).toBe('check')

    const t = turn.timings
    expect(t.utteranceMs).toBe(2000)
    expect(t.sttMs).toBeLessThanOrEqual(t.firstAudioMs)
    expect(t.firstAudioMs).toBeGreaterThan(0)
    expect(t.firstAudioMs).toBeLessThanOrEqual(t.speechDoneMs)
    expect(Math.max(t.speechDoneMs, t.checkDoneMs)).toBeLessThanOrEqual(t.totalMs)

    const wav = decodeWav(await fs.readFile(turn.audioPath!))
    expect(path.dirname(turn.audioPath!)).toBe(dir)
    expect(wav.sampleRate).toBe(RATE)
    expect(wav.channels[0]!.length).toBe(17 * 80 * 24) // "Meza vidonge viwili."
    expect(turn.speech).toMatchObject({ lang: 'sw', audioMs: 1360 })
    expect(turn.speech).not.toHaveProperty('samples')
  })

  it('reverses the languages for the patient side', async () => {
    const { service, log, transcriber } = setup({ sw: 'Mtoto ana homa.' })
    const turn = await service.turn({ audio: second(), speakerSide: 'patient' })
    expect(transcriber.calls).toEqual(['sw'])
    expect(turn).toMatchObject({ sourceLang: 'sw', targetLang: 'en', translation: 'The child has a fever.' })
    expect(log).toContain('speak en: The child has a fever.')
  })

  it('speaks the first sentence while the next is translated, and checks while the rest is spoken', async () => {
    const { service, log, speaker, translator } = setup(
      { en: 'Take two tablets. Come back tomorrow.' },
      { heldTranslations: ['Come back tomorrow.'], held: ['Rudi kesho.'] }
    )
    translator.hold()
    speaker.hold()
    const events: string[] = []
    await service.turn({
      audio: second(),
      speakerSide: 'clinician',
      onEvent: (e) => {
        events.push(e.type)
        if (e.type === 'audio') translator.release()
        if (e.type === 'check') speaker.release()
      }
    })
    expect(log).toEqual([
      'translate en→sw: Take two tablets.',
      'speak sw: Meza vidonge viwili.',
      'translate en→sw: Come back tomorrow.',
      'translate sw→en: Meza vidonge viwili.',
      'translate sw→en: Rudi kesho.',
      'speak sw: Rudi kesho.'
    ])
    expect(events[1]).toBe('audio')
    expect(events.indexOf('check')).toBeGreaterThan(events.indexOf('translation'))
    expect(events.at(-1)).toBe('audio')
  })

  it('can wait for the whole translation before speaking', async () => {
    const { service, log } = setup({ en: 'Take two tablets. Come back tomorrow.' }, { speakAsTranslated: false })
    const events: string[] = []
    const turn = await service.turn({ audio: second(), speakerSide: 'clinician', onEvent: (e) => events.push(e.type) })
    expect(log.slice(0, 3)).toEqual([
      'translate en→sw: Take two tablets.',
      'translate en→sw: Come back tomorrow.',
      'speak sw: Meza vidonge viwili.'
    ])
    expect(events.slice(0, 3)).toEqual(['transcript', 'translation', 'audio'])
    expect(turn.translation).toBe('Meza vidonge viwili. Rudi kesho.')
    expect(turn.speech?.text).toBe('Meza vidonge viwili. Rudi kesho.')
  })

  it('fails the turn, without hanging, when translation fails', async () => {
    const failing = new ConversationService(
      new SpeechToText(new FakeTranscriber({ en: 'Take two tablets. Come back tomorrow.' })),
      new TranslationService({ translate: async (t) => (t.startsWith('Come') ? Promise.reject(new Error('model crashed')) : 'Sawa.') }, new FakeEmbedder()),
      new ReadAloud(new GatedSpeaker([])),
      { audioDir: dir }
    )
    await expect(failing.turn({ audio: second(), speakerSide: 'clinician' })).rejects.toThrow('model crashed')
  })

  it('can start the check together with the speech', async () => {
    const { service, log, speaker } = setup({ en: 'Take two tablets.' }, { checkStart: 'with-speech', held: ['Meza vidonge viwili.'] })
    speaker.hold()
    const events: string[] = []
    await service.turn({
      audio: second(),
      speakerSide: 'clinician',
      onEvent: (e) => {
        events.push(e.type)
        if (e.type === 'check') speaker.release()
      }
    })
    expect(events).toEqual(['transcript', 'translation', 'check', 'audio'])
    expect(log.indexOf('translate sw→en: Meza vidonge viwili.')).toBeLessThan(log.indexOf('speak sw: Meza vidonge viwili.'))
  })

  it('stops after speech-to-text when nothing was said', async () => {
    const { service, log } = setup({})
    const events: string[] = []
    const turn = await service.turn({ audio: second(), speakerSide: 'patient', onEvent: (e) => events.push(e.type) })
    expect(turn).toMatchObject({ sourceText: '', translation: '', flags: ['no-speech'], fidelity: 0 })
    expect(turn.audioPath).toBeUndefined()
    expect(turn.check).toBeUndefined()
    expect(turn.timings.firstAudioMs).toBe(0)
    expect(events).toEqual(['transcript'])
    expect(log).toEqual([])
  })

  it('speaks a flagged translation and reports every flag, speech-to-text first', async () => {
    const { service } = setup({ en: 'Take 500 mg. Take 500 mg. Take 500 mg. Take 500 mg. Take 500 mg.' })
    const turn = await service.turn({ audio: second(), speakerSide: 'clinician' })
    expect(turn.flags).toEqual(['repetition', 'numbers-changed'])
    expect(turn.audioPath).toBeDefined()
  })

  it('still checks when nothing could be spoken, and writes no audio', async () => {
    const silent: Speaker = { speak: async () => undefined }
    const { service } = setup({ en: 'Take two tablets.' }, { speaker: silent })
    const turn = await service.turn({ audio: second(), speakerSide: 'clinician' })
    expect(turn.flags).toEqual(['no-audio'])
    expect(turn.backTranslation).toBe('Take two tablets.')
    expect(turn.timings.firstAudioMs).toBe(0)
    expect(turn.audioPath).toBeUndefined()
  })

  it('writes no audio without an audio directory', async () => {
    const { service } = setup({ en: 'Take two tablets.' }, { audioDir: undefined })
    expect((await service.turn({ audio: second(), speakerSide: 'clinician' })).audioPath).toBeUndefined()
  })

  it('fails the turn when the speech engine fails', async () => {
    const broken: Speaker = { speak: async () => Promise.reject(new Error('engine crashed')) }
    const { service } = setup({ en: 'Take two tablets.' }, { speaker: broken })
    await expect(service.turn({ audio: second(), speakerSide: 'clinician' })).rejects.toThrow('engine crashed')
  })

  it('takes the language of each side from the options', async () => {
    const { service, transcriber } = setup({ sw: 'Mtoto ana homa.' }, { sides: { clinician: 'sw', patient: 'en' } })
    expect(service.languageOf('patient')).toBe('en')
    const turn = await service.turn({ audio: second(), speakerSide: 'clinician' })
    expect(transcriber.calls).toEqual(['sw'])
    expect(turn.targetLang).toBe('en')
    expect(() => setup({}, { sides: { patient: 'en' } })).toThrow(/Both sides/)
  })
})

describe('ConversationService.warmUp', () => {
  it('runs every model once in each language', async () => {
    const { service, log, transcriber } = setup({ en: 'Hello.', sw: 'Habari.' })
    await service.warmUp()
    expect(transcriber.calls).toEqual(['en', 'sw'])
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak en: Hello.', 'speak sw: Habari.'])
    expect(log.filter((l) => l.startsWith('translate'))).toEqual([
      'translate en→sw: Hello.',
      'translate sw→en: Hello.',
      'translate sw→en: Habari.',
      'translate en→sw: Habari.'
    ])
  })
})

describe('createConversation', () => {
  const GB = 1024 ** 3
  const runtime = async (budgetGb: number) => {
    const entry = (name: string, size: number, engine: string) => ({ name, file: `${name}.bin`, size, sha256: 'x', addon: '', engine })
    await writeManifest(dir, {
      sdkVersion: '0.21.0',
      createdAt: '',
      models: [
        entry(M.stt, GB, 'whispercpp-transcription'),
        entry(M.vad, 1, 'whispercpp-transcription'),
        entry(M.translator, GB, 'llamacpp-completion'),
        entry(M.embedder, GB / 4, 'llamacpp-embedding'),
        entry(M.ttsT3, GB / 4, 'tts-ggml'),
        entry(M.ttsS3gen, GB, 'tts-ggml')
      ]
    })
    const sdk = new FakeSdk()
    sdk.pcmChunks = [new Array(RATE).fill(1000)] // 1 s, long enough for speech-to-text to run on
    return new QvacRuntime(await ModelStore.open(dir), sdk, { memoryBudgetBytes: budgetGb * GB })
  }
  const config = (modelsDir: string) => ({ ...loadConfig({}), modelsDir, memoryBudgetBytes: 0, voices: {}, packsDir: dir })

  it('keeps STT, translator, embedder and one TTS per language loaded together', async () => {
    const rt = await runtime(6)
    const { warmUp } = await createConversation(rt, config(dir))
    expect((await warmUp()).evicted).toEqual([])
    expect(rt.loaded().map((m) => m.name).sort()).toEqual([M.embedder, M.ttsT3, M.ttsT3, M.translator, M.stt].sort())
  })

  it('reports the models a small memory budget pushed out', async () => {
    const { warmUp } = await createConversation(await runtime(4), config(dir))
    expect((await warmUp()).evicted.length).toBeGreaterThan(0)
  })
})
