/**
 * F9 eval: the key stores, the encrypted log and the license, measured on
 * this Mac, plus an end-to-end check that the real CLI logs metadata only.
 *
 *   npm run eval:platform [-- --no-cli]
 *
 * - Key stores: Keychain create/read times through /usr/bin/security;
 *   Electron safeStorage across three separate app launches.
 * - Log: append and read-and-verify speed on 10,000 activity records, bytes
 *   per line.
 * - Tamper sweep: every bit of every byte of a 3-day log flipped in turn; the
 *   target is that no flip reads back without a problem. Then deliberate
 *   edits: lines deleted, duplicated, swapped, moved between days, replayed
 *   from an old key, cut off at the end, a whole day deleted.
 * - License: check time; every bit of a license file flipped; one scenario per
 *   status (valid, expired, missing, forged, edited, wrong device, a pack
 *   signature passed off as a license) with the features each one opens.
 * - CLI (real models, needs the dev license key keys/ofa-license-dev-2026.key.pem):
 *   translate, stt, speak, converse, guide, phrase search and doc read run as
 *   separate processes against a scratch log, Keychain item and license. The
 *   decrypted log must hold none of the words people said, typed, read or
 *   heard (metadata only), and the raw files nothing readable; with
 *   OFA_LOG_TRANSCRIPTS=1 the text must be there, and still not in the raw
 *   files. Then an expired license: translate refused, the guide still works.
 *   Then `logs wipe`.
 *
 * Writes eval/outputs/platform-summary.json. The scratch Keychain items are
 * deleted at the end.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs, promisify } from 'node:util'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { canonicalJson } from '../src/features/packs/manifest.js'
import { generateSigningKey, loadPrivateKey, signManifest, trustedKey } from '../src/features/packs/signing.js'
import { ActivityLog, type ActivityInput } from '../src/features/platform/activity.js'
import { deviceId, deviceIdFrom } from '../src/features/platform/device.js'
import { KeyProvider, keychainVault, type SecretVault } from '../src/features/platform/keys.js'
import { LICENSE_FEATURES, allows, checkLicense, issueLicense, type License } from '../src/features/platform/license.js'
import { SecureLog, type LogProblemKind } from '../src/features/platform/secure-log.js'
import { openSession } from '../src/cli/session.js'
import { quantile, round } from './stats.js'

const { values } = parseArgs({ options: { 'no-cli': { type: 'boolean', default: false } } })
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-eval-platform-'))
const exec = promisify(execFile)
const ms = (t0: number) => performance.now() - t0
const stats = (xs: number[]) => ({ median: round(quantile(xs, 0.5), 3), p99: round(quantile(xs, 0.99), 3), max: round(Math.max(...xs), 3) })
const scratchServices: string[] = []
const scratchVault = () => {
  const service = `OFA eval ${randomBytes(4).toString('hex')}`
  scratchServices.push(service)
  return { service, vault: keychainVault({ service }) }
}

class MemoryVault implements SecretVault {
  name = 'memory'
  secret: Buffer | undefined
  async read() {
    return this.secret
  }
  async add(secret: Buffer) {
    if (this.secret) return false
    this.secret = secret
    return true
  }
  async delete() {
    this.secret = undefined
  }
}

try {
  // ── Key stores ──────────────────────────────────────────────────────────
  console.log('Keychain …')
  const { vault } = scratchVault()
  let t0 = performance.now()
  const made = await new KeyProvider(vault).logKey()
  const createMs = ms(t0)
  const readMs: number[] = []
  for (let i = 0; i < 20; i++) {
    t0 = performance.now()
    const k = await new KeyProvider(vault).existingLogKey()
    readMs.push(ms(t0))
    if (!k?.key.equals(made.key)) throw new Error('Keychain returned another key')
  }
  await vault.delete()
  const keychain = { createMs: round(createMs, 1), readMs: stats(readMs) }

  console.log('Electron safeStorage …')
  const electronDir = path.join(tmp, 'electron')
  const electronRuns: Record<string, unknown>[] = []
  for (const phase of ['write', 'read', 'wipe']) {
    t0 = performance.now()
    const { stdout } = await exec(path.join(PROJECT_ROOT, 'node_modules/.bin/electron'), [path.join(PROJECT_ROOT, 'electron/key-check.ts'), electronDir, phase], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NODE_OPTIONS: '--import tsx' }
    })
    electronRuns.push({ ...JSON.parse(stdout.trim().split('\n').at(-1)!), launchMs: Math.round(ms(t0)) })
  }
  const [ew, er, ex] = electronRuns as [{ keyId: string; keyMs: number; launchMs: number; available: boolean; electron: string }, { keyId: string; problems: unknown[]; records: unknown[]; launchMs: number }, { keyAfter: unknown; launchMs: number }]
  const electron = {
    version: ew.electron,
    available: ew.available,
    keyMs: round(ew.keyMs, 1),
    sameKeyNextLaunch: er.keyId === ew.keyId,
    recordsReadBack: er.records.length,
    problems: er.problems.length,
    wipedKey: ex.keyAfter === null,
    launchMs: [ew.launchMs, er.launchMs, ex.launchMs]
  }

  // ── Log speed ───────────────────────────────────────────────────────────
  console.log('Log speed …')
  const speedLog = new SecureLog(path.join(tmp, 'speed'), new KeyProvider(new MemoryVault()))
  const activity = new ActivityLog(speedLog, { app: '0.1.0', sdk: '0.21.0', onError: (e) => { throw e } })
  const sample: ActivityInput = {
    feature: 'conversation',
    action: 'turn',
    outcome: 'ok',
    langs: { from: 'sw', to: 'en' },
    timings: { utteranceMs: 4120, sttMs: 812, translateMs: 1460, firstAudioMs: 3105, speechDoneMs: 6012, checkDoneMs: 4380, totalMs: 6020 },
    detail: { side: 'patient' },
    flags: ['low-fidelity'],
    models: ['EMBEDDINGGEMMA_300M_Q8_0@a0f7b4e13c39', 'TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M@fc2a80532e58', 'TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0@0123456789ab', 'TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0@0123456789ab', 'WHISPER_LARGE_V3_TURBO@0123456789ab']
  }
  const appendMs: number[] = []
  const N = 10_000
  for (let i = 0; i < N; i++) {
    t0 = performance.now()
    await activity.record(sample)
    appendMs.push(ms(t0))
  }
  const [speedFile] = await speedLog.files()
  t0 = performance.now()
  const speedRead = await speedLog.read()
  const readAllMs = ms(t0)
  if (speedRead.entries.length !== N || speedRead.problems.length) throw new Error('Speed log did not read back cleanly')
  const log = {
    records: N,
    appendMs: stats(appendMs),
    bytesPerLine: Math.round(speedFile!.bytes / N),
    plaintextBytesPerRecord: JSON.stringify(speedRead.entries[0]!.record).length,
    readAndVerifyMs: Math.round(readAllMs),
    readPerLineUs: round((readAllMs * 1000) / N, 1)
  }

  // ── Tamper sweep ────────────────────────────────────────────────────────
  console.log('Log tamper sweep …')
  let clockMs = Date.parse('2026-10-13T09:00:00Z')
  const sweepKeys = new KeyProvider(new MemoryVault())
  const sweepLog = new SecureLog(path.join(tmp, 'sweep'), sweepKeys, { now: () => new Date(clockMs) })
  const sweepActivity = new ActivityLog(sweepLog, { app: '0.1.0', sdk: '0.21.0' })
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 4; i++) {
      await sweepActivity.record({ ...sample, counts: { turn: i } })
      clockMs += 60_000
    }
    clockMs += 86_400_000
  }
  const sweepFiles = await sweepLog.files()
  const originals = await Promise.all(sweepFiles.map((f) => fs.readFile(f.file)))
  const flipProblems: Partial<Record<LogProblemKind, number>> = {}
  let flips = 0
  let silent = 0
  for (const [fi, f] of sweepFiles.entries()) {
    const original = originals[fi]!
    for (let i = 0; i < original.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const copy = Buffer.from(original)
        copy[i]! ^= 1 << bit
        await fs.writeFile(f.file, copy)
        const read = await sweepLog.read()
        flips++
        if (!read.problems.length) silent++
        const first = read.problems[0]?.problem
        if (first) flipProblems[first] = (flipProblems[first] ?? 0) + 1
      }
    }
    await fs.writeFile(f.file, original)
  }
  if ((await sweepLog.read()).problems.length) throw new Error('Sweep log not restored')

  // Deliberate edits, each on a fresh copy of the 3-day log.
  const lines = originals.map((b) => b.toString('utf8').trimEnd().split('\n'))
  const put = async (edited: string[][]) => {
    for (const [fi, f] of sweepFiles.entries()) {
      const ls = edited[fi]!
      if (ls.length) await fs.writeFile(f.file, ls.join('\n') + '\n')
      else await fs.rm(f.file, { force: true })
    }
  }
  const oldKeyLine = await (async () => {
    const other = new SecureLog(path.join(tmp, 'other'), new KeyProvider(new MemoryVault()), { now: () => new Date('2026-10-13T09:00:00Z') })
    await other.append({ old: true })
    return (await fs.readFile((await other.files())[0]!.file, 'utf8')).trimEnd()
  })()
  const [d0, d1, d2] = lines as [string[], string[], string[]]
  const attacks: Record<string, string[][]> = {
    'delete a middle line': [[d0[0]!, d0[2]!, d0[3]!], d1, d2],
    'delete the first line of a day': [d0.slice(1), d1, d2],
    'duplicate a line': [[d0[0]!, d0[1]!, d0[1]!, d0[2]!, d0[3]!], d1, d2],
    'swap two lines': [[d0[0]!, d0[2]!, d0[1]!, d0[3]!], d1, d2],
    'move a line to the next day (same position)': [d0, [d0[0]!, ...d1.slice(1)], d2],
    'replay a line written with an old key': [[...d0, oldKeyLine], d1, d2],
    'append a line from another day': [[...d0, d1[3]!], d1, d2],
    'cut off the last line of a day (not detected)': [d0.slice(0, 3), d1, d2],
    'delete a whole day (not detected)': [d0, [], d2]
  }
  const attackResults = []
  for (const [name, edited] of Object.entries(attacks)) {
    await put(edited)
    const read = await sweepLog.read()
    attackResults.push({ attack: name, detected: read.problems.length > 0, problems: [...new Set(read.problems.map((p) => p.problem))] })
    await put(lines)
  }
  const tamper = {
    lines: lines.flat().length,
    bytes: originals.reduce((s, b) => s + b.length, 0),
    flips,
    silentlyAccepted: silent,
    firstProblem: flipProblems,
    attacks: attackResults
  }

  // ── License ─────────────────────────────────────────────────────────────
  console.log('License …')
  const vendor = generateSigningKey()
  const vendorKey = loadPrivateKey(vendor.privateKeyPem)
  const trustedKeys = [trustedKey('eval vendor', vendor.publicKeyPem)]
  const thisDevice = deviceIdFrom('EVAL-0000-0000-0000-000000000001')
  const now = new Date('2026-10-15T12:00:00Z')
  const base: License = {
    format: 1,
    kind: 'license',
    id: 'eval-clinic-001',
    licensee: 'Eval Clinic',
    seats: 500,
    issued: '2026-10-01T00:00:00.000Z',
    expiry: '2027-09-30T23:59:59.999Z',
    features: [...LICENSE_FEATURES]
  }
  const validText = issueLicense(base, vendorKey)
  const checkMs: number[] = []
  for (let i = 0; i < 1000; i++) {
    t0 = performance.now()
    checkLicense(validText, { trustedKeys, deviceId: thisDevice, now })
    checkMs.push(ms(t0))
  }
  const licenseBytes = Buffer.from(validText)
  let licenseFlips = 0
  let licenseAccepted = 0
  for (let i = 0; i < licenseBytes.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const copy = Buffer.from(licenseBytes)
      copy[i]! ^= 1 << bit
      licenseFlips++
      if (checkLicense(copy.toString('utf8'), { trustedKeys, deviceId: thisDevice, now }).status === 'valid') licenseAccepted++
    }
  }
  const forgedKey = loadPrivateKey(generateSigningKey().privateKeyPem)
  const forgedId = JSON.parse(issueLicense(base, forgedKey))
  forgedId.signature.keyId = trustedKeys[0]!.keyId
  const edited = JSON.parse(validText)
  edited.license.expiry = '2099-12-31T23:59:59.999Z'
  const scenarios: Record<string, { text: string | undefined; now?: Date; deviceId?: string }> = {
    valid: { text: validText },
    'expires in 10 days': { text: validText, now: new Date('2027-09-20T12:00:00Z') },
    expired: { text: validText, now: new Date('2027-10-01T00:00:00Z') },
    missing: { text: undefined },
    'signed by an untrusted key': { text: issueLicense(base, forgedKey) },
    'untrusted signature claiming the vendor key id': { text: canonicalJson(forgedId) },
    'expiry edited after signing': { text: canonicalJson(edited) },
    'reformatted (not canonical)': { text: JSON.stringify(JSON.parse(validText)) },
    'pack-style signature (no license domain)': {
      text: canonicalJson({ format: 1, license: base, signature: signManifest(Buffer.from(canonicalJson(base)), vendorKey) })
    },
    'bound to this device': { text: issueLicense({ ...base, deviceId: thisDevice }, vendorKey) },
    'bound to another device': { text: issueLicense({ ...base, deviceId: deviceIdFrom('EVAL-0000-0000-0000-000000000002') }, vendorKey) },
    'clock before issue date': { text: validText, now: new Date('2026-09-01T00:00:00Z') }
  }
  const licenseScenarios = Object.entries(scenarios).map(([name, s]) => {
    const state = checkLicense(s.text, { trustedKeys, deviceId: s.deviceId ?? thisDevice, now: s.now ?? now })
    return {
      scenario: name,
      status: state.status,
      ...(state.problem ? { problem: state.problem } : {}),
      mode: state.mode,
      warnings: state.warnings,
      features: LICENSE_FEATURES.filter((f) => allows(state, f))
    }
  })
  const license = {
    bytes: licenseBytes.length,
    checkMs: stats(checkMs),
    flips: licenseFlips,
    flipsAccepted: licenseAccepted,
    scenarios: licenseScenarios
  }

  // ── Start-up cost of the CLI session ────────────────────────────────────
  console.log('Start-up …')
  const startupMs: number[] = []
  const devMs: number[] = []
  for (let i = 0; i < 10; i++) {
    t0 = performance.now()
    await deviceId()
    devMs.push(ms(t0))
    t0 = performance.now()
    await openSession({ ...loadConfig(), licenseFile: path.join(tmp, 'none.ofalicense'), logDir: path.join(tmp, 'startup-logs') })
    startupMs.push(ms(t0))
  }
  const startup = { openSessionMs: stats(startupMs), deviceIdMs: stats(devMs), firstRecordAddsKeychainReadMs: keychain.readMs.median }

  // ── End to end through the CLI ──────────────────────────────────────────
  const devKeyFile = path.join(PROJECT_ROOT, 'keys/ofa-license-dev-2026.key.pem')
  const haveDevKey = await fs.stat(devKeyFile).then(() => true, () => false)
  const cli = values['no-cli'] ? { skipped: '--no-cli' } : !haveDevKey ? { skipped: `no ${path.relative(PROJECT_ROOT, devKeyFile)}` } : await runCli(devKeyFile)

  const summary = {
    date: new Date().toISOString().slice(0, 10),
    machine: `${os.cpus()[0]?.model} · ${Math.round(os.totalmem() / 1024 ** 3)} GB · ${os.platform()} ${os.release()}`,
    keychain,
    electron,
    log,
    tamper,
    license,
    startup,
    cli
  }
  await fs.writeFile(path.join(outDir, 'platform-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary, null, 2))
} finally {
  for (const service of scratchServices) await keychainVault({ service }).delete().catch(() => undefined)
  await fs.rm(tmp, { recursive: true, force: true })
}

/** Record fields the code fills with its own fixed names, never with input. */
function isNamedField(field: string): boolean {
  return /^(feature|action|outcome|reason|app|sdk|flags\.\d+|models\.\d+|detail\.[A-Za-z]+)$/.test(field)
}

