/**
 * The model pack: the app's model files, shipped apart from the app and
 * installed offline (from a USB stick) into the models directory.
 *
 * Models are gigabytes, too big for the .ofapack ZIP (4 GB limit, read into
 * memory), so a model pack is a directory:
 *
 *   ofa-models-1.0.0/
 *     manifest.json   canonical JSON: id, version, SDK version, and the name,
 *                     file, size and sha256 of every model
 *     manifest.sig    Ed25519 signature over manifest.json (F5 format and keys)
 *     files/<file>    the model files as they are
 *
 * Install checks the signature before anything else, then hashes every file
 * as it copies it, so the bytes that land on the device are the bytes that
 * were signed. Files go to a staging directory first and replace the old ones
 * only once all of them are in, so a pulled USB stick leaves the previous
 * models working. Like content packs, an older version never replaces a newer one.
 */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { KeyObject } from 'node:crypto'
import { z } from 'zod'
import { MANIFEST_FILE as STORE_MANIFEST, ModelStore, sha256File, type Manifest, type ManifestEntry } from '../../core/model-store.js'
import { assertEntryName } from '../packs/archive.js'
import { PackError, parseCanonicalJson } from '../packs/loader.js'
import { MANIFEST_FILE, SLUG, canonicalJson, compareVersions, isVersion } from '../packs/manifest.js'
import { PackSignatureSchema, SIGNATURE_FILE, checkSignature, signManifest, type TrustedKey } from '../packs/signing.js'

export const FILES_DIR = 'files'
/** Where an installed pack's signed manifest is kept, next to the models it installed. */
export const INSTALLED_MANIFEST = 'model-pack.json'
export const INSTALLED_SIGNATURE = 'model-pack.sig'
const VERSIONS_FILE = 'model-pack-versions.json'
const STAGING_DIR = '.incoming'

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

export const ModelFileSchema = z.strictObject({
  /** Manifest name, e.g. WHISPER_LARGE_V3_TURBO. */
  name: z.string().regex(/^[A-Z0-9][A-Z0-9_]{0,99}$/),
  /** Plain file name, no directories. */
  file: z.string().min(1).refine((f) => !f.includes('/') && !f.startsWith('.'), 'a plain file name'),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  addon: z.string().min(1),
  engine: z.string().min(1),
  source: z.string().min(1).optional()
})

export const ModelPackManifestSchema = z.strictObject({
  format: z.literal(1),
  kind: z.literal('models'),
  id: z.string().regex(SLUG, 'lowercase letters, digits and dashes'),
  title: z.string().min(1),
  version: z.string().regex(SEMVER, 'MAJOR.MINOR.PATCH'),
  created: z.iso.datetime(),
  /** QVAC SDK version the models were checked with. */
  sdkVersion: z.string().min(1),
  models: z.array(ModelFileSchema).min(1)
})
export type ModelPackManifest = z.infer<typeof ModelPackManifestSchema>

export interface Progress {
  /** The model being hashed or copied. */
  name: string
  done: number
  total: number
}

export interface OpenedModelPack {
  dir: string
  manifest: ModelPackManifest
  manifestBytes: Buffer
  signatureBytes: Buffer
  signedBy: { keyId: string; label: string }
}

const sum = (models: { size: number }[]) => models.reduce((s, m) => s + m.size, 0)

// ---------------------------------------------------------------------------
// Build and sign (vendor side)
// ---------------------------------------------------------------------------

export interface BuildModelPackOptions {
  /** Models directory with manifest.json (as written by fetch-models). */
  modelsDir: string
  /** New directory for the pack; must not exist or be empty. */
  outDir: string
  /** Manifest names to include. */
  names: string[]
  id: string
  title: string
  version: string
  sdkVersion: string
  now?: Date
  onProgress?: (p: Progress) => void
}

/**
 * Writes an unsigned model pack. Every source file is hashed against the
 * models manifest first, so a damaged file is never packed. Files are cloned
 * (APFS copy-on-write) when the volume allows it.
 */
