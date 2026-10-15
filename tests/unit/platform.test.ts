import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/core/config.js'
import { canonicalJson } from '../../src/features/packs/manifest.js'
import { generateSigningKey, loadPrivateKey, signManifest, trustedKey } from '../../src/features/packs/signing.js'
import { TRUSTED_PACK_KEYS } from '../../src/features/packs/trusted-keys.js'
import { ActivityLog, errorKind } from '../../src/features/platform/activity.js'
import { DEVICE_ID, deviceId, deviceIdFrom } from '../../src/features/platform/device.js'
import type { Run } from '../../src/features/platform/exec.js'
import { KeyProvider, keychainVault, logKeyId, safeStorageVault, type SafeStorage, type SecretVault } from '../../src/features/platform/keys.js'
import { TRUSTED_LICENSE_KEYS } from '../../src/features/platform/license-keys.js'
import {
  LICENSE_FEATURES,
  READ_ONLY_FEATURES,
  allows,
  checkLicense,
  issueLicense,
  readLicense,
  type License
} from '../../src/features/platform/license.js'
import { SecureLog, utcDay, type LogProblemKind } from '../../src/features/platform/secure-log.js'

let tmp: string
let n = 0
const newDir = () => path.join(tmp, `d${++n}`)

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-platform-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** A vault in memory; `delay` lets two providers race. */
class MemoryVault implements SecretVault {
  name = 'memory'
  secret: Buffer | undefined
  adds = 0
  constructor(private readonly delay = 0) {}
  async read() {
    await new Promise((r) => setTimeout(r, this.delay))
    return this.secret
  }
  async add(secret: Buffer) {
    this.adds++
    await new Promise((r) => setTimeout(r, this.delay))
    if (this.secret) return false
    this.secret = secret
    return true
  }
  async delete() {
    this.secret = undefined
  }
}

const keyProvider = () => new KeyProvider(new MemoryVault())

describe('KeyProvider', () => {
  it('makes a 256-bit key on first use and returns the same one after', async () => {
    const vault = new MemoryVault()
    const keys = new KeyProvider(vault)
    expect(await keys.existingLogKey()).toBeUndefined()
    const a = await keys.logKey()
    const b = await new KeyProvider(vault).logKey()
    expect(a.key.length).toBe(32)
    expect(b.key.equals(a.key)).toBe(true)
    expect(a.id).toBe(logKeyId(a.key))
    expect(a.id).toMatch(/^[0-9a-f]{16}$/)
    expect(vault.adds).toBe(1)
  })

  it('gives two processes racing to make the key the same key', async () => {
    const vault = new MemoryVault(5)
    const [a, b] = await Promise.all([new KeyProvider(vault).logKey(), new KeyProvider(vault).logKey()])
    expect(vault.adds).toBe(2)
    expect(a.key.equals(b.key)).toBe(true)
  })

  it('refuses a stored secret of the wrong length', async () => {
    const vault = new MemoryVault()
    vault.secret = Buffer.alloc(16)
    await expect(new KeyProvider(vault).logKey()).rejects.toThrow(/16 bytes, not 32/)
  })

  it('the key id does not reveal the key', () => {
    const key = Buffer.alloc(32, 7)
    expect(logKeyId(key)).not.toBe(createHash('sha256').update(key).digest('hex').slice(0, 16))
  })
})

