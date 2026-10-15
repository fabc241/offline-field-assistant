/**
 * F1 eval: translates the intake set in both directions with every installed
 * TranslatePsy-AfriSLM size, and calibrates the back-translation fidelity check.
 *
 *   npm run eval:translate [-- --models TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M,...]
 *
 * Writes eval/outputs/translate-<model>.csv (side by side) and
 * eval/outputs/translate-summary.json.
 * chrF is measured against the dataset's own Swahili/English, which is
 * placeholder text and NOT a vetted reference: use it to compare models only.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { translatorSpec } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { qvacEmbedder, qvacTranslator, type Embedder, type Lang } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { cosine, countNegations } from '../src/features/translate/checks.js'
import { diffQuantities, extractQuantities } from '../src/features/translate/quantities.js'
import {
  DEFAULT_FIDELITY_THRESHOLD,
  FLAGS,
  TranslationService,
  type CheckedTranslation
} from '../src/features/translate/translation-service.js'
import { chrF } from './chrf.js'
import { parseCsv, toCsv } from './csv.js'
import { quantile, round } from './stats.js'

const SIZES = ['0_8B', '2B', '4B'].map((s) => `TRANSLATEPSY_AFRISLM_${s}_TRANSLATION_Q4_K_M`)
const DEFAULT_MODEL = translatorSpec().name

const { values } = parseArgs({ options: { models: { type: 'string' }, dataset: { type: 'string' } } })
const datasetPath = values.dataset ?? path.join(PROJECT_ROOT, 'eval/datasets/intake.csv')
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
const rows = parseCsv(await fs.readFile(datasetPath, 'utf8'))

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const embedder = qvacEmbedder(runtime)
const models = values.models ? values.models.split(',') : SIZES.filter((m) => store.has(m))
await fs.mkdir(outDir, { recursive: true })

interface Run {
  dir: string
  id: string
  reference: string
  result: CheckedTranslation
}

const summary: Record<string, unknown> = { dataset: path.relative(PROJECT_ROOT, datasetPath), sentences: rows.length }
const perModel: Record<string, unknown> = {}
let defaultRuns: Run[] = []

for (const model of models) {
  const service = new TranslationService(qvacTranslator(runtime, translatorSpec(model)), embedder)
  const t0 = performance.now()
  await service.translate('Hello.', 'en', 'sw') // load + warm up
  const loadMs = performance.now() - t0

  const runs: Run[] = []
  for (const [dir, from, to] of [['en→sw', 'en', 'sw'], ['sw→en', 'sw', 'en']] as [string, Lang, Lang][]) {
    for (const row of rows) {
      const result = await service.translateWithCheck(row[from]!, from, to)
      runs.push({ dir, id: row.id!, reference: row[to]!, result })
    }
  }
  await runtime.unload(runtime.loaded().find((m) => m.name === model)?.key ?? '')

  await fs.writeFile(
    path.join(outDir, `translate-${model}.csv`),
    toCsv(
      runs.map((r) => ({
        id: r.id,
        direction: r.dir,
        source: r.result.source,
        translation: r.result.translation,
        back_translation: r.result.backTranslation,
        reference_unvetted: r.reference,
        fidelity: r.result.fidelity.toFixed(3),
        flags: r.result.flags.join(' '),
        translate_ms: Math.round(r.result.timings.translateMs)
      }))
    )
  )

  const byDir: Record<string, unknown> = {}
  for (const dir of ['en→sw', 'sw→en']) {
    const rs = runs.filter((r) => r.dir === dir)
    const ms = rs.map((r) => r.result.timings.translateMs)
    const checkMs = rs.map((r) => r.result.timings.backTranslateMs + r.result.timings.checkMs)
    byDir[dir] = {
      chrF: round(chrF(rs.map((r) => r.result.translation), rs.map((r) => r.reference))),
      translateMs: { median: Math.round(quantile(ms, 0.5)), p90: Math.round(quantile(ms, 0.9)) },
      checkMs: { median: Math.round(quantile(checkMs, 0.5)), p90: Math.round(quantile(checkMs, 0.9)) },
      fidelity: quantiles(rs.map((r) => r.result.fidelity)),
      flagged: rs.filter((r) => r.result.flags.length).length,
      flags: Object.fromEntries(FLAGS.map((f) => [f, rs.filter((r) => r.result.flags.includes(f)).map((r) => r.id)]))
    }
  }
  perModel[model] = { sizeMB: Math.round(store.entry(model).size / 1e6), loadMs: Math.round(loadMs), ...byDir }
  if (model === DEFAULT_MODEL) defaultRuns = runs
  console.log(`${model}\n${JSON.stringify(perModel[model], null, 2)}`)
}
summary.models = perModel
if (defaultRuns.length) {
  summary.calibration = await calibrate(defaultRuns, embedder)
  summary.crossModelBackTranslation = await crossBack(defaultRuns)
}

await fs.writeFile(path.join(outDir, 'translate-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ calibration: summary.calibration, crossModelBackTranslation: summary.crossModelBackTranslation }, null, 2))
await runtime.unloadAll()
await shutdown()

// ---------------------------------------------------------------------------

/**
 * Re-checks the default model's translations with every other size as the
 * back-translator: does an independent round trip expose errors that the
 * model's own round trip hides?
 */
