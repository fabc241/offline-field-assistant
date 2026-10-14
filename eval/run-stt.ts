/**
 * F2 eval: word error rate of each installed Whisper model on every speech
 * set in var/eval-audio/ (npm run fetch-fleurs, npm run eval:make-intake-audio).
 *
 *   npm run eval:stt [-- --models WHISPER_LARGE_V3_TURBO,... --sets fleurs-sw,...]
 *
 * Writes eval/outputs/stt-<model>.csv (per clip) and eval/outputs/stt-summary.json.
 * The language is forced per set, as in the app.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { STT_CANDIDATES, sttSpec } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { qvacTranscriber } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { STT_FLAGS, SpeechToText, type Transcript } from '../src/features/speech/speech-service.js'
import { readSet, type Clip } from './audio-sets.js'
import { toCsv } from './csv.js'
import { quantile, round } from './stats.js'
import { corpusRates, errorCounts, type ErrorCounts } from './wer.js'

const SETS = ['fleurs-sw', 'intake-tts-sw', 'fleurs-en', 'intake-tts-en']

const { values } = parseArgs({ options: { models: { type: 'string' }, sets: { type: 'string' } } })
const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const models = values.models ? values.models.split(',') : STT_CANDIDATES.filter((m) => store.has(m))
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })

const sets: [string, Clip[]][] = []
for (const name of values.sets ? values.sets.split(',') : SETS) {
  const clips = await readSet(name)
  if (clips) sets.push([name, clips])
  else console.log(`- ${name}: not found, skipped`)
}

interface Run {
  set: string
  clip: Clip
  t: Transcript
  counts: ErrorCounts
}

const summary: Record<string, unknown> = {
  sets: Object.fromEntries(sets.map(([n, c]) => [n, c.length])),
  normalization: 'lowercase, punctuation removed, numbers not spelled out (eval/wer.ts)'
}
const perModel: Record<string, unknown> = {}

for (const model of models) {
  const spec = sttSpec(model)
  const stt = new SpeechToText(qvacTranscriber(runtime, spec))
  const t0 = performance.now()
  await runtime.use(spec, async () => undefined)
  const loadMs = performance.now() - t0
  await stt.transcribe(sets[0]![1][0]!.file, sets[0]![1][0]!.lang) // warm up Metal kernels

  const runs: Run[] = []
  for (const [set, clips] of sets) {
    for (const clip of clips) {
      const t = await stt.transcribe(clip.file, clip.lang)
      runs.push({ set, clip, t, counts: errorCounts(clip.text, t.text) })
    }
  }
  await runtime.unloadAll()

  await fs.writeFile(
    path.join(outDir, `stt-${model}.csv`),
    toCsv(
      runs.map((r) => ({
        set: r.set,
        id: r.clip.id,
        reference: r.clip.text,
        hypothesis: r.t.text,
        word_errors: r.counts.wordErrors,
        words: r.counts.words,
        audio_ms: Math.round(r.t.audioMs),
        transcribe_ms: Math.round(r.t.transcribeMs),
        flags: r.t.flags.join(' ')
      }))
    )
  )

  const bySet: Record<string, unknown> = {}
  for (const [set] of sets) {
    const rs = runs.filter((r) => r.set === set)
    const { wer, cer } = corpusRates(rs.map((r) => r.counts))
    const ms = rs.map((r) => r.t.transcribeMs)
    bySet[set] = {
      clips: rs.length,
      wer: round(wer, 1),
      cer: round(cer, 1),
      perfect: rs.filter((r) => r.counts.wordErrors === 0).length,
      audioS: round(rs.reduce((s, r) => s + r.t.audioMs, 0) / 1000, 0),
      transcribeMs: { median: Math.round(quantile(ms, 0.5)), p90: Math.round(quantile(ms, 0.9)) },
      rtf: { median: round(quantile(rs.map((r) => r.t.realTimeFactor), 0.5), 3) },
      flags: Object.fromEntries(STT_FLAGS.map((f) => [f, rs.filter((r) => r.t.flags.includes(f)).map((r) => r.clip.id)]))
    }
  }
  perModel[model] = { sizeMB: Math.round(store.entry(model).size / 1e6), loadMs: Math.round(loadMs), ...bySet }
  console.log(`${model}\n${JSON.stringify(perModel[model], null, 2)}`)
}
summary.models = perModel

await fs.writeFile(path.join(outDir, 'stt-summary.json'), JSON.stringify(summary, null, 2) + '\n')
await shutdown()
