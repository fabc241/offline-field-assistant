/**
 * The log key: 256 random bits, kept by the operating system, never in the
 * app's files. The CLI keeps it in the macOS Keychain, the Electron app with
 * safeStorage (an encrypted file whose key is in the Keychain). Deleting it
 * makes every log line written with it unreadable, which is how `ofa logs
 * wipe` erases lines the disk might still hold.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { run, type Run } from './exec.js'

export const LOG_KEY_BYTES = 32

/** Somewhere the operating system keeps one secret for this user. */
export interface SecretVault {
  /** For messages, e.g. "macOS Keychain (Offline Field Assistant / log-key)". */
  readonly name: string
  read(): Promise<Buffer | undefined>
  /** Stores `secret` unless one is already there; false when there was one. */
  add(secret: Buffer): Promise<boolean>
  delete(): Promise<void>
}

export interface LogKey {
  /** First 16 hex digits of a hash of the key: names it in log lines without revealing it. */
  id: string
  key: Buffer
}

export const logKeyId = (key: Buffer) => createHash('sha256').update('ofa-log-key-id\n').update(key).digest('hex').slice(0, 16)

export class KeyProvider {
  constructor(
    private readonly vault: SecretVault,
    private readonly random: (n: number) => Buffer = randomBytes
  ) {}

  get name(): string {
    return this.vault.name
  }

  /** The log key, made on first use. */
  async logKey(): Promise<LogKey> {
    const existing = await this.existingLogKey()
    if (existing) return existing
    // Another process may add one first: then everyone uses that one.
    await this.vault.add(this.random(LOG_KEY_BYTES))
    const key = await this.existingLogKey()
    if (!key) throw new Error(`${this.vault.name} did not keep the log key`)
    return key
  }

  async existingLogKey(): Promise<LogKey | undefined> {
    const key = await this.vault.read()
    if (!key) return undefined
    if (key.length !== LOG_KEY_BYTES) throw new Error(`The log key in ${this.vault.name} is ${key.length} bytes, not ${LOG_KEY_BYTES}`)
    return { id: logKeyId(key), key }
  }

  deleteLogKey(): Promise<void> {
    return this.vault.delete()
  }
}

/** `security` exit codes: the low byte of the OSStatus. */
const SEC_ITEM_NOT_FOUND = 44 // errSecItemNotFound (-25300)
const SEC_DUPLICATE_ITEM = 45 // errSecDuplicateItem (-25299)

const ARG = /^[A-Za-z0-9 ._-]{1,64}$/

/**
 * A generic password in the login Keychain, through `/usr/bin/security`. The
 * secret goes in through stdin (`security -i`), never on a command line other
 * processes could read.
 */
export function keychainVault(opts: { service: string; account?: string; run?: Run }): SecretVault {
  const { service, account = 'log-key', run: exec = run } = opts
  if (!ARG.test(service) || !ARG.test(account)) throw new Error(`Keychain service and account must be plain words, got "${service}" / "${account}"`)
  const name = `macOS Keychain (${service} / ${account})`
  const fail = (what: string, r: { code: number; stderr: string }) =>
    new Error(`${name}: cannot ${what} (security exit ${r.code}: ${r.stderr.trim() || 'no message'})`)
  return {
    name,
    async read() {
      const r = await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'])
      if (r.code === SEC_ITEM_NOT_FOUND) return undefined
      if (r.code !== 0) throw fail('read the log key', r)
      return decodeSecret(r.stdout.trim(), name)
    },
    async add(secret) {
      const command = `add-generic-password -s "${service}" -a "${account}" -l "${service}" -w ${secret.toString('base64')}\n`
      const r = await exec('/usr/bin/security', ['-i'], command)
      if (r.code === SEC_DUPLICATE_ITEM) return false
      if (r.code !== 0) throw fail('store the log key', r)
      return true
    },
    async delete() {
      const r = await exec('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account])
      if (r.code !== 0 && r.code !== SEC_ITEM_NOT_FOUND) throw fail('delete the log key', r)
    }
  }
}

/** The part of Electron's `safeStorage` the vault uses. */
export interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** A file encrypted with Electron's safeStorage, e.g. in `app.getPath('userData')`. */
export function safeStorageVault(opts: { safeStorage: SafeStorage; file: string }): SecretVault {
  const { safeStorage, file } = opts
  const name = `Electron safeStorage (${file})`
  const available = () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`${name}: encryption is not available on this system`)
  }
  return {
    name,
    async read() {
      const encrypted = await fs.readFile(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined
        throw err
      })
      if (!encrypted) return undefined
      available()
      return decodeSecret(safeStorage.decryptString(encrypted), name)
    },
    async add(secret) {
      available()
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      try {
        // "wx": a key already there is never replaced.
        await fs.writeFile(file, safeStorage.encryptString(secret.toString('base64')), { flag: 'wx', mode: 0o600 })
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      }
    },
    async delete() {
      await fs.rm(file, { force: true })
    }
  }
}

function decodeSecret(base64: string, vault: string): Buffer {
  const secret = Buffer.from(base64, 'base64')
  if (secret.toString('base64') !== base64) throw new Error(`${vault} holds something that is not a log key`)
  return secret
}
