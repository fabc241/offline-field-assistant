/**
 * Pack content: guidance cards and phrasebook entries, written by the
 * customer organization as two CSV files next to a pack.json:
 *
 *   my-pack/
 *     pack.json      { "id": "intake-ke", "title": "…", "version": "1.0.0", "notice": "…" }
 *     cards.csv      id,title_en,title_sw,danger_signs_en,danger_signs_sw,steps_en,steps_sw,tags,source,version
 *     phrases.csv    id,category,en,sw,audio_en,audio_sw,vetted_by
 *     recordings/    WAV files that phrases.csv refers to (relative paths)
 *
 * Every phrase needs a recording in both languages: the phrasebook plays
 * recordings as they are and never falls back to text-to-speech. A recording
 * made with text-to-speech as a placeholder carries a record saying so
 * (recordings.ts) and is tagged `synthetic` in the pack.
 *
 * Lists inside a cell (danger signs, steps, tags) are separated by "|".
 * Every problem in the source is reported at once, with its file and row.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { decodeWav } from '../../core/audio.js'
import { parseCsvTable } from '../../core/csv.js'
import { LANGS, type Lang } from '../../core/engines.js'
import { AUDIO_DIR, PackManifestSchema, SLUG, sha256Hex } from './manifest.js'
import { readSyntheticRecord, syntheticRecordFile, type SyntheticRecord } from './recordings.js'

export const CARD_COLUMNS = [
  'id',
  'title_en',
  'title_sw',
  'danger_signs_en',
  'danger_signs_sw',
  'steps_en',
  'steps_sw',
  'tags',
  'source',
  'version'
] as const
export const PHRASE_COLUMNS = ['id', 'category', 'en', 'sw', 'audio_en', 'audio_sw', 'vetted_by'] as const

export const LIST_SEPARATOR = '|'

const text = z.string().min(1, 'must not be empty')
const bilingual = <T extends z.ZodType>(schema: T) => z.strictObject({ en: schema, sw: schema })

/** A guidance card. Danger signs come first and are never empty: the guide shows them before any steps. */
export const CardSchema = z.strictObject({
  id: z.string().regex(SLUG, 'lowercase letters, digits and dashes'),
  title: bilingual(text),
  dangerSigns: bilingual(z.array(text).min(1, 'needs at least one danger sign')),
  steps: bilingual(z.array(text).min(1, 'needs at least one step')),
  tags: z.array(z.string().regex(SLUG, 'lowercase letters, digits and dashes')),
  /** Where the guidance comes from. */
  source: text,
  /** Content revision of this card. */
  version: z.number({ error: 'must be a whole number' }).int().positive()
})
export type Card = z.infer<typeof CardSchema>

/** A phrasebook entry. `audio` holds pack paths of the recordings, one per language. */
export const PhraseSchema = z.strictObject({
  id: z.string().regex(SLUG, 'lowercase letters, digits and dashes'),
  category: z.string().regex(SLUG, 'lowercase letters, digits and dashes'),
  text: bilingual(text),
  audio: bilingual(z.string().min(1)),
  /** Who checked the wording. */
  vettedBy: text
})
export type Phrase = z.infer<typeof PhraseSchema>

export const PackContentSchema = z.strictObject({
  cards: z.array(CardSchema),
  phrases: z.array(PhraseSchema)
})
export type PackContent = z.infer<typeof PackContentSchema>

export const PackInfoSchema = PackManifestSchema.pick({ id: true, title: true, version: true, notice: true })
export type PackInfo = z.infer<typeof PackInfoSchema>

/** Pack path of a phrase recording: one name per phrase and language, whatever the source file was called. */
export const phraseAudioPath = (phraseId: string, lang: Lang) => `${AUDIO_DIR}/${phraseId}.${lang}.wav`

export class PackSourceError extends Error {
  constructor(
    dir: string,
    readonly problems: string[]
  ) {
    super(`${dir} has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n  • ${problems.join('\n  • ')}`)
    this.name = 'PackSourceError'
  }
}

/** Longest recording a phrase may have; anything longer is not a phrase. */
export const MAX_RECORDING_S = 30
/** A recording whose loudest sample is below this (-60 dBFS) holds no speech. */
const SILENCE_PEAK = 1e-3

export interface SourceRecording {
  /** Absolute path of the WAV on disk. */
  file: string
  /** Set when the recording is a text-to-speech placeholder. */
  synthetic?: SyntheticRecord
}

