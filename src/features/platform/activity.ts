/**
 * What the app records about its own use, in the encrypted log. By default
 * that is metadata only: which feature ran, how long each stage took, the
 * flags raised, the models and pack used, and whether it worked. Every
 * metadata string must be a single token (letters, digits, `._@-`, no
 * spaces), so a sentence of what someone said cannot slip into it.
 *
 * Words people said, typed or photographed go in `content`, which is dropped
 * unless transcripts are switched on (OFA_LOG_TRANSCRIPTS=1). A record that
 * breaks these rules is not written, and recording never fails the action it
 * describes.
 */
import { z } from 'zod'
import { LANGS } from '../../core/engines.js'
import type { SecureLog } from './secure-log.js'

export const ACTIVITY_FEATURES = [
  'translate',
  'speech',
  'read-aloud',
  'conversation',
  'documents',
  'guide',
  'phrasebook',
  'packs',
  'license',
  'logs'
] as const
export type ActivityFeature = (typeof ACTIVITY_FEATURES)[number]

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/
const token = z.string().regex(TOKEN, 'a single token: letters, digits and ._@- only')
const ms = z.number().nonnegative().max(1e9)

export const ActivitySchema = z.strictObject({
  at: z.iso.datetime(),
  /** App and QVAC SDK versions. */
  app: token,
  sdk: token.optional(),
  feature: z.enum(ACTIVITY_FEATURES),
  action: token,
  outcome: z.enum(['ok', 'refused', 'error']),
  /** What kind of error or refusal, never its message (which can quote input). */
  reason: token.optional(),
  langs: z.strictObject({ from: z.enum(LANGS).optional(), to: z.enum(LANGS).optional() }).optional(),
  /** Milliseconds per stage. */
  timings: z.record(token, ms).optional(),
  counts: z.record(token, z.number().int().nonnegative()).optional(),
  /** Short enumerated facts, e.g. { side: 'patient', mode: 'hybrid' }. */
  detail: z.record(token, token).optional(),
  flags: z.array(token).optional(),
  /** NAME@sha256-prefix of each model used. */
  models: z.array(token).optional(),
  /** Text from or for people: kept only when transcripts are on. */
  content: z.record(token, z.string()).optional()
})
export type Activity = z.infer<typeof ActivitySchema>

export type ActivityInput = Omit<Activity, 'at' | 'app' | 'sdk'>

export interface ActivityLogOptions {
  /** Keep `content` (transcripts, translations, queries). Off by default. */
  transcripts?: boolean
  app: string
  sdk?: string
  now?: () => Date
  /** Told when a record is dropped or cannot be written. */
  onError?: (err: Error) => void
}

export class ActivityLog {
  constructor(
    private readonly log: SecureLog | undefined,
    private readonly opts: ActivityLogOptions
  ) {}

  get transcripts(): boolean {
    return this.opts.transcripts === true
  }

  /** Records one action; never throws. Resolves once it is written (or dropped). */
  async record(input: ActivityInput): Promise<void> {
    if (!this.log) return
    const { content, timings, ...meta } = input
    const record = {
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      app: this.opts.app,
      ...(this.opts.sdk ? { sdk: this.opts.sdk } : {}),
      ...meta,
      ...(timings ? { timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])) } : {}),
      ...(this.transcripts && content && Object.keys(content).length ? { content } : {})
    }
    const parsed = ActivitySchema.safeParse(record)
    if (!parsed.success) {
      const where = parsed.error.issues.map((i) => i.path.join('.') || '(record)').join(', ')
      this.opts.onError?.(new Error(`Activity record for ${input.feature} not written: invalid ${where}`))
      return
    }
    await this.log.append(parsed.data).catch((err: Error) => this.opts.onError?.(err))
  }

  async flush(): Promise<void> {
    await this.log?.flush()
  }
}

/** A short token for an error: its `problem` or `code` when it has one, else its class name. */
export function errorKind(err: unknown): string {
  const e = err as { problem?: unknown; code?: unknown; name?: unknown }
  for (const v of [e?.problem, e?.code, e?.name]) if (typeof v === 'string' && TOKEN.test(v)) return v
  return 'Error'
}
