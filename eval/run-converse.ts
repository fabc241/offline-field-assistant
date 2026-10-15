/**
 * F4 eval: end-to-end conversation turns (speech-to-text → translation →
 * read-aloud, back-translation check alongside) on the M4, with every model
 * kept loaded.
 *
 *   npm run eval:converse [-- --sets intake,fleurs --limit 10]
 *
 * Turn sets, each spoken by the clinician (en) and by the patient (sw):
 *   - intake: consecutive intake sentences rendered by F3 (var/eval-audio/
 *     tts-spoken-<lang>, from npm run eval:tts), joined with 0.4 s of silence
 *     until a turn lasts at least 4.5 s: the "5 s utterance" of the latency
 *     budget, in clinic vocabulary. Synthetic speech, so cleaner than a clinic.
 *   - fleurs: human read speech (npm run fetch-fleurs), the sentences present
 *     in both languages, so the other language's FLEURS text is a professional
 *     reference translation. Longer (4–28 s) and on general topics.
 * Intake turns run once per scheduling variant, back to back: each sentence
 * spoken as soon as it is translated (default), speech only after the whole
 * translation, and that with the check started together with the speech.
 * FLEURS turns run with the default only.
 *
 * Measures, per turn: the time of each stage, the listener's wait for the
 * first translated audio, when the check arrives, playback stalls, and peak
 * memory (sampled every second through the SDK). Quality, with no human
 * judge: chrF of the spoken-input translation against the reference, next to
 * chrF of translating the reference source text directly (the gap is what
 * speech recognition costs), and whether the quantities in the source reach
 * the translation unchanged.
 *
 * Writes eval/outputs/converse.csv (per turn) and eval/outputs/converse-summary.json.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { loadSpeech, SPEECH_SAMPLE_RATE } from '../src/core/audio.js'
import { MODEL_SPECS } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { LANGS, qvacEmbedder, qvacTranslator, type Lang } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown, systemResources } from '../src/core/qvac.js'
import {
  TURN_FLAGS,
  type ConversationOptions,
  type Side,
  type Turn
} from '../src/features/conversation/conversation-service.js'
import { createConversation } from '../src/features/conversation/setup.js'
import { mentionsClockTime } from '../src/features/translate/checks.js'
import { diffQuantities, extractQuantities, formatQuantity } from '../src/features/translate/quantities.js'
import { TranslationService } from '../src/features/translate/translation-service.js'
import { readSet } from './audio-sets.js'
import { chrF } from './chrf.js'
import { parseCsv, toCsv } from '../src/core/csv.js'
import { quantile, round } from './stats.js'

const { values } = parseArgs({ options: { sets: { type: 'string' }, limit: { type: 'string' } } })
const setNames = values.sets ? values.sets.split(',') : ['intake', 'fleurs']
const limit = values.limit ? Number(values.limit) : Infinity

const SIDE: Record<Lang, Side> = { en: 'clinician', sw: 'patient' }
const other = (lang: Lang): Lang => (lang === 'en' ? 'sw' : 'en')
/** How a turn is scheduled; the first is the app's default. */
const VARIANTS: Record<string, ConversationOptions> = {
  streamed: {},
  'wait-for-translation': { speakAsTranslated: false },
  'check-with-speech': { speakAsTranslated: false, checkStart: 'with-speech' }
}
const VARIANT_NAMES = Object.keys(VARIANTS)

interface Case {
  set: string
  id: string
  lang: Lang
  audio: Float32Array
  /** What was said. */
  source: string
  /** Its translation into the other language. */
  reference: string
}

// --- Turn sets ---------------------------------------------------------------

const MIN_TURN_S = 4.5
const GAP_S = 0.4

