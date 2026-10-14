/**
 * Rewrites text the way it should be read aloud: numbers, doses, units, clock
 * times, fractions and ranges become words before they reach the TTS model.
 *
 * Chatterbox reads digits and symbols badly in both languages ("500 mg" came
 * back from Whisper as "500 Michi", "38.5 °C" as noise) and Swahili digits
 * worst of all, while the same sentences spelled out came back almost word
 * for word. Doses are the one thing read-aloud must not garble.
 *
 * Swahili numbers use the counting forms (moja, mbili, tatu…), not the forms
 * that agree with the noun ("vidonge viwili"): understandable, if not
 * idiomatic. Every quantity keeps its value: F1's quantity parser reads the
 * spoken form back to the same numbers (tests/unit/spoken.test.ts).
 */
import type { Lang } from '../../core/engines.js'

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const EN_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'
]
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

const SW_ONES = ['sifuri', 'moja', 'mbili', 'tatu', 'nne', 'tano', 'sita', 'saba', 'nane', 'tisa']
const SW_TENS = ['', 'kumi', 'ishirini', 'thelathini', 'arobaini', 'hamsini', 'sitini', 'sabini', 'themanini', 'tisini']

/** Integers from here up are read digit by digit, like ID and phone numbers. */
const MAX_SPELLED = 1_000_000

function enInteger(n: number): string {
  if (n < 20) return EN_ONES[n]!
  if (n < 100) return EN_TENS[Math.floor(n / 10)]! + (n % 10 ? `-${EN_ONES[n % 10]}` : '')
  if (n < 1000) {
    const rest = n % 100
    return `${EN_ONES[Math.floor(n / 100)]} hundred${rest ? ` and ${enInteger(rest)}` : ''}`
  }
  const rest = n % 1000
  return `${enInteger(Math.floor(n / 1000))} thousand${rest ? `${rest < 100 ? ' and' : ''} ${enInteger(rest)}` : ''}`
}

/**
 * Swahili names the scale first: 150 "mia moja na hamsini", 2024 "elfu mbili
 * na ishirini na nne". Thousands from 11 000 up are ambiguous when spoken
 * ("elfu kumi na mbili" is 12 000 or 10 002), as they are for people.
 */
function swInteger(n: number): string {
  if (n < 10) return SW_ONES[n]!
  if (n < 100) return SW_TENS[Math.floor(n / 10)]! + (n % 10 ? ` na ${SW_ONES[n % 10]}` : '')
  const [scale, unit] = n < 1000 ? ['mia', 100] : ['elfu', 1000]
  const rest = n % unit
  return `${scale} ${swInteger(Math.floor(n / unit))}${rest ? ` na ${swInteger(rest)}` : ''}`
}

const digitByDigit = (digits: string, lang: Lang) =>
  [...digits].map((d) => (lang === 'en' ? EN_ONES : SW_ONES)[Number(d)]).join(' ')

/** "38.5" → "thirty-eight point five" / "thelathini na nane nukta tano". */
export function spellNumber(numeral: string, lang: Lang): string {
  const [int = '', frac] = numeral.split('.')
  const n = Number(int)
  const whole =
    (int.length > 1 && int.startsWith('0')) || n >= MAX_SPELLED
      ? digitByDigit(int, lang)
      : lang === 'en'
        ? enInteger(n)
        : swInteger(n)
  return frac ? `${whole} ${lang === 'en' ? 'point' : 'nukta'} ${digitByDigit(frac, lang)}` : whole
}

const EN_ORDINAL: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth'
}

