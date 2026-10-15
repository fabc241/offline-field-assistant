import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../../src/core/config.js'
import { LANGS, type Embedder, type Lang, type Transcriber } from '../../src/core/engines.js'
import { DEFAULT_THRESHOLDS, Guide, NO_MATCH_MESSAGE, type GuideOptions, type GuideResult } from '../../src/features/guide/guide.js'
import { KeywordIndex, termMatch, wordForms } from '../../src/features/guide/keyword-index.js'
import type { Card } from '../../src/features/packs/content.js'
import { cardEmbeddingText, type CardVectors } from '../../src/features/packs/embeddings.js'
import type { LoadedPack } from '../../src/features/packs/loader.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'

const card = (id: string, title: [string, string], signs: [string, string][], steps: [string, string][], tags: string[]): Card => ({
  id,
  title: { en: title[0], sw: title[1] },
  dangerSigns: { en: signs.map((s) => s[0]), sw: signs.map((s) => s[1]) },
  steps: { en: steps.map((s) => s[0]), sw: steps.map((s) => s[1]) },
  tags,
  source: 'PLACEHOLDER',
  version: 1
})

/** Five of the sample pack's cards. */
const CARDS: Card[] = [
  card('fever-child', ['Fever in a child', 'Homa kwa mtoto'], [['Convulsions', 'Degedege'], ['Stiff neck', 'Shingo imekakamaa'], ['Vomits everything', 'Anatapika kila kitu']], [['Measure the temperature', 'Pima joto la mwili'], ['Give plenty of fluids', 'Mpe maji mengi ya kunywa']], ['fever', 'malaria', 'child']),
  card('cough-child', ['Cough or difficult breathing in a child', 'Kikohozi au kupumua kwa shida kwa mtoto'], [['Chest pulls in when breathing', 'Kifua kinavutika ndani wakati wa kupumua'], ['Lips or tongue look blue', 'Midomo au ulimi una rangi ya bluu']], [['Count the breaths for one full minute', 'Hesabu pumzi kwa dakika moja kamili']], ['cough', 'pneumonia', 'breathing', 'child']),
  card('burns', ['Burns', 'Kuungua moto'], [['Burn larger than the patient\'s palm', 'Jeraha kubwa kuliko kiganja cha mgonjwa']], [['Cool the burn with clean running water for 20 minutes', 'Poza jeraha kwa maji safi yanayotiririka kwa dakika 20'], ['Do not apply butter, oil or toothpaste', 'Usipake siagi, mafuta wala dawa ya meno']], ['burns', 'injury']),
  card('wound-care', ['Wound care', 'Kutunza kidonda'], [['Pus or a bad smell', 'Usaha au harufu mbaya'], ['Fever', 'Homa']], [['Clean the wound with clean water', 'Safisha kidonda kwa maji safi'], ['Cover it with a clean dressing', 'Funika kwa bandeji safi']], ['wound', 'injury', 'infection']),
  card('diarrhoea-adult', ['Diarrhoea in an adult', 'Kuharisha kwa mtu mzima'], [['Blood in the stool', 'Damu kwenye kinyesi'], ['Very weak or confused', 'Dhaifu sana au amechanganyikiwa']], [['Give oral rehydration solution after every loose stool', 'Mpe ORS kila baada ya kuharisha']], ['diarrhoea', 'dehydration', 'adult'])
]

/**
 * A stand-in for EmbeddingGemma: one dimension per topic, set by any of the
 * topic's words (synonyms included), plus a constant one every text shares.
 * Queries sit near their topic's card and far from the others.
 */
const TOPICS: string[][] = [
  ['fever', 'homa', 'hot'],
  ['cough', 'breath', 'wheez', 'gasping', 'kikohozi', 'pumu'],
  ['burns', 'burn ', 'scald', 'ungua'],
  ['wound', 'kidonda', 'cut', 'machete'],
  ['diarrhoea', 'kuharisha', 'the runs']
]
const topicEmbedder = (calls: string[][] = []): Embedder => ({
  async embed(texts) {
    calls.push(texts)
    return texts.map((t) => {
      const v = [1, ...TOPICS.map((words) => (words.some((w) => t.toLowerCase().includes(w)) ? 3 : 0))]
      const norm = Math.hypot(...v)
      return v.map((x) => x / norm)
    })
  }
})

