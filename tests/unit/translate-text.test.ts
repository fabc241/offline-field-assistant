import { describe, expect, it } from 'vitest'
import { cosine, countNegations, looksUntranslated, mentionsClockTime } from '../../src/features/translate/checks.js'
import { diffQuantities, extractQuantities, formatQuantity } from '../../src/features/translate/quantities.js'
import { reassemble, segment, splitSentences } from '../../src/features/translate/segment.js'
import type { Lang } from '../../src/core/engines.js'

describe('segment', () => {
  it('splits sentences without breaking decimals or titles', () => {
    expect(splitSentences('Dr. Juma will see you. Take 2.5 ml now. Is that ok?')).toEqual([
      'Dr. Juma will see you.',
      'Take 2.5 ml now.',
      'Is that ok?'
    ])
  })

  it('reassembles translations with the original line breaks and blank lines', () => {
    const lines = segment('One. Two.\n\nThree.\r\nFour')
    expect(lines.map((l) => l.sentences)).toEqual([['One.', 'Two.'], [], ['Three.'], ['Four']])
    expect(reassemble(lines, ['A.', 'B.', 'C.', 'D'])).toBe('A. B.\n\nC.\r\nD')
  })
})

const q = (text: string, lang: Lang) => extractQuantities(text, lang).map(formatQuantity)

describe('extractQuantities', () => {
  it.each<[string, Lang, string[]]>([
    ['Take two tablets three times a day.', 'en', ['2 tablet', '3 time']],
    ['Meza vidonge viwili mara tatu kwa siku.', 'sw', ['2 tablet', '3 time']],
    ['Take 1 tablet every 8 hours for 5 days.', 'en', ['1 tablet', '8 hour', '5 day']],
    ['Meza kidonge kimoja kila baada ya saa 8 kwa siku 5.', 'sw', ['1 tablet', '8 hour', '5 day']],
    ['Give 500mg twice a day.', 'en', ['500 mg', '2 time']],
    ['Mpe mtoto ml 5 za dawa', 'sw', ['5']],
    ['A 5-year-old with 38.5°C fever.', 'en', ['5 year', '38.5 °c']],
    ['Joto lako ni nyuzi 38,5.', 'sw', ['38.5 °c']],
    ['BP 140/90, weight 1,250 g.', 'en', ['140/90', '1250 g']],
    ['one hundred and fifty, twenty-five', 'en', ['150', '25']],
    ['kumi na mbili, mia tano, elfu mbili', 'sw', ['12', '500', '2000']],
    ['Opens at 8:00 a.m., closes at 5 pm.', 'en', ['8:00', '17:00']],
    ['Mweke mwili wa mtoto katika joto.', 'sw', []]
  ])('%s', (text, lang, expected) => {
    expect(q(text, lang)).toEqual(expected)
  })
})

describe('diffQuantities', () => {
  const en = (t: string) => extractQuantities(t, 'en')

  it('accepts reworded quantities', () => {
    expect(diffQuantities(en('Take 2 tablets twice a day'), en('Take two pills 2 times daily'), { units: true })).toEqual({
      missing: [],
      added: []
    })
  })

  it('reports a changed dose or duration', () => {
    expect(diffQuantities(en('for 3 days'), en('for 3 weeks'), { units: true })).toEqual({
      missing: ['3 day'],
      added: ['3 week']
    })
    expect(diffQuantities(en('500 mg'), en('50 mg'), { units: true })).toEqual({ missing: ['500 mg'], added: ['50 mg'] })
  })

  it('compares values only across languages, ignoring the value 1', () => {
    const sw = extractQuantities('Meza kidonge kimoja kwa siku 5', 'sw')
    expect(diffQuantities(en('Take a tablet for 5 days'), sw, { units: false })).toEqual({ missing: [], added: [] })
  })

  it('matches a unitless number with the same number carrying a unit', () => {
    expect(diffQuantities(en('Take 2 of them'), en('Take 2 tablets'), { units: true }).missing).toEqual([])
  })
})

describe('checks', () => {
  it('counts English negations', () => {
    expect(countNegations('Do not take more than 8 tablets.')).toBe(1)
    expect(countNegations("Don't drink alcohol and never drive.")).toBe(2)
    expect(countNegations('The child is unable to drink.')).toBe(countNegations('The child cannot drink.'))
    expect(countNegations('Take 8 tablets.')).toBe(0)
  })

  it('spots clock times in both languages', () => {
    expect(mentionsClockTime('The clinic opens at 8:00.', 'en')).toBe(true)
    expect(mentionsClockTime('Come at 9 am', 'en')).toBe(true)
    expect(mentionsClockTime('Take it for 8 hours', 'en')).toBe(false)
    expect(mentionsClockTime('Kliniki inafunguliwa saa mbili asubuhi.', 'sw')).toBe(true)
    expect(mentionsClockTime('Njoo saa 9:30.', 'sw')).toBe(true)
    expect(mentionsClockTime('Meza kila baada ya saa 8.', 'sw')).toBe(false)
  })

  it('detects echoed source text', () => {
    expect(looksUntranslated('Drink clean water.', 'drink clean water')).toBe(true)
    expect(looksUntranslated('Drink clean water.', 'Kunywa maji safi.')).toBe(false)
    expect(looksUntranslated('Paracetamol.', 'Paracetamol.')).toBe(false)
  })

  it('computes cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 2])).toBeCloseTo(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})
