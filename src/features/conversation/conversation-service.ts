/**
 * Conversation mode: one push-to-talk turn goes through speech-to-text,
 * translation and read-aloud. Each side of the screen has its own language, so
 * nothing is detected.
 *
 * The listener should hear the translation as soon as possible, so the
 * back-translation check does not hold up the audio. It runs while the
 * translation is spoken, and the UI shows the check line shortly after the
 * audio starts. As in the features it combines, flags never block a turn: they
 * tell the speakers what to confirm.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { encodeWav, resample, SPEECH_SAMPLE_RATE } from '../../core/audio.js'
import type { Lang, SpeechAudio } from '../../core/engines.js'
import { STT_FLAGS, STT_FLAG_HELP, type SpeechToText, type Transcript } from '../speech/speech-service.js'
import {
  FLAGS,
  FLAG_HELP,
  type CheckedTranslation,
  type Translation,
  type TranslationService
} from '../translate/translation-service.js'
import { segment } from '../translate/segment.js'
import { TTS_FLAGS, TTS_FLAG_HELP, type PendingLine, type ReadAloud, type Speech } from '../voice/read-aloud.js'

export const SIDES = ['clinician', 'patient'] as const
export type Side = (typeof SIDES)[number]

export const isSide = (value: string): value is Side => (SIDES as readonly string[]).includes(value)

export const DEFAULT_SIDE_LANGS: Record<Side, Lang> = { clinician: 'en', patient: 'sw' }

/** Speech, then translation, then read-aloud flags: the order the problems arise in. */
export const TURN_FLAGS = [...STT_FLAGS, ...FLAGS, ...TTS_FLAGS] as const
export type TurnFlag = (typeof TURN_FLAGS)[number]

export const TURN_FLAG_HELP: Record<TurnFlag, string> = { ...STT_FLAG_HELP, ...FLAG_HELP, ...TTS_FLAG_HELP }

/**
 * When the back-translation check starts. `after-first-audio` gives the
 * engines to the first spoken sentence alone, then checks while it plays;
 * `with-speech` starts both together. The F4 eval compares them.
 */
export type CheckStart = 'with-speech' | 'after-first-audio'

/**
 * What a UI can show while the turn is still running. The transcript comes
 * first; audio can start before the whole translation is there; the check
 * comes once both the translation and (by default) the first audio exist.
 */
export type TurnEvent =
  | { type: 'transcript'; atMs: number; transcript: Transcript }
  | { type: 'translation'; atMs: number; translation: Translation }
  | { type: 'audio'; atMs: number; chunk: SpeechAudio }
  | { type: 'check'; atMs: number; check: CheckedTranslation }

export interface TurnTimings {
  /** Length of the utterance. */
  utteranceMs: number
  sttMs: number
  translateMs: number
  /**
   * From the start of the turn (the speaker let go of the button) to the
   * first translated audio: how long the listener waits. 0 when nothing is spoken.
   */
  firstAudioMs: number
  /** From the start of the turn to the last translated audio. */
  speechDoneMs: number
  /** From the start of the turn to the check result. */
  checkDoneMs: number
  totalMs: number
}

export interface TurnInput {
  /** A WAV path, or 16 kHz mono samples (what the push-to-talk recorder delivers). */
  audio: string | Float32Array
  speakerSide: Side
  /** Receives partial results as they exist. */
  onEvent?: (event: TurnEvent) => void
}

export interface Turn {
  id: string
  speakerSide: Side
  sourceLang: Lang
  targetLang: Lang
  sourceText: string
  translation: string
  backTranslation: string
  /** Back-translation fidelity, lowest sentence; 0 when nothing was translated. */
  fidelity: number
  flags: TurnFlag[]
  /** The translated speech as WAV; absent when nothing was spoken or no audio directory is set. */
  audioPath?: string
  timings: TurnTimings
  transcript: Transcript
  /** Absent when no speech was recognized. */
  check?: CheckedTranslation
  /** Absent when no speech was recognized. Samples are in `audioPath`. */
  speech?: Omit<Speech, 'samples'>
}

export interface ConversationOptions {
  /** Language per side of the screen. */
  sides?: Partial<Record<Side, Lang>>
  /** Where each turn's translated speech is written as `<id>.wav`; unset: not written. */
  audioDir?: string
  checkStart?: CheckStart
  /**
   * Speak each sentence as soon as it is translated (default), or only once
   * the whole translation exists. The F4 eval compares them.
   */
  speakAsTranslated?: boolean
}

export interface WarmUpReport {
  /** Wall time to load and run every model once in each language. */
  warmUpMs: number
}

export class ConversationService {
  private readonly sides: Record<Side, Lang>
  private readonly checkStart: CheckStart
  private readonly speakAsTranslated: boolean

  constructor(
    private readonly stt: SpeechToText,
    private readonly translation: TranslationService,
    private readonly readAloud: ReadAloud,
    private readonly opts: ConversationOptions = {}
  ) {
    this.sides = { ...DEFAULT_SIDE_LANGS, ...opts.sides }
    if (this.sides.clinician === this.sides.patient) throw new Error(`Both sides speak "${this.sides.clinician}"`)
    this.checkStart = opts.checkStart ?? 'after-first-audio'
    this.speakAsTranslated = opts.speakAsTranslated ?? true
  }

