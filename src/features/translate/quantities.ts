/**
 * Extracts the quantities in a sentence (numbers, doses, durations, counts,
 * clock times) so a translation can be checked for changed numbers.
 *
 * Digits and number words in both languages are read ("two tablets",
 * "vidonge viwili", "kumi na mbili"); units are mapped to one canonical name
 * per concept, so "siku 3" and "3 days" both give `3 day`.
 */
import type { Lang } from '../../core/engines.js'

export interface Quantity {
  /** Normalised value: "2.5", "120/80", or a 24-hour clock time like "9:30" / "21:00". */
  value: string
  /** Canonical unit ("mg", "day", "tablet", "clock"…), when one is attached. */
  unit?: string
}

export const formatQuantity = (q: Quantity) => (q.unit && q.unit !== 'clock' ? `${q.value} ${q.unit}` : q.value)

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Abbreviated and metric units, written after the number in both languages. */
const METRIC: Record<string, string> = {
  mg: 'mg', milligram: 'mg', milligrams: 'mg', miligramu: 'mg',
  mcg: 'mcg', µg: 'mcg', microgram: 'mcg', micrograms: 'mcg',
  g: 'g', gm: 'g', gram: 'g', grams: 'g', gramu: 'g',
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', kilogramu: 'kg',
  ml: 'ml', mls: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml', mililita: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l', lita: 'l',
  '%': '%', percent: '%',
  '°c': '°c', '°': '°c', degree: '°c', degrees: '°c', celsius: '°c',
  mmhg: 'mmhg'
}

/** English unit words, written after the number. */
const EN_UNITS: Record<string, string> = {
  ...METRIC,
  min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute',
  h: 'hour', hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour',
  day: 'day', days: 'day',
  wk: 'week', wks: 'week', week: 'week', weeks: 'week',
  month: 'month', months: 'month',
  yr: 'year', yrs: 'year', year: 'year', years: 'year',
  tab: 'tablet', tabs: 'tablet', tablet: 'tablet', tablets: 'tablet', pill: 'tablet', pills: 'tablet',
  capsule: 'tablet', capsules: 'tablet',
  time: 'time', times: 'time',
  dose: 'dose', doses: 'dose',
  drop: 'drop', drops: 'drop',
  tsp: 'spoon', teaspoon: 'spoon', teaspoons: 'spoon', tablespoon: 'spoon', tablespoons: 'spoon', spoon: 'spoon',
  spoons: 'spoon', spoonful: 'spoon', spoonfuls: 'spoon',
  sachet: 'sachet', sachets: 'sachet', packet: 'sachet', packets: 'sachet',
  injection: 'injection', injections: 'injection'
}

/** Swahili nouns, written before the number ("siku tatu", "vidonge 2"). */
const SW_UNITS: Record<string, string> = {
  dakika: 'minute',
  saa: 'hour', masaa: 'hour',
  siku: 'day',
  wiki: 'week',
  mwezi: 'month', miezi: 'month',
  mwaka: 'year', miaka: 'year',
  kidonge: 'tablet', vidonge: 'tablet', tembe: 'tablet',
  mara: 'time',
  dozi: 'dose',
  tone: 'drop', matone: 'drop',
  kijiko: 'spoon', vijiko: 'spoon',
  pakiti: 'sachet', paketi: 'sachet',
  sindano: 'injection',
  asilimia: '%',
  nyuzi: '°c', nyuzijoto: '°c', joto: '°c'
}

// ---------------------------------------------------------------------------
// Number words
// ---------------------------------------------------------------------------

const EN_SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
}
/** Frequency adverbs carry their own unit. */
const EN_TIMES: Record<string, number> = { once: 1, twice: 2, thrice: 3 }