async function vectorsFor(cards: Card[], embedder: Embedder): Promise<CardVectors> {
  const vectors: CardVectors = new Map()
  for (const c of cards) {
    const [en, sw] = await embedder.embed(LANGS.map((l) => cardEmbeddingText(c, l)), 'document')
    vectors.set(c.id, { en: Float32Array.from(en!), sw: Float32Array.from(sw!) })
  }
  return vectors
}

function fakePack(cards: Card[], vectors: CardVectors | undefined): LoadedPack {
  return {
    manifest: {
      format: 1,
      kind: 'content',
      id: 'test-pack',
      title: 'Test',
      version: '1.0.0',
      created: '2026-10-15T08:00:00.000Z',
      notice: 'PLACEHOLDER',
      embedding: { model: 'm', sha256: 'a'.repeat(64), recipe: 'card-v1', dims: TOPICS.length + 1 },
      files: []
    },
    signedBy: { keyId: '0'.repeat(16), label: 'test' },
    content: { cards, phrases: [] },
    audio: new Map(),
    vectors,
    embeddings: vectors ? 'packed' : 'stale'
  }
}

const vectors = await vectorsFor(CARDS, topicEmbedder())
const keywordGuide = new Guide(fakePack(CARDS, vectors))
const hybridGuide = (opts: GuideOptions = {}) => new Guide(fakePack(CARDS, vectors), { embedder: topicEmbedder(), ...opts })
const ids = (r: GuideResult) => (r.status === 'match' ? r.hits.map((h) => h.card.id) : [])

describe('Guide results', () => {
  it('shows danger signs before steps, in the asked language, never empty', async () => {
    const result = await keywordGuide.search('homa mtoto', 'sw')
    expect(result.status).toBe('match')
    if (result.status !== 'match') return
    const { card } = result.hits[0]
    expect(card).toEqual({
      id: 'fever-child',
      lang: 'sw',
      title: 'Homa kwa mtoto',
      dangerSigns: ['Degedege', 'Shingo imekakamaa', 'Anatapika kila kitu'],
      steps: ['Pima joto la mwili', 'Mpe maji mengi ya kunywa'],
      source: 'PLACEHOLDER',
      version: 1
    })
    // As the UI and --json receive it: danger signs first.
    const json = JSON.stringify(result)
    expect(json.indexOf('"dangerSigns"')).toBeLessThan(json.indexOf('"steps"'))
    expect(Object.keys(card).indexOf('dangerSigns')).toBeLessThan(Object.keys(card).indexOf('steps'))
    expect(result).toMatchObject({ query: 'homa mtoto', lang: 'sw', notice: 'PLACEHOLDER' })
  })

  it('answers "no match — see a clinician" in the asked language when nothing fits', async () => {
    for (const lang of LANGS) {
      const result = await hybridGuide().search('how do I fix a bicycle', lang)
      expect(result).toMatchObject({ status: 'no-match', message: NO_MATCH_MESSAGE[lang] })
      expect(result).not.toHaveProperty('hits')
    }
    expect(NO_MATCH_MESSAGE.en).toMatch(/see a clinician/)
    expect(await keywordGuide.search('   ', 'en')).toMatchObject({ status: 'no-match' })
  })

  it('refuses a card without danger signs or steps, whatever the pack says', () => {
    const broken = { ...CARDS[0]!, dangerSigns: { en: [], sw: [] } }
    expect(() => new Guide(fakePack([broken], undefined))).toThrow(/no danger signs/)
  })

  it('lists cards and shows one by id', () => {
    expect(keywordGuide.list('en').map((c) => c.id)).toEqual(CARDS.map((c) => c.id))
    expect(keywordGuide.card('burns', 'en')?.title).toBe('Burns')
    expect(keywordGuide.card('nope', 'en')).toBeUndefined()
  })

  it('never generates: the guide imports no translator, speaker or model runtime', async () => {
    const source = await fs.readFile(path.join(PROJECT_ROOT, 'src/features/guide/guide.ts'), 'utf8')
    const imports = [...source.matchAll(/^import (type )?.* from '(.*)'/gm)].map((m) => `${m[1] ?? ''}${m[2]}`)
    expect(imports).toEqual([
      '../../core/engines.js',
      'type ../packs/content.js',
      'type ../packs/embeddings.js',
      'type ../packs/loader.js',
      'type ../speech/speech-service.js',
      '../translate/checks.js',
      './keyword-index.js'
    ])
    // engines.js is for the Embedder type and LANGS only.
    expect(source).toMatch(/^import \{ LANGS, type Embedder, type Lang \} from '..\/..\/core\/engines.js'$/m)
  })
})

