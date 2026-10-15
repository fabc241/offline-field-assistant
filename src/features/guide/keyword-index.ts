/**
 * Keyword half of the guide search: BM25 over each card's text in both
 * languages, so a query that mixes them ("mtoto ana fever") still finds its
 * card. Query words match card words the way the phrasebook matches them
 * (word starts, parts of words, small typos, a few word forms), plus the
 * forms guidance text needs: English plurals and Swahili verbs, whose
 * subject and tense prefixes differ between a question ("anatapika") and
 * a card ("kutapika").
 */
import { stems as phraseStems, searchWords, wordMatch } from '../phrasebook/phrasebook.js'

export interface KeywordDoc {
  id: string
  /** Text per field, with how many times each of its words counts (a title outweighs a step). */
  fields: { text: string; weight: number }[]
}

export interface KeywordScore {
  id: string
  /** BM25: ranks cards against each other; not comparable across queries. */
  bm25: number
  /**
   * 0–1: the share of the query's words this card matches, each word weighted
   * by how rare it is among the cards. A word no card has counts most, so
   * "child toothache" does not match a child card on "child" alone.
   */
  coverage: number
}

/** Words that carry no topic, dropped from queries and cards alike. */
export const STOPWORDS = new Set([
  // English
  ...'a an the and or but of to in on at by for from with without into about as is are was were be been being am do does did done has have had having what which who whom whose how when where why i you he she it we they me him her us them my your his its our their this that these those there here can could should would will shall may might must if then than so very just also any some please tell me'.split(' '),
  // Swahili: connectives, "of" in every noun class, question words, "has/have"
  ...'na ya wa za la cha vya kwa katika ni si au kama pia tu hata lakini kuhusu je nini gani ipi vipi wapi lini ana una nina tuna mna wana hana sina hii huu hiyo hizi hilo yake wake zake lake chake kwake yangu wangu nifanye nitafanye tufanye afanye'.split(' ')
])

const BM25_K1 = 1.2
const BM25_B = 0.75
/** A query word matched through one of its other forms counts for this much less. */
const STEM_FACTOR = 0.9
const MIN_PLURAL_STEM = 3
const MIN_VERB_STEM = 4
/** Swahili subject + tense markers (a-na-tapika, u-me-ungua, wa-ta-kula) and the negative ha- (ha-nyonyi). */
const SW_VERB_PREFIX = /^(?:(?:ni|u|a|tu|m|wa|ki|vi|i|zi|li|ya)(?:na|li|ta|me)|ha)/

/**
 * Other forms of a query word to look for, beyond the phrasebook's
 * (-ing, -ed, ku-): English plurals ("signs" → "sign") and Swahili verbs
 * without their subject and tense ("anatapika" → "tapika", found in
 * "kutapika"). Like the phrasebook's, these apply to either language.
 */
export function wordForms(word: string): string[] {
  const out = new Set(phraseStems(word))
  if (word.endsWith('s') && !word.endsWith('ss') && word.length - 1 >= MIN_PLURAL_STEM) out.add(word.slice(0, -1))
  const prefix = SW_VERB_PREFIX.exec(word)?.[0]
  if (prefix && word.length - prefix.length >= MIN_VERB_STEM) out.add(word.slice(prefix.length))
  out.delete(word)
  return [...out]
}

/** How well a query word matches a card word: the phrasebook's match, or one of its forms' at a discount. */
export function termMatch(query: string, term: string, forms = wordForms(query)): number {
  let best = wordMatch(query, term)
  for (const form of forms) best = Math.max(best, STEM_FACTOR * wordMatch(form, term))
  return best
}

/** Content words of a text, lowercased and without accents. */
export const contentWords = (text: string): string[] => searchWords(text).filter((w) => !STOPWORDS.has(w))

interface IndexedDoc {
  id: string
  tf: Map<string, number>
  length: number
}

export class KeywordIndex {
  private readonly docs: IndexedDoc[]
  private readonly df = new Map<string, number>()
  private readonly avgLength: number
  /** Query word → matching card words, with how well each matches. */
  private readonly expansions = new Map<string, Map<string, number>>()

  constructor(docs: KeywordDoc[]) {
    this.docs = docs.map(({ id, fields }) => {
      const tf = new Map<string, number>()
      let length = 0
      for (const { text, weight } of fields) {
        for (const word of contentWords(text)) {
          tf.set(word, (tf.get(word) ?? 0) + weight)
          length += weight
        }
      }
      return { id, tf, length }
    })
    for (const { tf } of this.docs) for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1)
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length)
  }

  /** Every document, in index order; those the query does not touch score 0. */
  score(query: string): KeywordScore[] {
    const words = [...new Set(contentWords(query))]
    const n = this.docs.length
    // match[q][d]: how well doc d matches query word q; bm25[q][d]: that word's BM25 contribution.
    const match = words.map(() => new Array<number>(n).fill(0))
    const bm25 = words.map(() => new Array<number>(n).fill(0))
    for (const [q, word] of words.entries()) {
      for (const [term, m] of this.expand(word)) {
        const idf = Math.log(1 + (n - this.df.get(term)! + 0.5) / (this.df.get(term)! + 0.5))
        for (const [d, doc] of this.docs.entries()) {
          const tf = doc.tf.get(term)
          if (!tf) continue
          const saturated = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / this.avgLength))
          match[q]![d] = Math.max(match[q]![d]!, m)
          bm25[q]![d] = Math.max(bm25[q]![d]!, m * idf * saturated)
        }
      }
    }
    const weights = match.map((m) => Math.log((n + 1) / (m.filter((x) => x > 0).length + 0.5)))
    const total = weights.reduce((s, w) => s + w, 0)
    return this.docs.map(({ id }, d) => ({
      id,
      bm25: bm25.reduce((s, b) => s + b[d]!, 0),
      coverage: total ? match.reduce((s, m, q) => s + weights[q]! * m[d]!, 0) / total : 0
    }))
  }

  private expand(word: string): Map<string, number> {
    let terms = this.expansions.get(word)
    if (!terms) {
      terms = new Map()
      const forms = wordForms(word)
      for (const term of this.df.keys()) {
        const m = termMatch(word, term, forms)
        if (m > 0) terms.set(term, m)
      }
      this.expansions.set(word, terms)
    }
    return terms
  }
}