  languageOf(side: Side): Lang {
    return this.sides[side]
  }

  /**
   * Loads every model and runs each once per language, so the first turn pays
   * neither the loads nor the first-inference warm-up (Metal kernels).
   */
  async warmUp(): Promise<WarmUpReport> {
    const t0 = performance.now()
    for (const side of SIDES) {
      const lang = this.sides[side]
      const other = this.sides[side === 'clinician' ? 'patient' : 'clinician']
      const speech = await this.readAloud.speak(lang === 'sw' ? 'Habari.' : 'Hello.', lang)
      await this.stt.transcribe(resample(speech.samples, speech.sampleRate, SPEECH_SAMPLE_RATE), lang)
      await this.translation.translateWithCheck(lang === 'sw' ? 'Habari.' : 'Hello.', lang, other)
    }
    return { warmUpMs: performance.now() - t0 }
  }

  async turn({ audio, speakerSide, onEvent }: TurnInput): Promise<Turn> {
    const t0 = performance.now()
    const at = () => performance.now() - t0
    const id = randomUUID()
    const sourceLang = this.sides[speakerSide]
    const targetLang = this.sides[speakerSide === 'clinician' ? 'patient' : 'clinician']

    const transcript = await this.stt.transcribe(audio, sourceLang)
    const sttMs = at()
    onEvent?.({ type: 'transcript', atMs: sttMs, transcript })
    const base = { id, speakerSide, sourceLang, targetLang, sourceText: transcript.text, transcript }
    if (!transcript.text) {
      const totalMs = at()
      return {
        ...base,
        translation: '',
        backTranslation: '',
        fidelity: 0,
        flags: transcript.flags,
        timings: { utteranceMs: transcript.audioMs, sttMs, translateMs: 0, firstAudioMs: 0, speechDoneMs: 0, checkDoneMs: 0, totalMs }
      }
    }

    // Each sentence is spoken as soon as it is translated (and the one before it spoken).
    const lines = segment(transcript.text)
    const sentences = lines.flatMap((l) => l.sentences).map(() => deferred<string>())
    const translating = this.translation
      .translate(transcript.text, sourceLang, targetLang, { onSentence: (i, t) => sentences[i]?.resolve(t) })
      .then((translation) => {
        onEvent?.({ type: 'translation', atMs: at(), translation })
        return translation
      })
    translating.catch((err) => sentences.forEach((d) => d.reject(err)))
    let next = 0
    const toSpeak: string | PendingLine[] = this.speakAsTranslated
      ? lines.map((l) => ({ sentences: l.sentences.map(() => sentences[next++]!.promise), eol: l.eol }))
      : (await translating).translation

    let firstAudioMs = 0
    let heardFirst!: () => void
    const firstAudio = new Promise<void>((resolve) => (heardFirst = resolve))
    const speaking = this.readAloud
      .speak(toSpeak, targetLang, {
        onAudio: (chunk) => {
          const atMs = at()
          if (!firstAudioMs) {
            firstAudioMs = atMs
            heardFirst()
          }
          onEvent?.({ type: 'audio', atMs, chunk })
        }
      })
      .then((speech) => ({ speech, doneMs: at() }))
      .finally(heardFirst) // nothing spoken: the check need not wait

    const checking = Promise.all([translating, this.checkStart === 'after-first-audio' ? firstAudio : undefined])
      .then(([translation]) => this.translation.check(translation))
      .then((check) => {
        const doneMs = at()
        onEvent?.({ type: 'check', atMs: doneMs, check })
        return { check, doneMs }
      })

    const [{ speech, doneMs: speechDoneMs }, { check, doneMs: checkDoneMs }] = await Promise.all([speaking, checking])
    const translation = await translating
    const audioPath = await this.save(id, speech)
    const { samples: _samples, ...speechInfo } = speech
    const flags = new Set<TurnFlag>([...transcript.flags, ...check.flags, ...speech.flags])
    return {
      ...base,
      translation: translation.translation,
      backTranslation: check.backTranslation,
      fidelity: check.fidelity,
      flags: TURN_FLAGS.filter((f) => flags.has(f)),
      ...(audioPath ? { audioPath } : {}),
      timings: {
        utteranceMs: transcript.audioMs,
        sttMs,
        translateMs: translation.translateMs,
        firstAudioMs,
        speechDoneMs,
        checkDoneMs,
        totalMs: at()
      },
      transcript,
      check,
      speech: speechInfo
    }
  }

  private async save(id: string, speech: Speech): Promise<string | undefined> {
    if (!this.opts.audioDir || speech.samples.length === 0) return undefined
    const file = path.join(this.opts.audioDir, `${id}.wav`)
    await fs.mkdir(this.opts.audioDir, { recursive: true })
    await fs.writeFile(file, encodeWav(speech.samples, speech.sampleRate))
    return file
  }
}

/** A promise settled from outside. Its rejection counts as handled: whoever awaits it gets the error. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}