const SW_SMALL: Record<string, number> = {
  mbili: 2, sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10, ishirini: 20, thelathini: 30, arobaini: 40,
  hamsini: 50, sitini: 60, sabini: 70, themanini: 80, tisini: 90
}
/** Numbers 1–5 agree with the noun class: mmoja, viwili, watatu, minne, matano… */
const SW_AGREEING = /^(?:mw|wa|vi|ki|ma|mi|zi|li|ji|ku|pa|mu|m|n|i|u)?(moja|wili|tatu|nne|tano)$/
const SW_STEMS: Record<string, number> = { moja: 1, wili: 2, tatu: 3, nne: 4, tano: 5 }
/** Words that look like an agreeing number but are not one. */
const SW_NOT_NUMBERS = new Set(['mwili' /* body */, 'utatu' /* trinity */])

interface Lexicon {
  /** Value of a number word that can combine with others, else undefined. */
  small(word: string): number | undefined
  /** Multipliers: hundred/thousand, mia/elfu. */
  scale: Record<string, number>
  /** English multiplies what came before ("five hundred"); Swahili what follows ("mia tano"). */
  scaleFollowsCount: boolean
  /** Joins parts of one number: "one hundred and five", "kumi na mbili". */
  joiner: string
  /** Fractions that stand alone. */
  fraction: Record<string, number>
}

const EN_LEX: Lexicon = {
  small: (w) => EN_SMALL[w],
  scale: { hundred: 100, thousand: 1000 },
  scaleFollowsCount: true,
  joiner: 'and',
  fraction: { half: 0.5, quarter: 0.25 }
}