export interface PackSource {
  info: PackInfo
  content: PackContent
  /** Pack path → the recording on disk. */
  audio: Map<string, SourceRecording>
}

/** Reads and validates a pack source directory; throws PackSourceError listing every problem. */
export async function readPackSource(dir: string): Promise<PackSource> {
  const problems: string[] = []
  const info = await readInfo(dir, problems)
  const cards = await readRows(dir, 'cards.csv', CARD_COLUMNS, problems, (row, where) => {
    const parsed = CardSchema.safeParse({
      id: row.id,
      title: { en: row.title_en, sw: row.title_sw },
      dangerSigns: { en: splitList(row.danger_signs_en), sw: splitList(row.danger_signs_sw) },
      steps: { en: splitList(row.steps_en), sw: splitList(row.steps_sw) },
      tags: splitList(row.tags),
      source: row.source,
      version: /^\d+$/.test(row.version) ? Number(row.version) : row.version
    })
    if (!parsed.success) return void problems.push(...issues(where, parsed.error, csvColumn))
    const card = parsed.data
    // The two languages are one card: a list that differs in length was not translated item for item.
    for (const field of ['dangerSigns', 'steps'] as const) {
      if (card[field].en.length !== card[field].sw.length) {
        problems.push(`${where}: ${field} has ${card[field].en.length} items in en but ${card[field].sw.length} in sw`)
      }
    }
    return card
  })

  const audio = new Map<string, SourceRecording>()
  const phrases = await readRows(dir, 'phrases.csv', PHRASE_COLUMNS, problems, async (row, where) => {
    const recordings: Partial<Phrase['audio']> = {}
    let complete = true
    for (const lang of LANGS) {
      const ref = row[`audio_${lang}`]!
      const column = `${where}: audio_${lang}`
      if (!ref) {
        problems.push(`${column}: no recording; every phrase is played from a recording in both languages, never read by text-to-speech`)
        complete = false
        continue
      }
      const recording = await checkRecording(dir, ref, column, problems)
      if (recording) await checkSynthetic(recording, ref, lang, row[lang]!, column, problems)
      if (!recording || !SLUG.test(row.id!)) {
        complete = false
        continue
      }
      recordings[lang] = phraseAudioPath(row.id!, lang)
      audio.set(recordings[lang], recording)
    }
    const parsed = PhraseSchema.safeParse({
      id: row.id,
      category: row.category,
      text: { en: row.en, sw: row.sw },
      // Recording problems are reported above; stand-ins keep them from being reported twice.
      audio: complete ? recordings : { en: 'audio/-', sw: 'audio/-' },
      vettedBy: row.vetted_by
    })
    if (!parsed.success) return void problems.push(...issues(where, parsed.error, csvColumn))
    return complete ? parsed.data : undefined
  })

  if (cards.length === 0 && phrases.length === 0 && !problems.length) problems.push('no cards and no phrases')
  if (problems.length || !info) throw new PackSourceError(dir, problems)
  return { info, content: { cards, phrases }, audio }
}

async function readInfo(dir: string, problems: string[]): Promise<PackInfo | undefined> {
  const raw = await fs.readFile(path.join(dir, 'pack.json'), 'utf8').catch(() => undefined)
  if (raw === undefined) return void problems.push('pack.json: not found')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return void problems.push('pack.json: not valid JSON')
  }
  const parsed = PackInfoSchema.strict().safeParse(normalize(json))
  if (!parsed.success) return void problems.push(...issues('pack.json', parsed.error))
  return parsed.data
}

async function readRows<T, C extends readonly string[]>(
  dir: string,
  file: string,
  columns: C,
  problems: string[],
  toItem: (row: Record<C[number], string>, where: string) => T | undefined | Promise<T | undefined>
): Promise<T[]> {
  const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => undefined)
  if (raw === undefined) {
    problems.push(`${file}: not found`)
    return []
  }
  const table = parseCsvTable(raw)
  const header = table.header.map((h) => h.trim())
  const missing = columns.filter((c) => !header.includes(c))
  const unknown = header.filter((h) => !(columns as readonly string[]).includes(h))
  const repeated = header.filter((h, i) => header.indexOf(h) !== i)
  if (missing.length) problems.push(`${file}: missing column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`)
  if (unknown.length) problems.push(`${file}: unknown column${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`)
  if (repeated.length) problems.push(`${file}: repeated column${repeated.length > 1 ? 's' : ''} ${repeated.join(', ')}`)
  if (missing.length || unknown.length || repeated.length) return []

  const items: T[] = []
  const seen = new Set<string>()
  for (const [i, raw] of table.rows.entries()) {
    const row = Object.fromEntries(columns.map((c) => [c, normalize(raw[table.header[header.indexOf(c)]!] ?? '')]))
    const where = `${file} row ${i + 1}${row.id ? ` (${row.id})` : ''}`
    if (row.id && seen.has(row.id)) problems.push(`${where}: id "${row.id}" is used more than once`)
    seen.add(row.id!)
    if (table.widths[i] !== header.length) {
      problems.push(`${where}: has ${table.widths[i]} fields, the header has ${header.length}`)
      continue
    }
    const item = await toItem(row as Record<C[number], string>, where)
    if (item) items.push(item)
  }
  return items
}

