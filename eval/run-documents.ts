/**
 * F8 eval: document translate on rendered placeholder forms and labels, with
 * no human judge. The documents are written out in eval/datasets/documents.json
 * and rendered by eval/make-documents.ts, so their text is the ground truth.
 *
 *   npm run eval:documents [-- --no-translate]
 *
 * - Reading: character error rate per page, strict (case and punctuation
 *   count) and normalized (as F2's WER); blocks that come back as one intact
 *   segment; numbers (doses, dates, weights) read exactly.
 * - Low-confidence flag: on the dev documents only, every threshold is tried
 *   against the segments with a misread word; the chosen one is then measured
 *   on the eval documents. Raw engine confidence is the A/B.
 * - A/B on the dev documents: OCR settings (rotation retries, detector
 *   magnification) and deskewing.
 * - Translation: each eval document into its other language, with the F1
 *   check; time per page. OCR noise is measured as drift: chrF of the
 *   translation of what was read against the translation of the true text
 *   (same model), so 100 means the misreads changed nothing.
 *
 * Writes eval/outputs/documents-summary.json, documents-segments.csv and
 * documents-translations.csv; the rendered files go to var/eval-docs/.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { MODEL_SPECS, ocrSpec } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { toCsv } from '../src/core/csv.js'
import { qvacEmbedder, qvacOcr, qvacTranslator, type Lang } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown, systemResources } from '../src/core/qvac.js'
import { editDistance, normalizeForWer } from '../src/core/wer.js'
import { DEFAULT_MIN_CONFIDENCE, DocumentService, type DocumentOptions, type ReadDocument } from '../src/features/documents/document-service.js'
import { guessLang } from '../src/features/documents/language.js'
import { TranslationService } from '../src/features/translate/translation-service.js'
import { chrF } from './chrf.js'
import { renderAll, type RenderedDocument } from './make-documents.js'
import { quantile, round } from './stats.js'

const { values } = parseArgs({ options: { 'no-translate': { type: 'boolean', default: false } } })
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })

const docs = await renderAll()
const devDocs = docs.filter((d) => d.set === 'dev')
const evalDocs = docs.filter((d) => d.set === 'eval')

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const translation = new TranslationService(qvacTranslator(runtime, MODEL_SPECS.translator), qvacEmbedder(runtime, MODEL_SPECS.embedder))
const service = (ocrConfig: Record<string, unknown> = {}, opts: DocumentOptions = {}) =>
  new DocumentService(qvacOcr(runtime, ocrSpec(ocrConfig)), translation, opts)

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Strict: only Unicode and whitespace normalized. */
const strict = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim()
const cer = (ref: string, hyp: string) => ({ errors: editDistance([...ref], [...hyp]), chars: [...ref].length })
const words = (s: string) => normalizeForWer(s).split(' ').filter(Boolean)
/** Numbers as printed: 14.5, 12/03/2019, 0712, 9:00. */
const numbers = (s: string) => s.match(/\d+(?:[.,:/]\d+)*/g) ?? []

