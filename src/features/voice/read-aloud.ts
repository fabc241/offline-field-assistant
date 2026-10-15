/**
 * Read aloud: text in, speech out, one sentence at a time so the first
 * sentence plays while the next is synthesized. Numbers and units are spelled
 * out first (spoken.ts). Like the other features' flags, speech flags never
 * block: they tell the person the audio may be wrong.
 */
import { performance } from 'node:perf_hooks'
import type { Lang, Speaker, SpeechAudio } from '../../core/engines.js'
import { segment } from '../translate/segment.js'
import { toSpokenForm } from './spoken.js'

export const TTS_FLAGS = ['no-audio', 'too-long', 'too-short'] as const
export type TtsFlag = (typeof TTS_FLAGS)[number]

export const TTS_FLAG_HELP: Record<TtsFlag, string> = {
  'no-audio': 'Nothing was spoken for part of the text. Read it out yourself.',
  'too-long': 'The audio is much longer than the text needs: it may repeat or babble. Listen before relying on it.',
  'too-short': 'The audio is much shorter than the text: words may be missing. Listen before relying on it.'
}

/** One piece the engine speaks: a sentence, or a clause of a long one. */
export interface SpeechPart {
  /** As written. */
  text: string
  /** As sent to the engine, numbers spelled out. */
  spoken: string
  /** Silence after this part: between sentences, longer at a line break. */
  pauseAfterMs: number
}

export interface SpokenPart extends SpeechPart {
  /** Where this part starts in the full audio. */
  startMs: number
  audioMs: number
  synthMs: number
  flags: TtsFlag[]
}

export interface Speech {
  lang: Lang
  text: string
  parts: SpokenPart[]
  samples: Float32Array
  sampleRate: number
  audioMs: number
  /** Wall time from the call to the last audio. */
  synthMs: number
  /** Wall time from the call to the first audio: how long a listener waits. */
  firstAudioMs: number
  /** Synthesis time over audio duration; below 1 is faster than real time. */
  realTimeFactor: number
  /**
   * Silence a listener would hear mid-speech if playback started with the
   * first audio and the next audio was not ready in time.
   */
  stallMs: number
  flags: TtsFlag[]
}

export interface SpeakOptions {
  /** Receives each piece of audio as soon as it exists, pauses included, in playback order. */
  onAudio?: (chunk: SpeechAudio) => void
  /** Send numbers and units as written instead of spelling them out (for A/B evals). */
  raw?: boolean
}

const PAUSE_SENTENCE_MS = 250
const PAUSE_LINE_MS = 500
/** Longest part sent in one call; the engine's own reference splitter uses 180. */
export const MAX_PART_CHARS = 180

/**
 * Duration sanity bounds per spoken letter (or digit). The F3 eval's 700
 * renders spanned 48–116 ms in English and 64–158 ms in Swahili (speed 0.85
 * included); the bounds sit at about half the lowest and twice the highest,
 * so only gross failures (babbling, dropped words) are flagged.
 */
export const MS_PER_LETTER: Record<Lang, { min: number; max: number }> = {
  en: { min: 24, max: 230 },
  sw: { min: 32, max: 300 }
}
/** Short parts carry fixed lead-in and trailing silence; leave them this much slack. */
const DURATION_SLACK_MS = 1000

const speakable = (s: string) => /[\p{L}\p{N}]/u.test(s)

/** Splits a sentence that is too long for one call at clause breaks, else at spaces. */
export function splitLong(sentence: string, max = MAX_PART_CHARS): string[] {
  if (sentence.length <= max) return [sentence]
  const head = sentence.slice(0, max)
  const minCut = Math.floor(max * 0.4)
  let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '))
  cut = cut >= minCut ? cut + 1 : head.lastIndexOf(' ')
  if (cut < minCut) cut = max
  return [sentence.slice(0, cut).trim(), ...splitLong(sentence.slice(cut).trim(), max)]
}

/**
 * Text laid out in lines, whose sentences may still be arriving: conversation
 * mode speaks the first translated sentence while the next is translated.
 */
export interface PendingLine {
  sentences: Promise<string>[]
  /** The line break after this line ('' for the last). */
  eol: string
}

export const pendingLines = (text: string): PendingLine[] =>
  segment(text).map((l) => ({ sentences: l.sentences.map((s) => Promise.resolve(s)), eol: l.eol }))

/** One sentence's parts, each followed by a sentence pause until the caller knows better. */
function sentenceParts(sentence: string, lang: Lang, raw: boolean): SpeechPart[] {
  return splitLong(sentence)
    .filter(speakable)
    .map((piece) => ({ text: piece, spoken: raw ? piece : toSpokenForm(piece, lang), pauseAfterMs: PAUSE_SENTENCE_MS }))
}