function enOrdinal(n: number): string {
  return enInteger(n).replace(/[a-z]+$/, (w) => EN_ORDINAL[w] ?? (w.endsWith('y') ? `${w.slice(0, -1)}ieth` : `${w}th`))
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

interface UnitWords {
  en: [singular: string, plural: string]
  sw: string
}

const UNITS: Record<string, UnitWords> = {
  mg: { en: ['milligram', 'milligrams'], sw: 'miligramu' },
  mcg: { en: ['microgram', 'micrograms'], sw: 'mikrogramu' },
  g: { en: ['gram', 'grams'], sw: 'gramu' },
  kg: { en: ['kilogram', 'kilograms'], sw: 'kilo' },
  ml: { en: ['millilitre', 'millilitres'], sw: 'mililita' },
  l: { en: ['litre', 'litres'], sw: 'lita' },
  '%': { en: ['percent', 'percent'], sw: 'asilimia' },
  '°c': { en: ['degree Celsius', 'degrees Celsius'], sw: 'nyuzi joto' },
  mmhg: { en: ['millimetre of mercury', 'millimetres of mercury'], sw: 'milimita za zebaki' }
}

const UNIT_ALIASES: Record<string, string> = { µg: 'mcg', ug: 'mcg', mls: 'ml', '°': '°c' }

function unitKey(raw: string): string | undefined {
  const k = raw.toLowerCase().replace(/\s+/g, '')
  const key = UNIT_ALIASES[k] ?? k
  return UNITS[key] ? key : undefined
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** A numeral as written: "1,250", "38.5", "38,5". */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?`
/** Units written after a number. Letters must not run on ("5 grams" is already words). */
const UNIT_AFTER = String.raw`(mg|mcg|µg|ug|kg|g|mls?|l|%|°\s?c|°|mm\s?hg)(?![\p{L}])`
/** Units written before a number, Swahili style ("ml 5"); single letters are too ambiguous. */
const UNIT_BEFORE = String.raw`\b(mg|mcg|kg|mls?)\s+`
/** "a.m." keeps its last dot only mid-sentence; at the end it is the full stop. */
const AMPM = String.raw`([ap])\.?\s?m\b(?:\.(?=\s+\p{Ll}))?`

/** "1,250" → "1250"; a comma not grouping thousands is a decimal comma. */
function numeral(raw: string): string {
  return raw.replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.')
}

const isOne = (raw: string) => Number(numeral(raw)) === 1

function withUnit(raw: string, unit: string, lang: Lang): string {
  const words = UNITS[unit]!
  const number = spellNumber(numeral(raw), lang)
  return lang === 'en' ? `${number} ${words.en[isOne(raw) ? 0 : 1]}` : `${words.sw} ${number}`
}

function clock(hours: string, minutes: string, ampm: string | undefined, lang: Lang): string {
  const h = Number(hours)
  const m = Number(minutes)
  if (lang === 'sw') {
    // Read as written. Whether "saa 8:00" means 8 or 2 o'clock is F1's clock-time flag.
    const mins = m === 0 ? '' : m === 30 ? ' na nusu' : m === 15 ? ' na robo' : ` na dakika ${swInteger(m)}`
    return `${swInteger(h)}${mins}${ampm ? ` ${swPartOfDay(h, ampm)}` : ''}`
  }
  const mins = m === 0 ? (ampm ? '' : " o'clock") : m < 10 ? ` oh ${EN_ONES[m]}` : ` ${enInteger(m)}`
  return `${enInteger(h)}${mins}${ampm ? ` ${ampm.toUpperCase()} M` : ''}`
}

function swPartOfDay(h: number, ampm: string): string {
  if (ampm === 'a') return h === 12 || h < 4 ? 'usiku' : 'asubuhi'
  return h === 12 || h < 4 ? 'mchana' : h < 7 ? 'jioni' : 'usiku'
}

function fraction(a: string, b: string, lang: Lang): string {
  const named: Record<string, [en: string, sw: string]> = {
    '1/2': ['one half', 'nusu'],
    '1/4': ['one quarter', 'robo'],
    '3/4': ['three quarters', 'robo tatu']
  }
  const hit = named[`${a}/${b}`]
  if (hit) return lang === 'en' ? hit[0] : hit[1]
  // Blood pressure and other ratios: "120/80" → "one hundred and twenty over eighty".
  return `${spellNumber(a, lang)} ${lang === 'en' ? 'over' : 'kwa'} ${spellNumber(b, lang)}`
}

/** Rewrites one sentence for reading aloud. Text without digits or unit symbols comes back unchanged. */
export function toSpokenForm(text: string, lang: Lang): string {
  const rules: [RegExp, (...m: string[]) => string][] = [
    // 8:30, 8:30 pm
    [new RegExp(String.raw`\b(\d{1,2}):(\d{2})(?:\s?${AMPM})?`, 'giu'), (_, h, m, ap) => clock(h!, m!, ap?.toLowerCase(), lang)],
    // 8 am
    [new RegExp(String.raw`\b(\d{1,2})\s?${AMPM}`, 'giu'), (_, h, ap) => clock(h!, '00', ap!.toLowerCase(), lang)],
    // 120/80 mmHg, 1/2
    [
      new RegExp(String.raw`\b(\d+)\/(\d+)(?:\s?(mm\s?hg)\b)?`, 'giu'),
      (_, a, b, u) => fraction(a!, b!, lang) + (u ? ` ${lang === 'en' ? UNITS.mmhg!.en[1] : UNITS.mmhg!.sw}` : '')
    ],
    // 2-3 days
    [
      new RegExp(String.raw`(${NUM})\s?[-–]\s?(${NUM})`, 'gu'),
      (_, a, b) => `${a} ${lang === 'en' ? 'to' : 'hadi'} ${b}`
    ],
    // 500 mg, 38.5 °C, 5%
    [
      new RegExp(String.raw`(${NUM})\s?${UNIT_AFTER}`, 'giu'),
      (whole, n, u) => {
        const key = unitKey(u!)
        return key ? withUnit(n!, key, lang) : whole
      }
    ],
    // ml 5
    [
      new RegExp(String.raw`${UNIT_BEFORE}(${NUM})\b`, 'giu'),
      (whole, u, n) => {
        const key = unitKey(u!)
        return key ? withUnit(n!, key, lang) : whole
      }
    ],
    // 2nd
    [/\b(\d+)(st|nd|rd|th)\b/giu, (whole, n) => (lang === 'en' ? enOrdinal(Number(n)) : whole)],
    // anything numeric left
    [new RegExp(String.raw`\b(${NUM})\b`, 'gu'), (_, n) => spellNumber(numeral(n!), lang)]
  ]
  let out = text
  for (const [re, fn] of rules) out = out.replace(re, (...m) => fn(...(m.slice(0, -2) as string[])))
  return out.replace(/\s+/g, ' ').trim()
}
