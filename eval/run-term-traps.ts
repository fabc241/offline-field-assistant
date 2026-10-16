/**
 * Terminology traps: sentences where the default translator has been seen to
 * turn one clinical term into another meaning ("drinking" → alcohol, oral
 * rehydration solution → mouthwash, syrup → broth). Each row names the wrong
 * meaning as it shows up in the English back-translation, so the eval can
 * tell whether the trap fired and whether the checks flagged it.
 *
 *   npm run eval:term-traps
 *
 * The `term-changed` check knows these meanings, so it must catch every trap
 * that fires; what decides whether it is safe to keep is its false flags.
 * Those are counted on every English round trip the other evals saved in
 * eval/outputs (run eval:translate and eval:documents first): all three
 * translator sizes, the cross-model back-translations and the documents.
 *
 * Writes eval/outputs/translate-traps.csv and translate-traps-summary.json.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { translatorSpec } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { parseCsv, toCsv } from '../src/core/csv.js'
import { qvacEmbedder, qvacTranslator } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { wrongMeanings } from '../src/features/translate/checks.js'
import { TranslationService } from '../src/features/translate/translation-service.js'

const MODEL = translatorSpec().name
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
const traps = parseCsv(await fs.readFile(path.join(PROJECT_ROOT, 'eval/datasets/term-traps.csv'), 'utf8'))

// Every saved round trip with an English source: [where, source, back-translation].
const saved: [string, string, string][] = []
for (const f of await fs.readdir(outDir)) {
  if (/^translate-TRANSLATEPSY.*\.csv$/.test(f)) {
    for (const r of parseCsv(await fs.readFile(path.join(outDir, f), 'utf8')))
      if (r.direction === 'en→sw' && r.back_translation) saved.push([`${f.replace(/\.csv$/, '')}:${r.id}`, r.source!, r.back_translation])
  } else if (f === 'documents-translations.csv') {
    for (const r of parseCsv(await fs.readFile(path.join(outDir, f), 'utf8')))
      if (r.to === 'sw' && r.backTranslation) saved.push([`documents:${r.doc}`, r.original!, r.backTranslation])
  }
}

const config = loadConfig()
const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
const service = new TranslationService(qvacTranslator(runtime), qvacEmbedder(runtime))
const rows = []
try {
  for (const t of traps) {
    const r = await service.translateWithCheck(t.en!, 'en', 'sw')
    const fired = new RegExp(t.wrong_meaning!, 'i').test(r.backTranslation)
    rows.push({
      id: t.id!,
      source: t.en!,
      translation: r.translation,
      back_translation: r.backTranslation,
      fidelity: r.fidelity.toFixed(3),
      flags: r.flags.join(' '),
      trap_fired: fired ? 'yes' : 'no',
      caught: fired ? (r.flags.includes('term-changed') ? 'yes' : 'no') : ''
    })
  }
} finally {
  await runtime.unloadAll()
  await shutdown()
}

const fired = rows.filter((r) => r.trap_fired === 'yes')
const falseFlags = saved.map(([where, source, back]) => ({ where, source, back, meanings: wrongMeanings(source, back) })).filter((x) => x.meanings.length)
const summary = {
  model: MODEL,
  traps: rows.length,
  trapsFired: fired.length,
  caughtByTermChanged: `${fired.filter((r) => r.caught === 'yes').length}/${fired.length}`,
  // Saved round trips include the trap sentences themselves when they are in the intake set (i45, syrup → broth).
  termChangedOnSavedRoundTrips: `${falseFlags.length}/${saved.length}`,
  flaggedSavedRoundTrips: falseFlags,
  rows
}
await fs.writeFile(path.join(outDir, 'translate-traps.csv'), toCsv(rows))
await fs.writeFile(path.join(outDir, 'translate-traps-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
