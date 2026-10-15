/**
 * The phrasebook: fixed phrases from a verified content pack, each with a
 * recording per language. Recordings are played exactly as they are in the
 * pack. Nothing here synthesizes speech, and a phrase without a recording
 * cannot get this far: the pack build refuses it, and so does the loader.
 *
 * Search is keyword search over the phrase text, forgiving of word
 * fragments, small typos and a few word forms (Swahili builds words from
 * parts: "harisha" and "kuhara" should both find "Unaharisha?").
 */
import { LANGS, type Lang } from '../../core/engines.js'
import type { Phrase } from '../packs/content.js'
import type { LoadedPack } from '../packs/loader.js'

export interface PhraseRecording {
  /** Path inside the pack, e.g. "audio/sym-fever.sw.wav". */
  path: string
  /** A text-to-speech placeholder, not a native speaker: the UI must say so. */
  synthetic: boolean
}

export interface PhraseEntry {
  id: string
  category: string
  text: Record<Lang, string>
  vettedBy: string
  recordings: Record<Lang, PhraseRecording>
}

export interface PhraseHit {
  phrase: PhraseEntry
  /** 0–1: the share of the query's (weighted) words the phrase matches. */
  score: number
}

export interface SearchOptions {
  /** Most hits returned; default 5. */
  limit?: number
  /**
   * How much a match in the other language's text counts, from 0 (none) to 1.
   * Queries mix languages ("homa ya child"); the query's own language still ranks first.
   */
  otherLangWeight?: number
}

export class PhraseNotFoundError extends Error {
  constructor(id: string) {
    super(`No phrase "${id}" in this pack`)
    this.name = 'PhraseNotFoundError'
  }
}

/** How well one query word matches one phrase word. */
const MATCH = { exact: 1, prefix: 0.9, inside: 0.8, typo: 0.6 } as const
/** Shortest query word matched as a prefix, as a part of a word, and with typos (1 edit; 2 from 9 letters). */
const MIN_PREFIX = 3
const MIN_INSIDE = 4
const MIN_TYPO = 5
const MIN_TWO_TYPOS = 9
const DEFAULT_OTHER_LANG_WEIGHT = 0.8
/** A query word with its ending or prefix taken off matches for this much less. */
const STEM_FACTOR = 0.9
const MIN_STEM = 4

interface Indexed {
  entry: PhraseEntry
  words: Record<Lang, string[]>
}

export class Phrasebook {
  readonly packId: string
  readonly packVersion: string
  /** The pack's notice, e.g. "PLACEHOLDER – NOT CLINICALLY VETTED". */
  readonly notice: string | undefined
  private readonly phrases: Indexed[]
  private readonly byId: Map<string, PhraseEntry>
  private readonly audio: Map<string, Uint8Array>

  constructor(pack: LoadedPack) {
    const synthetic = new Set(pack.manifest.files.filter((f) => f.synthetic).map((f) => f.path))
    const recording = (p: Phrase, lang: Lang): PhraseRecording => {
      const path = p.audio[lang]
      // The loader guarantees this; checked again because the alternative would be silence.
      if (!pack.audio.has(path)) throw new Error(`Phrase ${p.id} has no ${lang} recording in pack ${pack.manifest.id}`)
      return { path, synthetic: synthetic.has(path) }
    }
    this.packId = pack.manifest.id
    this.packVersion = pack.manifest.version
    this.notice = pack.manifest.notice
    this.audio = pack.audio
    this.phrases = pack.content.phrases.map((p) => ({
      entry: {
        id: p.id,
        category: p.category,
        text: { ...p.text },
        vettedBy: p.vettedBy,
        recordings: { en: recording(p, 'en'), sw: recording(p, 'sw') }
      },
      words: { en: searchWords(p.text.en), sw: searchWords(p.text.sw) }
    }))
    this.byId = new Map(this.phrases.map(({ entry }) => [entry.id, entry]))
  }

  /** Categories in pack order. */
  categories(): string[] {
    return [...new Set(this.phrases.map(({ entry }) => entry.category))]
  }

  /** Every phrase, or those of one category, in pack order. */
  list(category?: string): PhraseEntry[] {
    return this.phrases.map(({ entry }) => entry).filter((e) => category === undefined || e.category === category)
  }

  get(id: string): PhraseEntry | undefined {
    return this.byId.get(id)
  }

