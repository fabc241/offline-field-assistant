import { describe, expect, it } from 'vitest'
import type { EmbedTask, Embedder, Lang, Translator } from '../../src/core/engines.js'
import { TranslationService } from '../../src/features/translate/translation-service.js'

/** Looks translations up in a table; unknown input comes back unchanged. */
class TableTranslator implements Translator {
  calls: [string, Lang, Lang][] = []
  constructor(private readonly table: Record<string, string>) {}
  async translate(text: string, from: Lang, to: Lang) {
    this.calls.push([text, from, to])
    return this.table[text] ?? text
  }
}

/** Identical texts get similarity 1; texts in `far` get 0. */
class FakeEmbedder implements Embedder {
  tasks: EmbedTask[] = []
  constructor(private readonly far: string[] = []) {}
  async embed(texts: string[], task: EmbedTask) {
    this.tasks.push(task)
    return texts.map((t) => (this.far.includes(t) ? [0, 1] : [1, 0]))
  }
}

const table = {
  'Take two tablets.': 'Meza vidonge viwili.',
  'Meza vidonge viwili.': 'Take two tablets.',
  'Do not drink alcohol.': 'Usinywe pombe.',
  'Usinywe pombe.': 'Drink alcohol.',
  'Take 500 mg for 3 days.': 'Meza mg 500 kwa siku 3.',
  'Meza mg 500 kwa siku 3.': 'Take 500 mg for 3 weeks.',
  'Come at 9:30.': 'Njoo saa 9:30.',
  'Njoo saa 9:30.': 'Come at 9:30.',
  'Keep warm.': 'Weka joto.',
  'Weka joto.': 'Stay somewhere else.'
}

describe('TranslationService', () => {
  it('translates sentence by sentence and keeps line breaks', async () => {
    const tr = new TableTranslator(table)
    const svc = new TranslationService(tr, new FakeEmbedder())
    const res = await svc.translate('Take two tablets. Do not drink alcohol.\n\nKeep warm.', 'en', 'sw')
    expect(res.translation).toBe('Meza vidonge viwili. Usinywe pombe.\n\nWeka joto.')
    expect(tr.calls.map((c) => c[0])).toEqual(['Take two tablets.', 'Do not drink alcohol.', 'Keep warm.'])
  })

  it('passes a faithful translation with no flags', async () => {
    const embedder = new FakeEmbedder()
    const res = await new TranslationService(new TableTranslator(table), embedder).translateWithCheck(
      'Take two tablets.',
      'en',
      'sw'
    )
    expect(res).toMatchObject({
      translation: 'Meza vidonge viwili.',
      backTranslation: 'Take two tablets.',
      fidelity: 1,
      flags: [],
      numericCheck: { ok: true, source: ['2 tablet'] }
    })
    expect(embedder.tasks).toEqual(['similarity'])
  })

  it('flags a lost negation', async () => {
    const svc = new TranslationService(new TableTranslator(table), new FakeEmbedder())
    const res = await svc.translateWithCheck('Do not drink alcohol.', 'en', 'sw')
    expect(res.flags).toEqual(['negation-changed'])
  })

  it('flags changed numbers and says which', async () => {
    const svc = new TranslationService(new TableTranslator(table), new FakeEmbedder())
    const res = await svc.translateWithCheck('Take 500 mg for 3 days.', 'en', 'sw')
    expect(res.flags).toEqual(['numbers-changed'])
    expect(res.numericCheck.translation).toEqual({ missing: [], added: [] })
    expect(res.numericCheck.backTranslation).toEqual({ missing: ['3 day'], added: ['3 week'] })
  })

  it('flags clock times', async () => {
    const svc = new TranslationService(new TableTranslator(table), new FakeEmbedder())
    expect((await svc.translateWithCheck('Come at 9:30.', 'en', 'sw')).flags).toEqual(['clock-time'])
  })

  it('flags low fidelity per source language and reports the lowest sentence', async () => {
    const tr = new TableTranslator(table)
    const svc = new TranslationService(tr, new FakeEmbedder(['Stay somewhere else.']))
    const res = await svc.translateWithCheck('Take two tablets. Keep warm.', 'en', 'sw')
    expect(res.fidelity).toBe(0)
    expect(res.flags).toEqual(['low-fidelity'])
    expect(res.sentences.map((s) => s.flags)).toEqual([[], ['low-fidelity']])
    expect(res.backTranslation).toBe('Take two tablets. Stay somewhere else.')
  })

  it('flags empty and echoed output', async () => {
    const empty = new TranslationService({ translate: async () => '' }, new FakeEmbedder())
    expect((await empty.translateWithCheck('Drink water now.', 'en', 'sw')).flags).toEqual(['empty-output', 'low-fidelity'])
    const echo = new TranslationService(new TableTranslator({}), new FakeEmbedder())
    expect((await echo.translateWithCheck('Drink water now.', 'en', 'sw')).flags).toEqual(['untranslated'])
    const looping = new TranslationService(new TableTranslator({ 'AMOXICILLIN CAPSULES': 'Vidonge vya ugonjwa wa ugonjwa wa ugonjwa wa ugonjwa' }), new FakeEmbedder())
    expect((await looping.translateWithCheck('AMOXICILLIN CAPSULES', 'en', 'sw')).flags).toContain('translation-loop')
  })

  it('can back-translate with a different model', async () => {
    const forward = new TableTranslator(table)
    const back = new TableTranslator({ 'Meza vidonge viwili.': 'Swallow two tablets.' })
    const svc = new TranslationService(forward, new FakeEmbedder(), { backTranslator: back })
    const res = await svc.translateWithCheck('Take two tablets.', 'en', 'sw')
    expect(res.backTranslation).toBe('Swallow two tablets.')
    expect(forward.calls).toHaveLength(1)
    expect(back.calls).toEqual([['Meza vidonge viwili.', 'sw', 'en']])
  })

  it('handles empty input without calling the models', async () => {
    const tr = new TableTranslator(table)
    const res = await new TranslationService(tr, new FakeEmbedder()).translateWithCheck('', 'en', 'sw')
    expect(res).toMatchObject({ translation: '', backTranslation: '', fidelity: 1, flags: [] })
    expect(tr.calls).toHaveLength(0)
  })

  it('rejects translating a language into itself', async () => {
    const svc = new TranslationService(new TableTranslator(table), new FakeEmbedder())
    await expect(svc.translate('Hi', 'en', 'en')).rejects.toThrow(/both "en"/)
  })
})
