import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../../src/core/config.js'
import { LANGS, type Lang } from '../../src/core/engines.js'
import { extractQuantities, formatQuantity } from '../../src/features/translate/quantities.js'
import { spellNumber, toSpokenForm } from '../../src/features/voice/spoken.js'
import { parseCsv } from '../../eval/csv.js'

const values = (text: string, lang: Lang) => extractQuantities(text, lang).map((q) => q.value)
/** Quantities with units; a ratio counts as its two numbers ("120/80" is spoken "one hundred and twenty over eighty"). */
const quantities = (text: string, lang: Lang) =>
  extractQuantities(text, lang).flatMap((q) => (q.value.includes('/') ? q.value.split('/') : [formatQuantity(q)]))
/** The parser does not read spoken clock times, so those are tested by example only. */
const hasClockTime = (text: string, lang: Lang) => extractQuantities(text, lang).some((q) => q.unit === 'clock')

const intake = parseCsv(fs.readFileSync(path.join(PROJECT_ROOT, 'eval/datasets/intake.csv'), 'utf8'))

describe('spellNumber', () => {
  it.each<[string, Lang, string]>([
    ['0', 'en', 'zero'],
    ['21', 'en', 'twenty-one'],
    ['105', 'en', 'one hundred and five'],
    ['2024', 'en', 'two thousand and twenty-four'],
    ['500000', 'en', 'five hundred thousand'],
    ['38.5', 'en', 'thirty-eight point five'],
    ['0712', 'en', 'zero seven one two'],
    ['0', 'sw', 'sifuri'],
    ['34', 'sw', 'thelathini na nne'],
    ['150', 'sw', 'mia moja na hamsini'],
    ['1500', 'sw', 'elfu moja na mia tano'],
    ['2024', 'sw', 'elfu mbili na ishirini na nne'],
    ['38.5', 'sw', 'thelathini na nane nukta tano'],
    ['12345678', 'sw', 'moja mbili tatu nne tano sita saba nane']
  ])('%s (%s) → %s', (n, lang, words) => {
    expect(spellNumber(n, lang)).toBe(words)
  })

  it('reads back to the same value in English, 0 to 999 999', () => {
    const ns = [...Array.from({ length: 2001 }, (_, i) => i), ...Array.from({ length: 999 }, (_, i) => 1001 * (i + 1))]
    for (const n of ns) expect(values(spellNumber(String(n), 'en'), 'en'), String(n)).toEqual([String(n)])
  })

  it('reads back to the same value in Swahili, 0 to 10 999 and round ten thousands', () => {
    // From 11 000 up spoken Swahili is ambiguous: "elfu kumi na mbili" is 12 000 or 10 002.
    const ns = [...Array.from({ length: 11_000 }, (_, i) => i), ...Array.from({ length: 9 }, (_, i) => 10_000 * (i + 1))]
    for (const n of ns) expect(values(spellNumber(String(n), 'sw'), 'sw'), String(n)).toEqual([String(n)])
  })

  it('reads decimals back in both languages', () => {
    for (const lang of LANGS) {
      for (const n of ['0.5', '2.5', '37.25', '38.5', '120.75']) expect(values(spellNumber(n, lang), lang)).toEqual([n])
    }
  })
})

describe('toSpokenForm', () => {
  it.each<[string, Lang, string]>([
    ['Take 500 mg twice a day.', 'en', 'Take five hundred milligrams twice a day.'],
    ['Her temperature is 38.5 °C.', 'en', 'Her temperature is thirty-eight point five degrees Celsius.'],
    ['Give 1 ml every 8 hours for 2-3 days.', 'en', 'Give one millilitre every eight hours for two to three days.'],
    ['Weight 1,250 g, BP 120/80 mmHg.', 'en', 'Weight one thousand two hundred and fifty grams, BP one hundred and twenty over eighty millimetres of mercury.'],
    ['Come back at 8:00, or at 2:30 pm.', 'en', "Come back at eight o'clock, or at two thirty P M."],
    ['Opens at 8 am on the 2nd floor.', 'en', 'Opens at eight A M on the second floor.'],
    ['Give 1/2 tablet, 5% solution.', 'en', 'Give one half tablet, five percent solution.'],
    ['A 5-year-old with COVID-19.', 'en', 'A five-year-old with COVID-nineteen.'],
    ['Meza paracetamol mg 500 unapokuwa na maumivu.', 'sw', 'Meza paracetamol miligramu mia tano unapokuwa na maumivu.'],
    ['Kunywa 500mg mara mbili kwa siku.', 'sw', 'Kunywa miligramu mia tano mara mbili kwa siku.'],
    ['Joto lake ni 38.5°C.', 'sw', 'Joto lake ni nyuzi joto thelathini na nane nukta tano.'],
    ['Mpe ml 5 kila saa 8 kwa siku 2-3.', 'sw', 'Mpe mililita tano kila saa nane kwa siku mbili hadi tatu.'],
    ['Shinikizo ni 140/90, nusu ni 1/2.', 'sw', 'Shinikizo ni mia moja na arobaini kwa tisini, nusu ni nusu.'],
    ['Kliniki inafunguliwa saa 8:30 na kufungwa saa 11:15.', 'sw', 'Kliniki inafunguliwa saa nane na nusu na kufungwa saa kumi na moja na robo.'],
    ['Rudi saa 9 pm.', 'sw', 'Rudi saa tisa usiku.'],
    ['Asilimia ni 5%.', 'sw', 'Asilimia ni asilimia tano.'],
    ['No numbers here.', 'en', 'No numbers here.'],
    ['Mtoto ana gramu 5, si 5 grams.', 'sw', 'Mtoto ana gramu tano, si tano grams.']
  ])('%s', (text, lang, spoken) => {
    expect(toSpokenForm(text, lang)).toBe(spoken)
  })

  it('leaves no digits in the intake sentences', () => {
    for (const row of intake) for (const lang of LANGS) expect(toSpokenForm(row[lang]!, lang)).not.toMatch(/\d/)
  })

  it('keeps every quantity of the intake sentences, with its unit', () => {
    for (const row of intake) {
      for (const lang of LANGS) {
        const text = row[lang]!
        if (hasClockTime(text, lang)) continue
        expect(quantities(toSpokenForm(text, lang), lang), `${row.id} ${lang}: ${text}`).toEqual(quantities(text, lang))
      }
    }
  })

  it('keeps the quantities of dose instructions, with their units', () => {
    const doses: [string, Lang][] = [
      ['Give 250 mg every 6 hours for 7 days.', 'en'],
      ['Take 2 tablets of 500mg, then 1 tablet.', 'en'],
      ['Weight 12.5 kg, temperature 37.8 °C, 3 ml.', 'en'],
      ['Mpe mtoto ml 2.5 mara tatu kwa siku 5.', 'sw'],
      ['Meza mg 250 kila saa 6 kwa siku 7.', 'sw'],
      ['Uzito kilo 12.5, joto 37.8°C.', 'sw']
    ]
    for (const [text, lang] of doses) expect(quantities(toSpokenForm(text, lang), lang), text).toEqual(quantities(text, lang))
  })
})