export async function buildModelPack(opts: BuildModelPackOptions): Promise<ModelPackManifest> {
  if (!SLUG.test(opts.id)) throw new Error(`"${opts.id}" is not a pack id (lowercase letters, digits and dashes)`)
  if (!isVersion(opts.version)) throw new Error(`"${opts.version}" is not a version (MAJOR.MINOR.PATCH)`)
  const store = await ModelStore.open(opts.modelsDir)
  const names = [...new Set(opts.names)]
  const entries = names.map((n) => store.entry(n))
  const existing = await fs.readdir(opts.outDir).catch(() => [])
  if (existing.length) throw new Error(`${opts.outDir} is not empty`)
  await fs.mkdir(path.join(opts.outDir, FILES_DIR), { recursive: true })

  const total = sum(entries)
  let done = 0
  for (const entry of entries) {
    const src = path.join(opts.modelsDir, entry.file)
    const stat = await fs.stat(src).catch(() => undefined)
    if (!stat || stat.size !== entry.size) throw new Error(`${entry.name}: ${src} is missing or not ${entry.size} bytes`)
    if ((await sha256File(src)) !== entry.sha256) throw new Error(`${entry.name}: ${src} does not match the sha256 in the models manifest`)
    await fs.copyFile(src, path.join(opts.outDir, FILES_DIR, entry.file), constants.COPYFILE_FICLONE)
    done += entry.size
    opts.onProgress?.({ name: entry.name, done, total })
  }

  const manifest: ModelPackManifest = {
    format: 1,
    kind: 'models',
    id: opts.id,
    title: opts.title,
    version: opts.version,
    created: (opts.now ?? new Date()).toISOString(),
    sdkVersion: opts.sdkVersion,
    models: entries.map(({ name, file, size, sha256, addon, engine, source }) => ({ name, file, size, sha256, addon, engine, ...(source ? { source } : {}) }))
  }
  ModelPackManifestSchema.parse(manifest)
  await fs.writeFile(path.join(opts.outDir, MANIFEST_FILE), canonicalJson(manifest))
  return manifest
}

/**
 * Signs a model pack in place. The files are hashed first: signing vouches
 * for every byte the manifest lists.
 */
export async function signModelPack(
  dir: string,
  privateKey: KeyObject,
  opts: { onProgress?: (p: Progress) => void } = {}
): Promise<{ manifest: ModelPackManifest; keyId: string }> {
  const { manifest, manifestBytes } = await readManifest(dir)
  await checkFiles(dir, manifest, { hashes: true, onProgress: opts.onProgress })
  const signature = signManifest(manifestBytes, privateKey)
  await fs.writeFile(path.join(dir, SIGNATURE_FILE), canonicalJson(signature))
  return { manifest, keyId: signature.keyId }
}

// ---------------------------------------------------------------------------
// Verify and install (device side)
// ---------------------------------------------------------------------------

/**
 * Reads a model pack's manifest and checks its signature against the
 * trusted keys, before the manifest is parsed. Checks that the files are
 * there with the right sizes; it does not hash them.
 */
export async function openModelPack(dir: string, trustedKeys: readonly TrustedKey[]): Promise<OpenedModelPack> {
  const manifestBytes = await fs.readFile(path.join(dir, MANIFEST_FILE)).catch(() => undefined)
  if (!manifestBytes) throw new PackError('malformed', `${dir} has no ${MANIFEST_FILE}: not a model pack`)
  const signatureBytes = await fs.readFile(path.join(dir, SIGNATURE_FILE)).catch(() => undefined)
  if (!signatureBytes) throw new PackError('unsigned', 'The model pack is not signed')
  const signedBy = checkPackSignature(manifestBytes, signatureBytes, trustedKeys)
  const { manifest } = parseManifest(manifestBytes)
  await checkFiles(dir, manifest, { hashes: false })
  return { dir, manifest, manifestBytes, signatureBytes, signedBy }
}

/** openModelPack, then every file hashed against the manifest. */
export async function verifyModelPack(
  dir: string,
  trustedKeys: readonly TrustedKey[],
  opts: { onProgress?: (p: Progress) => void } = {}
): Promise<OpenedModelPack> {
  const pack = await openModelPack(dir, trustedKeys)
  await checkFiles(dir, pack.manifest, { hashes: true, onProgress: opts.onProgress })
  return pack
}

export interface InstallResult {
  manifest: ModelPackManifest
  signedBy: { keyId: string; label: string }
  /** Models copied from the pack. */
  copied: string[]
  /** Models already on the device with the same sha256. */
  kept: string[]
  /** Files of the previous pack's models that this pack no longer has. */
  removed: string[]
  bytesCopied: number
  ms: number
}

export interface InstallOptions {
  trustedKeys: readonly TrustedKey[]
  onProgress?: (p: Progress) => void
}