describe('keychainVault', () => {
  /** A fake `security` with one item. */
  function fakeSecurity() {
    const calls: { args: string[]; stdin?: string }[] = []
    let stored: string | undefined
    const run: Run = async (_cmd, args, stdin) => {
      calls.push({ args, stdin })
      if (args[0] === 'find-generic-password') return stored ? { code: 0, stdout: `${stored}\n`, stderr: '' } : { code: 44, stdout: '', stderr: 'not found' }
      if (args[0] === '-i') {
        if (stored) return { code: 45, stdout: '', stderr: 'already exists' }
        stored = /-w (\S+)\n$/.exec(stdin ?? '')![1]
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'delete-generic-password') {
        const had = stored !== undefined
        stored = undefined
        return { code: had ? 0 : 44, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    }
    return { run, calls }
  }

  it('stores the key through stdin, never on the command line', async () => {
    const { run, calls } = fakeSecurity()
    const keys = new KeyProvider(keychainVault({ service: 'OFA test', run }))
    const key = await keys.logKey()
    const b64 = key.key.toString('base64')
    expect(calls.some((c) => c.args.some((a) => a.includes(b64)))).toBe(false)
    expect(calls.find((c) => c.args[0] === '-i')!.stdin).toContain(b64)
    expect((await keys.existingLogKey())!.key.equals(key.key)).toBe(true)
  })

  it('treats "not found" as no key, and deleting a missing key as done', async () => {
    const { run } = fakeSecurity()
    const vault = keychainVault({ service: 'OFA test', run })
    expect(await vault.read()).toBeUndefined()
    await expect(vault.delete()).resolves.toBeUndefined()
  })

  it('does not replace a key that is already there', async () => {
    const { run } = fakeSecurity()
    const vault = keychainVault({ service: 'OFA test', run })
    expect(await vault.add(Buffer.alloc(32, 1))).toBe(true)
    expect(await vault.add(Buffer.alloc(32, 2))).toBe(false)
    expect((await vault.read())!.equals(Buffer.alloc(32, 1))).toBe(true)
  })

  it('reports other failures with the exit code', async () => {
    const run: Run = async () => ({ code: 36, stdout: '', stderr: 'User interaction is not allowed.' })
    await expect(keychainVault({ service: 'OFA test', run }).read()).rejects.toThrow(/exit 36: User interaction is not allowed/)
  })

  it('accepts only plain words as service and account', () => {
    expect(() => keychainVault({ service: 'x" -w evil' })).toThrow(/plain words/)
  })
})

describe('safeStorageVault', () => {
  /** Reversible stand-in for Electron's safeStorage. */
  const fakeSafeStorage = (available = true): SafeStorage => ({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
    decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString()
  })

  it('keeps the key encrypted in its file and reads it back', async () => {
    const file = path.join(newDir(), 'log-key.bin')
    const keys = new KeyProvider(safeStorageVault({ safeStorage: fakeSafeStorage(), file }))
    const key = await keys.logKey()
    const raw = await fs.readFile(file)
    expect(raw.toString()).toMatch(/^enc:/)
    expect(raw.includes(key.key)).toBe(false)
    expect(raw.toString().includes(key.key.toString('base64'))).toBe(false)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await new KeyProvider(safeStorageVault({ safeStorage: fakeSafeStorage(), file })).logKey()).key.equals(key.key)).toBe(true)
    await keys.deleteLogKey()
    expect(await keys.existingLogKey()).toBeUndefined()
  })

  it('refuses to work without OS encryption', async () => {
    const file = path.join(newDir(), 'log-key.bin')
    await expect(new KeyProvider(safeStorageVault({ safeStorage: fakeSafeStorage(false), file })).logKey()).rejects.toThrow(/not available/)
  })
})

/** A clock that can be moved. */
const clock = (iso: string) => {
  let t = new Date(iso).getTime()
  return { now: () => new Date(t), set: (s: string) => (t = new Date(s).getTime()) }
}

async function dayFile(log: SecureLog, day: string): Promise<string> {
  return path.join(log.dir, `${day}.jsonl`)
}

const problems = async (log: SecureLog): Promise<LogProblemKind[]> => (await log.read()).problems.map((p) => p.problem)

