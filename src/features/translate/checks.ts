/** Cheap per-sentence checks that flag a translation for the speakers to confirm. */
import type { Lang } from '../../core/engines.js'

const EN_NEGATION = /\b(?:not|no|never|without|none|nothing|nobody|nowhere|neither|nor|cannot|unable)\b|n't\b/g

/**
 * Number of negations in English text. Swahili marks negation inside the verb
 * (hajala, usile, sijui), so it is not counted.
 */
export function countNegations(text: string): number {
  return text.toLowerCase().replace(/[’`]/g, "'").match(EN_NEGATION)?.length ?? 0
}

const EN_CLOCK = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*[ap]\.?m\b\.?|\bo'?clock\b|\bnoon\b|\bmidnight\b/i
const SW_CLOCK = /\bsaa\s+\d{1,2}:\d{2}\b|\bsaa\s+ngapi\b/i
const SW_SAA = /\bsaa\b/i
const SW_TIME_OF_DAY = /\b(?:asubuhi|mchana|alasiri|jioni|usiku|adhuhuri)\b/i

/**
 * True when either side mentions a time of day. Swahili counts the hours from
 * dawn (07:00 is "saa moja asubuhi"), so a digit-for-digit time is six hours
 * off for the listener and must be confirmed out loud.
 */
export function mentionsClockTime(text: string, lang: Lang): boolean {
  if (lang === 'en') return EN_CLOCK.test(text)
  return SW_CLOCK.test(text) || (SW_SAA.test(text) && SW_TIME_OF_DAY.test(text))
}

/**
 * Clinical terms the translator has been seen to turn into another meaning,
 * as that meaning reads in the English back-translation. Each comes from
 * eval/datasets/term-traps.csv; add a row there before adding one here. Only
 * words that are wrong whenever the source lacks them: "rinse" or "drunk"
 * can be faithful paraphrases, so they are left out.
 */
const WRONG_MEANINGS: { meaning: string; pattern: RegExp }[] = [
  // "Is he drinking?" → "Je, anakunywa pombe?"
  { meaning: 'alcohol', pattern: /\b(?:alcohol\w*|beer|wine|liquor)\b/i },
  // "oral rehydration solution" → "a mouthwash"
  { meaning: 'mouthwash', pattern: /\bmouth\s?wash\w*|\bgargl\w*/i },
  // "syrup" → "mchuzi", broth
  { meaning: 'broth', pattern: /\b(?:broth|soup|gravy)\b/i },
  // "loose stool" → "kinyesi kizito", a heavy (hard) stool
  { meaning: 'hard stool', pattern: /\b(?:heavy|hard|thick)\s+stools?\b/i }
]

/** Known wrong meanings that the back-translation brings in and the English source does not mention. */
export function wrongMeanings(source: string, back: string): string[] {
  return WRONG_MEANINGS.filter(({ pattern }) => pattern.test(back) && !pattern.test(source)).map((m) => m.meaning)
}

const words = (text: string) => text.toLowerCase().match(/\p{L}+/gu) ?? []

/** The model echoed the source instead of translating it. */
export function looksUntranslated(source: string, translation: string): boolean {
  const a = words(source)
  return a.length >= 2 && a.join(' ') === words(translation).join(' ')
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