  /** Phrases matching the query's words, best first; ties keep pack order. */
  search(query: string, lang: Lang, { limit = 5, otherLangWeight = DEFAULT_OTHER_LANG_WEIGHT }: SearchOptions = {}): PhraseHit[] {
    const queryWords = [...new Set(searchWords(query))]
    if (!queryWords.length) return []
    const other = LANGS.find((l) => l !== lang)!
    // matches[q][p]: how well phrase p matches query word q.
    const matches = queryWords.map((q) =>
      this.phrases.map(({ words }) => Math.max(bestMatch(q, words[lang]), otherLangWeight * bestMatch(q, words[other])))
    )
    // Rare words decide; a word most phrases share ("you", "una") barely counts.
    const n = this.phrases.length
    const weights = matches.map((m) => Math.log((n + 1) / (m.filter((x) => x > 0).length + 0.5)))
    const total = weights.reduce((s, w) => s + w, 0)
    return this.phrases
      .map(({ entry }, p) => ({ phrase: entry, score: matches.reduce((s, m, q) => s + weights[q]! * m[p]!, 0) / total }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Where a phrase's recording sits in the pack. Throws PhraseNotFoundError. */
  audioPath(id: string, lang: Lang): string {
    const entry = this.byId.get(id)
    if (!entry) throw new PhraseNotFoundError(id)
    return entry.recordings[lang].path
  }

  /** The recording's WAV bytes, exactly as signed into the pack. Throws PhraseNotFoundError. */
  recording(id: string, lang: Lang): Uint8Array {
    return this.audio.get(this.audioPath(id, lang))!
  }
}

/** Lowercase words without accents or apostrophes: "Ng'ombe, SAWA?" → ["ngombe", "sawa"]. */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function bestMatch(query: string, words: string[]): number {
  let best = 0
  for (const word of words) {
    best = Math.max(best, wordMatch(query, word))
    if (best === MATCH.exact) return best
  }
  if (best >= MATCH.inside) return best
  for (const stem of stems(query)) {
    for (const word of words) best = Math.max(best, STEM_FACTOR * wordMatch(stem, word))
  }
  return best
}

/**
 * The query word without a common ending or prefix, for phrases that use
 * another form of it: English -ing and -ed ("vomiting" → "vomit", found in
 * "vomited"), and the Swahili infinitive ku- ("kupumua" → "pumua", found in
 * "Unapumua"). Both rules apply to either language, since queries mix them.
 */
export function stems(word: string): string[] {
  const out: string[] = []
  for (const ending of ['ing', 'ed']) {
    if (word.endsWith(ending) && word.length - ending.length >= MIN_STEM) out.push(word.slice(0, -ending.length))
  }
  if (word.startsWith('ku') && word.length - 2 >= MIN_STEM) out.push(word.slice(2))
  return out
}

export function wordMatch(query: string, word: string): number {
  if (word === query) return MATCH.exact
  if (query.length >= MIN_PREFIX && word.startsWith(query)) return MATCH.prefix
  if (query.length >= MIN_INSIDE && word.includes(query)) return MATCH.inside
  if (query.length >= MIN_TYPO) {
    const allowed = query.length >= MIN_TWO_TYPOS ? 2 : 1
    if (substringDistance(query, word) <= allowed) return MATCH.typo
  }
  return 0
}

/**
 * Fewest edits (substitute, insert, delete, or swap two neighbours) that
 * turn `query` into some part of `word`: "kikohoz" in "kikohozi" is 0,
 * "harsha" in "unaharisha" is 1.
 */
export function substringDistance(query: string, word: string): number {
  const q = [...query]
  const w = [...word]
  // rows[i][j]: best for q[0..i) ending at w[0..j); the match may start anywhere, so row 0 is all zeros.
  let prev2: number[] = []
  let prev = new Array<number>(w.length + 1).fill(0)
  for (let i = 1; i <= q.length; i++) {
    const cur = [i]
    for (let j = 1; j <= w.length; j++) {
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (q[i - 1] === w[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && q[i - 1] === w[j - 2] && q[i - 2] === w[j - 1]) d = Math.min(d, prev2[j - 2]! + 1)
      cur[j] = d
    }
    prev2 = prev
    prev = cur
  }
  return Math.min(...prev)
}