describe('Guide keyword search', () => {
  const top = async (query: string, lang: Lang = 'en') => ids(await keywordGuide.search(query, lang))

  it('finds a card by its words in either language, and by a mix of both', async () => {
    expect((await top('child cough'))[0]).toBe('cough-child')
    expect((await top('kikohozi mtoto', 'sw'))[0]).toBe('cough-child')
    expect((await top('mtoto ana fever', 'sw'))[0]).toBe('fever-child')
    expect((await top('wound ina usaha'))[0]).toBe('wound-care')
  })

  it('forgives typos and finds other forms of a word', async () => {
    expect((await top('feaver in a child'))[0]).toBe('fever-child')
    expect((await top('mtoto ana kikohozo', 'sw'))[0]).toBe('cough-child')
    // Swahili verbs: the question's subject and tense differ from the card's.
    expect((await top('mtu mzima anaharisha', 'sw'))[0]).toBe('diarrhoea-adult')
    expect((await top('ameungua moto', 'sw'))[0]).toBe('burns')
    expect((await top('stools with blood'))[0]).toBe('diarrhoea-adult')
  })

  it('does not offer a card on a common word alone', async () => {
    expect(await top('child toothache')).toEqual([])
    expect(await top('mtoto ana jino', 'sw')).toEqual([])
  })

  it('runs on keywords alone without an embedder, and says why', async () => {
    const result = await keywordGuide.search('burns', 'en')
    expect(result).toMatchObject({ mode: 'keyword-only', degraded: 'no embedding model on this device' })
    if (result.status === 'match') expect(result.hits[0].confidence).toEqual({ keyword: expect.any(Number) })
  })
})

describe('Guide hybrid search', () => {
  it('finds a card by meaning when no keyword matches', async () => {
    const calls: string[][] = []
    const guide = new Guide(fakePack(CARDS, vectors), { embedder: topicEmbedder(calls) })
    const result = await guide.search('the kid feels hot', 'en')
    // Wound care lists fever among its danger signs, so it comes second.
    expect(ids(result)).toEqual(['fever-child', 'wound-care'])
    expect(calls).toEqual([['the kid feels hot']])
    if (result.status !== 'match') return
    expect(result.mode).toBe('hybrid')
    expect(result.hits[0].confidence.keyword).toBe(0)
    expect(result.hits[0].confidence.lift).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minLift)
  })

  it('offers nothing when the meaning half sees every card alike and no keyword matches', async () => {
    const flat: Embedder = { embed: async (texts) => texts.map(() => [1, 0, 0, 0, 0, 0]) }
    expect(await new Guide(fakePack(CARDS, vectors), { embedder: flat }).search('the kid feels hot', 'en')).toMatchObject({ status: 'no-match' })
  })

  it('ranks a full keyword match above a card the meaning half slightly prefers; rank fusion does not', async () => {
    // Every word is on the burns card, "clean" also on wound care. The meaning half leans,
    // weakly, the other way (as it does on Swahili queries): cosine 0.60 for wound care, 0.50 for burns.
    const cosines: Record<string, number> = { 'fever-child': 0.56, 'cough-child': 0.56, burns: 0.5, 'wound-care': 0.6, 'diarrhoea-adult': 0.55 }
    const leaning: CardVectors = new Map(
      Object.entries(cosines).map(([id, c]) => [id, { en: Float32Array.of(c, Math.sqrt(1 - c * c)), sw: Float32Array.of(c, Math.sqrt(1 - c * c)) }])
    )
    const guide = new Guide(fakePack(CARDS, leaning), { embedder: { embed: async (t) => t.map(() => [1, 0]) }, thresholds: { minCoverage: 0.45, minLift: 0 } })
    const query = 'toothpaste butter clean'
    expect(ids(await guide.search(query, 'en'))[0]).toBe('burns')
    expect(ids(await guide.search(query, 'en', { fusion: 'rrf' }))[0]).toBe('wound-care')
    expect(ids(await guide.search(query, 'en', { only: 'semantic' }))[0]).toBe('wound-care')
    expect(ids(await guide.search(query, 'en', { only: 'keyword' }))).toEqual(['burns'])
  })

  it('falls back to keywords when the vectors are stale or the embedder fails', async () => {
    const stale = await new Guide(fakePack(CARDS, undefined), { embedder: topicEmbedder() }).search('burns', 'en')
    expect(stale).toMatchObject({ status: 'match', mode: 'keyword-only', degraded: expect.stringMatching(/older card recipe/) })
    const failing: Embedder = { embed: async () => Promise.reject(new Error('model file missing')) }
    const broken = await new Guide(fakePack(CARDS, vectors), { embedder: failing }).search('burns', 'en')
    expect(broken).toMatchObject({ status: 'match', mode: 'keyword-only', degraded: 'the embedding model failed (model file missing)' })
    expect(ids(broken)[0]).toBe('burns')
  })

  it('returns at most `limit` cards', async () => {
    const guide = hybridGuide({ thresholds: { minCoverage: 0, minLift: -1 } })
    expect(ids(await guide.search('child', 'en'))).toHaveLength(3)
    expect(ids(await guide.search('child', 'en', { limit: 1 }))).toHaveLength(1)
  })
})

