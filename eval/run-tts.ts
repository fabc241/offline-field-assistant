/**
 * F3 eval: read-aloud speed and intelligibility on the M4.
 *
 *   npm run eval:tts [-- --variants spoken,raw --langs sw --limit 10]
 *
 * Renders the 60 intake sentences, plus 10 three-sentence paragraphs, in each
 * language and variant, then has the F2 speech-to-text transcribe each render.
 * Intelligibility is measured against the input, with no human listener:
 *   - WER/CER of what Whisper hears. Hypothesis and reference both go through
 *     the spoken form first, so "500 mg" and "five hundred milligrams" match.
 *   - Quantities heard back: every number (and its unit) in a sentence must
 *     come back from Whisper unchanged, judged by F1's quantity parser on the
 *     spoken form of both sides ("140/90" and "140 over 90" agree).
 * Whisper's own errors count against the TTS here; its error rate on real
 * human speech (F2: FLEURS sw CER 8.4, en 2.0) is the floor.
 *
 * Writes eval/outputs/tts-<variant>.csv (per render), eval/outputs/tts-summary.json,
 * and the renders as speech sets in var/eval-audio/tts-<variant>-<lang>/.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { encodeWav, resample, SPEECH_SAMPLE_RATE } from '../src/core/audio.js'
import { MODEL_SPECS, ttsSpec, type TtsOptions } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { LANGS, isLang, qvacSpeaker, qvacTranscriber, type Lang } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { STT_FLAGS, SpeechToText, type Transcript } from '../src/features/speech/speech-service.js'
import { diffQuantities, extractQuantities } from '../src/features/translate/quantities.js'
import { ReadAloud, TTS_FLAGS, type Speech } from '../src/features/voice/read-aloud.js'
import { toSpokenForm } from '../src/features/voice/spoken.js'
import { EVAL_AUDIO_DIR, writeSet, type Clip } from './audio-sets.js'
import { parseCsv, toCsv } from './csv.js'
import { quantile, round } from './stats.js'
import { corpusRates, errorCounts, type ErrorCounts } from './wer.js'

interface Variant {
  tts: TtsOptions
  /** Send the text as written, without spelling out numbers. */
  raw?: boolean
  note: string
}

const VARIANTS: Record<string, Variant> = {
  spoken: { tts: {}, note: 'default: whole sentences, numbers spelled out' },
  raw: { tts: {}, raw: true, note: 'text as written (digits, units, symbols)' },
  stream50: { tts: { chunkTokens: 50 }, note: 'native chunk streaming, 50 tokens (~2 s), first chunk 20' },
  stream25: { tts: { chunkTokens: 25 }, note: 'native chunk streaming, 25 tokens (~1 s), first chunk 20' },
  slow: { tts: { speed: 0.85 }, note: 'speaking rate 0.85 (time-stretched)' }
}

const { values } = parseArgs({
  options: { variants: { type: 'string' }, langs: { type: 'string' }, limit: { type: 'string' } }
})
const variants = values.variants ? values.variants.split(',') : Object.keys(VARIANTS)
const langs = (values.langs ? values.langs.split(',') : [...LANGS]).filter(isLang)
for (const v of variants) if (!VARIANTS[v]) throw new Error(`Unknown variant ${v}; known: ${Object.keys(VARIANTS).join(', ')}`)

const rows = parseCsv(await fs.readFile(path.join(PROJECT_ROOT, 'eval/datasets/intake.csv'), 'utf8')).slice(
  0,
  values.limit ? Number(values.limit) : undefined
)
/** Ten paragraphs of three consecutive intake sentences: first-audio wait and stalls on longer text. */
const PARAGRAPHS = Array.from({ length: Math.min(10, Math.floor(rows.length / 3)) }, (_, i) => rows.slice(3 * i, 3 * i + 3))

const config = loadConfig()
const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
const stt = new SpeechToText(qvacTranscriber(runtime))
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })

interface Render {
  id: string
  lang: Lang
  text: string
  speech: Speech
  heard: Transcript
  counts: ErrorCounts
  /** Sentence quantities (value and unit) Whisper did not hear back, or heard differently. */
  lost: string[]
  quantities: number
  msPerLetter: number
}

const letters = (s: string) => s.match(/[\p{L}\p{N}]/gu)?.length ?? 0

async function render(reader: ReadAloud, variant: Variant, id: string, text: string, lang: Lang): Promise<Render> {
  const speech = await reader.speak(text, lang, { raw: variant.raw })
  const heard = await stt.transcribe(resample(speech.samples, speech.sampleRate, SPEECH_SAMPLE_RATE), lang)
  const source = extractQuantities(toSpokenForm(text, lang), lang)
  const diff = diffQuantities(source, extractQuantities(toSpokenForm(heard.text, lang), lang), { units: true })
  const spoken = speech.parts.map((p) => p.spoken).join(' ')
  return {
    id,
    lang,
    text,
    speech,
    heard,
    counts: errorCounts(toSpokenForm(text, lang), toSpokenForm(heard.text, lang)),
    lost: [...diff.missing, ...diff.added.map((q) => `+${q}`)],
    quantities: source.length,
    msPerLetter: speech.parts.reduce((s, p) => s + p.audioMs, 0) / Math.max(1, letters(spoken))
  }
}

const ms = (xs: number[]) => ({ median: Math.round(quantile(xs, 0.5)), p90: Math.round(quantile(xs, 0.9)), max: Math.round(quantile(xs, 1)) })

const summary: Record<string, unknown> = {
  sentences: rows.length,
  paragraphs: PARAGRAPHS.length,
  wer: 'WER/CER of Whisper large-v3-turbo transcripts; both sides in spoken form (numbers as words), then eval/wer.ts normalization',
  quantities: 'sentences whose every quantity (value and unit, F1 parser) Whisper heard back unchanged',
  variants: Object.fromEntries(variants.map((v) => [v, VARIANTS[v]!.note]))
}
const results: Record<string, Record<string, unknown>> = {}

