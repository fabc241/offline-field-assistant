/**
 * English ↔ Swahili translation with a back-translation check.
 *
 * Text is translated sentence by sentence (the model stops at a line break)
 * and reassembled with its original line breaks. The check translates each
 * sentence back and compares it with the source; anything that might have
 * changed meaning is flagged for the speakers to confirm. Flags never block a
 * translation: the app shows them, people decide.
 */
import { performance } from 'node:perf_hooks'
import type { Embedder, Lang, Translator } from '../../core/engines.js'
import { cosine, countNegations, looksUntranslated, mentionsClockTime } from './checks.js'
import { diffQuantities, extractQuantities, formatQuantity, type QuantityDiff } from './quantities.js'
import { reassemble, segment, type Line } from './segment.js'

/** Most severe first; this is also the display order. */
export const FLAGS = [
  'empty-output',
  'untranslated',
  'numbers-changed',
  'negation-changed',
  'low-fidelity',
  'clock-time'
] as const
export type Flag = (typeof FLAGS)[number]

/** What each flag asks the speakers to do. */
export const FLAG_HELP: Record<Flag, string> = {
  'empty-output': 'The model returned nothing. Rephrase and try again.',
  untranslated: 'The text came back untranslated. Rephrase and try again.',
  'numbers-changed': 'A number, dose or duration differs. Confirm it out loud.',
  'negation-changed': 'A "not" or "no" was lost or added. Confirm the instruction.',
  'low-fidelity': 'The back-translation drifts from the original. Rephrase more simply.',
  'clock-time': 'Swahili counts hours from 6 a.m. (8 a.m. is "saa mbili asubuhi"). Confirm the time.'
}

export interface SentencePair {
  source: string
  translation: string
}

export interface Translation {
  from: Lang
  to: Lang
  source: string
  translation: string
  sentences: SentencePair[]
  /** Layout of `source`, used to reassemble the back-translation. */
  lines: Line[]
  translateMs: number
}

export interface NumericCheck {
  ok: boolean
  /** Quantities found in the source. */
  source: string[]
  /** Translation vs source, values only (unit words move between languages). */
  translation: QuantityDiff
  /** Back-translation vs source, values and units. */
  backTranslation: QuantityDiff
}

export interface SentenceCheck extends SentencePair {
  backTranslation: string
  /** Cosine similarity of source and back-translation embeddings. */
  fidelity: number
  numericCheck: NumericCheck
  flags: Flag[]
}

export interface CheckedTranslation extends Omit<Translation, 'sentences'> {
  backTranslation: string
  /** Lowest sentence fidelity: one bad sentence is enough to doubt the whole. */
  fidelity: number
  numericCheck: NumericCheck
  flags: Flag[]
  sentences: SentenceCheck[]
  timings: { translateMs: number; backTranslateMs: number; checkMs: number }
}

export interface TranslationServiceOptions {
  /** Per source language: sentences whose fidelity falls below this get `low-fidelity`. */
  fidelityThreshold?: Partial<Record<Lang, number>>
  /**
   * Model for the back-translation; defaults to the forward translator. A
   * model tends to undo its own mistakes on the way back, so a different one
   * makes the check more independent.
   */
  backTranslator?: Translator
}

/**
 * Calibrated on the intake set (eval/RESULTS.md, F1). The embedder scores
 * Swahili paraphrases lower than English ones ("mimba" vs "mjamzito" ≈ 0.79),
 * so Swahili sources get a lower bar. Fidelity only catches gross meaning
 * loss; negations and numbers have their own checks.
 */
export const DEFAULT_FIDELITY_THRESHOLD: Record<Lang, number> = { en: 0.85, sw: 0.75 }

export class TranslationService {
  private readonly threshold: Record<Lang, number>
  private readonly backTranslator: Translator

  constructor(
    private readonly translator: Translator,
    private readonly embedder: Embedder,
    opts: TranslationServiceOptions = {}
  ) {
    this.threshold = { ...DEFAULT_FIDELITY_THRESHOLD, ...opts.fidelityThreshold }
    this.backTranslator = opts.backTranslator ?? translator
  }