export async function installModelPack(dir: string, modelsDir: string, opts: InstallOptions): Promise<InstallResult> {
  const t0 = performance.now()
  const pack = await openModelPack(dir, opts.trustedKeys)
  const { manifest } = pack
  const versions = await readVersions(modelsDir)
  const floor = versions[manifest.id]
  if (floor && compareVersions(manifest.version, floor) < 0) {
    throw new PackError('downgrade', `Model pack ${manifest.id} ${manifest.version} is older than version ${floor}, which this device already had`)
  }

  await fs.mkdir(modelsDir, { recursive: true })
  const staging = path.join(modelsDir, STAGING_DIR)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })

  const total = sum(manifest.models)
  let done = 0
  const copied: string[] = []
  const kept: string[] = []
  let bytesCopied = 0
  try {
    for (const model of manifest.models) {
      const dest = path.join(modelsDir, model.file)
      if (await sameFile(dest, model)) {
        kept.push(model.name)
      } else {
        await copyHashed(path.join(dir, FILES_DIR, model.file), path.join(staging, model.file), model, (n) =>
          opts.onProgress?.({ name: model.name, done: done + n, total })
        )
        copied.push(model.name)
        bytesCopied += model.size
      }
      done += model.size
      opts.onProgress?.({ name: model.name, done, total })
    }
    // Every file is in: only now replace the old ones.
    for (const model of manifest.models) {
      if (copied.includes(model.name)) await fs.rename(path.join(staging, model.file), path.join(modelsDir, model.file))
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }

  const previous = await previousPackFiles(modelsDir)
  const storeManifest: Manifest = {
    sdkVersion: manifest.sdkVersion,
    createdAt: manifest.created,
    models: manifest.models.map((m): ManifestEntry => ({ ...m }))
  }
  await writeAtomic(path.join(modelsDir, STORE_MANIFEST), JSON.stringify(storeManifest, null, 2) + '\n')
  await writeAtomic(path.join(modelsDir, INSTALLED_MANIFEST), pack.manifestBytes)
  await writeAtomic(path.join(modelsDir, INSTALLED_SIGNATURE), pack.signatureBytes)
  if (!floor || compareVersions(manifest.version, floor) > 0) {
    await writeAtomic(path.join(modelsDir, VERSIONS_FILE), JSON.stringify({ ...versions, [manifest.id]: manifest.version }, null, 2) + '\n')
  }

  // Only files a previous model pack installed are removed; anything else in the directory is left alone.
  const keep = new Set(manifest.models.map((m) => m.file))
  const removed: string[] = []
  for (const { name, file } of previous) {
    if (keep.has(file)) continue
    await fs.rm(path.join(modelsDir, file), { force: true })
    removed.push(name)
  }
  return { manifest, signedBy: pack.signedBy, copied, kept, removed, bytesCopied, ms: performance.now() - t0 }
}

export type InstalledModelPack =
  /** The models manifest is the one a signed model pack installed. */
  | { status: 'signed'; manifest: ModelPackManifest; signedBy: { keyId: string; label: string } }
  /** No model pack installed (dev machine: models from fetch-models). */
  | { status: 'none' }
  /** A model pack record is there but fails its signature, or no longer matches the models manifest. */
  | { status: 'invalid'; problem: string }

/** What model pack, if any, the models directory came from. Does not hash the model files (doctor --verify does). */
export async function installedModelPack(modelsDir: string, trustedKeys: readonly TrustedKey[]): Promise<InstalledModelPack> {
  const manifestBytes = await fs.readFile(path.join(modelsDir, INSTALLED_MANIFEST)).catch(() => undefined)
  if (!manifestBytes) return { status: 'none' }
  try {
    const signatureBytes = await fs.readFile(path.join(modelsDir, INSTALLED_SIGNATURE)).catch(() => undefined)
    if (!signatureBytes) throw new PackError('unsigned', `${INSTALLED_SIGNATURE} is missing`)
    const signedBy = checkPackSignature(manifestBytes, signatureBytes, trustedKeys)
    const { manifest } = parseManifest(manifestBytes)
    const store = await ModelStore.open(modelsDir)
    const listed = (models: { name: string; file: string; size: number; sha256: string }[]) =>
      JSON.stringify(models.map(({ name, file, size, sha256 }) => [name, file, size, sha256]).sort())
    if (listed(store.manifest.models) !== listed(manifest.models)) {
      throw new PackError('hash-mismatch', `${STORE_MANIFEST} no longer matches the installed model pack`)
    }
    return { status: 'signed', manifest, signedBy }
  } catch (err) {
    if (err instanceof PackError) return { status: 'invalid', problem: `${err.problem}: ${err.message}` }
    throw err
  }
}

// ---------------------------------------------------------------------------

function checkPackSignature(manifestBytes: Uint8Array, signatureBytes: Uint8Array, trustedKeys: readonly TrustedKey[]) {
  const parsed = PackSignatureSchema.safeParse(parseCanonicalJson(signatureBytes, SIGNATURE_FILE))
  if (!parsed.success) throw new PackError('malformed', `${SIGNATURE_FILE} is not a valid signature record`)
  const result = checkSignature(manifestBytes, parsed.data, trustedKeys)
  if (!result.ok) {
    throw new PackError(
      result.problem,
      result.problem === 'unknown-key'
        ? `The model pack is signed with key ${parsed.data.keyId}, which this app does not trust`
        : 'The signature does not match the manifest: the model pack was changed after signing'
    )
  }
  return { keyId: result.key.keyId, label: result.key.label }
}