describe('SecureLog', () => {
  it('round-trips records in order, one file per UTC day, owner-only', async () => {
    const c = clock('2026-10-15T23:59:59Z')
    const log = new SecureLog(newDir(), keyProvider(), { now: c.now })
    await log.append({ n: 1 })
    c.set('2026-10-16T00:00:01Z')
    await Promise.all([log.append({ n: 2 }), log.append({ n: 3, text: 'é ✓' })])
    const read = await log.read()
    expect(read.problems).toEqual([])
    expect(read.days).toEqual(['2026-10-15', '2026-10-16'])
    expect(read.entries.map((e) => e.record)).toEqual([{ n: 1 }, { n: 2 }, { n: 3, text: 'é ✓' }])
    expect((await fs.stat(log.dir)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(await dayFile(log, '2026-10-16'))).mode & 0o777).toBe(0o600)
  })

  it('writes no plaintext, and pads it so lengths say little', async () => {
    const log = new SecureLog(newDir(), keyProvider())
    await log.append({ secret: 'Mtoto ana homa kali' })
    await log.append({ secret: 'Mtoto ana homa kali sana sana' })
    const raw = await fs.readFile((await log.files())[0]!.file, 'utf8')
    expect(raw).not.toMatch(/Mtoto|homa|secret/)
    const lengths = raw.trim().split('\n').map((l) => Buffer.from(JSON.parse(l).ct, 'base64').length)
    expect(lengths[0]! % 64).toBe(0)
    expect(lengths[0]).toBe(lengths[1])
  })

  it('flags an edited line and still reads the others', async () => {
    const log = new SecureLog(newDir(), keyProvider())
    for (let i = 0; i < 3; i++) await log.append({ i })
    const file = (await log.files())[0]!.file
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    const line = JSON.parse(lines[1]!)
    const ct = Buffer.from(line.ct, 'base64')
    ct[0]! ^= 1
    lines[1] = JSON.stringify({ ...line, ct: ct.toString('base64') })
    await fs.writeFile(file, lines.join('\n') + '\n')
    const read = await log.read()
    expect(read.problems).toEqual([{ day: read.days[0], line: 2, problem: 'tampered' }])
    expect(read.entries.map((e) => e.record)).toEqual([{ i: 0 }, { i: 2 }])
  })

  it('catches every single-bit flip anywhere in a log file', async () => {
    const log = new SecureLog(newDir(), keyProvider())
    await log.append({ a: 1 })
    await log.append({ b: 'two' })
    const file = (await log.files())[0]!.file
    const original = await fs.readFile(file)
    const silent: number[] = []
    for (let i = 0; i < original.length; i++) {
      const copy = Buffer.from(original)
      copy[i]! ^= 1
      await fs.writeFile(file, copy)
      if ((await log.read()).problems.length === 0) silent.push(i)
    }
    expect(silent).toEqual([])
  })

  it('notices deleted, duplicated, reordered and moved lines', async () => {
    const keys = keyProvider()
    const c = clock('2026-10-15T12:00:00Z')
    const log = new SecureLog(newDir(), keys, { now: c.now })
    for (let i = 0; i < 4; i++) await log.append({ i })
    c.set('2026-10-16T12:00:00Z')
    await log.append({ i: 'next day' })
    const file = await dayFile(log, '2026-10-15')
    const next = await dayFile(log, '2026-10-16')
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    const nextLines = await fs.readFile(next, 'utf8')
    const put = (ls: string[]) => fs.writeFile(file, ls.join('\n') + '\n')

    await put([lines[0]!, lines[2]!, lines[3]!])
    expect(await problems(log)).toEqual(['missing-lines'])
    await put([lines[1]!, lines[2]!, lines[3]!])
    expect(await problems(log)).toEqual(['missing-lines'])
    await put([lines[0]!, lines[1]!, lines[1]!, lines[2]!, lines[3]!])
    expect(await problems(log)).toEqual(['out-of-order'])
    await put([lines[0]!, lines[2]!, lines[1]!, lines[3]!])
    expect(await problems(log)).toEqual(['missing-lines', 'out-of-order'])
    // A line moved to another day's file, even into the right position, fails authentication.
    await put([...lines])
    await fs.writeFile(next, lines[0]! + '\n')
    expect(await problems(log)).toEqual(['tampered'])
    await fs.writeFile(next, nextLines)
    expect(await problems(log)).toEqual([])
  })

  it('does not notice the last lines of a session cut off (documented limit)', async () => {
    const log = new SecureLog(newDir(), keyProvider())
    for (let i = 0; i < 3; i++) await log.append({ i })
    const file = (await log.files())[0]!.file
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    await fs.writeFile(file, lines.slice(0, 2).join('\n') + '\n')
    const read = await log.read()
    expect(read.problems).toEqual([])
    expect(read.entries).toHaveLength(2)
  })

  it('keeps sessions of concurrent writers apart', async () => {
    const dir = newDir()
    const keys = keyProvider()
    const a = new SecureLog(dir, keys)
    const b = new SecureLog(dir, keys)
    for (let i = 0; i < 5; i++) await Promise.all([a.append({ w: 'a', i }), b.append({ w: 'b', i })])
    const read = await a.read()
    expect(read.problems).toEqual([])
    expect(read.entries).toHaveLength(10)
  })

  it('refuses a line that is not byte-for-byte canonical', async () => {
    const log = new SecureLog(newDir(), keyProvider())
    await log.append({ x: 1 })
    const file = (await log.files())[0]!.file
    const line = (await fs.readFile(file, 'utf8')).trim()
    await fs.writeFile(file, JSON.stringify(JSON.parse(line), null, 1).replace(/\n/g, '') + '\n')
    expect(await problems(log)).toEqual(['malformed'])
  })

  it('starts a fresh line after a writer died mid-line', async () => {
    const dir = newDir()
    const keys = keyProvider()
    const first = new SecureLog(dir, keys)
    await first.append({ before: true })
    const file = (await first.files())[0]!.file
    await fs.appendFile(file, '{"v":1,"key":"0123')
    const second = new SecureLog(dir, keys)
    await second.append({ after: true })
    const read = await second.read()
    expect(read.problems).toEqual([{ day: read.days[0], line: 2, problem: 'malformed' }])
    expect(read.entries.map((e) => e.record)).toEqual([{ before: true }, { after: true }])
  })

  it('deletes days past the retention period when written or read', async () => {
    const c = clock('2026-09-14T08:00:00Z')
    const keys = keyProvider()
    const log = () => new SecureLog(path.join(tmp, 'retention'), keys, { now: c.now })
    for (const day of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-10-14']) {
      c.set(`${day}T08:00:00Z`)
      await log().append({ day })
    }
    // 30 days after 09-15 08:00: whatever is left of 09-15 is at least 30 days old.
    c.set('2026-10-15T00:00:00Z')
    expect((await log().read()).days).toEqual(['2026-09-16', '2026-10-14'])
    c.set('2026-10-16T09:00:00Z')
    await log().append({ day: 'today' })
    expect((await log().files()).map((f) => f.day)).toEqual(['2026-10-14', '2026-10-16'])
  })

  it('wipes every file and the key; old lines copied back stay unreadable', async () => {
    const keys = keyProvider()
    const log = new SecureLog(newDir(), keys)
    await log.append({ old: true })
    const file = (await log.files())[0]!.file
    const saved = await fs.readFile(file)
    const oldId = (await keys.existingLogKey())!.id
    expect(await log.wipe()).toEqual({ files: 1, bytes: saved.length })
    expect(await log.files()).toEqual([])
    expect(await keys.existingLogKey()).toBeUndefined()
    await log.append({ wiped: true })
    expect((await keys.existingLogKey())!.id).not.toBe(oldId)
    await fs.appendFile(file, saved)
    const read = await log.read()
    expect(read.entries.map((e) => e.record)).toEqual([{ wiped: true }])
    expect(read.problems.map((p) => p.problem)).toEqual(['unknown-key'])
  })

  it('reads a log whose key is gone as unknown-key, not as tampering', async () => {
    const keys = keyProvider()
    const log = new SecureLog(newDir(), keys)
    await log.append({ x: 1 })
    await keys.deleteLogKey()
    const read = await log.read()
    expect(read.keyId).toBeUndefined()
    expect(read.problems.map((p) => p.problem)).toEqual(['unknown-key'])
  })

  it('filters by day', async () => {
    const c = clock('2026-10-10T10:00:00Z')
    const log = new SecureLog(newDir(), keyProvider(), { now: c.now })
    for (const d of ['10', '11', '12']) {
      c.set(`2026-10-${d}T10:00:00Z`)
      await log.append({ d })
    }
    expect((await log.read({ since: '2026-10-11', until: '2026-10-11' })).entries.map((e) => e.record)).toEqual([{ d: '11' }])
  })

  it('utcDay is the UTC date', () => {
    expect(utcDay(new Date('2026-10-15T23:30:00-03:00'))).toBe('2026-10-16')
  })
})

