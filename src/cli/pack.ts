import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { MODEL_SPECS } from '../core/catalog.js'
import { PROJECT_ROOT, type AppConfig } from '../core/config.js'
import { qvacEmbedder } from '../core/engines.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort } from '../core/qvac.js'
import { buildPack, signPack } from '../features/packs/build.js'
import { PackError, PackLoader, type LoadedPack, type PackLoaderOptions } from '../features/packs/loader.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../features/packs/signing.js'
import { PackStore } from '../features/packs/store.js'
import { TRUSTED_PACK_KEYS } from '../features/packs/trusted-keys.js'
import type { Session } from './session.js'

const USAGE = `Usage:
  ofa pack keygen --out keys/NAME                 new Ed25519 signing key (NAME.key.pem, NAME.pub.pem)
  ofa pack build [--out FILE] DIR                 validate DIR's CSVs, embed the cards, write an unsigned .ofapack
  ofa pack sign --key FILE [--out FILE] PACK      sign PACK (in place unless --out)
  ofa pack verify [--trust PUB.pem] [--json] PACK check PACK against the app's trusted keys
  ofa pack install PACK                           verify and install PACK, refusing older versions
  ofa pack list                                   installed packs
Keys: OFA_PACK_KEY can stand in for --key; OFA_PACK_KEY_PASSPHRASE encrypts and decrypts keys.`

type Sub = (config: AppConfig, args: string[], session: Session) => Promise<boolean>

export async function packCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const [sub, ...rest] = args
  const run = sub ? subcommands[sub] : undefined
  if (!run) {
    console.error(USAGE)
    return false
  }
  return run(config, rest, session)
}

/** Writes NAME.key.pem (0600) and NAME.pub.pem, never over existing files. */
export async function writeKeyPair(out: string, trustNote: string): Promise<void> {
  const key = generateSigningKey(process.env.OFA_PACK_KEY_PASSPHRASE || undefined)
  const privateFile = `${out}.key.pem`
  const publicFile = `${out}.pub.pem`
  await fs.mkdir(path.dirname(path.resolve(privateFile)), { recursive: true })
  // "wx": never overwrite a key.
  await fs.writeFile(privateFile, key.privateKeyPem, { flag: 'wx', mode: 0o600 })
  await fs.writeFile(publicFile, key.publicKeyPem, { flag: 'wx' })
  console.log(`Key ${key.keyId}`)
  console.log(`  private  ${privateFile}  (keep it secret and off the devices)`)
  console.log(`  public   ${publicFile}`)
  console.log(trustNote)
}

const subcommands: Record<string, Sub> = {
  async keygen(_config, args) {
    const { values } = parseArgs({ args, options: { out: { type: 'string' } } })
    if (!values.out) return usage()
    await writeKeyPair(values.out, 'Devices accept packs signed with this key once the public key is in src/features/packs/trusted-keys.ts.')
    return true
  },

  async build(config, args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' } } })
    const [dir] = positionals
    if (!dir || positionals.length > 1) return usage()
    const store = await ModelStore.open(config.modelsDir)
    const spec = MODEL_SPECS.embedder
    const runtime = new QvacRuntime(store, createSdkPort(), config)
    try {
      const built = await buildPack(path.resolve(dir), {
        embedder: qvacEmbedder(runtime, spec),
        embeddingModel: { name: spec.name, sha256: store.entry(spec.name).sha256 }
      })
      const { id, version } = built.manifest
      const out = values.out ?? path.join(PROJECT_ROOT, 'var/pack-builds', `${id}-${version}.ofapack`)
      await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true })
      await fs.writeFile(out, built.bytes)
      const { cards, phrases } = built.source.content
      const synthetic = [...built.source.audio.values()].filter((r) => r.synthetic).length
      console.log(
        `Built ${id} ${version}: ${cards.length} cards, ${phrases.length} phrases, ${built.source.audio.size} recordings` +
          (synthetic ? ` (${synthetic} synthetic placeholders)` : '')
      )
      console.log(`  ${out}  (${kb(built.bytes.length)}, unsigned)`)
      console.log(`  card vectors: ${spec.name}, ${(built.embedMs / 1000).toFixed(1)} s`)
      if (built.manifest.notice) console.log(`  ⚠ ${built.manifest.notice}`)
      console.log(`Next: ofa pack sign --key KEY.pem ${out}`)
      return true
    } finally {
      await runtime.unloadAll()
    }
  },

  async sign(_config, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { key: { type: 'string' }, out: { type: 'string' } }
    })
    const keyFile = values.key ?? process.env.OFA_PACK_KEY
    const [file] = positionals
    if (!keyFile || !file || positionals.length > 1) return usage()
    const key = loadPrivateKey(await fs.readFile(keyFile, 'utf8'), process.env.OFA_PACK_KEY_PASSPHRASE || undefined)
    const signed = signPack(await fs.readFile(file), key)
    const out = values.out ?? file
    await fs.writeFile(out, signed.bytes)
    const trusted = TRUSTED_PACK_KEYS.find((k) => k.keyId === signed.keyId)
    console.log(`Signed ${signed.manifest.id} ${signed.manifest.version} with key ${signed.keyId}: ${out}`)
    if (!trusted) console.log('⚠ This app does not trust that key: devices will refuse the pack.')
    return true
  },

  async verify(config, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { trust: { type: 'string', multiple: true }, json: { type: 'boolean', default: false } }
    })
    const [file] = positionals
    if (!file || positionals.length > 1) return usage()
    const extra = await Promise.all((values.trust ?? []).map(async (f) => trustedKey(path.basename(f), await fs.readFile(f, 'utf8'))))
    return withLoader(config, extra, async (loader) => {
      const pack = await loader.verifyAndLoad(file)
      if (values.json) console.log(JSON.stringify(summary(pack), null, 2))
      else printPack('Verified', pack)
      return true
    })
  },

  async install(config, args, session) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    const [file] = positionals
    if (!file || positionals.length > 1) return usage()
    if (!(await session.require('packs', 'install'))) return false
    const ok = await withLoader(config, [], async (loader) => {
      const pack = await new PackStore(config.packsDir, loader).install(file)
      printPack('Installed', pack)
      console.log(`  in ${config.packsDir}`)
      await session.activity.record({
        feature: 'packs',
        action: 'install',
        outcome: 'ok',
        detail: { pack: `${pack.manifest.id}@${pack.manifest.version}`, vectors: pack.embeddings }
      })
      return true
    }, (err) => session.activity.record({ feature: 'packs', action: 'install', outcome: 'refused', reason: err.problem }))
    return ok
  },

  async list(config) {
    const installed = await new PackStore(config.packsDir, new PackLoader({ trustedKeys: TRUSTED_PACK_KEYS })).list()
    if (!installed.length) console.log(`No packs installed in ${config.packsDir}`)
    for (const p of installed) console.log(`${p.id.padEnd(32)} ${p.version.padEnd(10)} ${p.file}`)
    return true
  }
}

