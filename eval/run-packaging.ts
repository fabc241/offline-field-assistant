/**
 * F10 eval: the packaged app, the model pack and the release gate, on this Mac.
 *
 *   npm run eval:packaging [-- --no-package]
 *
 * - Package: npm run package (arm64, Forge + QVAC plugin, signed inside out
 *   with the hardened runtime; ad hoc here, no Developer ID on this Mac).
 *   Sizes, signing counts, entitlements, Gatekeeper's verdict.
 * - Release policy: `package:release` must refuse this tree (no Developer ID,
 *   no notary profile, development keys).
 * - Model pack: built from models/ (APFS clones), signed with the dev pack
 *   key, verified (every file hashed); times and size.
 * - Model pack refusals at full size, through the installer: one byte changed
 *   in a model file after signing (caught while copying; the installed
 *   models stay as they were), the manifest edited, an unknown signing key,
 *   an older version over a newer one. Then a reinstall of the same pack
 *   (nothing to copy).
 * - Release gate: scripts/release-gate.sh on a kit in var/release-kit, with
 *   a scratch app home and a scratch Keychain item (ad hoc builds are a new
 *   code identity each time, so safeStorage would make macOS ask). Installs
 *   the app from its zip, then the license, the model pack (4.4 GB copied and
 *   hashed) and the content pack through the app's own binary, runs
 *   `ofa doctor --verify --load` and the IPC smoke suite; sockets watched.
 *
 * Writes eval/outputs/packaging-summary.json. The gate's scratch home is
 * deleted at the end; the kit stays in var/release-kit.
 */
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs, promisify } from 'node:util'
import { releaseProblems } from '../src/app/release-policy.js'
import { ALL_MODEL_NAMES } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { sdkVersion } from '../src/core/qvac.js'
import { FILES_DIR, buildModelPack, installModelPack, signModelPack, verifyModelPack } from '../src/features/models/model-pack.js'
import { PackError } from '../src/features/packs/loader.js'
import { canonicalJson } from '../src/features/packs/manifest.js'
import { generateSigningKey, loadPrivateKey } from '../src/features/packs/signing.js'
import { TRUSTED_PACK_KEYS } from '../src/features/packs/trusted-keys.js'
import { TRUSTED_LICENSE_KEYS } from '../src/features/platform/license-keys.js'
import { round } from './stats.js'

const { values } = parseArgs({ options: { 'no-package': { type: 'boolean', default: false } } })
const exec = promisify(execFile)
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
const kit = path.join(PROJECT_ROOT, 'var/release-kit')
const reportDir = path.join(PROJECT_ROOT, 'var/release-kit-report')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-eval-packaging-'))
const s = (t0: number) => round((performance.now() - t0) / 1000, 1)
const GB = 1024 ** 3
const devPackKey = path.join(PROJECT_ROOT, 'keys/ofa-dev-2026.key.pem')

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; echo?: boolean } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: PROJECT_ROOT, env: opts.env ?? process.env })
    let out = ''
    const take = (d: Buffer) => {
      out += d
      if (opts.echo) process.stdout.write(d)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'accepted'
  } catch (err) {
    return err instanceof PackError ? err.problem : `error: ${(err as Error).message}`
  }
}

