/**
 * F9 check of the Electron key path: the log key kept with safeStorage, used
 * by the encrypted log, across separate launches of the app.
 *
 *   NODE_OPTIONS="--import tsx" electron electron/key-check.ts DIR write|read|wipe
 *
 * DIR holds the encrypted key file and the log. Prints one JSON line.
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { KeyProvider, safeStorageVault } from '../src/features/platform/keys.js'
import { SecureLog } from '../src/features/platform/secure-log.js'

app.dock?.hide()

async function main() {
  const [dir, phase] = process.argv.slice(-2)
  if (!dir || !['write', 'read', 'wipe'].includes(phase!)) throw new Error('usage: key-check.ts DIR write|read|wipe')
  const keys = new KeyProvider(safeStorageVault({ safeStorage, file: path.join(dir, 'log-key.bin') }))
  const log = new SecureLog(path.join(dir, 'logs'), keys)
  const t0 = performance.now()
  if (phase === 'write') {
    const key = await keys.logKey()
    const keyMs = performance.now() - t0
    for (let i = 0; i < 3; i++) await log.append({ check: 'electron', i })
    return { phase, available: safeStorage.isEncryptionAvailable(), keyId: key.id, keyMs, pid: process.pid }
  }
  if (phase === 'read') {
    const read = await log.read()
    return { phase, keyId: read.keyId, records: read.entries.map((e) => e.record), problems: read.problems, readMs: performance.now() - t0, pid: process.pid }
  }
  const wiped = await log.wipe()
  return { phase, wiped, keyAfter: (await keys.existingLogKey())?.id ?? null }
}

app
  .whenReady()
  .then(main)
  .then((result) => {
    console.log(JSON.stringify({ electron: process.versions.electron, ...result }))
    app.exit(0)
  })
  .catch((err) => {
    console.error('[key-check] FAILED:', err)
    app.exit(1)
  })
