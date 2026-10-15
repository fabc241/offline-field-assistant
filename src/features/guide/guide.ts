/**
 * Ask the guide: finds the guidance cards of a verified pack that answer a
 * question, typed or spoken, in English or Swahili. The guide only ever
 * returns cards as the organization wrote them. It generates nothing: when
 * no card matches well enough, the answer is "no match — see a clinician".
 *
 * Search is hybrid, in two halves that score every card:
 * - keywords: BM25 over both languages, forgiving of typos and word forms,
 *   and the coverage of the query's words (keyword-index.ts);
 * - meaning: cosine of the query with the pack's EmbeddingGemma card
 *   vectors, as a lift over the median card for that query. Swahili queries
 *   sit closer to every card than English ones do, so a raw cosine means
 *   different things in the two languages; the lift does not.
 * Cards rank by coverage + 2 × lift. Reciprocal-rank fusion of the BM25 and
 * cosine rankings is kept as an alternative: on the tuning queries it let a
 * weak meaning signal outrank a full keyword match (eval/RESULTS.md, F7).
 *
 * A card is offered only when one half is confident about it on its own:
 * the keywords cover most of the query, or the meaning lifts it well above
 * the typical card.
 */
import { LANGS, type Embedder, type Lang } from '../../core/engines.js'
import type { Card } from '../packs/content.js'
import type { CardVectors } from '../packs/embeddings.js'
import type { LoadedPack } from '../packs/loader.js'
import type { SpeechToText, Transcript } from '../speech/speech-service.js'
import { cosine } from '../translate/checks.js'
import { KeywordIndex, contentWords, type KeywordScore } from './keyword-index.js'

type NonEmpty<T> = readonly [T, ...T[]]

/** One card in one language. Danger signs come before steps, and neither is ever empty. */
export interface GuideCard {
  id: string
  lang: Lang
  title: string
  /** Shown first, always: any one of them means refer. */
  dangerSigns: NonEmpty<string>
  steps: NonEmpty<string>
  source: string
  version: number
}

export interface GuideHit {
  card: GuideCard
  confidence: {
    /** 0–1: the share of the query's words the card matches, rare words counting most. */
    keyword: number
    /** Cosine of the query with the card (the closer of its two languages); hybrid mode only. */
    semantic?: number
    /** That cosine minus the median card's for this query. */
    lift?: number
  }
}

export type SearchMode = 'hybrid' | 'keyword-only'

interface ResultBase {
  query: string
  lang: Lang
  mode: SearchMode
  /** Why the search ran on keywords alone, when it did. */
  degraded?: string
  /** The pack's notice, e.g. "PLACEHOLDER – NOT CLINICALLY VETTED". */
  notice?: string
}

/** Never empty: either cards, best first, or the message to see a clinician. */
export type GuideResult =
  | (ResultBase & { status: 'match'; hits: NonEmpty<GuideHit> })
  | (ResultBase & { status: 'no-match'; message: string })

export interface VoiceGuideResult {
  /** What was heard: the UI shows it, so a misheard question is caught. */
  transcript: Transcript
  result: GuideResult
}

export const NO_MATCH_MESSAGE: Record<Lang, string> = {
  en: 'No match in the guide — see a clinician.',
  sw: 'Hakuna mwongozo unaolingana — mwone mhudumu wa afya.'
}

export interface GuideThresholds {
  /** Keyword coverage at or above which a card is offered. */
  minCoverage: number
  /** Cosine lift over the median card at or above which a card is offered. */
  minLift: number
}

/**
 * Chosen on eval/datasets/guide-dev.csv, never on the eval queries: each sits
 * midway between the highest out-of-scope query (coverage 0.39, lift 0.16)
 * and the in-scope queries above it.
 */
export const DEFAULT_THRESHOLDS: GuideThresholds = { minCoverage: 0.45, minLift: 0.17 }
/** Weight of the meaning lift against keyword coverage when ranking. */
const LIFT_WEIGHT = 2
/** The usual reciprocal-rank fusion constant. */
const RRF_K = 60

export interface GuideOptions {
  /** Query embedder; without it, or when the pack's vectors are stale, search runs on keywords alone. */
  embedder?: Embedder
  /** For spoken questions. */
  speech?: SpeechToText
  thresholds?: GuideThresholds
}