/** Word errors of `hyp` against its best-matching stretch of `ref` (free start and end in `ref`). */
function semiGlobal(ref: string[], hyp: string[]): number {
  let prev = new Array<number>(ref.length + 1).fill(0)
  for (let i = 1; i <= hyp.length; i++) {
    const cur = [i]
    for (let j = 1; j <= ref.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (hyp[i - 1] === ref[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return Math.min(...prev)
}

/** Multiset recall: how many of `want` appear in `have`. */
function found(want: string[], have: string[]): number {
  const pool = [...have]
  let n = 0
  for (const w of want) {
    const i = pool.indexOf(w)
    if (i >= 0) {
      pool.splice(i, 1)
      n++
    }
  }
  return n
}

interface PageScore {
  doc: string
  page: number
  source: string
  readMs: number
  strict: { errors: number; chars: number }
  normalized: { errors: number; chars: number }
  blocks: number
  intact: number
  numbers: number
  numbersRead: number
}

interface SegmentRow {
  doc: string
  set: string
  page: number
  source: string
  confidence: number | null
  wordErrors: number
  numberErrors: number
  text: string
}

function score(doc: RenderedDocument, read: ReadDocument) {
  const pages: PageScore[] = []
  const segments: SegmentRow[] = []
  for (const [i, truth] of doc.truth.entries()) {
    const page = i + 1
    const segs = read.segments.filter((s) => s.page === page)
    const info = read.pages[i]!
    const ref = truth.join(' ')
    const hyp = segs.map((s) => s.text).join(' ')
    const intact = truth.filter((block) =>
      segs.some((s) => {
        const c = cer(normalizeForWer(block), normalizeForWer(s.text))
        return c.errors <= 0.15 * c.chars
      })
    ).length
    pages.push({
      doc: doc.id,
      page,
      source: info.source,
      readMs: info.readMs,
      strict: cer(strict(ref), strict(hyp)),
      normalized: cer(normalizeForWer(ref), normalizeForWer(hyp)),
      blocks: truth.length,
      intact,
      numbers: numbers(ref).length,
      numbersRead: found(numbers(ref), numbers(hyp))
    })
    const refWords = words(ref)
    for (const s of segs) {
      const wordErrors = semiGlobal(refWords, words(s.text))
      // A number in the segment that the page does not have was misread.
      const numberErrors = numbers(s.text).length - found(numbers(s.text), numbers(ref))
      segments.push({ doc: doc.id, set: doc.set, page, source: s.source, confidence: s.ocrConfidence, wordErrors, numberErrors, text: s.text })
    }
  }
  return { pages, segments }
}

function summarize(pages: PageScore[]) {
  const sum = (f: (p: PageScore) => number) => pages.reduce((s, p) => s + f(p), 0)
  return {
    pages: pages.length,
    cerStrict: round((100 * sum((p) => p.strict.errors)) / Math.max(1, sum((p) => p.strict.chars)), 2),
    cerNormalized: round((100 * sum((p) => p.normalized.errors)) / Math.max(1, sum((p) => p.normalized.chars)), 2),
    blocksIntact: `${sum((p) => p.intact)}/${sum((p) => p.blocks)}`,
    numbersRead: `${sum((p) => p.numbersRead)}/${sum((p) => p.numbers)}`,
    readMs: { median: Math.round(quantile(pages.map((p) => p.readMs), 0.5)), max: Math.round(Math.max(...pages.map((p) => p.readMs))) }
  }
}

/** Flagging at a threshold: misread segments caught, clean ones flagged needlessly. */
function flagging(rows: SegmentRow[], threshold: number) {
  const ocr = rows.filter((r) => r.confidence !== null)
  const bad = ocr.filter((r) => r.wordErrors > 0)
  const clean = ocr.filter((r) => r.wordErrors === 0)
  const numberBad = ocr.filter((r) => r.numberErrors > 0)
  const flagged = (r: SegmentRow) => r.confidence! < threshold
  return {
    threshold,
    misread: `${bad.filter(flagged).length}/${bad.length}`,
    misreadNumbers: `${numberBad.filter(flagged).length}/${numberBad.length}`,
    cleanFlagged: `${clean.filter(flagged).length}/${clean.length}`,
    recall: bad.length ? bad.filter(flagged).length / bad.length : 1,
    falseRate: clean.length ? clean.filter(flagged).length / clean.length : 0
  }
}

/** Area under the ROC curve: chance a misread segment scores below a clean one. */
function auc(rows: SegmentRow[]): number {
  const ocr = rows.filter((r) => r.confidence !== null)
  const bad = ocr.filter((r) => r.wordErrors > 0).map((r) => r.confidence!)
  const clean = ocr.filter((r) => r.wordErrors === 0).map((r) => r.confidence!)
  let wins = 0
  for (const b of bad) for (const c of clean) wins += b < c ? 1 : b === c ? 0.5 : 0
  return bad.length && clean.length ? round(wins / (bad.length * clean.length), 3) : NaN
}

async function readAll(set: RenderedDocument[], svc: DocumentService) {
  // Load the OCR model before timing.
  await svc.read(set.find((d) => d.format !== 'pdf-text')!.file)
  const pages: PageScore[] = []
  const segments: SegmentRow[] = []
  const reads = new Map<string, ReadDocument>()
  for (const doc of set) {
    const read = await svc.read(doc.file)
    reads.set(doc.id, read)
    const s = score(doc, read)
    pages.push(...s.pages)
    segments.push(...s.segments)
  }
  return { pages, segments, reads }
}

// ---------------------------------------------------------------------------
// Dev: OCR settings, deskew, confidence
// ---------------------------------------------------------------------------

// The app's settings (ocrSpec()) are the second row; the others override them.
const OCR_VARIANTS: Record<string, [Record<string, unknown>, DocumentOptions]> = {
  'engine defaults (magnify 1.5, retry unsure lines at 90/270)': [{ defaultRotationAngles: [90, 270] }, {}],
  'no rotation retries (app)': [{}, {}],
  'no rotation retries, magnify 1.0': [{ magRatio: 1.0 }, {}],
  'no rotation retries, magnify 2.0': [{ magRatio: 2.0 }, {}],
  'no rotation retries, scans at 2 px/pt (not 3)': [{}, { maxSide: 2 * 842 }]
}
const ocrAb: Record<string, unknown> = {}
for (const [name, [cfg, opts]] of Object.entries(OCR_VARIANTS)) {
  const r = await readAll(devDocs, service(cfg, opts))
  ocrAb[name] = { ...summarize(r.pages.filter((p) => p.source === 'ocr')), auc: auc(r.segments) }
  await runtime.unloadAll()
}
const devRun = await readAll(devDocs, service())
const devNoDeskew = await readAll(devDocs, service({}, { deskew: false }))
const devRaw = await readAll(devDocs, service({}, { normalizeConfidence: false }))

const THRESHOLDS = [0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98]
const devSweep = THRESHOLDS.map((t) => flagging(devRun.segments, t))
const rawSweep = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => flagging(devRaw.segments, t))

// ---------------------------------------------------------------------------
// Eval: reading, flags, translation
// ---------------------------------------------------------------------------

const evalSvc = service()
const evalRun = await readAll(evalDocs, evalSvc)
const evalNoDeskew = await readAll(evalDocs, service({}, { deskew: false }))
const evalRaw = await readAll(evalDocs, service({}, { normalizeConfidence: false }))
const bySource = (pages: PageScore[]) => ({
  all: summarize(pages),
  textLayer: summarize(pages.filter((p) => p.source === 'text-layer')),
  ocr: summarize(pages.filter((p) => p.source === 'ocr'))
})
const perDoc = Object.fromEntries(
  evalDocs.map((d) => [d.id, { title: d.title, format: d.format, ...summarize(evalRun.pages.filter((p) => p.doc === d.id)) }])
)

let translate: Record<string, unknown> | undefined
const translationRows: Record<string, string | number>[] = []
if (!values['no-translate']) {
  const perPageMs: number[] = []
  const drift: { doc: string; page: number; chrF: number }[] = []
  const flagCounts: Record<string, number> = {}
  let segments = 0
  let kept = 0
  let peakRss = 0
  for (const doc of evalDocs) {
    const read = evalRun.reads.get(doc.id)!
    const lang = guessLang(doc.truth.flat().join(' ')).lang
    const to: Lang = lang === 'en' ? 'sw' : 'en'
    const t0 = performance.now()
    const result = await evalSvc.translate(read, to)
    // Reading time comes from the read above; translate() reuses it.
    perPageMs.push(...read.pages.map(() => (read.readMs + performance.now() - t0) / read.pages.length))
    const rss = (await systemResources(true).catch(() => undefined))?.sample?.memory.processUsedBytes
    if (rss?.status === 'supported') peakRss = Math.max(peakRss, rss.value)
    segments += result.segments.length
    kept += result.segments.filter((s) => s.kept).length
    for (const s of result.segments) for (const f of s.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1

    for (const [i, truth] of doc.truth.entries()) {
      const page = i + 1
      const segs = result.segments.filter((s) => s.page === page)
      // The true text through the same pipeline, block by block.
      const truthTranslations: string[] = []
      for (const block of truth) {
        const g = guessLang(block)
        truthTranslations.push(g.lang === to && g.margin >= 2 ? block : (await translation.translate(block, to === 'en' ? 'sw' : 'en', to)).translation)
      }
      const c = chrF([segs.map((s) => s.translation).join(' ')], [truthTranslations.join(' ')])
      drift.push({ doc: doc.id, page, chrF: round(c, 1) })
      for (const s of segs) {
        translationRows.push({
          doc: doc.id,
          page,
          to,
          confidence: s.ocrConfidence ?? '',
          original: s.original,
          translation: s.translation,
          kept: s.kept ?? '',
          backTranslation: s.backTranslation ?? '',
          flags: s.flags.join(' ')
        })
      }
    }
  }
  const driftOf = (pred: (d: RenderedDocument) => boolean) => {
    const xs = drift.filter((d) => pred(evalDocs.find((e) => e.id === d.doc)!)).map((d) => d.chrF)
    return { median: quantile(xs, 0.5), min: Math.min(...xs) }
  }
  translate = {
    segments,
    keptAsIs: kept,
    flags: flagCounts,
    perPageMs: { median: Math.round(quantile(perPageMs, 0.5)), p90: Math.round(quantile(perPageMs, 0.9)), max: Math.round(Math.max(...perPageMs)) },
    drift: { textLayer: driftOf((d) => d.format === 'pdf-text'), ocr: driftOf((d) => d.format !== 'pdf-text'), perPage: drift },
    ...(peakRss ? { peakWorkerRssGb: round(peakRss / 1024 ** 3, 2) } : {})
  }
}

const summary = {
  documents: { eval: evalDocs.length, dev: devDocs.length, evalPages: evalRun.pages.length },
  ocrConfig: ocrSpec().config,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  dev: {
    ocrSettings: ocrAb,
    reading: bySource(devRun.pages),
    withoutDeskew: summarize(devNoDeskew.pages.filter((p) => p.source === 'ocr')),
    confidence: { auc: auc(devRun.segments), aucRaw: auc(devRaw.segments), sweep: devSweep, rawSweep }
  },
  eval: {
    reading: bySource(evalRun.pages),
    withoutDeskew: summarize(evalNoDeskew.pages.filter((p) => p.source === 'ocr')),
    perDocument: perDoc,
    confidence: { auc: auc(evalRun.segments), aucRaw: auc(evalRaw.segments), atDefault: flagging(evalRun.segments, DEFAULT_MIN_CONFIDENCE), sweep: THRESHOLDS.map((t) => flagging(evalRun.segments, t)) },
    ...(translate ? { translate } : {})
  }
}
await fs.writeFile(path.join(outDir, 'documents-summary.json'), JSON.stringify(summary, null, 2) + '\n')
await fs.writeFile(
  path.join(outDir, 'documents-segments.csv'),
  toCsv([...devRun.segments, ...evalRun.segments].map((s) => ({ ...s, confidence: s.confidence ?? '' })))
)
if (translationRows.length) await fs.writeFile(path.join(outDir, 'documents-translations.csv'), toCsv(translationRows))
console.log(JSON.stringify(summary, null, 2))
await runtime.unloadAll()
await shutdown()
