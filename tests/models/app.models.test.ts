/**
 * F10 against the real models: the Electron main process (dev build, not
 * packaged) runs any ofa command in-process, and its IPC smoke suite passes
 * end to end through the hidden window (page → preload → ipcMain → services).
 *
 * Uses a scratch app home with the dev license and the installed sample pack,
 * the project's models, and a scratch Keychain item for the log key (deleted
 * after). Needs var/license/dev.ofalicense and an installed pack (var/packs).
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SmokeReport } from '../../src/app/smoke.js'
import { PROJECT_ROOT } from '../../src/core/config.js'
import { keychainVault } from '../../src/features/platform/keys.js'
import { buildElectron } from '../../scripts/build-electron.js'

const exec = promisify(execFile)
const electron = path.join(PROJECT_ROOT, 'node_modules/.bin/electron')
const service = `OFA test ${randomBytes(4).toString('hex')}`
let home: string
let env: NodeJS.ProcessEnv

const run = (args: string[]) => exec(electron, ['.', ...args], { cwd: PROJECT_ROOT, env, maxBuffer: 32 * 1024 * 1024 })

beforeAll(async () => {
  await buildElectron()
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-app-home-'))
  env = { ...process.env, OFA_HOME: home, OFA_MODELS_DIR: path.join(PROJECT_ROOT, 'models'), OFA_KEY_STORE: 'keychain', OFA_KEYCHAIN_SERVICE: service }
  for (const k of ['OFA_PACKS_DIR', 'OFA_LOG_DIR', 'OFA_LICENSE', 'OFA_LOG_TRANSCRIPTS']) delete env[k]
}, 60_000)

afterAll(async () => {
  await keychainVault({ service }).delete()
  await fs.rm(home, { recursive: true, force: true })
})

describe('Electron app', { timeout: 600_000 }, () => {
  it('runs ofa commands in-process against its own home', async () => {
    await run(['ofa', 'license', 'install', path.join(PROJECT_ROOT, 'var/license/dev.ofalicense')])
    const packs = path.join(PROJECT_ROOT, 'var/packs')
    const pack = (await fs.readdir(packs)).find((f) => f.endsWith('.ofapack'))!
    await run(['ofa', 'pack', 'install', path.join(packs, pack)])
    const { stdout } = await run(['ofa', 'doctor'])
    expect(stdout).toContain('All checks passed.')
    expect(stdout).toContain(`Activity log    ✓ ${path.join(home, 'logs')}`)
  })

  it('passes the IPC smoke suite in the hidden window', async () => {
    const out = path.join(home, 'smoke.json')
    await run(['--ipc-smoke', '--fixtures', path.join(PROJECT_ROOT, 'tests/fixtures'), '--out', out]).catch((err) => err)
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as SmokeReport
    expect(report.steps.filter((s) => !s.ok)).toEqual([])
    expect(report.passed).toBeGreaterThanOrEqual(25)
  })
})
