/**
 * F1 against the real translator and embedder (npm run fetch-models first).
 * Decoding is greedy, so outputs are stable; assertions still check meaning
 * markers rather than exact strings.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { MODEL_CATALOG as M } from '../../src/core/catalog.js'
import { loadConfig } from '../../src/core/config.js'
import { qvacEmbedder, qvacTranslator } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { TranslationService } from '../../src/features/translate/translation-service.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const service = new TranslationService(qvacTranslator(runtime), qvacEmbedder(runtime))
const installed = store.has(M.translator) && store.has(M.embedder)

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
})

describe.skipIf(!installed)('TranslationService with real models', { timeout: 120_000 }, () => {
  it('translates a dosing instruction en→sw and keeps every number', async () => {
    const r = await service.translateWithCheck('Take two tablets every 8 hours for 5 days.', 'en', 'sw')
    expect(r.translation).toMatch(/vidonge/i)
    expect(r.translation).toMatch(/\b8\b/)
    expect(r.translation).toMatch(/\b5\b/)
    expect(r.numericCheck.ok).toBe(true)
    expect(r.flags).toEqual([])
    expect(r.fidelity).toBeGreaterThan(0.9)
  })

  it('translates sw→en', async () => {
    const r = await service.translateWithCheck('Mtoto ana homa na kutapika tangu jana.', 'sw', 'en')
    expect(r.translation.toLowerCase()).toMatch(/child.*fever.*vomit/)
    expect(r.flags).toEqual([])
  })

  it('keeps multi-line layout', async () => {
    const r = await service.translate('Drink clean water.\n\nCome back in one week.', 'en', 'sw')
    expect(r.translation.split('\n')).toHaveLength(3)
    expect(r.translation.split('\n')[1]).toBe('')
  })

  it('flags a clock time, which the model copies digit for digit', async () => {
    const r = await service.translateWithCheck('The clinic opens at 8:00 in the morning.', 'en', 'sw')
    expect(r.flags).toContain('clock-time')
  })
})
