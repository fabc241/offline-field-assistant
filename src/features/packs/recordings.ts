/**
 * Synthetic recordings: placeholder phrase audio made with text-to-speech
 * until a native speaker records the phrase. Each one has a record next to it
 * that says so, and the pack manifest tags it `synthetic`:
 *
 *   recordings/sym-fever.sw.wav
 *   recordings/sym-fever.sw.wav.synthetic.json   { "engine": "…", "lang": "sw", "text": "Una homa?", "sha256": "…", "created": "…" }
 *
 * The record pins the WAV's sha256 and the text it was made from, so it cannot
 * drift: replace the WAV with a native recording and the build asks for the
 * record to be deleted; edit the phrase and the build asks for a new take.
 * A recording without a record is taken as a human recording.
 */
import fs from 'node:fs/promises'
import { z } from 'zod'
import { LANGS } from '../../core/engines.js'

export const syntheticRecordFile = (wavPath: string) => `${wavPath}.synthetic.json`

export const SyntheticRecordSchema = z.strictObject({
  /** What made the audio, e.g. the TTS model's manifest name. */
  engine: z.string().min(1),
  lang: z.enum(LANGS),
  /** The phrase text the audio was made from. */
  text: z.string().min(1),
  /** sha256 of the WAV file this record describes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created: z.iso.datetime(),
  /** The engine seed of this take, when not the default. */
  seed: z.number().int().optional(),
  /** What speech recognition heard in the take, and its character error rate in percent. */
  heard: z.string().optional(),
  cer: z.number().nonnegative().optional()
})
export type SyntheticRecord = z.infer<typeof SyntheticRecordSchema>

/** The record next to a recording: undefined when there is none, a problem string when it is unreadable. */
export async function readSyntheticRecord(wavPath: string): Promise<SyntheticRecord | undefined | { problem: string }> {
  const raw = await fs.readFile(syntheticRecordFile(wavPath), 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { problem: 'is not valid JSON' }
  }
  const parsed = SyntheticRecordSchema.safeParse(json)
  if (!parsed.success) return { problem: parsed.error.issues.map((i) => `${i.path.join('.') || 'record'} ${i.message}`).join('; ') }
  return parsed.data
}
