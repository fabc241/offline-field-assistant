/**
 * F9 against the real key stores of this Mac (no models needed): the macOS
 * Keychain through /usr/bin/security, and Electron's safeStorage in separate
 * app launches. Each test uses its own Keychain item and deletes it after.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../../src/core/config.js'
import { DEVICE_ID, deviceId } from '../../src/features/platform/device.js'
import { KeyProvider, keychainVault } from '../../src/features/platform/keys.js'
import { SecureLog } from '../../src/features/platform/secure-log.js'

const mac = process.platform === 'darwin'
const service = `OFA test ${randomBytes(4).toString('hex')}`
const vault = mac ? keychainVault({ service }) : undefined
let tmp: string | undefined

afterAll(async () => {
  await vault?.delete()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

describe.runIf(mac)('macOS Keychain', { timeout: 30_000 }, () => {
  it('makes the log key once, finds it again from a new provider, and deletes it', async () => {
    const key = await new KeyProvider(vault!).logKey()
    const again = await new KeyProvider(keychainVault({ service })).existingLogKey()
    expect(again?.key.equals(key.key)).toBe(true)
    // Racing a second maker changes nothing.
    const [a, b] = await Promise.all([new KeyProvider(vault!).logKey(), new KeyProvider(keychainVault({ service })).logKey()])
    expect(a.id).toBe(key.id)
    expect(b.id).toBe(key.id)
    await vault!.delete()
    expect(await new KeyProvider(vault!).existingLogKey()).toBeUndefined()
  })

  it('encrypts a log another process can read with the same Keychain item', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-platform-'))
    await new SecureLog(tmp, new KeyProvider(vault!)).append({ hello: 'keychain' })
    const read = await new SecureLog(tmp, new KeyProvider(keychainVault({ service }))).read()
    expect(read.problems).toEqual([])
    expect(read.entries.map((e) => e.record)).toEqual([{ hello: 'keychain' }])
  })

  it('reads a stable device id', async () => {
    const id = await deviceId()
    expect(id).toMatch(DEVICE_ID)
    expect(await deviceId()).toBe(id)
  })
})

describe.runIf(mac)('Electron safeStorage', { timeout: 120_000 }, () => {
  const electron = path.join(PROJECT_ROOT, 'node_modules/.bin/electron')
  const launch = async (dir: string, phase: string) => {
    const { stdout } = await promisify(execFile)(electron, [path.join(PROJECT_ROOT, 'electron/key-check.ts'), dir, phase], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_OPTIONS: '--import tsx' }
    })
    return JSON.parse(stdout.trim().split('\n').at(-1)!)
  }

  it('keeps the log key across app launches and wipes it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-electron-key-'))
    try {
      const write = await launch(dir, 'write')
      expect(write.available).toBe(true)
      const read = await launch(dir, 'read')
      expect(read.pid).not.toBe(write.pid)
      expect(read.keyId).toBe(write.keyId)
      expect(read.problems).toEqual([])
      expect(read.records).toEqual([0, 1, 2].map((i) => ({ check: 'electron', i })))
      const raw = await fs.readFile(path.join(dir, 'log-key.bin'))
      expect(raw.length).toBeGreaterThan(32)
      const wipe = await launch(dir, 'wipe')
      expect(wipe).toMatchObject({ wiped: { files: 1 }, keyAfter: null })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