const SW_LEX: Lexicon = {
  small: (w) => SW_SMALL[w] ?? (SW_NOT_NUMBERS.has(w) ? undefined : SW_STEMS[SW_AGREEING.exec(w)?.[1] ?? '']),
  scale: { mia: 100, elfu: 1000 },
  scaleFollowsCount: false,
  joiner: 'na',
  fraction: { nusu: 0.5, robo: 0.25 }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Punctuation is kept as tokens so separate numbers never merge ("twenty, five"). */
const TOKEN = /\d{1,2}:\d{2}|\d+\/\d+|\d+(?:[.,]\d+)*|[\p{L}°%µ']+|[,.;:!?()]/gu

function tokenize(text: string): string[] {
  const normalised = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\b([ap])\.m\.?/g, '$1m')
    // "500mg", "38.5°C", "5%", "5-year-old", "2-3" → separate tokens
    .replace(/(\d)(?=[\p{L}°%µ])/gu, '$1 ')
    .replace(/([\p{L}])(?=\d)/gu, '$1 ')
    .replace(/[-–]/g, ' ')
  return normalised.match(TOKEN) ?? []
}

/** "8:00", "8:00am" and "8 am" are the same time; "8:00pm" becomes "20:00". */
function clockValue(hours: string, minutes: string, suffix: string | undefined): string {
  let h = Number(hours) % (suffix ? 12 : 24)
  if (suffix === 'pm') h += 12
  return `${h}:${minutes}`
}

function parseNumeral(token: string): string | undefined {
  if (!/^\d/.test(token)) return undefined
  if (token.includes('/')) return token
  // A comma before exactly three digits groups thousands; otherwise it is a decimal comma.
  const n = Number(token.replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.'))
  return Number.isFinite(n) ? String(n) : undefined
}

interface Span {
  value: string
  start: number
  end: number
  unit?: string
}

/** Reads a run of number words starting at `i` ("twenty five", "mia moja na hamsini"). */
function readWords(tokens: string[], i: number, lex: Lexicon): Span | undefined {
  const first = tokens[i]!
  if (lex.fraction[first] !== undefined) return { value: String(lex.fraction[first]), start: i, end: i }
  if (lex.small(first) === undefined && lex.scale[first] === undefined) return undefined

  let total = 0
  let current = 0
  let end = i - 1
  for (let j = i; j < tokens.length; j++) {
    const word = tokens[j]!
    const small = lex.small(word)
    const scale = lex.scale[word]
    if (small !== undefined) {
      current += small
    } else if (scale !== undefined) {
      if (lex.scaleFollowsCount) {
        total += (current || 1) * scale
        current = 0
      } else {
        const next = tokens[j + 1] !== undefined ? lex.small(tokens[j + 1]!) : undefined
        total += scale * (next ?? 1)
        if (next !== undefined) j++
      }
    } else if (word === lex.joiner && j + 1 < tokens.length && isNumberWord(tokens[j + 1]!, lex)) {
      continue
    } else {
      break
    }
    end = j
  }
  return { value: String(total + current), start: i, end }
}

const isNumberWord = (w: string, lex: Lexicon) => lex.small(w) !== undefined || lex.scale[w] !== undefined

export function extractQuantities(text: string, lang: Lang): Quantity[] {
  const tokens = tokenize(text)
  const lex = lang === 'en' ? EN_LEX : SW_LEX
  const spans: Span[] = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const suffix = /^[ap]m$/.test(tokens[i + 1] ?? '') ? tokens[i + 1] : undefined
    const clock = /^(\d{1,2}):(\d{2})$/.exec(t)
    if (clock) {
      spans.push({ value: clockValue(clock[1]!, clock[2]!, suffix), start: i, end: suffix ? i + 1 : i, unit: 'clock' })
      i += suffix ? 1 : 0
      continue
    }
    const numeral = parseNumeral(t)
    if (numeral !== undefined) {
      if (suffix && /^\d{1,2}$/.test(numeral)) {
        spans.push({ value: clockValue(numeral, '00', suffix), start: i, end: i + 1, unit: 'clock' })
        i++
      } else {
        spans.push({ value: numeral, start: i, end: i })
      }
      continue
    }
    if (lang === 'en' && EN_TIMES[t] !== undefined) {
      spans.push({ value: String(EN_TIMES[t]), start: i, end: i, unit: 'time' })
      continue
    }
    const words = readWords(tokens, i, lex)
    if (words) {
      spans.push(words)
      i = words.end
    }
  }

  return spans.map((s) => ({ value: s.value, unit: s.unit ?? unitFor(tokens, s, lang) }))
}

function unitFor(tokens: string[], span: Span, lang: Lang): string | undefined {
  const next = tokens[span.end + 1]
  if (lang === 'en') return next !== undefined ? EN_UNITS[next] : undefined
  if (next !== undefined && METRIC[next]) return METRIC[next]
  const prev = tokens[span.start - 1]
  return prev !== undefined ? SW_UNITS[prev] : undefined
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface QuantityDiff {
  /** In the reference, not in the candidate. */
  missing: string[]
  /** In the candidate, not in the reference. */
  added: string[]
}

/**
 * Multiset difference of two quantity lists. With `units: false` only values
 * are compared (use across languages, where unit words may move or drop out).
 * A quantity without a unit matches one with a unit and the same value. The
 * value 1 is ignored: "a", "an" and "one" are interchangeable in translation.
 */
export function diffQuantities(reference: Quantity[], candidate: Quantity[], { units }: { units: boolean }): QuantityDiff {
  const norm = (q: Quantity): Quantity => (units || q.unit === 'clock' ? q : { value: q.value })
  const ref = reference.map(norm).filter((q) => q.value !== '1')
  const cand = candidate.map(norm).filter((q) => q.value !== '1')

  const take = (pred: (r: Quantity, c: Quantity) => boolean) => {
    for (let i = ref.length - 1; i >= 0; i--) {
      const j = cand.findIndex((c) => pred(ref[i]!, c))
      if (j >= 0) {
        ref.splice(i, 1)
        cand.splice(j, 1)
      }
    }
  }
  take((r, c) => r.value === c.value && r.unit === c.unit)
  take((r, c) => r.value === c.value && (!r.unit || !c.unit))

  return { missing: ref.map(formatQuantity), added: cand.map(formatQuantity) }
}
