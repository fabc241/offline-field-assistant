/**
 * F6 eval: the phrasebook on the signed sample pack, with no human listener.
 *
 *   npm run eval:phrasebook [-- --dir content/sample --queries eval/datasets/phrase-queries.csv]
 *
 * - Open: verify and load the pack (recordings included) and index the
 *   phrasebook, median of 20.
 * - Time to audio: from a phrase id to decoded samples ready to play, for
 *   every recording. Read-aloud's first audio (F3) is the comparison.
 * - Search: each query in the dataset must bring its phrase into the top 3
 *   (and top 1). Kinds: keyword, partial (word start or stem), typo, mixed
 *   (words from the other language), form (another form of a word) and
 *   synonym (a word the phrase does not use; keyword search is not expected
 *   to find these). The target is ≥90 % top 3 on keyword, partial, typo and
 *   mixed. A/B: matching the other language's text (weight 0.8) or not.
 * - Recordings: the F2 Whisper transcribes every recording; WER/CER against
 *   the phrase text, both in spoken form (as in F3). For the synthetic
 *   placeholders this checks that each one says its phrase, and ranks the
 *   ones to replace first.
 *
 * Writes eval/outputs/phrasebook-summary.json, phrasebook-search.csv and
 * phrasebook-recordings.csv.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { decodeWav, toSpeechInput } from '../src/core/audio.js'
import { MODEL_SPECS } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { parseCsv, toCsv } from '../src/core/csv.js'
import { LANGS, isLang, qvacEmbedder, qvacTranscriber, type Lang } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { buildPack, signPack } from '../src/features/packs/build.js'
import { PackLoader } from '../src/features/packs/loader.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../src/features/packs/signing.js'
import { Phrasebook } from '../src/features/phrasebook/phrasebook.js'
import { SpeechToText } from '../src/features/speech/speech-service.js'
import { durationFlags } from '../src/features/voice/read-aloud.js'
import { toSpokenForm } from '../src/features/voice/spoken.js'
import { quantile, round } from './stats.js'
import { corpusRates, errorCounts, normalizeForWer } from '../src/core/wer.js'

const { values } = parseArgs({ options: { dir: { type: 'string' }, queries: { type: 'string' } } })
const sourceDir = path.resolve(values.dir ?? path.join(PROJECT_ROOT, 'content/sample'))
const queriesFile = path.resolve(values.queries ?? path.join(PROJECT_ROOT, 'eval/datasets/phrase-queries.csv'))
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const spec = MODEL_SPECS.embedder

// The pack as a device gets it: built, signed, verified.
const built = await buildPack(sourceDir, {
  embedder: qvacEmbedder(runtime, spec),
  embeddingModel: { name: spec.name, sha256: store.entry(spec.name).sha256 }
})
const key = generateSigningKey()
const signed = signPack(built.bytes, loadPrivateKey(key.privateKeyPem)).bytes
await runtime.unloadAll()
const loader = new PackLoader({ trustedKeys: [trustedKey('eval key', key.publicKeyPem)] })

const openMs: number[] = []
let book!: Phrasebook
for (let i = 0; i < 20; i++) {
  const t0 = performance.now()
  book = new Phrasebook(await loader.verifyAndLoad(signed))
  openMs.push(performance.now() - t0)
}
const phrases = book.list()

// Time to audio.
const toAudioMs: number[] = []
for (let round = 0; round < 5; round++) {
  for (const p of phrases) {
    for (const lang of LANGS) {
      const t0 = performance.now()
      decodeWav(book.recording(p.id, lang))
      toAudioMs.push(performance.now() - t0)
    }
  }
}

// Search.
const queries = parseCsv(await fs.readFile(queriesFile, 'utf8'))
for (const q of queries) {
  if (!isLang(q.lang!) || !book.get(q.expected!)) throw new Error(`Bad query row: ${JSON.stringify(q)}`)
}
const TARGET_KINDS = ['keyword', 'partial', 'typo', 'mixed']
const SEARCH_VARIANTS = { 'other language 0.8 (default)': 0.8, 'own language only': 0 }
const searchRows: Record<string, string | number>[] = []
const searchMs: number[] = []
const searchSummary: Record<string, unknown> = {}
for (const [variant, otherLangWeight] of Object.entries(SEARCH_VARIANTS)) {
  const results = queries.map((q) => {
    const t0 = performance.now()
    const hits = book.search(q.query!, q.lang as Lang, { otherLangWeight })
    searchMs.push(performance.now() - t0)
    const rank = hits.findIndex((h) => h.phrase.id === q.expected) + 1
    searchRows.push({ variant, query: q.query!, lang: q.lang!, kind: q.kind!, expected: q.expected!, rank, top: hits.slice(0, 3).map((h) => `${h.phrase.id} ${h.score.toFixed(2)}`).join(' | ') })
    return { query: q.query!, lang: q.lang!, kind: q.kind!, expected: q.expected!, rank }
  })
  const rate = (rows: typeof results) => ({
    queries: rows.length,
    top1: rows.filter((r) => r.rank === 1).length,
    top3: rows.filter((r) => r.rank >= 1 && r.rank <= 3).length
  })
  const kinds = [...new Set(queries.map((q) => q.kind!))]
  searchSummary[variant] = {
    target: rate(results.filter((r) => TARGET_KINDS.includes(r.kind))),
    byKind: Object.fromEntries(kinds.map((k) => [k, rate(results.filter((r) => r.kind === k))])),
    byLang: Object.fromEntries(LANGS.map((l) => [l, rate(results.filter((r) => r.lang === l && TARGET_KINDS.includes(r.kind)))])),
    misses: results.filter((r) => !(r.rank >= 1 && r.rank <= 3)).map((r) => `${r.kind} ${r.lang} "${r.query}" → ${r.expected}`)
  }
}

// Recordings, heard back by Whisper.
const stt = new SpeechToText(qvacTranscriber(runtime))
const recordingRows: Record<string, string | number>[] = []
const counts: Record<Lang, ReturnType<typeof errorCounts>[]> = { en: [], sw: [] }
for (const p of phrases) {
  for (const lang of LANGS) {
    const wav = decodeWav(book.recording(p.id, lang))
    const samples = wav.channels[0]!
    const audioMs = (samples.length / wav.sampleRate) * 1000
    let peak = 0
    for (const v of samples) peak = Math.max(peak, Math.abs(v))
    const heard = await stt.transcribe(toSpeechInput(wav), lang)
    const c = errorCounts(toSpokenForm(p.text[lang], lang), toSpokenForm(heard.text, lang))
    counts[lang].push(c)
    recordingRows.push({
      id: p.id,
      lang,
      synthetic: String(p.recordings[lang].synthetic),
      text: p.text[lang],
      heard: heard.text,
      wer: round((100 * c.wordErrors) / Math.max(1, c.words), 1),
      cer: round((100 * c.charErrors) / Math.max(1, c.chars), 1),
      audioMs: Math.round(audioMs),
      peakDbfs: round(20 * Math.log10(peak), 1),
      flags: [...durationFlags(toSpokenForm(p.text[lang], lang), audioMs, lang), ...heard.flags].join(' ')
    })
  }
}
const byLang = Object.fromEntries(
  LANGS.map((lang) => {
    const rows = recordingRows.filter((r) => r.lang === lang)
    const { wer, cer } = corpusRates(counts[lang])
    const exact = rows.filter((r) => normalizeForWer(toSpokenForm(String(r.text), lang)) === normalizeForWer(toSpokenForm(String(r.heard), lang)))
    return [
      lang,
      {
        recordings: rows.length,
        synthetic: rows.filter((r) => r.synthetic === 'true').length,
        wer: round(wer, 1),
        cer: round(cer, 1),
        heardExactly: exact.length,
        flagged: rows.filter((r) => r.flags).map((r) => `${r.id}: ${r.flags}`),
        durationS: { min: round(Math.min(...rows.map((r) => Number(r.audioMs))) / 1000, 1), max: round(Math.max(...rows.map((r) => Number(r.audioMs))) / 1000, 1) },
        // The placeholders to replace first: what Whisper heard least well.
        worst: [...rows].sort((a, b) => Number(b.cer) - Number(a.cer)).slice(0, 5).map((r) => `${r.id} CER ${r.cer}: "${r.text}" → "${r.heard}"`)
      }
    ]
  })
)

const summary = {
  source: path.relative(PROJECT_ROOT, sourceDir),
  pack: { id: book.packId, version: book.packVersion, phrases: phrases.length, recordings: phrases.length * 2, bytes: signed.length },
  open: { medianMs: round(quantile(openMs, 0.5), 1), p90Ms: round(quantile(openMs, 0.9), 1) },
  timeToAudio: { medianMs: round(quantile(toAudioMs, 0.5), 3), p90Ms: round(quantile(toAudioMs, 0.9), 3), maxMs: round(Math.max(...toAudioMs), 3) },
  search: { medianMs: round(quantile(searchMs, 0.5), 3), p90Ms: round(quantile(searchMs, 0.9), 3), ...searchSummary },
  recordings: byLang
}
await fs.writeFile(path.join(outDir, 'phrasebook-summary.json'), JSON.stringify(summary, null, 2) + '\n')
await fs.writeFile(path.join(outDir, 'phrasebook-search.csv'), toCsv(searchRows))
await fs.writeFile(path.join(outDir, 'phrasebook-recordings.csv'), toCsv(recordingRows))
console.log(JSON.stringify(summary, null, 2))
await runtime.unloadAll()
await shutdown()
