/**
 * An append-only log in which every line is encrypted on its own with
 * AES-256-GCM, one file per UTC day (`YYYY-MM-DD.jsonl`, mode 0600).
 *
 * A line is a small JSON envelope: the log key's id, the writing session, the
 * line's number within that session and day, the IV, the ciphertext and the
 * GCM tag. The day, key id, session and number are bound to the ciphertext as
 * additional data, so a line cannot be edited, moved to another day or
 * renumbered without failing authentication, and a gap or repeat in a
 * session's numbers shows that lines were deleted, duplicated or reordered.
 * Lines must be byte-for-byte canonical, so no byte changes unnoticed. The
 * plaintext is padded with spaces to a multiple of 64 bytes, so a line's
 * length says little about what it holds.
 *
 * Not detected: the last lines of a session, or a whole session or day,
 * removed (there is no later line to miss them). Each process writes its own
 * session, so concurrent writers never break each other's numbering.
 *
 * Retention: day files older than the retention period are deleted whenever
 * the log is written or read.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { KeyProvider, LogKey } from './keys.js'

export const LOG_RETENTION_DAYS = 30

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY_MS = 86_400_000
const PAD = 64

const canonicalBase64 = (bytes?: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((s) => {
      const b = Buffer.from(s, 'base64')
      return b.toString('base64') === s && (bytes === undefined || b.length === bytes)
    }, 'not canonical base64')

const LineSchema = z.strictObject({
  v: z.literal(1),
  key: z.string().regex(/^[0-9a-f]{16}$/),
  s: z.string().regex(/^[0-9a-f]{16}$/),
  i: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  iv: canonicalBase64(12),
  ct: canonicalBase64(),
  tag: canonicalBase64(16)
})
type Line = z.infer<typeof LineSchema>

export type LogProblemKind =
  /** Not a canonical log line (edited, cut short, or not one of ours). */
  | 'malformed'
  /** Written with another log key, e.g. one deleted since. */
  | 'unknown-key'
  /** Fails authentication: edited, or moved from another day or position. */
  | 'tampered'
  /** A session's numbers skip: lines before this one were removed. */
  | 'missing-lines'
  /** A session's number repeats or goes back: a line was duplicated or moved. */
  | 'out-of-order'

export interface LogProblem {
  day: string
  /** From 1. */
  line: number
  problem: LogProblemKind
  /** For `missing-lines`: how many. */
  count?: number
}

export interface LogEntry {
  day: string
  line: number
  record: unknown
}

export interface LogReadResult {
  entries: LogEntry[]
  problems: LogProblem[]
  days: string[]
  lines: number
  /** The key the log is readable with now; absent when there is none. */
  keyId?: string
}

export interface LogFile {
  day: string
  file: string
  bytes: number
}

export interface SecureLogOptions {
  retentionDays?: number
  now?: () => Date
  random?: (n: number) => Buffer
}

export class SecureLog {
  private readonly retentionDays: number
  private readonly now: () => Date
  private readonly random: (n: number) => Buffer
  /** This writer's session id and next line number per day. */
  private session: string
  private readonly next = new Map<string, number>()
  private queue: Promise<unknown> = Promise.resolve()
  private key: Promise<LogKey> | undefined
  private pruned = false

  constructor(
    readonly dir: string,
    private readonly keys: KeyProvider,
    opts: SecureLogOptions = {}
  ) {
    this.retentionDays = opts.retentionDays ?? LOG_RETENTION_DAYS
    this.now = opts.now ?? (() => new Date())
    this.random = opts.random ?? randomBytes
    this.session = this.random(8).toString('hex')
  }

  /** Appends one record (any JSON value). Appends are written in call order. */
  append(record: unknown): Promise<void> {
    const write = this.queue.then(() => this.write(record))
    this.queue = write.catch(() => undefined)
    return write
  }

  /** Waits for every append made so far. */
  async flush(): Promise<void> {
    await this.queue
  }