export interface GuideSearchOptions {
  /** Most cards returned; default 3. */
  limit?: number
  /** For A/B evals: one half alone. */
  only?: 'keyword' | 'semantic'
  /** For A/B evals: how the halves' rankings merge; default "score" (coverage + 2 × lift). */
  fusion?: 'score' | 'rrf'
}

interface Scored {
  card: Card
  keyword?: KeywordScore
  semantic?: number
  lift?: number
}

export class Guide {
  readonly packId: string
  readonly packVersion: string
  readonly notice: string | undefined
  private readonly cards: Card[]
  private readonly byId: Map<string, Card>
  private readonly keywords: KeywordIndex
  private readonly vectors: CardVectors | undefined
  private readonly vocabulary: Record<Lang, Set<string>>
  private readonly thresholds: GuideThresholds

  constructor(
    pack: LoadedPack,
    private readonly opts: GuideOptions = {}
  ) {
    this.packId = pack.manifest.id
    this.packVersion = pack.manifest.version
    this.notice = pack.manifest.notice
    this.cards = pack.content.cards
    for (const card of this.cards) {
      // The schema guarantees this; checked again because the guide's answer depends on it.
      for (const lang of LANGS) {
        if (!card.dangerSigns[lang].length || !card.steps[lang].length) throw new Error(`Card ${card.id} has no danger signs or no steps in ${lang}`)
      }
    }
    this.byId = new Map(this.cards.map((c) => [c.id, c]))
    this.keywords = new KeywordIndex(
      this.cards.map((card) => ({
        id: card.id,
        fields: [
          ...LANGS.map((lang) => ({ text: card.title[lang], weight: 2 })),
          ...LANGS.flatMap((lang) => [...card.dangerSigns[lang], ...card.steps[lang]].map((text) => ({ text, weight: 1 }))),
          { text: card.tags.join(' '), weight: 1 }
        ]
      }))
    )
    this.vectors = pack.vectors
    this.vocabulary = Object.fromEntries(
      LANGS.map((lang) => [lang, new Set(this.cards.flatMap((c) => [c.title[lang], ...c.dangerSigns[lang], ...c.steps[lang]]).flatMap(contentWords))])
    ) as Record<Lang, Set<string>>
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS
  }

  /** How search will run, and why it is keyword-only when it is. */
  get mode(): { mode: SearchMode; degraded?: string } {
    if (!this.opts.embedder) return { mode: 'keyword-only', degraded: 'no embedding model on this device' }
    if (!this.vectors) return { mode: 'keyword-only', degraded: 'the pack was built with an older card recipe and could not be recomputed' }
    return { mode: 'hybrid' }
  }

  /** Every card, in pack order. */
  list(lang: Lang): GuideCard[] {
    return this.cards.map((c) => view(c, lang))
  }

  card(id: string, lang: Lang): GuideCard | undefined {
    const card = this.byId.get(id)
    return card && view(card, lang)
  }

  /** The cards that answer the query, best first, or "no match". `lang` is the language to show them in. */
  async search(query: string, lang: Lang, { limit = 3, only, fusion = 'score' }: GuideSearchOptions = {}): Promise<GuideResult> {
    let { mode, degraded } = this.mode
    const base = (): ResultBase => ({ query, lang, mode, ...(degraded ? { degraded } : {}), ...(this.notice ? { notice: this.notice } : {}) })
    if (!query.trim()) return { ...base(), status: 'no-match', message: NO_MATCH_MESSAGE[lang] }
    let cosines: number[] | undefined
    if (mode === 'hybrid' && only !== 'keyword') {
      try {
        cosines = await this.cosines(query)
      } catch (err) {
        // A broken embedding model must not take the guide down with it.
        mode = 'keyword-only'
        degraded = `the embedding model failed (${(err as Error).message})`
      }
    }
    if (only === 'semantic' && !cosines) throw new Error(`Meaning search is unavailable: ${degraded}`)
    const keyword = only === 'semantic' ? undefined : this.keywords.score(query)
    const median = cosines ? medianOf(cosines) : 0
    const scored = this.cards.map((card, i): Scored => ({
      card,
      ...(keyword ? { keyword: keyword[i]! } : {}),
      ...(cosines ? { semantic: cosines[i]!, lift: cosines[i]! - median } : {})
    }))

    const hits = (fusion === 'rrf' ? byRrf(scored) : byScore(scored))
      .filter((s) => (s.keyword?.coverage ?? 0) >= this.thresholds.minCoverage || (s.lift ?? -Infinity) >= this.thresholds.minLift)
      .slice(0, limit)
      .map((s): GuideHit => ({
        card: view(s.card, lang),
        confidence: { keyword: s.keyword?.coverage ?? 0, ...(s.lift !== undefined ? { semantic: s.semantic, lift: s.lift } : {}) }
      }))
    return isNonEmpty(hits) ? { ...base(), status: 'match', hits } : { ...base(), status: 'no-match', message: NO_MATCH_MESSAGE[lang] }
  }