async function crossBack(runs: Run[]) {
  const out: Record<string, unknown> = {}
  for (const backModel of models.filter((m) => m !== DEFAULT_MODEL)) {
    const service = new TranslationService(qvacTranslator(runtime, translatorSpec(DEFAULT_MODEL)), embedder, {
      backTranslator: qvacTranslator(runtime, translatorSpec(backModel))
    })
    const rechecked: Run[] = []
    for (const r of runs) {
      const sentences = r.result.sentences.map(({ source, translation }) => ({ source, translation }))
      rechecked.push({ ...r, result: await service.check({ ...r.result, sentences }) })
    }
    await runtime.unload(runtime.loaded().find((m) => m.name === backModel)?.key ?? '')
    await fs.writeFile(
      path.join(outDir, `translate-${DEFAULT_MODEL}-back-${backModel}.csv`),
      toCsv(
        rechecked.map((r) => ({
          id: r.id,
          direction: r.dir,
          source: r.result.source,
          translation: r.result.translation,
          back_translation: r.result.backTranslation,
          fidelity: r.result.fidelity.toFixed(3),
          flags: r.result.flags.join(' ')
        }))
      )
    )
    out[backModel] = Object.fromEntries(
      ['en→sw', 'sw→en'].map((dir) => {
        const rs = rechecked.filter((r) => r.dir === dir)
        const flagged = rs.filter((r) => r.result.flags.length).map((r) => `${r.id} [${r.result.flags.join(' ')}]`)
        return [dir, { fidelity: quantiles(rs.map((r) => r.result.fidelity)), flagged }]
      })
    )
  }
  return out
}

/**
 * How well source-vs-back-translation similarity separates faithful round
 * trips from meaning changes. Perturbations are applied to the English source
 * and only sentences a rule actually changed are scored.
 */
async function calibrate(runs: Run[], emb: Embedder) {
  const en = rows.map((r) => r.en!)
  const sim = async (pairs: [string, string][]) => {
    const v = await emb.embed([...pairs.map((p) => p[0]), ...pairs.map((p) => p[1])], 'similarity')
    return pairs.map((_, i) => cosine(v[i]!, v[pairs.length + i]!))
  }
  const changed = (f: (s: string) => string) =>
    en.map((s) => [s, f(s)] as [string, string]).filter(([a, b]) => a !== b)

  const real = (dir: string) => runs.filter((r) => r.dir === dir).map((r) => r.result.fidelity)
  const sets = {
    'real round trip en→sw→en': real('en→sw'),
    'real round trip sw→en→sw': real('sw→en'),
    'negation flipped': await sim(changed(flipNegation)),
    'number changed': await sim(changed(changeNumber)),
    'unrelated sentence': await sim(en.map((s, i) => [s, en[(i + 7) % en.length]!]))
  }
  // What the rule-based checks catch on the same perturbations, as if each
  // perturbed sentence were the back-translation.
  const negations = changed(flipNegation)
  const numbers = changed(changeNumber)
  const quantitiesDiffer = ([a, b]: [string, string]) => {
    const d = diffQuantities(extractQuantities(a, 'en'), extractQuantities(b, 'en'), { units: true })
    return d.missing.length + d.added.length > 0
  }
  const detection = {
    'negation-changed on negation flips': `${negations.filter(([a, b]) => countNegations(a) !== countNegations(b)).length}/${negations.length}`,
    'numbers-changed on number changes': `${numbers.filter(quantitiesDiffer).length}/${numbers.length}`,
    'false numbers-changed on real en round trips': `${runs.filter((r) => r.dir === 'en→sw' && r.result.flags.includes('numbers-changed')).length}/${rows.length}`,
    'false negation-changed on real en round trips': `${runs.filter((r) => r.dir === 'en→sw' && r.result.flags.includes('negation-changed')).length}/${rows.length}`
  }

  const fidelity = Object.fromEntries(
    Object.entries(sets).map(([k, xs]) => [
      k,
      {
        n: xs.length,
        ...quantiles(xs),
        belowEnThreshold: xs.filter((x) => x < DEFAULT_FIDELITY_THRESHOLD.en).length,
        belowSwThreshold: xs.filter((x) => x < DEFAULT_FIDELITY_THRESHOLD.sw).length
      }
    ])
  )
  return { fidelity, detection }
}

function flipNegation(s: string): string {
  if (/\bnot\b/.test(s)) return s.replace(/\s*\bnot\b/, '')
  if (/\bcannot\b/.test(s)) return s.replace(/\bcannot\b/, 'can')
  const aux = /\b(is|are|has|have|can|was|will)\b/
  if (aux.test(s)) return s.replace(aux, '$1 not')
  return /^[A-Z][a-z]+ /.test(s) ? `Do not ${s[0]!.toLowerCase()}${s.slice(1)}` : s
}

function changeNumber(s: string): string {
  const words: Record<string, string> = { one: 'three', two: 'four', three: 'five', four: 'six' }
  if (/\d/.test(s)) return s.replace(/\d+/, (n) => String(Number(n) + 2))
  return s.replace(/\b(one|two|three|four)\b/, (w) => words[w]!)
}

function quantiles(xs: number[]) {
  return { min: round(quantile(xs, 0)), p05: round(quantile(xs, 0.05)), median: round(quantile(xs, 0.5)) }
}