/** A loader with the app's keys and, when installed, this device's embedding model. */
async function withLoader(
  config: AppConfig,
  extraKeys: PackLoaderOptions['trustedKeys'],
  fn: (loader: PackLoader) => Promise<boolean>,
  onRefused?: (err: PackError) => Promise<void>
): Promise<boolean> {
  const store = await ModelStore.open(config.modelsDir)
  const spec = MODEL_SPECS.embedder
  const runtime = new QvacRuntime(store, createSdkPort(), config)
  const loader = new PackLoader({
    trustedKeys: [...TRUSTED_PACK_KEYS, ...extraKeys],
    ...(store.has(spec.name) ? { embedding: { embedder: qvacEmbedder(runtime, spec), sha256: store.entry(spec.name).sha256 } } : {})
  })
  try {
    return await fn(loader)
  } catch (err) {
    if (!(err instanceof PackError)) throw err
    console.error(`✖ Pack refused (${err.problem}): ${err.message}`)
    await onRefused?.(err)
    return false
  } finally {
    await runtime.unloadAll()
  }
}

function summary(pack: LoadedPack) {
  const { manifest, content } = pack
  return {
    id: manifest.id,
    title: manifest.title,
    version: manifest.version,
    created: manifest.created,
    notice: manifest.notice,
    signedBy: pack.signedBy,
    cards: content.cards.length,
    phrases: content.phrases.length,
    recordings: pack.audio.size,
    syntheticRecordings: manifest.files.filter((f) => f.synthetic).length,
    embeddings: pack.embeddings,
    embeddingModel: manifest.embedding.model,
    files: manifest.files.length,
    bytes: manifest.files.reduce((s, f) => s + f.size, 0)
  }
}

function printPack(verb: string, pack: LoadedPack) {
  const s = summary(pack)
  console.log(`${verb} ${s.id} ${s.version} — ${s.title}`)
  console.log(`  signed by     ${s.signedBy.label} (${s.signedBy.keyId})`)
  console.log(`  created       ${s.created}`)
  console.log(`  content       ${s.cards} cards, ${s.phrases} phrases, ${s.recordings} recordings (${kb(s.bytes)})`)
  if (s.syntheticRecordings) console.log(`  ⚠ ${s.syntheticRecordings} recordings are synthetic placeholders (text-to-speech), not native speakers`)
  console.log(`  card vectors  ${s.embeddings}${s.embeddings === 'stale' ? ' (made with an older recipe; install the embedding model to recompute)' : ''}`)
  if (s.notice) console.log(`  ⚠ ${s.notice}`)
}

const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`)

function usage(): false {
  console.error(USAGE)
  return false
}
