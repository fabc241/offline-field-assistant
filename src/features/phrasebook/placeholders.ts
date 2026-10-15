/**
 * Placeholder recordings for a pack source: every phrase without a
 * recording gets one made with text-to-speech, marked synthetic by a record
 * next to it (packs/recordings.ts), and phrases.csv is pointed at it. These
 * stand in until native speakers record the phrases; the pack tags them
 * `synthetic`, so the app can say what they are.
 *
 * A recording without a synthetic record is a human recording and is never
 * touched. A synthetic one is made again when its phrase text changed, its
 * WAV no longer matches its record, or `force` is set.
 *
 * Synthesis is seeded, so a text always renders the same, including the odd
 * bad take (in English, "Please wait here." came out twice in one take). With
 * `listen`, each take is heard back by speech recognition, and a take that
 * is not heard well enough is rendered again with other seeds; the best one is
 * kept, and the record notes its seed and what was heard.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { encodeWav } from '../../core/audio.js'
import { parseCsvTable, toCsv } from '../../core/csv.js'
import { LANGS, type Lang } from '../../core/engines.js'
import { errorCounts } from '../../core/wer.js'
import { PHRASE_COLUMNS } from '../packs/content.js'
import { sha256Hex } from '../packs/manifest.js'
import { readSyntheticRecord, syntheticRecordFile, type SyntheticRecord } from '../packs/recordings.js'
import type { ReadAloud, Speech, TtsFlag } from '../voice/read-aloud.js'
import { toSpokenForm } from '../voice/spoken.js'

export const RECORDINGS_DIR = 'recordings'

/** Seeds tried after the default take, in order. */
export const RETRY_SEEDS = [1, 2, 3]
/**
 * A take heard back with at most this character error rate (percent) is kept
 * without trying another. Whisper is far less sure of Swahili: CER 8.4 on
 * human FLEURS speech, 15 on Chatterbox's (F2, F3).
 */
export const MAX_CER: Record<Lang, number> = { en: 10, sw: 20 }

export interface PlaceholderOptions {
  /** Names the engine in each record, e.g. the TTS model's manifest name. */
  engine: string
  /** Read-aloud that renders takes with this engine seed (undefined: the engine's default). */
  readerFor: (seed: number | undefined) => ReadAloud
  /** What a listener hears in a take (speech recognition). Without it, the first take is kept. */
  listen?: (speech: Speech) => Promise<string>
  retrySeeds?: number[]
  maxCer?: Record<Lang, number>
  /** Make every synthetic recording again, even those that are current. */
  force?: boolean
  now?: () => Date
  onRecording?: (made: MadeRecording) => void
}

export interface MadeRecording {
  id: string
  lang: Lang
  /** Relative to the source directory, as in phrases.csv. */
  ref: string
  audioMs: number
  synthMs: number
  /** Read-aloud's duration checks on the kept take: it may have dropped or repeated words. */
  flags: TtsFlag[]
  /** Seed of the kept take (undefined: the default). */
  seed?: number
  /** What was heard in the kept take, and its character error rate in percent (with `listen`). */
  heard?: string
  cer?: number
  /** Takes rendered to get it. */
  takes: number
}

export interface PlaceholderReport {
  made: MadeRecording[]
  /** Synthetic recordings that were already current. */
  current: number
  /** Human recordings, left as they are. */
  human: number
  /** Cells that refer to a file that does not exist: left for the pack build to report. */
  missing: { id: string; lang: Lang; ref: string }[]
}

export async function makePlaceholderRecordings(dir: string, opts: PlaceholderOptions): Promise<PlaceholderReport> {
  const csvFile = path.join(dir, 'phrases.csv')
  const table = parseCsvTable(await fs.readFile(csvFile, 'utf8'))
  const missingColumns = PHRASE_COLUMNS.filter((c) => !table.header.includes(c))
  if (missingColumns.length) throw new Error(`${csvFile}: missing column${missingColumns.length > 1 ? 's' : ''} ${missingColumns.join(', ')}`)

  const report: PlaceholderReport = { made: [], current: 0, human: 0, missing: [] }
  let changed = false
  for (const row of table.rows) {
    const id = row.id!.trim()
    for (const lang of LANGS) {
      const text = row[lang]!.normalize('NFC').trim()
      if (!id || !text) continue
      const column = `audio_${lang}`
      const ref = row[column]!.trim()
      if (ref) {
        const state = await recordingState(path.resolve(dir, ref), lang, text)
        if (state === 'missing') {
          report.missing.push({ id, lang, ref })
          continue
        }
        if (state === 'human') {
          report.human++
          continue
        }
        if (state === 'current' && !opts.force) {
          report.current++
          continue
        }
      }
      const target = ref || `${RECORDINGS_DIR}/${id}.${lang}.wav`
      const made = await synthesize(path.resolve(dir, target), text, lang, opts)
      const entry = { id, lang, ref: target, ...made }
      report.made.push(entry)
      opts.onRecording?.(entry)
      if (row[column] !== target) {
        row[column] = target
        changed = true
      }
    }
  }
  if (changed) await fs.writeFile(csvFile, toCsv(table.rows))
  return report
}

async function recordingState(file: string, lang: Lang, text: string): Promise<'missing' | 'human' | 'current' | 'stale'> {
  const bytes = await fs.readFile(file).catch(() => undefined)
  if (!bytes) return 'missing'
  const record = await readSyntheticRecord(file)
  if (!record) return 'human'
  if ('problem' in record) return 'stale'
  const current = record.sha256 === sha256Hex(bytes) && record.lang === lang && record.text.normalize('NFC').trim() === text
  return current ? 'current' : 'stale'
}

interface Take {
  speech: Speech
  seed?: number
  heard?: string
  cer?: number
}

async function synthesize(file: string, text: string, lang: Lang, opts: PlaceholderOptions) {
  const take = async (seed?: number): Promise<Take> => {
    const speech = await opts.readerFor(seed).speak(text, lang)
    if (!opts.listen) return { speech, seed }
    const heard = await opts.listen(speech)
    const c = errorCounts(toSpokenForm(text, lang), toSpokenForm(heard, lang))
    return { speech, seed, heard, cer: Math.round((1000 * c.charErrors) / Math.max(1, c.chars)) / 10 }
  }
  // Fewer duration flags first, then what was heard best; ties keep the earlier take.
  const worse = (a: Take, b: Take) => a.speech.flags.length - b.speech.flags.length || (a.cer ?? 0) - (b.cer ?? 0)
  const takes = [await take()]
  const good = (t: Take) => !t.speech.flags.length && (t.cer ?? 0) <= (opts.maxCer ?? MAX_CER)[lang]
  for (const seed of opts.listen ? (opts.retrySeeds ?? RETRY_SEEDS) : []) {
    if (takes.some(good)) break
    takes.push(await take(seed))
  }
  const best = takes.reduce((a, b) => (worse(b, a) < 0 ? b : a))

  const { speech } = best
  const wav = encodeWav(speech.samples, speech.sampleRate)
  const record: SyntheticRecord = {
    engine: opts.engine,
    lang,
    text,
    sha256: sha256Hex(wav),
    created: (opts.now?.() ?? new Date()).toISOString(),
    seed: best.seed,
    heard: best.heard,
    cer: best.cer
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, wav)
  await fs.writeFile(syntheticRecordFile(file), JSON.stringify(record, null, 2) + '\n')
  return {
    audioMs: speech.audioMs,
    synthMs: takes.reduce((s, t) => s + t.speech.synthMs, 0),
    flags: speech.flags,
    seed: best.seed,
    heard: best.heard,
    cer: best.cer,
    takes: takes.length
  }
}
