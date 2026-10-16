/**
 * The IPC contract between the Electron main process and a renderer: one
 * channel per service call, each with a request schema (checked in the main
 * process, since a renderer is not trusted) and a response type.
 *
 * Every call resolves to an envelope, never a rejection, so an error keeps
 * its code across the process boundary:
 *
 *   const r = await window.ofa.invoke('translate.text', { text, from: 'en', to: 'sw' })
 *   if (r.ok) show(r.value.translation)
 *   else if (r.error.code === 'not-licensed') …
 *
 * Audio and documents travel as bytes (WAV, PNG/JPEG/HEIC/PDF), never as
 * paths, so a renderer cannot point the main process at arbitrary files.
 * The one exception is models.install, whose directory comes from a folder
 * picker: the pack's signature, not the path, is what is trusted.
 */
import { z } from 'zod'
import { LANGS } from '../core/engines.js'
import type { VerifyResult } from '../core/model-store.js'
import type { ReadDocument, DocTranslation } from '../features/documents/document-service.js'
import type { GuideCard, GuideResult, VoiceGuideResult } from '../features/guide/guide.js'
import type { InstalledModelPack } from '../features/models/model-pack.js'
import type { PackFile } from '../features/packs/manifest.js'
import type { InstalledPack } from '../features/packs/store.js'
import type { PhraseEntry, PhraseHit } from '../features/phrasebook/phrasebook.js'
import type { LicenseFeature, LicenseState } from '../features/platform/license.js'
import type { LogProblem } from '../features/platform/secure-log.js'
import type { Transcript } from '../features/speech/speech-service.js'
import type { Turn } from '../features/conversation/conversation-service.js'
import type { CheckedTranslation, Translation } from '../features/translate/translation-service.js'
import type { Speech } from '../features/voice/read-aloud.js'

const MB = 1024 * 1024
const lang = z.enum(LANGS)
const bytes = (maxBytes: number) =>
  z
    .custom<Uint8Array>((v) => v instanceof Uint8Array, 'must be bytes (a Uint8Array)')
    .refine((b) => b.length > 0, 'is empty')
    .refine((b) => b.length <= maxBytes, `is larger than ${maxBytes / MB} MB`)
const text = (max: number) => z.string().trim().min(1).max(max)
const packId = z.string().regex(/^[a-z0-9-]{1,64}$/).optional()
const limit = z.number().int().min(1).max(20).optional()
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const none = z.strictObject({})

/** 10 minutes of 48 kHz stereo 16-bit WAV. */
const MAX_WAV = 120 * MB
const MAX_DOCUMENT = 50 * MB

export const REQUESTS = {
  'app.status': none,
  'license.status': none,
  'license.install': z.strictObject({ text: z.string().min(1).max(64 * 1024) }),
  'models.status': none,
  'models.install': z.strictObject({ dir: z.string().min(1).max(4096).refine((p) => p.startsWith('/'), 'must be an absolute path') }),
  'packs.list': none,
  'packs.install': z.strictObject({ bytes: bytes(200 * MB) }),
  'translate.text': z.strictObject({ text: text(5000), from: lang, to: lang, check: z.boolean().default(true) }),
  'speech.transcribe': z.strictObject({ wav: bytes(MAX_WAV), lang }),
  'voice.speak': z.strictObject({ text: text(2000), lang }),
  'conversation.turn': z.strictObject({
    wav: bytes(MAX_WAV),
    side: z.enum(['clinician', 'patient']),
    /** Send partial results on `ofa:event` while the turn runs. */
    stream: z.boolean().default(false)
  }),
  'phrasebook.list': z.strictObject({ category: z.string().max(100).optional(), pack: packId }),
  'phrasebook.search': z.strictObject({ query: text(500), lang, limit, pack: packId }),
  'phrasebook.recording': z.strictObject({ id: z.string().min(1).max(100), lang, pack: packId }),
  'guide.search': z.strictObject({ query: text(1000), lang: lang.optional(), limit, pack: packId }),
  'guide.ask': z.strictObject({ wav: bytes(MAX_WAV), lang, limit, pack: packId }),
  'guide.card': z.strictObject({ id: z.string().min(1).max(100), lang, pack: packId }),
  'documents.read': z.strictObject({ bytes: bytes(MAX_DOCUMENT) }),
  'documents.translate': z.strictObject({ bytes: bytes(MAX_DOCUMENT), to: lang, check: z.boolean().default(true) }),
  'logs.status': none,
  'logs.export': z.strictObject({ since: day.optional(), until: day.optional() }),
  'logs.wipe': z.strictObject({ confirm: z.literal(true) })
} as const

export type Channel = keyof typeof REQUESTS
export const CHANNELS = Object.keys(REQUESTS) as Channel[]
export const isChannel = (c: unknown): c is Channel => typeof c === 'string' && Object.hasOwn(REQUESTS, c)

