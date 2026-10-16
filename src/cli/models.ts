import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ALL_MODEL_NAMES } from '../core/catalog.js'
import type { AppConfig } from '../core/config.js'
import { ModelStore } from '../core/model-store.js'
import { sdkVersion } from '../core/qvac.js'
import {
  buildModelPack,
  installModelPack,
  installedModelPack,
  signModelPack,
  verifyModelPack,
  type ModelPackManifest,
  type Progress
} from '../features/models/model-pack.js'
import { PackError } from '../features/packs/loader.js'
import { loadPrivateKey, trustedKey } from '../features/packs/signing.js'
import { TRUSTED_PACK_KEYS } from '../features/packs/trusted-keys.js'
import type { Session } from './session.js'

const USAGE = `Usage:
  ofa models status [--json]                      installed models and the model pack they came from
  ofa models install DIR                          verify the model pack in DIR (e.g. on a USB stick) and install it
  ofa models verify [--trust PUB.pem] DIR         check a model pack's signature and hash every file
Vendor only:
  ofa models build --out DIR [--id ID] [--version X.Y.Z] [--title T] [--models A,B,…]
                                                  copy this machine's runtime models into an unsigned model pack
  ofa models sign --key FILE DIR                  sign a model pack (hashes every file first)
Models install into ${'$'}OFA_MODELS_DIR (the app: ~/Library/Application Support/OfflineFieldAssistant/models).`

type Sub = (config: AppConfig, args: string[], session: Session) => Promise<boolean>

