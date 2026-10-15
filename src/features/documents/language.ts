/**
 * English or Swahili, for one piece of a document. Forms and labels are often
 * printed in both, so a segment already in the target language is kept as it
 * is rather than sent through the translator. General-purpose detectors know
 * no Swahili (tinyld, in the SDK, reads "Kunywa maji safi" as Kirundi), so
 * this counts marker words and word endings: Swahili words end in a vowel,
 * most English content words do not.
 */
import type { Lang } from '../../core/engines.js'

const MARKERS: Record<Lang, Set<string>> = {
  en: new Set(
    ('the a an and or of to in on at for with from by is are be was were if not no do does did you your this that ' +
      'it its as will may can should must after before every each day days hours name date age please take give ' +
      'when what how who where which have has had').split(' ')
  ),
  sw: new Set(
    ('na ya wa za la cha vya kwa katika ni au kama je nini gani wapi si hii huu hiyo kila siku saa mara kwenye ' +
      'kabla baada bila sana tu pia lakini kwamba ili hadi mpaka ndani juu chini jina tarehe umri dawa mtoto ' +
      'mgonjwa tafadhali usi kuhusu mama baba').split(' ')
  )
}

export interface LangGuess {
  lang: Lang
  /** Evidence for `lang` over the other language, in marker words; below 2 is a weak guess. */
  margin: number
}

export function guessLang(text: string): LangGuess {
  const words = text.toLowerCase().match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? []
  const score: Record<Lang, number> = { en: 0, sw: 0 }
  for (const w of words) {
    if (MARKERS.en.has(w)) score.en += 2
    if (MARKERS.sw.has(w)) score.sw += 2
    if (w.length < 4) continue
    // Swahili content words end in a vowel; English ones mostly in a consonant.
    if (/[aeiou]$/.test(w)) score.sw += 0.5
    else score.en += 0.5
    if (/^(?:ku|wa|ki|vi|mw|ny|ch)[^aeiou]?[aeiou]/.test(w) && /[aeiou]$/.test(w)) score.sw += 0.5
  }
  const lang: Lang = score.sw > score.en ? 'sw' : 'en'
  return { lang, margin: Math.abs(score.sw - score.en) / 2 }
}

/**
 * False when there is nothing to translate: dates, numbers and bare units
 * ("14.5 kg", "BP 140/90") have no word of three letters or more.
 */
export const hasWords = (text: string) => /\p{L}{3,}/u.test(text)
