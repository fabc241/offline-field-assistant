/**
 * Opens a .ofapack and refuses it unless it is exactly what a trusted key
 * signed: the signature is checked over the raw manifest bytes before anything
 * else is parsed, then every file is checked against the manifest's sha256,
 * then the version against the newest one installed.
 */
import fs from 'node:fs/promises'
import { LANGS, type Embedder } from '../../core/engines.js'
import { ArchiveError, assertEntryName, readArchive, type ArchiveEntry } from './archive.js'
import { PackContentSchema, type PackContent } from './content.js'
import {
  CARD_EMBEDDING_RECIPE,
  EmbeddingsFileSchema,
  decodeVectors,
  embedCards,
  vectorDims,
  type CardVectors
} from './embeddings.js'
import {
  AUDIO_DIR,
  CONTENT_FILE,
  EMBEDDINGS_FILE,
  MANIFEST_FILE,
  PackManifestSchema,
  canonicalJson,
  compareVersions,
  sha256Hex,
  type PackManifest
} from './manifest.js'
import { PackSignatureSchema, SIGNATURE_FILE, checkSignature, type TrustedKey } from './signing.js'

export const PACK_PROBLEMS = [
  'malformed',
  'unsigned',
  'unknown-key',
  'bad-signature',
  'missing-file',
  'unexpected-file',
  'hash-mismatch',
  'downgrade',
  'invalid-content'
] as const
export type PackProblem = (typeof PACK_PROBLEMS)[number]

export class PackError extends Error {
  constructor(
    readonly problem: PackProblem,
    message: string
  ) {
    super(message)
    this.name = 'PackError'
  }
}

/** Where the card vectors in a loaded pack came from. */
export type EmbeddingsStatus =
  /** Built with this device's embedding model. */
  | 'packed'
  /** Built with another model (or recipe) and recomputed on this device. */
  | 'recomputed'
  /** Built with an older recipe and not recomputed, because no embedder was given. Not usable for search. */
  | 'stale'

export interface LoadedPack {
  manifest: PackManifest
  signedBy: { keyId: string; label: string }
  content: PackContent
  /** Pack path (e.g. "audio/greet-001.sw.wav") → WAV bytes. Every phrase has one per language. */
  audio: Map<string, Uint8Array>
  /** Card id → vector per language; undefined when stale. */
  vectors: CardVectors | undefined
  embeddings: EmbeddingsStatus
}

export interface DeviceEmbedding {
  embedder: Embedder
  /** sha256 of this device's embedding model file. */
  sha256: string
}

export interface PackLoaderOptions {
  /** Public keys whose packs are accepted; the app builds these in (trusted-keys.ts). */
  trustedKeys: readonly TrustedKey[]
  /**
   * This device's embedding model, to recompute vectors a pack was built with
   * another one. Without it, packed vectors are taken as they are.
   */
  embedding?: DeviceEmbedding
}

/** The parts of a pack that hold together, before the signature or the content is judged. */
export interface PackParts {
  manifest: PackManifest
  manifestBytes: Uint8Array
  signatureBytes: Uint8Array | undefined
  /** Every file the manifest lists, by path. */
  files: Map<string, Uint8Array>
}

export class PackLoader {
  constructor(private readonly opts: PackLoaderOptions) {}

  /** Verifies a pack (file path or bytes) and returns its content. Throws PackError. */
  async verifyAndLoad(pack: string | Uint8Array, { minVersion }: { minVersion?: string } = {}): Promise<LoadedPack> {
    const bytes = typeof pack === 'string' ? await fs.readFile(pack) : pack
    const entries = parseArchive(bytes)
    const manifestBytes = entries.get(MANIFEST_FILE)
    const signatureBytes = entries.get(SIGNATURE_FILE)
    if (!manifestBytes) throw new PackError('malformed', `The pack has no ${MANIFEST_FILE}`)
    if (!signatureBytes) throw new PackError('unsigned', 'The pack is not signed')
    const key = this.checkSignature(manifestBytes, signatureBytes)

    const { manifest, files } = checkParts(entries)
    if (minVersion && compareVersions(manifest.version, minVersion) < 0) {
      throw new PackError(
        'downgrade',
        `Pack ${manifest.id} ${manifest.version} is older than version ${minVersion}, which this device already had`
      )
    }
    const { content, audio, packedVectors } = readContent(manifest, files)
    const { vectors, embeddings } = await this.vectorsFor(manifest, content, packedVectors)
    return { manifest, signedBy: { keyId: key.keyId, label: key.label }, content, audio, vectors, embeddings }
  }

  private checkSignature(manifestBytes: Uint8Array, signatureBytes: Uint8Array): TrustedKey {
    const parsed = PackSignatureSchema.safeParse(parseCanonicalJson(signatureBytes, SIGNATURE_FILE))
    if (!parsed.success) throw new PackError('malformed', `${SIGNATURE_FILE} is not a valid signature record`)
    const result = checkSignature(manifestBytes, parsed.data, this.opts.trustedKeys)
    if (result.ok) return result.key
    throw new PackError(
      result.problem,
      result.problem === 'unknown-key'
        ? `The pack is signed with key ${parsed.data.keyId}, which this app does not trust`
        : 'The signature does not match the manifest: the pack was changed after signing'
    )
  }

  private async vectorsFor(
    manifest: PackManifest,
    content: PackContent,
    packed: CardVectors
  ): Promise<Pick<LoadedPack, 'vectors' | 'embeddings'>> {
    const device = this.opts.embedding
    const sameModel = !device || device.sha256 === manifest.embedding.sha256
    if (sameModel && manifest.embedding.recipe === CARD_EMBEDDING_RECIPE) return { vectors: packed, embeddings: 'packed' }
    if (!device) return { vectors: undefined, embeddings: 'stale' }
    return { vectors: await embedCards(content.cards, device.embedder), embeddings: 'recomputed' }
  }
}