async function intakeCases(): Promise<Case[]> {
  const rows = new Map(
    parseCsv(await fs.readFile(path.join(PROJECT_ROOT, 'eval/datasets/intake.csv'), 'utf8')).map((r) => [r.id!, r])
  )
  const cases: Case[] = []
  for (const lang of LANGS) {
    const clips = await readSet(`tts-spoken-${lang}`)
    if (!clips) throw new Error(`var/eval-audio/tts-spoken-${lang} is missing: run npm run eval:tts first`)
    let group: { id: string; audio: Float32Array }[] = []
    const flush = () => {
      const gap = new Float32Array(GAP_S * SPEECH_SAMPLE_RATE)
      const parts = group.flatMap((g, i) => (i ? [gap, g.audio] : [g.audio]))
      const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
      parts.reduce((at, p) => (audio.set(p, at), at + p.length), 0)
      const ids = group.map((g) => g.id)
      cases.push({
        set: 'intake',
        id: `${lang}-${ids[0]}-${ids.at(-1)}`,
        lang,
        audio,
        source: ids.map((id) => rows.get(id)![lang]).join(' '),
        reference: ids.map((id) => rows.get(id)![other(lang)]).join(' ')
      })
      group = []
    }
    for (const clip of clips) {
      group.push({ id: clip.id.slice(lang.length + 1), audio: await loadSpeech(clip.file) })
      const seconds = group.reduce((s, g) => s + g.audio.length, 0) / SPEECH_SAMPLE_RATE + GAP_S * (group.length - 1)
      if (seconds >= MIN_TURN_S) flush()
    }
    if (group.length) flush()
  }
  return cases
}

async function fleursCases(): Promise<Case[]> {
  const sets = { en: await readSet('fleurs-en'), sw: await readSet('fleurs-sw') }
  if (!sets.en || !sets.sw) throw new Error('var/eval-audio/fleurs-* is missing: run npm run fetch-fleurs first')
  const text = (lang: Lang) => new Map(sets[lang]!.map((c) => [c.id.slice(3), c.text]))
  const texts = { en: text('en'), sw: text('sw') }
  const cases: Case[] = []
  for (const lang of LANGS) {
    for (const clip of sets[lang]!) {
      const reference = texts[other(lang)].get(clip.id.slice(3))
      if (!reference) continue
      cases.push({ set: 'fleurs', id: clip.id, lang, audio: await loadSpeech(clip.file), source: clip.text, reference })
    }
  }
  return cases
}

const cases: Case[] = []
for (const name of setNames) {
  const all = name === 'intake' ? await intakeCases() : name === 'fleurs' ? await fleursCases() : undefined
  if (!all) throw new Error(`Unknown set ${name}; known: intake, fleurs`)
  for (const lang of LANGS) cases.push(...all.filter((c) => c.lang === lang).slice(0, limit))
}

// --- Memory sampling -----------------------------------------------------------

interface MemorySample {
  systemUsed?: number
  workerRss?: number
}
async function sampleMemory(): Promise<MemorySample> {
  const { sample } = await systemResources(true)
  const value = (m: { status: string; value?: number } | undefined) => (m?.status === 'supported' ? m.value : undefined)
  return { systemUsed: value(sample?.memory.usedBytes), workerRss: value(sample?.memory.processUsedBytes) }
}

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const baseline = await sampleMemory()
const peak: Required<MemorySample> = { systemUsed: 0, workerRss: 0 }
let sampling = true
const sampler = (async () => {
  while (sampling) {
    const m = await sampleMemory().catch(() => ({}) as MemorySample)
    peak.systemUsed = Math.max(peak.systemUsed, m.systemUsed ?? 0)
    peak.workerRss = Math.max(peak.workerRss, m.workerRss ?? 0)
    await new Promise((r) => setTimeout(r, 1000))
  }
})()

// --- Run -----------------------------------------------------------------------

const conversations = Object.fromEntries(
  await Promise.all(VARIANT_NAMES.map(async (v) => [v, await createConversation(runtime, config, VARIANTS[v])] as const))
)
const t0 = performance.now()
const warm = await conversations[VARIANT_NAMES[0]!]!.warmUp()
const warmUpMs = performance.now() - t0
if (warm.evicted.length) throw new Error(`Models evicted during warm-up: ${warm.evicted.join(', ')}`)
const loadedBytes = runtime.loaded().reduce((s, m) => s + m.bytes, 0)