/** What will be spoken, in order. Pure; the unit tests pin it down. */
export function planSpeech(text: string, lang: Lang, { raw = false } = {}): SpeechPart[] {
  const parts: SpeechPart[] = []
  for (const line of segment(text)) {
    for (const sentence of line.sentences) parts.push(...sentenceParts(sentence, lang, raw))
    const last = parts.at(-1)
    if (last && line.eol) last.pauseAfterMs = PAUSE_LINE_MS
  }
  if (parts.length) parts.at(-1)!.pauseAfterMs = 0
  return parts
}

export function durationFlags(spoken: string, audioMs: number, lang: Lang): TtsFlag[] {
  if (audioMs === 0) return ['no-audio']
  const letters = spoken.match(/[\p{L}\p{N}]/gu)?.length ?? 0
  const { min, max } = MS_PER_LETTER[lang]
  if (audioMs > letters * max + DURATION_SLACK_MS) return ['too-long']
  if (audioMs < letters * min) return ['too-short']
  return []
}

/** Gapless playback that starts with the first chunk: total wait for chunks that arrive late. */
export function playbackStall(chunks: { atMs: number; audioMs: number }[]): number {
  let stall = 0
  let playedUntil: number | undefined
  for (const { atMs, audioMs } of chunks) {
    if (playedUntil !== undefined && atMs > playedUntil) stall += atMs - playedUntil
    playedUntil = Math.max(playedUntil ?? atMs, atMs) + audioMs
  }
  return stall
}

export class ReadAloud {
  constructor(private readonly speaker: Speaker) {}

  /**
   * Speaks `text`, or lines whose sentences are still arriving: each sentence
   * is spoken once it is there and everything before it has been spoken.
   * Same parts and pauses as `planSpeech`.
   */
  async speak(text: string | PendingLine[], lang: Lang, opts: SpeakOptions = {}): Promise<Speech> {
    const t0 = performance.now()
    const lines = typeof text === 'string' ? pendingLines(text) : text
    const chunks: Float32Array[] = []
    const arrivals: { atMs: number; audioMs: number }[] = []
    const parts: SpokenPart[] = []
    const said: string[] = []
    let sampleRate = 0
    let total = 0

    const emit = (samples: Float32Array, rate: number) => {
      if (sampleRate && rate !== sampleRate) throw new Error(`TTS sample rate changed from ${sampleRate} to ${rate} Hz`)
      sampleRate = rate
      chunks.push(samples)
      total += samples.length
      arrivals.push({ atMs: performance.now() - t0, audioMs: (samples.length / rate) * 1000 })
      opts.onAudio?.({ samples, sampleRate: rate })
    }

    for (const line of lines) {
      const sentences: string[] = []
      for (const pending of line.sentences) {
        const sentence = await pending
        sentences.push(sentence)
        for (const part of sentenceParts(sentence, lang, opts.raw ?? false)) {
          // The pause after a part is only known once the next part exists (none after the last).
          const prev = parts.at(-1)
          if (prev?.pauseAfterMs && sampleRate) emit(new Float32Array(Math.round((prev.pauseAfterMs / 1000) * sampleRate)), sampleRate)
          const startMs = sampleRate ? (total / sampleRate) * 1000 : 0
          const before = total
          const s0 = performance.now()
          await this.speaker.speak(part.spoken, lang, (chunk) => emit(chunk.samples, chunk.sampleRate))
          const synthMs = performance.now() - s0
          const audioMs = sampleRate ? ((total - before) / sampleRate) * 1000 : 0
          parts.push({ ...part, startMs, audioMs, synthMs, flags: durationFlags(part.spoken, audioMs, lang) })
        }
      }
      said.push(sentences.join(' ') + line.eol)
      const last = parts.at(-1)
      if (last && line.eol) last.pauseAfterMs = PAUSE_LINE_MS
    }
    if (parts.length) parts.at(-1)!.pauseAfterMs = 0

    const samples = new Float32Array(total)
    let at = 0
    for (const c of chunks) {
      samples.set(c, at)
      at += c.length
    }
    const audioMs = sampleRate ? (total / sampleRate) * 1000 : 0
    const synthMs = arrivals.length ? arrivals.at(-1)!.atMs : performance.now() - t0
    const flags = new Set(parts.flatMap((p) => p.flags))
    return {
      lang,
      text: typeof text === 'string' ? text : said.join(''),
      parts,
      samples,
      sampleRate,
      audioMs,
      synthMs,
      firstAudioMs: arrivals[0]?.atMs ?? 0,
      realTimeFactor: audioMs ? synthMs / audioMs : 0,
      stallMs: playbackStall(arrivals),
      flags: TTS_FLAGS.filter((f) => flags.has(f))
    }
  }
}
