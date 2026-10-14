/**
 * Reference voices: a recording of a native speaker that Chatterbox imitates
 * instead of its built-in voice. Only a person who agreed to it may be cloned,
 * so a recording is used only with a consent record next to it:
 *
 *   voices/amina-sw.wav
 *   voices/amina-sw.wav.consent.json   { "speaker": "…", "consentDate": "2026-10-01", "scope": "…" }
 *
 * The app does not judge the consent; it refuses to clone without a record.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeWav } from '../../core/audio.js'
import { ttsSpec, type TtsOptions } from '../../core/catalog.js'
import { LANGS, type Lang } from '../../core/engines.js'
import type { ModelSpec } from '../../core/qvac.js'

export interface VoiceConsent {
  /** Who is speaking in the recording. */
  speaker: string
  /** When they agreed, as an ISO date. */
  consentDate: string
  /** What they agreed to, e.g. "read-aloud voice for the Offline Field Assistant, clinic X". */
  scope: string
}

export class ReferenceVoiceError extends Error {
  constructor(file: string, problem: string) {
    super(`Reference voice ${file}: ${problem}`)
    this.name = 'ReferenceVoiceError'
  }
}

/** Chatterbox needs at least this much clean speech to condition on. */
export const MIN_REFERENCE_S = 5

export const consentFile = (wavPath: string) => `${wavPath}.consent.json`

/** Checks a reference recording and its consent record; returns the record. */
export async function checkReferenceVoice(wavPath: string): Promise<VoiceConsent> {
  if (!path.isAbsolute(wavPath)) throw new ReferenceVoiceError(wavPath, 'must be an absolute path')
  const raw = await fs.readFile(consentFile(wavPath), 'utf8').catch(() => undefined)
  if (raw === undefined) {
    throw new ReferenceVoiceError(wavPath, `no consent record (${path.basename(consentFile(wavPath))}); voices are cloned only with the speaker's consent`)
  }
  let consent: Partial<VoiceConsent>
  try {
    consent = JSON.parse(raw) as Partial<VoiceConsent>
  } catch {
    throw new ReferenceVoiceError(wavPath, 'the consent record is not valid JSON')
  }
  for (const key of ['speaker', 'consentDate', 'scope'] as const) {
    if (typeof consent[key] !== 'string' || !consent[key].trim()) {
      throw new ReferenceVoiceError(wavPath, `the consent record has no "${key}"`)
    }
  }
  if (Number.isNaN(Date.parse(consent.consentDate!))) {
    throw new ReferenceVoiceError(wavPath, `consentDate "${consent.consentDate}" is not a date`)
  }

  const bytes = await fs.readFile(wavPath).catch(() => undefined)
  if (!bytes) throw new ReferenceVoiceError(wavPath, 'file not found')
  const audio = decodeWav(bytes)
  if (audio.channels.length !== 1) throw new ReferenceVoiceError(wavPath, `must be mono, has ${audio.channels.length} channels`)
  const seconds = audio.channels[0]!.length / audio.sampleRate
  if (seconds < MIN_REFERENCE_S) {
    throw new ReferenceVoiceError(wavPath, `${seconds.toFixed(1)} s of audio; at least ${MIN_REFERENCE_S} s of clean speech is needed`)
  }
  return consent as VoiceConsent
}

/**
 * The model spec per language, with the configured reference voices after
 * checking each one. Throws on the first voice that fails the check.
 */
export async function speakerSpecs(
  voices: Partial<Record<Lang, string>>,
  opts: Omit<TtsOptions, 'referenceAudio'> = {}
): Promise<(lang: Lang) => ModelSpec> {
  for (const lang of LANGS) if (voices[lang]) await checkReferenceVoice(voices[lang])
  const specs = Object.fromEntries(LANGS.map((l) => [l, ttsSpec(l, { ...opts, referenceAudio: voices[l] })]))
  return (lang) => specs[lang]!
}