for (const name of variants) {
  const variant = VARIANTS[name]!
  results[name] = {}
  const csv: Record<string, string | number>[] = []
  for (const lang of langs) {
    const spec = ttsSpec(lang, variant.tts)
    const reader = new ReadAloud(qvacSpeaker(runtime, () => spec))
    await runtime.use(MODEL_SPECS.stt, async () => undefined) // loaded first, so load timings are Chatterbox alone
    const t0 = performance.now()
    await runtime.use(spec, async () => undefined)
    const loadMs = performance.now() - t0
    const cold = await reader.speak(rows[0]![lang]!, lang, { raw: variant.raw }) // also warms the Metal kernels

    const sentences: Render[] = []
    for (const row of rows) sentences.push(await render(reader, variant, row.id!, row[lang]!, lang))
    const paragraphs: Render[] = []
    for (const [i, para] of PARAGRAPHS.entries()) {
      paragraphs.push(await render(reader, variant, `p${String(i + 1).padStart(2, '0')}`, para.map((r) => r[lang]).join(' '), lang))
    }
    await runtime.unload(runtime.loaded().find((m) => m.name === spec.name)!.key)

    const set = `tts-${name}-${lang}`
    const dir = path.join(EVAL_AUDIO_DIR, set)
    await fs.mkdir(dir, { recursive: true })
    const clips: Clip[] = []
    for (const r of sentences) {
      const file = path.join(dir, `${r.id}.wav`)
      await fs.writeFile(file, encodeWav(resample(r.speech.samples, r.speech.sampleRate, SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE))
      clips.push({ id: `${lang}-${r.id}`, lang, file, text: r.text })
    }
    await writeSet(set, clips)

    for (const r of [...sentences, ...paragraphs]) {
      csv.push({
        lang,
        id: r.id,
        text: r.text,
        spoken: r.speech.parts.map((p) => p.spoken).join(' '),
        heard: r.heard.text,
        word_errors: r.counts.wordErrors,
        words: r.counts.words,
        quantities: r.quantities,
        lost: r.lost.join(' '),
        audio_ms: Math.round(r.speech.audioMs),
        first_audio_ms: Math.round(r.speech.firstAudioMs),
        synth_ms: Math.round(r.speech.synthMs),
        stall_ms: Math.round(r.speech.stallMs),
        ms_per_letter: Math.round(r.msPerLetter),
        flags: [...r.speech.flags, ...r.heard.flags.map((f) => `stt:${f}`)].join(' ')
      })
    }

    const { wer, cer } = corpusRates(sentences.map((r) => r.counts))
    const withQ = sentences.filter((r) => r.quantities > 0)
    const perLetter = sentences.map((r) => r.msPerLetter)
    results[name]![lang] = {
      loadMs: Math.round(loadMs),
      coldFirstSentence: { firstAudioMs: Math.round(cold.firstAudioMs), audioMs: Math.round(cold.audioMs) },
      sentences: {
        wer: round(wer, 1),
        cer: round(cer, 1),
        perfect: sentences.filter((r) => r.counts.wordErrors === 0).length,
        quantitiesHeardBack: `${withQ.filter((r) => r.lost.length === 0).length}/${withQ.length}`,
        quantitiesLost: Object.fromEntries(withQ.filter((r) => r.lost.length).map((r) => [r.id, r.lost.join(' ')])),
        audioS: round(sentences.reduce((s, r) => s + r.speech.audioMs, 0) / 1000, 0),
        firstAudioMs: ms(sentences.map((r) => r.speech.firstAudioMs)),
        rtf: { median: round(quantile(sentences.map((r) => r.speech.realTimeFactor), 0.5), 2) },
        stall: {
          sentences: sentences.filter((r) => r.speech.stallMs > 0).length,
          totalMs: Math.round(sentences.reduce((s, r) => s + r.speech.stallMs, 0))
        },
        msPerLetter: {
          min: Math.round(quantile(perLetter, 0)),
          p05: Math.round(quantile(perLetter, 0.05)),
          median: Math.round(quantile(perLetter, 0.5)),
          p95: Math.round(quantile(perLetter, 0.95)),
          max: Math.round(quantile(perLetter, 1))
        },
        flags: Object.fromEntries(TTS_FLAGS.map((f) => [f, sentences.filter((r) => r.speech.flags.includes(f)).map((r) => r.id)])),
        sttFlags: Object.fromEntries(STT_FLAGS.map((f) => [f, sentences.filter((r) => r.heard.flags.includes(f)).map((r) => r.id)]))
      },
      paragraphs: {
        cer: round(corpusRates(paragraphs.map((r) => r.counts)).cer, 1),
        audioMs: ms(paragraphs.map((r) => r.speech.audioMs)),
        firstAudioMs: ms(paragraphs.map((r) => r.speech.firstAudioMs)),
        synthMs: ms(paragraphs.map((r) => r.speech.synthMs)),
        rtf: { median: round(quantile(paragraphs.map((r) => r.speech.realTimeFactor), 0.5), 2) },
        stallMs: ms(paragraphs.map((r) => r.speech.stallMs))
      }
    }
    console.log(`${name} ${lang}\n${JSON.stringify(results[name]![lang], null, 2)}`)
  }
  await fs.writeFile(path.join(outDir, `tts-${name}.csv`), toCsv(csv))
}
summary.results = results

await fs.writeFile(path.join(outDir, 'tts-summary.json'), JSON.stringify(summary, null, 2) + '\n')
await runtime.unloadAll()
await shutdown()