describe('Guide voice questions', () => {
  const transcriber = (text: string): Transcriber => ({ transcribe: async () => (text ? [{ text, startMs: 0, endMs: 1000 }] : []) })
  const second = new Float32Array(16_000).fill(0.1)

  it('transcribes in the given language, then searches what was heard', async () => {
    const asked: Lang[] = []
    const speech = new SpeechToText({ transcribe: async (_s, lang) => (asked.push(lang), [{ text: 'Mtoto ana homa.', startMs: 0, endMs: 1000 }]) })
    const { transcript, result } = await hybridGuide({ speech }).searchByVoice(second, 'sw')
    expect(asked).toEqual(['sw'])
    expect(transcript.text).toBe('Mtoto ana homa.')
    expect(result).toMatchObject({ status: 'match', query: 'Mtoto ana homa.', lang: 'sw' })
    expect(ids(result)[0]).toBe('fever-child')
  })

  it('answers "no match" when nothing was heard', async () => {
    const { transcript, result } = await hybridGuide({ speech: new SpeechToText(transcriber('')) }).searchByVoice(second, 'en')
    expect(transcript.flags).toContain('no-speech')
    expect(result).toMatchObject({ status: 'no-match', message: NO_MATCH_MESSAGE.en })
  })

  it('needs speech to text to be set up', async () => {
    await expect(keywordGuide.searchByVoice(second, 'en')).rejects.toThrow(/without speech to text/)
  })
})

describe('guessLang', () => {
  it('goes by the words the cards and function words use; English on a tie', () => {
    expect(keywordGuide.guessLang('mtoto ana homa na kutapika')).toBe('sw')
    expect(keywordGuide.guessLang('what should I do for a child with a fever')).toBe('en')
    expect(keywordGuide.guessLang('ORS')).toBe('sw')
    expect(keywordGuide.guessLang('paracetamol')).toBe('en')
  })
})

describe('keyword index', () => {
  it('finds other forms: plurals and Swahili verbs without subject and tense', () => {
    expect(wordForms('signs')).toContain('sign')
    expect(wordForms('illness')).not.toContain('illnes')
    expect(wordForms('anatapika')).toContain('tapika')
    expect(wordForms('ameungua')).toContain('ungua')
    expect(wordForms('hanyonyi')).toContain('nyonyi')
    expect(wordForms('kupumua')).toContain('pumua')
    expect(wordForms('ana')).toEqual([])
    expect(termMatch('anatapika', 'kutapika')).toBeGreaterThan(0)
    expect(termMatch('bicycle', 'breathing')).toBe(0)
  })

  it('weights coverage by rarity and drops stopwords', () => {
    const index = new KeywordIndex([
      { id: 'a', fields: [{ text: 'child fever', weight: 1 }] },
      { id: 'b', fields: [{ text: 'child cough', weight: 1 }] },
      { id: 'c', fields: [{ text: 'adult burns', weight: 1 }] }
    ])
    const [a, b, c] = index.score('what is the fever of the child')
    expect(a!.coverage).toBe(1)
    expect(b!.coverage).toBeGreaterThan(0)
    expect(b!.coverage).toBeLessThan(0.5)
    expect(c).toEqual({ id: 'c', bm25: 0, coverage: 0 })
    expect(a!.bm25).toBeGreaterThan(b!.bm25)
    expect(index.score('what is the')).toEqual([0, 0, 0].map((_, i) => ({ id: 'abc'[i], bm25: 0, coverage: 0 })))
  })
})