  /** A spoken question: speech to text in the given language, then search. Nothing heard is "no match". */
  async searchByVoice(input: string | Float32Array, lang: Lang, opts: GuideSearchOptions = {}): Promise<VoiceGuideResult> {
    if (!this.opts.speech) throw new Error('This guide was set up without speech to text')
    const transcript = await this.opts.speech.transcribe(input, lang)
    return { transcript, result: await this.search(transcript.text, lang, opts) }
  }

  /** The query's language by its words: the one whose cards use more of them; English on a tie. */
  guessLang(query: string): Lang {
    const words = query.toLowerCase().split(/[^\p{L}']+/u)
    const count = (lang: Lang) =>
      contentWords(query).filter((w) => this.vocabulary[lang].has(w)).length + words.filter((w) => FUNCTION_WORDS[lang].has(w)).length
    return count('sw') > count('en') ? 'sw' : 'en'
  }

  private async cosines(query: string): Promise<number[]> {
    const [q] = await this.opts.embedder!.embed([query], 'query')
    if (!q) throw new Error('no vector returned')
    return this.cards.map((card) => {
      const v = this.vectors!.get(card.id)!
      return Math.max(...LANGS.map((lang) => cosine(q, [...v[lang]])))
    })
  }
}

/** Coverage + 2 × lift; ties go to BM25. Cards neither half touches are left out. */
function byScore(scored: Scored[]): Scored[] {
  const score = (s: Scored) => (s.keyword?.coverage ?? 0) + LIFT_WEIGHT * (s.lift ?? 0)
  return scored
    .filter((s) => (s.keyword?.bm25 ?? 0) > 0 || s.lift !== undefined)
    .sort((a, b) => score(b) - score(a) || (b.keyword?.bm25 ?? 0) - (a.keyword?.bm25 ?? 0))
}

/** Reciprocal-rank fusion of the BM25 and cosine rankings: 1 / (60 + rank) from each. */
function byRrf(scored: Scored[]): Scored[] {
  const fused = new Map<Scored, number>()
  const add = (score: (s: Scored) => number | undefined) => {
    const ranked = scored.filter((s) => (score(s) ?? 0) > 0).sort((a, b) => score(b)! - score(a)!)
    for (const [rank, s] of ranked.entries()) fused.set(s, (fused.get(s) ?? 0) + 1 / (RRF_K + rank + 1))
  }
  add((s) => s.keyword?.bm25)
  add((s) => s.semantic)
  return [...fused.keys()].sort((a, b) => fused.get(b)! - fused.get(a)! || (b.keyword?.coverage ?? 0) - (a.keyword?.coverage ?? 0))
}

function view(card: Card, lang: Lang): GuideCard {
  const [firstSign, ...signs] = card.dangerSigns[lang]
  const [firstStep, ...steps] = card.steps[lang]
  // Key order is the display order: danger signs first.
  return {
    id: card.id,
    lang,
    title: card.title[lang],
    dangerSigns: [firstSign!, ...signs],
    steps: [firstStep!, ...steps],
    source: card.source,
    version: card.version
  }
}

const isNonEmpty = <T>(xs: T[]): xs is [T, ...T[]] => xs.length > 0

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Words that mark a language without being in any card. */
const FUNCTION_WORDS: Record<Lang, Set<string>> = {
  en: new Set('the a an and of to in for with is are what how do does i my has have should'.split(' ')),
  sw: new Set('na ya wa za la cha vya kwa katika ni au kama je nini gani wapi ana una nifanye'.split(' '))
}