/** Checks that a recording exists inside the pack directory and is a WAV with sound in it. */
async function checkRecording(dir: string, ref: string, where: string, problems: string[]): Promise<SourceRecording | undefined> {
  const root = path.resolve(dir)
  const file = path.resolve(root, ref)
  if (path.isAbsolute(ref) || !file.startsWith(root + path.sep)) {
    return void problems.push(`${where}: "${ref}" must be a relative path inside the pack directory`)
  }
  if (path.extname(file).toLowerCase() !== '.wav') return void problems.push(`${where}: "${ref}" is not a .wav file`)
  const bytes = await fs.readFile(file).catch(() => undefined)
  if (!bytes) return void problems.push(`${where}: "${ref}" not found`)
  let samples: Float32Array
  let seconds: number
  try {
    const wav = decodeWav(bytes)
    samples = wav.channels[0] ?? new Float32Array(0)
    seconds = samples.length / wav.sampleRate
  } catch (err) {
    return void problems.push(`${where}: "${ref}" is not a readable WAV (${(err as Error).message})`)
  }
  if (!samples.length) return void problems.push(`${where}: "${ref}" has no audio`)
  if (seconds > MAX_RECORDING_S) return void problems.push(`${where}: "${ref}" is ${seconds.toFixed(0)} s long; a phrase recording is at most ${MAX_RECORDING_S} s`)
  let peak = 0
  for (const v of samples) peak = Math.max(peak, Math.abs(v))
  if (peak < SILENCE_PEAK) return void problems.push(`${where}: "${ref}" is silent`)
  return { file }
}

/** Attaches a recording's synthetic record, after checking that it still describes this WAV and this text. */
async function checkSynthetic(
  recording: SourceRecording,
  ref: string,
  lang: Lang,
  phraseText: string,
  where: string,
  problems: string[]
): Promise<void> {
  const record = await readSyntheticRecord(recording.file)
  if (!record) return
  const recordName = `"${path.basename(syntheticRecordFile(ref))}"`
  if ('problem' in record) return void problems.push(`${where}: ${recordName} ${record.problem}`)
  if (record.sha256 !== sha256Hex(await fs.readFile(recording.file))) {
    return void problems.push(
      `${where}: "${ref}" changed after it was generated; if it is now a human recording, delete ${recordName}, otherwise generate it again`
    )
  }
  if (record.lang !== lang) return void problems.push(`${where}: ${recordName} was generated in ${record.lang}, not ${lang}`)
  if (record.text.normalize('NFC').trim() !== phraseText) {
    return void problems.push(`${where}: "${ref}" was generated from "${record.text}", not the phrase's current text; generate it again`)
  }
  recording.synthetic = record
}

function splitList(cell: string): string[] {
  return cell
    .split(LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Trims every string and normalizes it to NFC, so the same words always compare and hash the same. */
function normalize<T>(value: T): T {
  if (typeof value === 'string') return value.normalize('NFC').trim() as T
  if (Array.isArray(value)) return value.map(normalize) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) as T
  }
  return value
}

function issues(where: string, error: z.ZodError, field = (p: PropertyKey[]) => p.join('.')): string[] {
  return error.issues.map((i) => `${where}: ${i.path.length ? `${field(i.path)} ` : ''}${i.message}`)
}

/** The CSV column a schema path came from: title.sw → title_sw, text.en → en, vettedBy → vetted_by. */
function csvColumn([head, sub]: PropertyKey[]): string {
  if (head === 'text') return String(sub)
  const snake = String(head).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  return sub === 'en' || sub === 'sw' ? `${snake}_${sub}` : snake
}