  async translate(text: string, from: Lang, to: Lang): Promise<Translation> {
    if (from === to) throw new Error(`Source and target language are both "${from}"`)
    const t0 = performance.now()
    const lines = segment(text)
    const sources = lines.flatMap((l) => l.sentences)
    const translations: string[] = []
    for (const s of sources) translations.push(await this.translator.translate(s, from, to))
    return {
      from,
      to,
      source: text,
      translation: reassemble(lines, translations),
      sentences: sources.map((source, i) => ({ source, translation: translations[i]! })),
      lines,
      translateMs: performance.now() - t0
    }
  }

  /** Back-translates and checks a translation. Separate so callers can act on the translation first. */
  async check(t: Translation): Promise<CheckedTranslation> {
    const t0 = performance.now()
    const backs: string[] = []
    for (const s of t.sentences) {
      backs.push(s.translation ? await this.backTranslator.translate(s.translation, t.to, t.from) : '')
    }
    const t1 = performance.now()

    const vectors = await this.embedder.embed([...t.sentences.map((s) => s.source), ...backs], 'similarity')
    const sentences = t.sentences.map((s, i): SentenceCheck => {
      const fidelity = backs[i] ? cosine(vectors[i]!, vectors[t.sentences.length + i]!) : 0
      return this.checkSentence(s, backs[i]!, fidelity, t.from, t.to)
    })
    const t2 = performance.now()

    const all = <K extends keyof QuantityDiff>(side: 'translation' | 'backTranslation', key: K) =>
      sentences.flatMap((s) => s.numericCheck[side][key])
    return {
      from: t.from,
      to: t.to,
      source: t.source,
      translation: t.translation,
      lines: t.lines,
      translateMs: t.translateMs,
      backTranslation: reassemble(t.lines, backs),
      fidelity: sentences.length ? Math.min(...sentences.map((s) => s.fidelity)) : 1,
      numericCheck: {
        ok: sentences.every((s) => s.numericCheck.ok),
        source: sentences.flatMap((s) => s.numericCheck.source),
        translation: { missing: all('translation', 'missing'), added: all('translation', 'added') },
        backTranslation: { missing: all('backTranslation', 'missing'), added: all('backTranslation', 'added') }
      },
      flags: FLAGS.filter((f) => sentences.some((s) => s.flags.includes(f))),
      sentences,
      timings: { translateMs: t.translateMs, backTranslateMs: t1 - t0, checkMs: t2 - t1 }
    }
  }

  async translateWithCheck(text: string, from: Lang, to: Lang): Promise<CheckedTranslation> {
    return this.check(await this.translate(text, from, to))
  }

  private checkSentence(pair: SentencePair, back: string, fidelity: number, from: Lang, to: Lang): SentenceCheck {
    const { source, translation } = pair
    const clock = mentionsClockTime(source, from) || mentionsClockTime(translation, to)

    const sourceQ = extractQuantities(source, from)
    // A correctly converted Swahili clock time has different digits, so the
    // cross-language comparison is left to the clock-time flag.
    const vsTranslation = clock
      ? { missing: [], added: [] }
      : diffQuantities(sourceQ, extractQuantities(translation, to), { units: false })
    const vsBack = diffQuantities(sourceQ, extractQuantities(back, from), { units: true })
    const numbersOk = [vsTranslation, vsBack].every((d) => d.missing.length === 0 && d.added.length === 0)

    const flags = new Set<Flag>()
    if (!translation) flags.add('empty-output')
    if (looksUntranslated(source, translation)) flags.add('untranslated')
    if (!numbersOk) flags.add('numbers-changed')
    if (from === 'en' && countNegations(source) !== countNegations(back)) flags.add('negation-changed')
    if (fidelity < this.threshold[from]) flags.add('low-fidelity')
    if (clock) flags.add('clock-time')

    return {
      source,
      translation,
      backTranslation: back,
      fidelity,
      numericCheck: {
        ok: numbersOk,
        source: sourceQ.map(formatQuantity),
        translation: vsTranslation,
        backTranslation: vsBack
      },
      flags: FLAGS.filter((f) => flags.has(f))
    }
  }
}