/** Reads the archive into a name → bytes map; a broken archive is "malformed". */
export function parseArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  let entries: ArchiveEntry[]
  try {
    entries = readArchive(bytes)
  } catch (err) {
    if (err instanceof ArchiveError) throw new PackError('malformed', err.message)
    throw err
  }
  return new Map(entries.map((e) => [e.name, e.data]))
}

/** Parses the manifest and checks that the archive holds exactly the files it lists, byte for byte. */
export function checkParts(entries: Map<string, Uint8Array>): PackParts {
  const manifestBytes = entries.get(MANIFEST_FILE)
  if (!manifestBytes) throw new PackError('malformed', `The pack has no ${MANIFEST_FILE}`)
  const parsed = PackManifestSchema.safeParse(parseCanonicalJson(manifestBytes, MANIFEST_FILE))
  if (!parsed.success) {
    throw new PackError('malformed', `${MANIFEST_FILE}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  }
  const manifest = parsed.data

  const listed = new Set<string>()
  for (const { path } of manifest.files) {
    try {
      assertEntryName(path)
    } catch (err) {
      throw new PackError('malformed', `${MANIFEST_FILE}: ${(err as Error).message}`)
    }
    if (path === MANIFEST_FILE || path === SIGNATURE_FILE || listed.has(path)) {
      throw new PackError('malformed', `${MANIFEST_FILE} lists ${path} where it cannot`)
    }
    listed.add(path)
  }
  const extra = [...entries.keys()].filter((n) => n !== MANIFEST_FILE && n !== SIGNATURE_FILE && !listed.has(n))
  if (extra.length) throw new PackError('unexpected-file', `The pack holds files its manifest does not list: ${extra.join(', ')}`)

  const files = new Map<string, Uint8Array>()
  for (const { path, size, sha256 } of manifest.files) {
    const data = entries.get(path)
    if (!data) throw new PackError('missing-file', `The pack is missing ${path}`)
    if (data.length !== size || sha256Hex(data) !== sha256) {
      throw new PackError('hash-mismatch', `${path} does not match the sha256 in the manifest`)
    }
    files.set(path, data)
  }
  return { manifest, manifestBytes, signatureBytes: entries.get(SIGNATURE_FILE), files }
}

function readContent(manifest: PackManifest, files: Map<string, Uint8Array>) {
  const invalid = (message: string): never => {
    throw new PackError('invalid-content', message)
  }
  const json = (name: string): unknown => {
    const data = files.get(name) ?? invalid(`The pack has no ${name}`)
    try {
      return JSON.parse(Buffer.from(data).toString('utf8'))
    } catch {
      return invalid(`${name} is not valid JSON`)
    }
  }

  const parsed = PackContentSchema.safeParse(json(CONTENT_FILE))
  if (!parsed.success) invalid(`${CONTENT_FILE}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  const content = parsed.data!
  for (const items of [content.cards, content.phrases]) {
    const ids = items.map((x) => x.id)
    const dup = ids.find((id, i) => ids.indexOf(id) !== i)
    if (dup) invalid(`${CONTENT_FILE}: id "${dup}" is used more than once`)
  }

  const audio = new Map<string, Uint8Array>()
  for (const phrase of content.phrases) {
    for (const lang of LANGS) {
      const ref = phrase.audio[lang]
      const data = (ref.startsWith(`${AUDIO_DIR}/`) && files.get(ref)) || invalid(`Phrase ${phrase.id} refers to ${ref}, which is not in the pack`)
      audio.set(ref, data)
    }
  }
  const orphans = [...files.keys()].filter((f) => f.startsWith(`${AUDIO_DIR}/`) && !audio.has(f))
  if (orphans.length) invalid(`No phrase uses ${orphans.join(', ')}`)
  const others = [...files.keys()].filter((f) => !f.startsWith(`${AUDIO_DIR}/`) && f !== CONTENT_FILE && f !== EMBEDDINGS_FILE)
  if (others.length) invalid(`Unknown files in the pack: ${others.join(', ')}`)
  const misTagged = manifest.files.filter((f) => f.synthetic && !audio.has(f.path)).map((f) => f.path)
  if (misTagged.length) invalid(`Only recordings can be synthetic, not ${misTagged.join(', ')}`)

  const embeddings = EmbeddingsFileSchema.safeParse(json(EMBEDDINGS_FILE))
  if (!embeddings.success) invalid(`${EMBEDDINGS_FILE} is not a valid vector file`)
  let packedVectors: CardVectors
  try {
    packedVectors = decodeVectors(embeddings.data!, manifest.embedding.dims)
  } catch (err) {
    return invalid(`${EMBEDDINGS_FILE}: ${(err as Error).message}`)
  }
  const cardIds = content.cards.map((c) => c.id).sort()
  const vectorIds = [...packedVectors.keys()].sort()
  if (cardIds.join('\n') !== vectorIds.join('\n')) invalid(`${EMBEDDINGS_FILE} does not have exactly one entry per card`)
  if (packedVectors.size && vectorDims(packedVectors) !== manifest.embedding.dims) invalid(`${EMBEDDINGS_FILE} dimensions differ from the manifest`)
  return { content, audio, packedVectors }
}

/** JSON that must be byte-identical to its canonical form, so no byte of it can change unnoticed. */
function parseCanonicalJson(bytes: Uint8Array, name: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new PackError('malformed', `${name} is not valid JSON`)
  }
  if (canonicalJson(value) !== Buffer.from(bytes).toString('utf8')) {
    throw new PackError('malformed', `${name} is not in canonical form`)
  }
  return value
}