function parseManifest(manifestBytes: Uint8Array): { manifest: ModelPackManifest } {
  const parsed = ModelPackManifestSchema.safeParse(parseCanonicalJson(manifestBytes, MANIFEST_FILE))
  if (!parsed.success) {
    throw new PackError('malformed', `${MANIFEST_FILE}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  }
  const manifest = parsed.data
  for (const key of ['name', 'file'] as const) {
    const values = manifest.models.map((m) => m[key])
    const dup = values.find((v, i) => values.indexOf(v) !== i)
    if (dup) throw new PackError('malformed', `${MANIFEST_FILE} lists ${key} ${dup} twice`)
  }
  for (const { file } of manifest.models) {
    try {
      assertEntryName(file)
    } catch (err) {
      throw new PackError('malformed', `${MANIFEST_FILE}: ${(err as Error).message}`)
    }
  }
  return { manifest }
}

async function readManifest(dir: string) {
  const manifestBytes = await fs.readFile(path.join(dir, MANIFEST_FILE)).catch(() => undefined)
  if (!manifestBytes) throw new PackError('malformed', `${dir} has no ${MANIFEST_FILE}: not a model pack`)
  return { ...parseManifest(manifestBytes), manifestBytes }
}

/** Finder litter on a USB stick (.DS_Store, ._*) is ignored; any other file the manifest does not list is refused. */
async function checkFiles(
  dir: string,
  manifest: ModelPackManifest,
  opts: { hashes: boolean; onProgress?: (p: Progress) => void }
): Promise<void> {
  const present = (await fs.readdir(path.join(dir, FILES_DIR)).catch(() => [] as string[])).filter((f) => !f.startsWith('.'))
  const listed = new Set(manifest.models.map((m) => m.file))
  const extra = present.filter((f) => !listed.has(f))
  if (extra.length) throw new PackError('unexpected-file', `The model pack holds files its manifest does not list: ${extra.join(', ')}`)
  const total = sum(manifest.models)
  let done = 0
  for (const model of manifest.models) {
    const file = path.join(dir, FILES_DIR, model.file)
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat?.isFile()) throw new PackError('missing-file', `The model pack is missing ${FILES_DIR}/${model.file}`)
    if (stat.size !== model.size) throw new PackError('hash-mismatch', `${model.file} is ${stat.size} bytes, not the ${model.size} in the manifest`)
    if (opts.hashes && (await sha256File(file)) !== model.sha256) {
      throw new PackError('hash-mismatch', `${model.file} does not match the sha256 in the manifest`)
    }
    done += model.size
    opts.onProgress?.({ name: model.name, done, total })
  }
}

async function sameFile(file: string, model: { size: number; sha256: string }): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => undefined)
  return stat?.size === model.size && (await sha256File(file)) === model.sha256
}

/** Copies `src` to `dest`, hashing the bytes as they are written; removes `dest` unless they match the manifest. */
async function copyHashed(src: string, dest: string, model: { file: string; size: number; sha256: string }, onBytes: (n: number) => void) {
  const hash = createHash('sha256')
  const out = await fs.open(dest, 'wx', 0o644)
  let n = 0
  try {
    for await (const chunk of createReadStream(src, { highWaterMark: 8 * 1024 * 1024 })) {
      hash.update(chunk as Buffer)
      await out.write(chunk as Buffer)
      n += (chunk as Buffer).length
      onBytes(n)
    }
    await out.sync()
  } finally {
    await out.close()
  }
  if (n !== model.size || hash.digest('hex') !== model.sha256) {
    await fs.rm(dest, { force: true })
    throw new PackError('hash-mismatch', `${model.file} does not match the sha256 in the signed manifest: the copy on the pack was changed or damaged`)
  }
}

const VersionsSchema = z.record(z.string().regex(SLUG), z.string().refine(isVersion))

async function readVersions(modelsDir: string): Promise<Record<string, string>> {
  const file = path.join(modelsDir, VERSIONS_FILE)
  const raw = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (raw === undefined) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    json = undefined
  }
  const parsed = VersionsSchema.safeParse(json)
  // A damaged record must not lower the floor silently.
  if (!parsed.success) throw new Error(`${file} is damaged; restore it before installing model packs`)
  return parsed.data
}

/** The models the currently installed model pack put there, if one did. */
async function previousPackFiles(modelsDir: string): Promise<{ name: string; file: string }[]> {
  const bytes = await fs.readFile(path.join(modelsDir, INSTALLED_MANIFEST)).catch(() => undefined)
  if (!bytes) return []
  const parsed = ModelPackManifestSchema.safeParse(JSON.parse(bytes.toString('utf8')))
  return parsed.success ? parsed.data.models : []
}

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}