try {
  // ── Package ────────────────────────────────────────────────────────────
  console.log('Packaging …')
  let t0 = performance.now()
  if (!values['no-package']) {
    const r = await run('npx', ['tsx', 'scripts/package.ts'])
    if (r.code !== 0) throw new Error(`npm run package failed:\n${r.out}`)
  }
  const packageMs = s(t0)
  const packaged = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'out/package-report.json'), 'utf8'))
  console.log(`  ${(packaged.appBytes / 1024 ** 2).toFixed(0)} MB app, ${packaged.signed.files} Mach-O files signed`)

  // ── Release policy ─────────────────────────────────────────────────────
  const policy = releaseProblems({ identity: process.env.OFA_SIGN_IDENTITY, notaryProfile: process.env.OFA_NOTARY_PROFILE, packKeys: TRUSTED_PACK_KEYS, licenseKeys: TRUSTED_LICENSE_KEYS })
  const releaseRun = await run('npx', ['tsx', 'scripts/package.ts', '--release'])
  console.log(`Release build refused: ${releaseRun.code !== 0} (${policy.length} problems)`)

  // ── Model pack: build, sign, verify ────────────────────────────────────
  console.log('Model pack …')
  await fs.rm(kit, { recursive: true, force: true })
  await fs.mkdir(kit, { recursive: true })
  const models = path.join(kit, 'models')
  t0 = performance.now()
  const manifest = await buildModelPack({
    modelsDir: path.join(PROJECT_ROOT, 'models'),
    outDir: models,
    names: ALL_MODEL_NAMES,
    id: 'ofa-models',
    title: 'Offline Field Assistant models (development)',
    version: '1.0.0',
    sdkVersion: await sdkVersion()
  })
  const buildS = s(t0)
  t0 = performance.now()
  await signModelPack(models, loadPrivateKey(await fs.readFile(devPackKey, 'utf8')))
  const signS = s(t0)
  t0 = performance.now()
  const verified = await verifyModelPack(models, TRUSTED_PACK_KEYS)
  const verifyS = s(t0)
  const packBytes = manifest.models.reduce((n, m) => n + m.size, 0)
  console.log(`  ${(packBytes / GB).toFixed(2)} GB, ${manifest.models.length} models; build ${buildS} s, sign ${signS} s, verify ${verifyS} s`)

  // ── Model pack refusals at full size ───────────────────────────────────
  console.log('Model pack refusals …')
  const target = path.join(tmp, 'installed')
  t0 = performance.now()
  const first = await installModelPack(models, target, { trustedKeys: TRUSTED_PACK_KEYS })
  const installS = s(t0)
  t0 = performance.now()
  const again = await installModelPack(models, target, { trustedKeys: TRUSTED_PACK_KEYS })
  const reinstallS = s(t0)

  /** A clone of the pack (copy-on-write), changed by `edit`. */
  const variant = async (name: string, edit: (dir: string) => Promise<void>) => {
    const dir = path.join(tmp, name)
    await exec('/bin/cp', ['-c', '-R', models, dir])
    await edit(dir)
    return dir
  }
  const largest = [...manifest.models].sort((a, b) => b.size - a.size)[0]!
  const flipped = await variant('flipped', async (dir) => {
    // Middle of the largest file, same size: only hashing during the copy finds it.
    const file = path.join(dir, FILES_DIR, largest.file)
    await fs.rm(file)
    await fs.copyFile(path.join(models, FILES_DIR, largest.file), file, constants.COPYFILE_FICLONE)
    const fh = await fs.open(file, 'r+')
    const at = Math.floor(largest.size / 2)
    const { buffer } = await fh.read(Buffer.alloc(1), 0, 1, at)
    await fh.write(Buffer.from([buffer[0]! ^ 0x01]), 0, 1, at)
    await fh.close()
  })
  // Over the installed models the changed file would be skipped (the device's copy already matches
  // the signed hash), so install where it must be copied: a fresh device, and one with a 0.9.0 model
  // pack whose Whisper file differs.
  t0 = performance.now()
  const fresh = path.join(tmp, 'fresh-device')
  const flippedResult = await refusal(installModelPack(flipped, fresh, { trustedKeys: TRUSTED_PACK_KEYS }))
  const flippedS = s(t0)
  const freshLeft = await fs.readdir(fresh).catch(() => [] as string[])
  const manifestBefore = await fs.readFile(path.join(target, 'manifest.json'), 'utf8')
  const whisper = path.join(target, largest.file)
  const fh = await fs.open(whisper, 'r+')
  await fh.write(Buffer.from('older model'), 0, 11, 0)
  await fh.close()
  const flippedOver = await refusal(installModelPack(flipped, target, { trustedKeys: TRUSTED_PACK_KEYS }))
  const untouched =
    (await fs.readFile(path.join(target, 'manifest.json'), 'utf8')) === manifestBefore &&
    (await fs.readFile(whisper)).subarray(0, 11).toString() === 'older model' &&
    !(await fs.readdir(target)).includes('.incoming')
  const edited = await variant('edited', async (dir) => {
    const f = path.join(dir, 'manifest.json')
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('"version": "1.0.0"', '"version": "1.0.1"'))
  })
  const foreign = await variant('foreign', async (dir) => {
    await signModelPack(dir, loadPrivateKey(generateSigningKey().privateKeyPem))
  })
  const older = await variant('older', async (dir) => {
    const f = path.join(dir, 'manifest.json')
    const m = JSON.parse(await fs.readFile(f, 'utf8'))
    m.version = '0.9.0'
    await fs.writeFile(f, canonicalJson(m))
    await signModelPack(dir, loadPrivateKey(await fs.readFile(devPackKey, 'utf8')))
  })
  const refusals = {
    byteFlippedInLargestModel: {
      model: largest.name,
      freshDevice: { result: flippedResult, seconds: flippedS, filesLeft: freshLeft },
      overInstalledModels: { result: flippedOver, installedModelsUnchanged: untouched }
    },
    manifestEdited: await refusal(installModelPack(edited, target, { trustedKeys: TRUSTED_PACK_KEYS })),
    unknownKey: await refusal(installModelPack(foreign, target, { trustedKeys: TRUSTED_PACK_KEYS })),
    olderVersion: await refusal(installModelPack(older, target, { trustedKeys: TRUSTED_PACK_KEYS }))
  }
  console.log(`  ${JSON.stringify(refusals)}`)
  await fs.rm(path.join(tmp, 'installed'), { recursive: true, force: true })

  // ── Release gate ───────────────────────────────────────────────────────
  console.log('Release gate …')
  await fs.copyFile(path.join(PROJECT_ROOT, packaged.zip), path.join(kit, path.basename(packaged.zip)), constants.COPYFILE_FICLONE)
  const config = loadConfig({})
  const installedPack = (await fs.readdir(config.packsDir)).find((f) => f.endsWith('.ofapack'))
  if (!installedPack) throw new Error(`No content pack in ${config.packsDir}`)
  await fs.copyFile(path.join(config.packsDir, installedPack), path.join(kit, installedPack))
  await fs.copyFile(path.join(PROJECT_ROOT, 'var/license/dev.ofalicense'), path.join(kit, 'dev.ofalicense'))
  await fs.cp(path.join(PROJECT_ROOT, 'tests/fixtures'), path.join(kit, 'fixtures'), { recursive: true })
  await fs.copyFile(path.join(PROJECT_ROOT, 'scripts/release-gate.sh'), path.join(kit, 'release-gate.sh'))
  await fs.rm(reportDir, { recursive: true, force: true })
  const home = path.join(tmp, 'app-home')
  t0 = performance.now()
  const gate = await run(path.join(kit, 'release-gate.sh'), [kit, '--home', home, '--key-store', 'keychain', '--out', reportDir], { echo: true })
  const gateS = s(t0)
  const steps = (await fs.readFile(path.join(reportDir, 'steps.tsv'), 'utf8'))
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => {
      const [step, exit, ms, sockets] = l.split('\t')
      return { step, exit: Number(exit), seconds: round(Number(ms) / 1000, 1), sockets: Number(sockets) }
    })
  const env = Object.fromEntries((await fs.readFile(path.join(reportDir, 'gate.env'), 'utf8')).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
  const smoke = JSON.parse(await fs.readFile(path.join(reportDir, 'smoke.json'), 'utf8').catch(() => '{}'))
  const doctorLog = await fs.readFile(path.join(reportDir, 'doctor.log'), 'utf8')
  const loads = Object.fromEntries([...doctorLog.matchAll(/✓ (\S+)\s+loaded in ([\d.]+) s/g)].map((m) => [m[1], Number(m[2])]))
  const homeBytes = Number((await exec('/usr/bin/du', ['-sk', home])).stdout.split('\t')[0]) * 1024

  const summary = {
    when: new Date().toISOString(),
    machine: `${os.cpus()[0]?.model}, ${round(os.totalmem() / GB, 0)} GB, macOS ${(await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim()}`,
    package: { ...packaged, wallSeconds: packageMs },
    releasePolicy: { refused: releaseRun.code !== 0, problems: policy },
    modelPack: {
      id: verified.manifest.id,
      version: verified.manifest.version,
      models: manifest.models.length,
      gb: round(packBytes / GB, 2),
      signedBy: verified.signedBy,
      seconds: { build: buildS, sign: signS, verify: verifyS, installFresh: installS, reinstallSame: reinstallS },
      fresh: { copied: first.copied.length, gbPerSecond: round(first.bytesCopied / GB / installS, 2) },
      reinstall: { copied: again.copied.length, kept: again.kept.length },
      refusals
    },
    gate: {
      exit: gate.code,
      seconds: gateS,
      ...env,
      steps,
      appHomeGb: round(homeBytes / GB, 2),
      doctorLoadSeconds: loads,
      smoke: { ok: smoke.ok, passed: smoke.passed, failed: smoke.failed, seconds: round((smoke.totalMs ?? 0) / 1000, 1), steps: smoke.steps }
    }
  }
  await fs.writeFile(path.join(outDir, 'packaging-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`\nGate ${gate.code === 0 ? 'PASSED' : 'FAILED'} in ${gateS} s → eval/outputs/packaging-summary.json`)
  process.exitCode = gate.code === 0 ? 0 : 1
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