/** What the renderer sends (defaults optional). */
export type RequestOf<C extends Channel> = z.input<(typeof REQUESTS)[C]>
/** What a service receives (defaults filled in). */
export type ParsedRequest<C extends Channel> = z.output<(typeof REQUESTS)[C]>

export interface LicenseSummary {
  status: LicenseState['status']
  mode: LicenseState['mode']
  message: string
  licensee?: string
  expiry?: string
  daysLeft?: number
  warnings: LicenseState['warnings']
  /** Features this session may use. */
  available: LicenseFeature[]
  deviceId?: string
}

export interface ModelsStatus {
  dir: string
  pack: InstalledModelPack
  models: VerifyResult[]
}

export interface AppStatus {
  app: string
  sdk: string
  license: LicenseSummary
  models: ModelsStatus
  packs: InstalledPack[]
  log: { keyStore: string | null; transcripts: boolean }
}

export type SpeechResult = Omit<Speech, 'samples'> & { wav: Uint8Array }

export interface PackInfo {
  id: string
  version: string
  title: string
  notice?: string
  signedBy: { keyId: string; label: string }
  files: Pick<PackFile, 'path' | 'synthetic'>[]
}

export interface PhraseList {
  packId: string
  packVersion: string
  notice?: string
  categories: string[]
  phrases: PhraseEntry[]
}

export interface PhraseRecordingResult {
  phrase: PhraseEntry
  lang: (typeof LANGS)[number]
  /** WAV exactly as signed into the pack; never text-to-speech. */
  wav: Uint8Array
  synthetic: boolean
}

export interface Responses {
  'app.status': AppStatus
  'license.status': LicenseSummary
  /** The installed license; it applies from the next start, as the mode is decided once per session. */
  'license.install': LicenseSummary & { restartRequired: true }
  'models.status': ModelsStatus
  'models.install': { id: string; version: string; copied: string[]; kept: string[]; removed: string[]; bytesCopied: number; ms: number }
  'packs.list': InstalledPack[]
  'packs.install': PackInfo
  'translate.text': Omit<CheckedTranslation, 'lines'> | Omit<Translation, 'lines'>
  'speech.transcribe': Transcript
  'voice.speak': SpeechResult
  /** `wav` is the translated speech; absent when nothing was recognized. */
  'conversation.turn': Omit<Turn, 'audioPath'> & { wav?: Uint8Array }
  'phrasebook.list': PhraseList
  'phrasebook.search': { packId: string; notice?: string; hits: PhraseHit[] }
  'phrasebook.recording': PhraseRecordingResult
  'guide.search': GuideResult
  'guide.ask': VoiceGuideResult
  'guide.card': GuideCard
  'documents.read': ReadDocument
  'documents.translate': DocTranslation
  'logs.status': { dir: string; keyStore: string; keyId?: string; transcripts: boolean; days: string[]; lines: number; problems: LogProblem[] }
  'logs.export': { records: unknown[]; problems: LogProblem[] }
  'logs.wipe': { files: number; bytes: number }
}

export const ERROR_CODES = [
  /** The request does not match the channel's schema. */
  'bad-request',
  'unknown-channel',
  /** The license does not cover the feature; `refusal` says what still works. */
  'not-licensed',
  /** A content or model pack failed verification; `problem` says how. */
  'pack-refused',
  /** No pack installed, or several and none chosen. */
  'no-pack',
  /** No such phrase or card. */
  'not-found',
  /** Not audio or a document the app can read. */
  'unreadable-input',
  /** The model files are missing or damaged: install the model pack. */
  'models-missing',
  'failed'
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export interface CallError {
  code: ErrorCode
  message: string
  /** For pack-refused: the PackError problem. */
  problem?: string
  /** For not-licensed. */
  refusal?: { feature: LicenseFeature; available: LicenseFeature[] }
}

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: CallError }

/** Partial results pushed on `ofa:event` during a streamed call. */
export type AppEvent =
  | { channel: 'conversation.turn'; callId: string; type: 'transcript'; atMs: number; text: string }
  | { channel: 'conversation.turn'; callId: string; type: 'translation'; atMs: number; text: string }
  | { channel: 'conversation.turn'; callId: string; type: 'audio'; atMs: number; wav: Uint8Array }
  | { channel: 'conversation.turn'; callId: string; type: 'check'; atMs: number; backTranslation: string; fidelity: number; flags: string[] }

/** What the preload script exposes as `window.ofa`. */
export interface OfaApi {
  invoke<C extends Channel>(channel: C, request: RequestOf<C>, opts?: { callId?: string }): Promise<Envelope<Responses[C]>>
  /** Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}

/** IPC channel names on the wire. */
export const IPC_INVOKE = 'ofa:invoke'
export const IPC_EVENT = 'ofa:event'
