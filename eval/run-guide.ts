/**
 * F7 eval: the guide on the signed sample pack, with no human judge.
 *
 *   npm run eval:guide [-- --dir content/sample --no-voice]
 *
 * - Search: eval/datasets/guide-queries.csv, 100 questions (10 per card, half
 *   English, half Swahili) of five kinds: keyword, question, typo, mixed
 *   (code-switching) and synonym (words the card does not use). A hit is the
 *   expected card among the cards the guide offers (at most 3). The target is
 *   ≥90 % top 3. The same file has 20 out-of-scope questions, which must get
 *   "no match — see a clinician". The thresholds were chosen on
 *   eval/datasets/guide-dev.csv only; its numbers are reported alongside.
 * - A/B: score fusion (default) against reciprocal-rank fusion, keyword
 *   search alone, meaning search alone.
 * - Voice: the keyword, question and synonym queries are read by Chatterbox
 *   in their language, heard by the F2 Whisper, and searched; hit rate
 *   against the same queries typed. Chatterbox Swahili is hard for Whisper
 *   (F2, F3), so the Swahili voice numbers are a floor.
 * - Time: open (verify and index the pack), search per query, embedding share.
 *
 * Writes eval/outputs/guide-summary.json, guide-search.csv and guide-voice.csv;
 * the rendered questions go to var/eval-audio/guide-queries/.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { encodeWav, resample, SPEECH_SAMPLE_RATE } from '../src/core/audio.js'
import { MODEL_SPECS } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { parseCsv, toCsv } from '../src/core/csv.js'
import { LANGS, isLang, qvacEmbedder, qvacSpeaker, qvacTranscriber, type Embedder, type Lang } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { corpusRates, errorCounts } from '../src/core/wer.js'
import { DEFAULT_THRESHOLDS, Guide, type GuideResult, type GuideSearchOptions } from '../src/features/guide/guide.js'
import { buildPack, signPack } from '../src/features/packs/build.js'
import { PackLoader } from '../src/features/packs/loader.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../src/features/packs/signing.js'
import { SpeechToText } from '../src/features/speech/speech-service.js'
import { ReadAloud } from '../src/features/voice/read-aloud.js'
import { speakerSpecs } from '../src/features/voice/voices.js'
import { EVAL_AUDIO_DIR, readSet, writeSet, type Clip } from './audio-sets.js'
import { quantile, round } from './stats.js'

const { values } = parseArgs({ options: { dir: { type: 'string' }, 'no-voice': { type: 'boolean', default: false } } })
const sourceDir = path.resolve(values.dir ?? path.join(PROJECT_ROOT, 'content/sample'))
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const spec = MODEL_SPECS.embedder

// The pack as a device gets it: built, signed, verified.
const embedder = qvacEmbedder(runtime, spec)
const built = await buildPack(sourceDir, { embedder, embeddingModel: { name: spec.name, sha256: store.entry(spec.name).sha256 } })
const key = generateSigningKey()
const signed = signPack(built.bytes, loadPrivateKey(key.privateKeyPem)).bytes
const loader = new PackLoader({ trustedKeys: [trustedKey('eval key', key.publicKeyPem)] })

const embedMs: number[] = []
const timedEmbedder: Embedder = {
  async embed(texts, task) {
    const t0 = performance.now()
    const out = await embedder.embed(texts, task)
    embedMs.push(performance.now() - t0)
    return out
  }
}
const openMs: number[] = []
let guide!: Guide
for (let i = 0; i < 20; i++) {
  const t0 = performance.now()
  guide = new Guide(await loader.verifyAndLoad(signed), { embedder: timedEmbedder })
  openMs.push(performance.now() - t0)
}
const cardIds = new Set(guide.list('en').map((c) => c.id))

interface Query {
  query: string
  lang: Lang
  expected: string
  kind: string
}
async function readQueries(file: string): Promise<Query[]> {
  return parseCsv(await fs.readFile(path.join(PROJECT_ROOT, file), 'utf8')).map((r) => {
    if (!isLang(r.lang!) || (r.expected && !cardIds.has(r.expected))) throw new Error(`${file}: bad row ${JSON.stringify(r)}`)
    return { query: r.query!, lang: r.lang, expected: r.expected!, kind: r.kind! }
  })
}
const queries = await readQueries('eval/datasets/guide-queries.csv')
const devQueries = await readQueries('eval/datasets/guide-dev.csv')
// Load the embedder before timing.
await guide.search('warm up', 'en')
embedMs.length = 0

const offered = (r: GuideResult) => (r.status === 'match' ? r.hits.map((h) => h.card.id) : [])

interface Outcome extends Query {
  rank: number
  offered: string[]
}
function rates(rows: Outcome[]) {
  const inScope = rows.filter((r) => r.expected)
  const outOfScope = rows.filter((r) => !r.expected)
  return {
    queries: inScope.length,
    top1: inScope.filter((r) => r.rank === 1).length,
    top3: inScope.filter((r) => r.rank >= 1 && r.rank <= 3).length,
    ...(outOfScope.length ? { outOfScope: outOfScope.length, noMatch: outOfScope.filter((r) => !r.offered.length).length } : {})
  }
}
function report(rows: Outcome[]) {
  const kinds = [...new Set(rows.filter((r) => r.expected).map((r) => r.kind))]
  return {
    all: rates(rows),
    byLang: Object.fromEntries(LANGS.map((l) => [l, rates(rows.filter((r) => r.lang === l))])),
    byKind: Object.fromEntries(kinds.map((k) => [k, rates(rows.filter((r) => r.kind === k))])),
    misses: rows.filter((r) => r.expected && !(r.rank >= 1 && r.rank <= 3)).map((r) => `${r.kind} ${r.lang} "${r.query}" → ${r.expected}; offered ${r.offered.join(', ') || 'nothing'}`),
    acceptedOutOfScope: rows.filter((r) => !r.expected && r.offered.length).map((r) => `${r.lang} "${r.query}" → ${r.offered.join(', ')}`)
  }
}

// Search, typed.
const VARIANTS: Record<string, GuideSearchOptions> = {
  'hybrid, score fusion (default)': {},
  'hybrid, reciprocal-rank fusion': { fusion: 'rrf' },
  'keyword only': { only: 'keyword' },
  'meaning only': { only: 'semantic' }
}
const searchRows: Record<string, string | number>[] = []
const searchMs: Record<string, number[]> = {}
const searchSummary: Record<string, unknown> = {}
for (const [variant, opts] of Object.entries(VARIANTS)) {
  searchMs[variant] = []
  const outcomes: Outcome[] = []
  for (const q of queries) {
    const t0 = performance.now()
    const result = await guide.search(q.query, q.lang, opts)
    searchMs[variant].push(performance.now() - t0)
    const ids = offered(result)
    const rank = ids.indexOf(q.expected) + 1
    outcomes.push({ ...q, rank, offered: ids })
    const best = result.status === 'match' ? result.hits[0].confidence : undefined
    searchRows.push({
      variant,
      query: q.query,
      lang: q.lang,
      kind: q.kind,
      expected: q.expected,
      rank,
      offered: ids.join(' | '),
      keyword: best ? round(best.keyword, 2) : '',
      lift: best?.lift !== undefined ? round(best.lift, 3) : ''
    })
  }
  searchSummary[variant] = report(outcomes)
}
const defaultEmbedMs = embedMs.slice(0, queries.length)

// The tuning set, with the defaults: what the thresholds were chosen on.
const devOutcomes: Outcome[] = []
for (const q of devQueries) {
  const ids = offered(await guide.search(q.query, q.lang))
  devOutcomes.push({ ...q, rank: ids.indexOf(q.expected) + 1, offered: ids })
}

// Threshold sensitivity on the eval queries (not used to choose them).
const sweep: Record<string, unknown>[] = []
for (const minCoverage of [0.35, 0.45, 0.55]) {
  for (const minLift of [0.12, 0.17, 0.22]) {
    const g = new Guide(await loader.verifyAndLoad(signed), { embedder, thresholds: { minCoverage, minLift } })
    const outcomes: Outcome[] = []
    for (const q of queries) {
      const ids = offered(await g.search(q.query, q.lang))
      outcomes.push({ ...q, rank: ids.indexOf(q.expected) + 1, offered: ids })
    }
    sweep.push({ minCoverage, minLift, ...rates(outcomes) })
  }
}

// Voice: the same questions, read aloud and heard back.
let voice: Record<string, unknown> | undefined
const voiceRows: Record<string, string | number>[] = []
if (!values['no-voice']) {
  const VOICE_KINDS = ['keyword', 'question', 'synonym']
  const spoken = queries.filter((q) => VOICE_KINDS.includes(q.kind))
  const setName = 'guide-queries'
  const setDir = path.join(EVAL_AUDIO_DIR, setName)
  let clips = await readSet(setName)
  const wanted = spoken.map((q, i) => ({ id: `q${String(i + 1).padStart(3, '0')}`, ...q }))
  if (!clips || clips.length !== wanted.length || clips.some((c, i) => c.text !== wanted[i]!.query)) {
    await fs.mkdir(setDir, { recursive: true })
    const reader = new ReadAloud(qvacSpeaker(runtime, await speakerSpecs({})))
    clips = []
    for (const q of wanted) {
      const speech = await reader.speak(q.query, q.lang)
      const file = path.join(setDir, `${q.id}.${q.lang}.wav`)
      await fs.writeFile(file, encodeWav(resample(speech.samples, speech.sampleRate, SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE))
      clips.push({ id: q.id, lang: q.lang, file, text: q.query } satisfies Clip)
    }
    await writeSet(setName, clips)
    await runtime.unloadAll()
  }
  const voiceGuide = new Guide(await loader.verifyAndLoad(signed), { embedder, speech: new SpeechToText(qvacTranscriber(runtime, MODEL_SPECS.stt)) })
  await voiceGuide.searchByVoice(clips[0]!.file, clips[0]!.lang) // load Whisper before timing
  const voiceOutcomes: Outcome[] = []
  const typedOutcomes: Outcome[] = []
  const answerMs: number[] = []
  const counts: Record<Lang, ReturnType<typeof errorCounts>[]> = { en: [], sw: [] }
  for (const [i, clip] of clips.entries()) {
    const q = wanted[i]!
    const t0 = performance.now()
    const { transcript, result } = await voiceGuide.searchByVoice(clip.file, clip.lang)
    answerMs.push(performance.now() - t0)
    const ids = offered(result)
    const typed = offered(await voiceGuide.search(q.query, q.lang))
    voiceOutcomes.push({ ...q, rank: ids.indexOf(q.expected) + 1, offered: ids })
    typedOutcomes.push({ ...q, rank: typed.indexOf(q.expected) + 1, offered: typed })
    const c = errorCounts(q.query, transcript.text)
    counts[q.lang].push(c)
    voiceRows.push({
      id: clip.id,
      lang: q.lang,
      kind: q.kind,
      expected: q.expected,
      query: q.query,
      heard: transcript.text,
      wer: round((100 * c.wordErrors) / Math.max(1, c.words), 1),
      rank: ids.indexOf(q.expected) + 1,
      typedRank: typed.indexOf(q.expected) + 1,
      offered: ids.join(' | ')
    })
  }
  voice = {
    queries: clips.length,
    heard: Object.fromEntries(LANGS.map((l) => [l, { wer: round(corpusRates(counts[l]).wer, 1), cer: round(corpusRates(counts[l]).cer, 1) }])),
    spoken: report(voiceOutcomes),
    typed: rates(typedOutcomes),
    answerMs: { median: Math.round(quantile(answerMs, 0.5)), p90: Math.round(quantile(answerMs, 0.9)) }
  }
}

const ms = (xs: number[]) => ({ medianMs: round(quantile(xs, 0.5), 1), p90Ms: round(quantile(xs, 0.9), 1) })
const summary = {
  source: path.relative(PROJECT_ROOT, sourceDir),
  pack: { id: guide.packId, version: guide.packVersion, cards: cardIds.size },
  thresholds: DEFAULT_THRESHOLDS,
  randomTop3: round(3 / cardIds.size, 2),
  open: ms(openMs),
  searchTime: {
    hybrid: ms(searchMs['hybrid, score fusion (default)']!),
    embedQuery: ms(defaultEmbedMs),
    keywordOnly: { medianMs: round(quantile(searchMs['keyword only']!, 0.5), 3), p90Ms: round(quantile(searchMs['keyword only']!, 0.9), 3) }
  },
  search: searchSummary,
  dev: report(devOutcomes),
  thresholdSweep: sweep,
  ...(voice ? { voice } : {})
}
await fs.writeFile(path.join(outDir, 'guide-summary.json'), JSON.stringify(summary, null, 2) + '\n')
await fs.writeFile(path.join(outDir, 'guide-search.csv'), toCsv(searchRows))
if (voiceRows.length) await fs.writeFile(path.join(outDir, 'guide-voice.csv'), toCsv(voiceRows))
console.log(JSON.stringify(summary, null, 2))
await runtime.unloadAll()
await shutdown()
