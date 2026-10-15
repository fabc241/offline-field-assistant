/**
 * Speech to text for one side of the push-to-talk screen. The language is
 * always given by the caller, never detected. Like translation flags,
 * transcript flags never block: the app shows them and people decide.
 */
import { performance } from 'node:perf_hooks'
import { durationMs, loadSpeech, normalizePeak } from '../../core/audio.js'
import type { Lang, Transcriber, TranscriptSegment } from '../../core/engines.js'
import { hasRepetitionLoop, joinSegments, unglueSwahiliNumbers } from './transcript.js'

export const STT_FLAGS = ['no-speech', 'repetition'] as const
export type SttFlag = (typeof STT_FLAGS)[number]

export const STT_FLAG_HELP: Record<SttFlag, string> = {
  'no-speech': 'No speech was recognized. Hold the button while speaking and try again.',
  repetition: 'The transcript repeats itself, a sign of misrecognition. Say it again.'
}

export interface Transcript {
  lang: Lang
  text: string
  segments: TranscriptSegment[]
  audioMs: number
  transcribeMs: number
  /** Processing time over audio duration; below 1 is faster than real time. */
  realTimeFactor: number
  flags: SttFlag[]
}

/** Clips shorter than this are treated as an accidental tap and not sent to the model. */
export const MIN_AUDIO_MS = 200

export class SpeechToText {
  constructor(private readonly transcriber: Transcriber) {}

  /** `input` is a WAV path, or 16 kHz mono samples (not modified). */
  async transcribe(input: string | Float32Array, lang: Lang): Promise<Transcript> {
    const samples = normalizePeak(await loadSpeech(input))
    const audioMs = durationMs(samples)
    const t0 = performance.now()
    const segments = audioMs < MIN_AUDIO_MS ? [] : await this.transcriber.transcribe(samples, lang)
    const transcribeMs = performance.now() - t0
    const joined = joinSegments(segments)
    const text = lang === 'sw' ? unglueSwahiliNumbers(joined) : joined

    const flags = new Set<SttFlag>()
    if (!text) flags.add('no-speech')
    if (hasRepetitionLoop(text)) flags.add('repetition')
    return {
      lang,
      text,
      segments,
      audioMs,
      transcribeMs,
      realTimeFactor: audioMs ? transcribeMs / audioMs : 0,
      flags: STT_FLAGS.filter((f) => flags.has(f))
    }
  }
}