interface Run {
  c: Case
  variant: string
  turn: Turn
}
const runs: Run[] = []
for (const [i, c] of cases.entries()) {
  for (const variant of c.set === 'intake' ? VARIANT_NAMES : VARIANT_NAMES.slice(0, 1)) {
    const turn = await conversations[variant]!.service.turn({ audio: c.audio, speakerSide: SIDE[c.lang] })
    runs.push({ c, variant, turn })
  }
  if ((i + 1) % 10 === 0) console.log(`${i + 1}/${cases.length} turns`)
}
sampling = false
await sampler
const loadedAfter = runtime.loaded().length

// Text-only baseline, after the timed turns: the same translator on the reference source text.
const textOnly = new TranslationService(qvacTranslator(runtime, MODEL_SPECS.translator), qvacEmbedder(runtime, MODEL_SPECS.embedder))
const direct = new Map<Case, string>()
for (const c of cases) direct.set(c, (await textOnly.translate(c.source, c.lang, other(c.lang))).translation)

// --- Report --------------------------------------------------------------------

/**
 * Quantities in the source that did not reach the translation (values only;
 * units change words between languages). A ratio counts as its two numbers:
 * "140/90" is correctly translated "140 juu ya 90".
 */
function lostQuantities(c: Case, translation: string): string[] {
  if (mentionsClockTime(c.source, c.lang)) return [] // a correct Swahili clock time has other digits; F1's clock-time flag covers it
  const values = (text: string, lang: Lang) =>
    extractQuantities(text, lang).flatMap((q) => (/^\d+\/\d+$/.test(q.value) ? q.value.split('/').map((value) => ({ value })) : [q]))
  const d = diffQuantities(values(c.source, c.lang), values(translation, other(c.lang)), { units: false })
  return [...d.missing, ...d.added.map((q) => `+${q}`)]
}

const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })
await fs.writeFile(
  path.join(outDir, 'converse.csv'),
  toCsv(
    runs.map(({ c, variant, turn }) => ({
      set: c.set,
      id: c.id,
      side: turn.speakerSide,
      variant,
      utterance_ms: Math.round(turn.timings.utteranceMs),
      said: c.source,
      heard: turn.sourceText,
      translation: turn.translation,
      text_only_translation: direct.get(c)!,
      reference: c.reference,
      back_translation: turn.backTranslation,
      fidelity: turn.fidelity.toFixed(3),
      flags: turn.flags.join(' '),
      lost_quantities: lostQuantities(c, turn.translation).join(' '),
      sentences: turn.check?.sentences.length ?? 0,
      stt_ms: Math.round(turn.timings.sttMs),
      translate_ms: Math.round(turn.timings.translateMs),
      first_audio_ms: Math.round(turn.timings.firstAudioMs),
      check_done_ms: Math.round(turn.timings.checkDoneMs),
      speech_done_ms: Math.round(turn.timings.speechDoneMs),
      audio_out_ms: Math.round(turn.speech?.audioMs ?? 0),
      stall_ms: Math.round(turn.speech?.stallMs ?? 0)
    }))
  )
)

const stat = (xs: number[]) => ({ median: Math.round(quantile(xs, 0.5)), p90: Math.round(quantile(xs, 0.9)), max: Math.round(quantile(xs, 1)) })
const BUCKETS: [string, number, number][] = [
  ['< 3.5 s', 0, 3500],
  ['3.5–6.5 s', 3500, 6500],
  ['6.5–10 s', 6500, 10_000],
  ['≥ 10 s', 10_000, Infinity]
]
const BUDGET_MS = 5000