/** Paths of the string fields of `records` that contain `word`, e.g. "detail.side". */
function fieldsWith(records: unknown[], word: string): string[] {
  const found = new Set<string>()
  const re = new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'iu')
  const walk = (v: unknown, at: string) => {
    if (typeof v === 'string') {
      if (re.test(v)) found.add(at)
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k)
    }
  }
  for (const r of records) walk(r, '')
  return [...found]
}

/** Runs the real CLI with a scratch log, Keychain item and license. */
async function runCli(devKeyFile: string) {
  const { service } = scratchVault()
  const dir = path.join(tmp, 'cli')
  const env = {
    ...process.env,
    OFA_LOG_DIR: path.join(dir, 'logs'),
    OFA_KEYCHAIN_SERVICE: service,
    OFA_LICENSE: path.join(dir, 'license', 'license.ofalicense'),
    OFA_LOG_TRANSCRIPTS: '0'
  }
  const ofa = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const t0 = performance.now()
    const r = await exec(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['src/cli/ofa.ts', ...args], {
      cwd: PROJECT_ROOT,
      env: { ...env, ...extraEnv },
      maxBuffer: 64 * 1024 * 1024
    }).then(
      (x) => ({ code: 0, stdout: x.stdout, stderr: x.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr })
    )
    return { ...r, wallMs: Math.round(ms(t0)) }
  }
  const exportLog = async () => {
    const r = await ofa(['logs', 'export'])
    return { text: r.stdout, records: r.stdout.trim() ? r.stdout.trim().split('\n').map((l) => JSON.parse(l)) : [], stderr: r.stderr, code: r.code }
  }
  const rawLog = async () => {
    const files = await fs.readdir(env.OFA_LOG_DIR).catch(() => [] as string[])
    return (await Promise.all(files.map((f) => fs.readFile(path.join(env.OFA_LOG_DIR, f), 'utf8')))).join('')
  }

  console.log('CLI: license …')
  const device = await deviceId()
  const key = loadPrivateKey(await fs.readFile(devKeyFile, 'utf8'))
  const licenseText = issueLicense(
    {
      format: 1,
      kind: 'license',
      id: 'eval-cli',
      licensee: 'F9 eval',
      seats: 1,
      issued: new Date().toISOString(),
      expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      features: [...LICENSE_FEATURES],
      ...(device ? { deviceId: device } : {})
    },
    key
  )
  const licenseFile = path.join(dir, 'eval.ofalicense')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(licenseFile, licenseText)
  const install = await ofa(['license', 'install', licenseFile])
  if (install.code !== 0) throw new Error(`license install failed: ${install.stderr}`)

  // Text a person would say, type, read or hear: none of it may reach the metadata log.
  const typed = 'Mama Zawadi Achieng says the baby has vomited since Tuesday morning.'
  const spoken = 'Kunywa dawa hii mara mbili kwa siku baada ya chakula.'
  const asked = 'mtoto ana homa na kutapika'
  const phraseQuery = 'please wait here'
  const docFile = path.join(PROJECT_ROOT, 'var/eval-docs/e03-med-label-en.jpg')
  const enClip = path.join(PROJECT_ROOT, 'tests/fixtures/fleurs-en-1953.wav')
  const swClip = path.join(PROJECT_ROOT, 'tests/fixtures/fleurs-sw-1941-quiet.wav')
  const haveDoc = await fs.stat(docFile).then(() => true, () => false)

  const runs: { command: string; code: number; wallMs: number; json?: any }[] = []
  const step = async (label: string, args: string[]) => {
    console.log(`CLI: ${label} …`)
    const r = await ofa(args)
    let json: any
    try {
      json = JSON.parse(r.stdout)
    } catch {
      json = undefined
    }
    runs.push({ command: label, code: r.code, wallMs: r.wallMs, json })
    if (r.code !== 0) console.error(r.stderr)
  }
  await step('translate', ['translate', '--from', 'en', '--to', 'sw', '--json', typed])
  await step('stt', ['stt', '--lang', 'en', '--json', enClip])
  await step('speak', ['speak', '--lang', 'sw', '--json', '--out', path.join(dir, 'speak.wav'), spoken])
  await step('converse', ['converse', '--side', 'patient', '--json', '--out-dir', path.join(dir, 'turns'), swClip])
  await step('guide', ['guide', '--lang', 'sw', '--json', asked])
  await step('phrase search', ['phrase', 'search', '--lang', 'en', '--json', phraseQuery])
  if (haveDoc) await step('doc read', ['doc', 'read', '--json', docFile])

  const byLabel = Object.fromEntries(runs.map((r) => [r.command, r.json]))
  const sensitive: string[] = [typed, spoken, asked, phraseQuery]
  const t = byLabel.translate
  if (t) sensitive.push(t.translation, t.backTranslation)
  if (byLabel.stt) sensitive.push(byLabel.stt.text)
  if (byLabel.converse) sensitive.push(byLabel.converse.sourceText, byLabel.converse.translation, byLabel.converse.backTranslation)
  if (byLabel.guide?.status === 'match') sensitive.push(...byLabel.guide.hits.map((h: any) => `${h.card.id} ${h.card.title}`))
  if (byLabel['phrase search']) sensitive.push(...byLabel['phrase search'].map((h: any) => `${h.phrase.id} ${h.phrase.text.en} ${h.phrase.text.sw}`))
  if (byLabel['doc read']) sensitive.push(...byLabel['doc read'].segments.map((s: any) => s.text))
  const words = [...new Set(sensitive.join(' ').toLowerCase().match(/\p{L}{5,}/gu) ?? [])]

  const metaExport = await exportLog()
  const metaRaw = await rawLog()
  const wordHits = (text: string) => words.filter((w) => new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'iu').test(text))
  const features = new Set(metaExport.records.map((r: any) => `${r.feature}/${r.action}/${r.outcome}`))
  const metadataOnly = {
    commands: runs.map(({ command, code, wallMs }) => ({ command, code, wallMs })),
    records: metaExport.records.length,
    recorded: [...features],
    exportCode: metaExport.code,
    sensitiveWords: words.length,
    /**
     * Words of what people said, typed, read or heard found in the decrypted
     * log, with the fields holding them. Target: none outside the fields the
     * code fills with fixed names (feature, action, detail, flags, models …).
     */
    wordsInDecryptedLog: wordHits(metaExport.text).map((word) => ({ word, fields: fieldsWith(metaExport.records, word) })),
    wordsOutsideNamedFields: wordHits(metaExport.text).filter((w) => fieldsWith(metaExport.records, w).some((f) => !isNamedField(f))),
    recordsWithContent: metaExport.records.filter((r: any) => r.content).length,
    /** Any word of 6+ letters (text or metadata names) in the raw files: target none. */
    readableInRawFiles: [...words.filter((w) => w.length >= 6), 'feature', 'outcome', 'timings', 'translate', 'conversation'].filter((w) => metaRaw.toLowerCase().includes(w))
  }

  console.log('CLI: transcripts on …')
  const before = metaExport.records.length
  await ofa(['translate', '--from', 'en', '--to', 'sw', '--plain', typed], { OFA_LOG_TRANSCRIPTS: '1' })
  await ofa(['guide', '--lang', 'sw', asked], { OFA_LOG_TRANSCRIPTS: '1' })
  const fullExport = await exportLog()
  const added = fullExport.records.slice(before + 1) // the export of the previous step is recorded too
  const fullRaw = await rawLog()
  const transcripts = {
    records: added.length,
    withContent: added.filter((r: any) => r.content).length,
    typedTextInDecryptedLog: fullExport.text.includes(typed),
    questionInDecryptedLog: fullExport.text.includes(asked),
    readableInRawFiles: [typed, asked, ...words.filter((w) => w.length >= 6)].filter((w) => fullRaw.toLowerCase().includes(w.toLowerCase()))
  }

  console.log('CLI: expired license …')
  const expired = issueLicense(
    {
      format: 1,
      kind: 'license',
      id: 'eval-cli-expired',
      licensee: 'F9 eval',
      seats: 1,
      issued: '2025-10-01T00:00:00.000Z',
      expiry: '2026-10-01T23:59:59.999Z',
      features: [...LICENSE_FEATURES]
    },
    key
  )
  await fs.writeFile(env.OFA_LICENSE, expired)
  const refused = await ofa(['translate', '--from', 'en', '--to', 'sw', 'Hello'])
  const stillGuide = await ofa(['guide', '--lang', 'sw', asked])
  const stillPhrase = await ofa(['phrase', 'play', '--lang', 'sw', '--no-play', 'inst-wait'])
  const refusedInstall = await ofa(['license', 'install', env.OFA_LICENSE])
  const afterExpiry = (await exportLog()).records
  const readOnly = {
    translateExit: refused.code,
    translateMessage: refused.stderr.split('\n').find((l) => l.startsWith('✖'))?.trim(),
    guideExit: stillGuide.code,
    phrasePlayExit: stillPhrase.code,
    installExpiredExit: refusedInstall.code,
    refusalsRecorded: afterExpiry.filter((r: any) => r.outcome === 'refused').map((r: any) => `${r.feature}/${r.action}: ${r.reason}`)
  }

  console.log('CLI: wipe …')
  const noYes = await ofa(['logs', 'wipe'])
  const filesBefore = (await fs.readdir(env.OFA_LOG_DIR)).length
  const wipe = await ofa(['logs', 'wipe', '--yes'])
  const afterWipe = await exportLog()
  const wiped = {
    withoutYesExit: noYes.code,
    filesBefore,
    exit: wipe.code,
    recordsAfter: afterWipe.records.map((r: any) => `${r.feature}/${r.action}`),
    rawCopyReadable: false
  }
  // The old raw lines, copied back after the wipe, can no longer be read.
  const today = new Date().toISOString().slice(0, 10)
  await fs.appendFile(path.join(env.OFA_LOG_DIR, `${today}.jsonl`), metaRaw.split('\n').filter(Boolean).slice(0, 3).join('\n') + '\n')
  const replay = await exportLog()
  wiped.rawCopyReadable = replay.records.length > afterWipe.records.length + 1
  return { boundToDevice: device !== undefined, metadataOnly, transcripts, readOnly, wiped, replayProblems: replay.stderr.match(/unknown-key/g)?.length ?? 0 }
}