export async function modelsCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const [sub, ...rest] = args
  const run = sub ? subcommands[sub] : undefined
  if (!run) return usage()
  try {
    return await run(config, rest, session)
  } catch (err) {
    if (!(err instanceof PackError)) throw err
    console.error(`✖ Model pack refused (${err.problem}): ${err.message}`)
    await session.activity.record({ feature: 'models', action: sub!, outcome: 'refused', reason: err.problem })
    return false
  }
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`

/** One progress line on a terminal, rewritten in place; nothing when piped. */
function progress(verb: string) {
  if (!process.stderr.isTTY) return undefined
  return (p: Progress) => {
    process.stderr.write(`\r${verb} ${gb(p.done)} of ${gb(p.total)} (${p.name})`.padEnd(100))
    if (p.done === p.total) process.stderr.write('\n')
  }
}

const subcommands: Record<string, Sub> = {
  async status(config, args) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } })
    const store = await ModelStore.open(config.modelsDir)
    const pack = await installedModelPack(config.modelsDir, TRUSTED_PACK_KEYS)
    const results = await Promise.all(ALL_MODEL_NAMES.map((n) => store.verify(n)))
    if (values.json) {
      console.log(JSON.stringify({ dir: config.modelsDir, pack, models: results }, null, 2))
      return results.every((r) => r.status === 'ok') && pack.status !== 'invalid'
    }
    console.log(`Models dir    ${config.modelsDir}`)
    console.log(`Model pack    ${describePack(pack)}`)
    for (const r of results) console.log(`  ${r.status === 'ok' ? '✓' : '✗'} ${r.name.padEnd(44)} ${r.status}`)
    return results.every((r) => r.status === 'ok') && pack.status !== 'invalid'
  },

  async install(config, args, session) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    const [dir] = positionals
    if (!dir || positionals.length > 1) return usage()
    if (!(await session.require('packs', 'install-models'))) return false
    const result = await installModelPack(path.resolve(dir), config.modelsDir, { trustedKeys: TRUSTED_PACK_KEYS, onProgress: progress('Copying') })
    const { manifest } = result
    await session.activity.record({
      feature: 'models',
      action: 'install',
      outcome: 'ok',
      timings: { installMs: result.ms },
      counts: { copied: result.copied.length, kept: result.kept.length, removed: result.removed.length, bytes: result.bytesCopied },
      detail: { pack: `${manifest.id}@${manifest.version}` }
    })
    console.log(`Installed ${manifest.id} ${manifest.version} into ${config.modelsDir} in ${(result.ms / 1000).toFixed(1)} s`)
    console.log(`  signed by   ${result.signedBy.label} (${result.signedBy.keyId})`)
    console.log(`  copied      ${result.copied.length ? `${result.copied.join(', ')} (${gb(result.bytesCopied)})` : 'nothing'}`)
    if (result.kept.length) console.log(`  unchanged   ${result.kept.join(', ')}`)
    if (result.removed.length) console.log(`  removed     ${result.removed.join(', ')}`)
    const sdk = await sdkVersion()
    if (manifest.sdkVersion !== sdk) console.log(`⚠ The pack was made for QVAC SDK ${manifest.sdkVersion}; this app has ${sdk}. Run ofa doctor --load.`)
    return true
  },

  async verify(_config, args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { trust: { type: 'string' } } })
    const [dir] = positionals
    if (!dir || positionals.length > 1) return usage()
    const keys = [...TRUSTED_PACK_KEYS]
    if (values.trust) keys.push(trustedKey(`--trust ${values.trust}`, await fs.readFile(values.trust, 'utf8')))
    const pack = await verifyModelPack(path.resolve(dir), keys, { onProgress: progress('Hashing') })
    console.log(`✓ ${pack.manifest.id} ${pack.manifest.version}, signed by ${pack.signedBy.label} (${pack.signedBy.keyId})`)
    printManifest(pack.manifest)
    return true
  },

  async build(config, args) {
    const { values } = parseArgs({
      args,
      options: {
        out: { type: 'string' },
        id: { type: 'string', default: 'ofa-models' },
        version: { type: 'string', default: '1.0.0' },
        title: { type: 'string', default: 'Offline Field Assistant models' },
        models: { type: 'string' }
      }
    })
    if (!values.out) return usage()
    const names = values.models ? values.models.split(',').map((n) => n.trim()) : ALL_MODEL_NAMES
    const manifest = await buildModelPack({
      modelsDir: config.modelsDir,
      outDir: path.resolve(values.out),
      names,
      id: values.id,
      title: values.title,
      version: values.version,
      sdkVersion: await sdkVersion(),
      onProgress: progress('Packing')
    })
    console.log(`Built ${manifest.id} ${manifest.version} (unsigned) in ${values.out}`)
    printManifest(manifest)
    console.log(`Sign it with: ofa models sign --key keys/NAME.key.pem ${values.out}`)
    return true
  },

  async sign(_config, args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { key: { type: 'string' } } })
    const [dir] = positionals
    const keyFile = values.key ?? process.env.OFA_PACK_KEY
    if (!dir || positionals.length > 1 || !keyFile) return usage()
    const key = loadPrivateKey(await fs.readFile(keyFile, 'utf8'), process.env.OFA_PACK_KEY_PASSPHRASE || undefined)
    const { manifest, keyId } = await signModelPack(path.resolve(dir), key, { onProgress: progress('Hashing') })
    console.log(`Signed ${manifest.id} ${manifest.version} with key ${keyId}`)
    if (!TRUSTED_PACK_KEYS.some((k) => k.keyId === keyId)) console.log('⚠ This app does not trust that key: devices will refuse the model pack.')
    return true
  }
}

export function describePack(pack: Awaited<ReturnType<typeof installedModelPack>>): string {
  if (pack.status === 'none') return 'none (models were not installed from a model pack)'
  if (pack.status === 'invalid') return `✗ ${pack.problem}`
  return `✓ ${pack.manifest.id} ${pack.manifest.version}, signed by ${pack.signedBy.label} (${pack.signedBy.keyId})`
}

function printManifest(m: ModelPackManifest) {
  console.log(`  made for    QVAC SDK ${m.sdkVersion}, ${m.created.slice(0, 10)}`)
  for (const model of m.models) console.log(`  ${model.name.padEnd(44)} ${gb(model.size).padStart(9)}`)
  console.log(`  total       ${gb(m.models.reduce((s, x) => s + x.size, 0))}`)
}

function usage(): false {
  console.error(USAGE)
  return false
}