describe('ActivityLog', () => {
  const base = { feature: 'translate', action: 'translate', outcome: 'ok' } as const

  async function activity(transcripts: boolean, onError?: (e: Error) => void) {
    const log = new SecureLog(newDir(), keyProvider())
    return { log, activity: new ActivityLog(log, { app: '0.1.0', sdk: '0.21.0', transcripts, ...(onError ? { onError } : {}) }) }
  }

  it('records metadata only by default', async () => {
    const { log, activity: a } = await activity(false)
    await a.record({
      ...base,
      langs: { from: 'en', to: 'sw' },
      timings: { translateMs: 812.4 },
      flags: ['low-fidelity'],
      models: ['TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M@fc2a80532e58'],
      content: { source: 'The child has a fever.', translation: 'Mtoto ana homa.' }
    })
    const [entry] = (await log.read()).entries
    expect(entry!.record).toMatchObject({ ...base, app: '0.1.0', sdk: '0.21.0', timings: { translateMs: 812 }, flags: ['low-fidelity'] })
    expect(JSON.stringify(entry!.record)).not.toMatch(/fever|homa|content/)
  })

  it('keeps content when transcripts are on', async () => {
    const { log, activity: a } = await activity(true)
    await a.record({ ...base, content: { source: 'The child has a fever.' } })
    expect((await log.read()).entries[0]!.record).toMatchObject({ content: { source: 'The child has a fever.' } })
  })

  it('drops a record with text in a metadata field, without throwing', async () => {
    const errors: Error[] = []
    const { log, activity: a } = await activity(false, (e) => errors.push(e))
    await a.record({ ...base, detail: { side: 'the child has a fever' } })
    await a.record({ ...base, flags: ['has fever'] })
    await a.record({ ...base, reason: 'Pack x is not installed' })
    expect((await log.read()).entries).toEqual([])
    expect(errors.map((e) => e.message)).toEqual([
      'Activity record for translate not written: invalid detail.side',
      'Activity record for translate not written: invalid flags.0',
      'Activity record for translate not written: invalid reason'
    ])
  })

  it('never fails the action when the log cannot be written', async () => {
    const errors: Error[] = []
    const broken = new KeyProvider({ name: 'broken', read: async () => { throw new Error('keychain locked') }, add: async () => false, delete: async () => {} })
    const a = new ActivityLog(new SecureLog(newDir(), broken), { app: '0.1.0', onError: (e) => errors.push(e) })
    await expect(a.record(base)).resolves.toBeUndefined()
    expect(errors[0]!.message).toBe('keychain locked')
  })

  it('names errors by kind, never by message', () => {
    expect(errorKind(Object.assign(new Error('Pack "x" downgrade'), { problem: 'downgrade' }))).toBe('downgrade')
    expect(errorKind(Object.assign(new Error('no such file /Users/x/Juma form.pdf'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorKind(new TypeError('bad'))).toBe('TypeError')
    expect(errorKind('a string')).toBe('Error')
  })
})

describe('License', () => {
  const vendor = generateSigningKey()
  const vendorKey = loadPrivateKey(vendor.privateKeyPem)
  const trustedKeys = [trustedKey('test vendor', vendor.publicKeyPem)]
  const DEVICE = deviceIdFrom('00000000-0000-0000-0000-000000000001')
  const NOW = new Date('2026-10-15T12:00:00Z')
  const license = (over: Partial<License> = {}): License => ({
    format: 1,
    kind: 'license',
    id: 'test-clinic-001',
    licensee: 'Test Clinic',
    seats: 25,
    issued: '2026-10-01T00:00:00.000Z',
    expiry: '2027-09-30T23:59:59.999Z',
    features: ['conversation', 'translate', 'guide'],
    ...over
  })
  const check = (text: string | undefined, now = NOW, device = DEVICE) => checkLicense(text, { trustedKeys, deviceId: device, now })

  it('a valid license gives full mode and only its features (plus the read-only floor)', () => {
    const state = check(issueLicense(license(), vendorKey))
    expect(state).toMatchObject({ status: 'valid', mode: 'full', daysLeft: 350, warnings: [], signedBy: { label: 'test vendor' } })
    expect(LICENSE_FEATURES.filter((f) => allows(state, f))).toEqual(['conversation', 'translate', 'guide', 'phrasebook'])
  })

  it('an expired license opens read-only: guide and phrasebook only', () => {
    const text = issueLicense(license(), vendorKey)
    const state = check(text, new Date('2027-10-01T00:00:00Z'))
    expect(state).toMatchObject({ status: 'expired', mode: 'read-only' })
    expect(state.message).toMatch(/expired on 2027-09-30: read-only mode/)
    expect(LICENSE_FEATURES.filter((f) => allows(state, f))).toEqual([...READ_ONLY_FEATURES])
    // The last millisecond is still valid; the expiry instant is not.
    expect(check(text, new Date('2027-09-30T23:59:59.998Z')).status).toBe('valid')
    expect(check(text, new Date('2027-09-30T23:59:59.999Z')).status).toBe('expired')
  })

  it('no license is read-only too', () => {
    const state = check(undefined)
    expect(state).toMatchObject({ status: 'missing', mode: 'read-only' })
    expect(allows(state, 'guide')).toBe(true)
    expect(allows(state, 'conversation')).toBe(false)
  })

  it('refuses a license from a key the app does not trust', () => {
    const other = loadPrivateKey(generateSigningKey().privateKeyPem)
    expect(check(issueLicense(license(), other))).toMatchObject({ status: 'invalid', problem: 'unknown-key', mode: 'read-only' })
  })

  it('refuses a forged signature that names the trusted key', () => {
    const other = loadPrivateKey(generateSigningKey().privateKeyPem)
    const file = JSON.parse(issueLicense(license(), other))
    file.signature.keyId = trustedKeys[0]!.keyId
    expect(check(canonicalJson(file))).toMatchObject({ status: 'invalid', problem: 'bad-signature' })
  })

  it('refuses a license edited after signing', () => {
    const file = JSON.parse(issueLicense(license(), vendorKey))
    file.license.expiry = '2099-12-31T23:59:59.999Z'
    expect(check(canonicalJson(file))).toMatchObject({ status: 'invalid', problem: 'bad-signature' })
    file.license.expiry = license().expiry
    file.license.features = [...LICENSE_FEATURES]
    expect(check(canonicalJson(file))).toMatchObject({ status: 'invalid', problem: 'bad-signature' })
  })

  it('refuses any single-bit flip of the file', () => {
    const text = Buffer.from(issueLicense(license(), vendorKey))
    const accepted: number[] = []
    for (let i = 0; i < text.length; i++) {
      const copy = Buffer.from(text)
      copy[i]! ^= 1
      if (check(copy.toString('utf8')).status === 'valid') accepted.push(i)
    }
    expect(accepted).toEqual([])
  })

  it('refuses a reformatted file and one that is not JSON', () => {
    const text = issueLicense(license(), vendorKey)
    expect(check(JSON.stringify(JSON.parse(text))).problem).toBe('malformed')
    expect(check('not json').problem).toBe('malformed')
  })

  it('a pack signature by the same key does not pass as a license signature', () => {
    const lic = license()
    const file = { format: 1, license: lic, signature: signManifest(Buffer.from(canonicalJson(lic)), vendorKey) }
    expect(check(canonicalJson(file))).toMatchObject({ status: 'invalid', problem: 'bad-signature' })
  })

  it('a license bound to a device opens only on that device', () => {
    const text = issueLicense(license({ deviceId: DEVICE }), vendorKey)
    expect(check(text).status).toBe('valid')
    const other = check(text, NOW, deviceIdFrom('00000000-0000-0000-0000-000000000002'))
    expect(other).toMatchObject({ status: 'wrong-device', mode: 'read-only' })
    expect(other.license?.id).toBe('test-clinic-001')
    expect(checkLicense(text, { trustedKeys, now: NOW }).status).toBe('wrong-device')
  })

  it('warns before expiry and when the clock is before the issue date, but stays valid', () => {
    const text = issueLicense(license(), vendorKey)
    expect(check(text, new Date('2027-09-15T00:00:00Z'))).toMatchObject({ status: 'valid', warnings: ['expires-soon'], daysLeft: 15 })
    expect(check(text, new Date('2026-01-01T00:00:00Z'))).toMatchObject({ status: 'valid', warnings: ['clock-behind'] })
  })

  it('will not issue a malformed license', () => {
    expect(() => issueLicense(license({ expiry: '2026-01-01T00:00:00.000Z' }), vendorKey)).toThrow(/expiry must be after issued/)
    expect(() => issueLicense(license({ features: ['guide', 'guide'] }), vendorKey)).toThrow(/features repeat/)
    expect(() => issueLicense(license({ id: 'Not A Slug' }), vendorKey)).toThrow()
    expect(() => issueLicense(license({ deviceId: 'abc' }), vendorKey)).toThrow()
  })

  it('reads a missing file as missing', async () => {
    expect((await readLicense(path.join(tmp, 'none.ofalicense'), { trustedKeys })).status).toBe('missing')
  })

  it('keeps license keys apart from pack keys', () => {
    const packIds = new Set(TRUSTED_PACK_KEYS.map((k) => k.keyId))
    expect(TRUSTED_LICENSE_KEYS.length).toBeGreaterThan(0)
    expect(TRUSTED_LICENSE_KEYS.some((k) => packIds.has(k.keyId))).toBe(false)
  })
})

describe('device id', () => {
  it('is a short stable hash of the hardware UUID', () => {
    const uuid = '12345678-9ABC-DEF0-1234-56789ABCDEF0'
    expect(deviceIdFrom(uuid)).toMatch(DEVICE_ID)
    expect(deviceIdFrom(uuid.toLowerCase())).toBe(deviceIdFrom(uuid))
    expect(deviceIdFrom(uuid)).not.toContain('1234')
  })

  it.runIf(process.platform === 'darwin')('reads IOPlatformUUID from ioreg', async () => {
    const uuid = '12345678-9ABC-DEF0-1234-56789ABCDEF0'
    const run: Run = async () => ({ code: 0, stdout: `  "IOPlatformSerialNumber" = "X"\n  "IOPlatformUUID" = "${uuid}"\n`, stderr: '' })
    expect(await deviceId(run)).toBe(deviceIdFrom(uuid))
    expect(await deviceId(async () => ({ code: 1, stdout: '', stderr: '' }))).toBeUndefined()
  })
})

describe('config', () => {
  it('logs metadata only unless OFA_LOG_TRANSCRIPTS=1', () => {
    expect(loadConfig({}).logTranscripts).toBe(false)
    expect(loadConfig({ OFA_LOG_TRANSCRIPTS: '1' }).logTranscripts).toBe(true)
    expect(loadConfig({ OFA_LOG_TRANSCRIPTS: '0' }).logTranscripts).toBe(false)
    expect(() => loadConfig({ OFA_LOG_TRANSCRIPTS: 'yes please' })).toThrow(/must be 1 or 0/)
  })
})