function report(rs: Run[]) {
  const spoken = rs.filter((r) => r.turn.speech)
  const t = (k: keyof Turn['timings']) => spoken.map((r) => r.turn.timings[k])
  const withQ = rs.filter((r) => extractQuantities(r.c.source, r.c.lang).length && !mentionsClockTime(r.c.source, r.c.lang))
  return {
    turns: rs.length,
    utteranceS: { median: round(quantile(t('utteranceMs'), 0.5) / 1000, 1), max: round(quantile(t('utteranceMs'), 1) / 1000, 1) },
    sttMs: stat(t('sttMs')),
    translateMs: stat(t('translateMs')),
    firstAudioMs: stat(t('firstAudioMs')),
    firstAudioWithinBudget: `${spoken.filter((r) => r.turn.timings.firstAudioMs <= BUDGET_MS).length}/${spoken.length}`,
    /** First audio, measured from the end of speech-to-text: translation + the first sentence's synthesis. */
    afterSttMs: stat(spoken.map((r) => r.turn.timings.firstAudioMs - r.turn.timings.sttMs)),
    checkDoneMs: stat(t('checkDoneMs')),
    checkAfterFirstAudioMs: stat(spoken.map((r) => r.turn.timings.checkDoneMs - r.turn.timings.firstAudioMs)),
    speechDoneMs: stat(t('speechDoneMs')),
    audioOutS: round(quantile(spoken.map((r) => r.turn.speech!.audioMs), 0.5) / 1000, 1),
    stalls: {
      turns: spoken.filter((r) => r.turn.speech!.stallMs > 0).length,
      totalMs: Math.round(spoken.reduce((s, r) => s + r.turn.speech!.stallMs, 0))
    },
    byLength: Object.fromEntries(
      BUCKETS.map(([name, lo, hi]) => {
        const b = spoken.filter((r) => r.turn.timings.utteranceMs >= lo && r.turn.timings.utteranceMs < hi)
        return [name, b.length ? { turns: b.length, firstAudioMs: stat(b.map((r) => r.turn.timings.firstAudioMs)) } : { turns: 0 }]
      })
    ),
    chrF: {
      spoken: round(chrF(rs.map((r) => r.turn.translation), rs.map((r) => r.c.reference)), 1),
      textOnly: round(chrF(rs.map((r) => direct.get(r.c)!), rs.map((r) => r.c.reference)), 1)
    },
    quantitiesKept: {
      spoken: `${withQ.filter((r) => lostQuantities(r.c, r.turn.translation).length === 0).length}/${withQ.length}`,
      textOnly: `${withQ.filter((r) => lostQuantities(r.c, direct.get(r.c)!).length === 0).length}/${withQ.length}`,
      lost: Object.fromEntries(
        withQ
          .map((r) => [r.c.id, lostQuantities(r.c, r.turn.translation).join(' ')] as const)
          .filter(([, lost]) => lost)
      ),
      source: Object.fromEntries(withQ.map((r) => [r.c.id, extractQuantities(r.c.source, r.c.lang).map(formatQuantity).join(' ')]))
    },
    flags: Object.fromEntries(
      TURN_FLAGS.map((f) => [f, rs.filter((r) => r.turn.flags.includes(f)).map((r) => r.c.id)] as const).filter(([, ids]) => ids.length)
    )
  }
}

const gb = (b: number | undefined) => (b === undefined ? null : round(b / 1024 ** 3, 2))
const results: Record<string, unknown> = {}
for (const set of setNames) {
  for (const variant of VARIANT_NAMES) {
    for (const lang of LANGS) {
      const rs = runs.filter((r) => r.c.set === set && r.variant === variant && r.c.lang === lang)
      if (rs.length) results[`${set} ${SIDE[lang]} (${lang}→${other(lang)}) ${variant}`] = report(rs)
    }
  }
}
const summary = {
  variants: VARIANTS,
  sets: Object.fromEntries(setNames.map((s) => [s, cases.filter((c) => c.set === s).length])),
  budget: `first translated audio within ${BUDGET_MS / 1000} s of the end of the utterance`,
  warmUpMs: Math.round(warmUpMs),
  memory: {
    modelsLoadedGb: gb(loadedBytes),
    modelsStillLoaded: loadedAfter,
    systemUsedGb: { before: gb(baseline.systemUsed), peak: gb(peak.systemUsed) },
    workerRssGb: { before: gb(baseline.workerRss), peak: gb(peak.workerRss) },
    note: 'RSS undercounts on Apple Silicon (memory-mapped weights, Metal buffers in unified memory); system used includes every other process'
  },
  results
}
await fs.writeFile(path.join(outDir, 'converse-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, (k, v) => (k === 'source' || k === 'lost' ? undefined : v), 2))
await runtime.unloadAll()
await shutdown()