  /** Decrypts and checks every line still within the retention period. */
  async read(opts: { since?: string; until?: string } = {}): Promise<LogReadResult> {
    await this.flush()
    await this.prune()
    const key = await this.keys.existingLogKey()
    const files = (await this.files()).filter((f) => (!opts.since || f.day >= opts.since) && (!opts.until || f.day <= opts.until))
    const result: LogReadResult = { entries: [], problems: [], days: [], lines: 0, ...(key ? { keyId: key.id } : {}) }
    for (const { day, file } of files) {
      result.days.push(day)
      const text = await fs.readFile(file, 'utf8')
      if (text === '') continue
      const raw = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
      /** Next expected number per session in this file. */
      const expected = new Map<string, number>()
      raw.forEach((rawLine, index) => {
        const lineNo = index + 1
        result.lines++
        const problem = (kind: LogProblemKind, count?: number) =>
          result.problems.push({ day, line: lineNo, problem: kind, ...(count ? { count } : {}) })
        const line = parseLine(rawLine)
        if (!line) return problem('malformed')
        const want = expected.get(line.s) ?? 0
        if (line.i > want) problem('missing-lines', line.i - want)
        if (line.i < want) problem('out-of-order')
        expected.set(line.s, Math.max(want, line.i + 1))
        if (!key || line.key !== key.id) return problem('unknown-key')
        const record = decrypt(line, day, key)
        if (record === undefined) return problem('tampered')
        result.entries.push({ day, line: lineNo, record })
      })
    }
    return result
  }

  /** Day files, oldest first, without reading them. */
  async files(): Promise<LogFile[]> {
    const names = await fs.readdir(this.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[]
      throw err
    })
    const files: LogFile[] = []
    for (const name of names.sort()) {
      const day = DAY_FILE.exec(name)?.[1]
      if (!day) continue
      const file = path.join(this.dir, name)
      const stat = await fs.stat(file)
      if (stat.isFile()) files.push({ day, file, bytes: stat.size })
    }
    return files
  }

  /** Deletes the day files past the retention period; returns their days. */
  async prune(): Promise<string[]> {
    const cutoff = utcDay(new Date(this.now().getTime() - this.retentionDays * DAY_MS))
    const old = (await this.files()).filter((f) => f.day <= cutoff)
    for (const f of old) await fs.rm(f.file, { force: true })
    this.pruned = true
    return old.map((f) => f.day)
  }

  /**
   * Deletes every day file, then the log key, so any copy of a line left on
   * the disk can no longer be read. The next append makes a new key.
   */
  async wipe(): Promise<{ files: number; bytes: number }> {
    await this.flush()
    const files = await this.files()
    for (const f of files) await fs.rm(f.file, { force: true })
    await this.keys.deleteLogKey()
    // A new key starts a new session.
    this.key = undefined
    this.session = this.random(8).toString('hex')
    this.next.clear()
    return { files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) }
  }

  private async write(record: unknown): Promise<void> {
    const json = JSON.stringify(record)
    if (json === undefined) throw new Error('A log record must be a JSON value')
    if (!this.pruned) await this.prune()
    this.key ??= this.keys.logKey()
    const key = await this.key.catch((err) => {
      this.key = undefined
      throw err
    })
    const day = utcDay(this.now())
    const i = this.next.get(day) ?? 0
    const iv = this.random(12)
    const cipher = createCipheriv('aes-256-gcm', key.key, iv)
    cipher.setAAD(additionalData(day, key.id, this.session, i))
    const plain = Buffer.from(json, 'utf8')
    // JSON ignores trailing spaces.
    const padded = Buffer.concat([plain, Buffer.alloc(PAD - (plain.length % PAD), ' ')])
    const ct = Buffer.concat([cipher.update(padded), cipher.final()])
    const line: Line = {
      v: 1,
      key: key.id,
      s: this.session,
      i,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, `${day}.jsonl`)
    // A writer that died mid-line left no newline: start on a line of our own.
    const lead = i === 0 && !(await endsWithNewline(file)) ? '\n' : ''
    await fs.appendFile(file, lead + JSON.stringify(line) + '\n', { mode: 0o600 })
    this.next.set(day, i + 1)
  }
}

/** True for a missing or empty file too. */
async function endsWithNewline(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r').catch(() => undefined)
  if (!handle) return true
  try {
    const { size } = await handle.stat()
    if (size === 0) return true
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    await handle.close()
  }
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10)

const additionalData = (day: string, keyId: string, session: string, i: number) =>
  Buffer.from(`ofa-log-v1\n${day}\n${keyId}\n${session}\n${i}`, 'utf8')

function parseLine(raw: string): Line | undefined {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = LineSchema.safeParse(json)
  // Canonical: exactly the bytes the writer would produce.
  if (!parsed.success || JSON.stringify(parsed.data) !== raw) return undefined
  return parsed.data
}

function decrypt(line: Line, day: string, key: LogKey): unknown {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(line.iv, 'base64'), { authTagLength: 16 })
    decipher.setAAD(additionalData(day, line.key, line.s, line.i))
    decipher.setAuthTag(Buffer.from(line.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(line.ct, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    return undefined
  }
}
