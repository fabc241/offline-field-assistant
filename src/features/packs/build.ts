/**
 * Builds a pack from a source directory (see content.ts), and signs one.
 * Building and signing are separate steps, so the signing key can stay on
 * another machine than the one that builds.
 */
import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import type { KeyObject } from 'node:crypto'
import type { Embedder } from '../../core/engines.js'
import { writeArchive, type ArchiveEntry } from './archive.js'
import { readPackSource, type PackSource } from './content.js'
import { CARD_EMBEDDING_RECIPE, embedCards, encodeVectors, vectorDims } from './embeddings.js'
import { checkParts, parseArchive } from './loader.js'
import {
  CONTENT_FILE,
  EMBEDDINGS_FILE,
  MANIFEST_FILE,
  canonicalJson,
  sha256Hex,
  type PackManifest
} from './manifest.js'
import { SIGNATURE_FILE, signManifest } from './signing.js'

export interface BuildOptions {
  embedder: Embedder
  /** The embedding model the vectors are made with, as named and hashed in the model manifest. */
  embeddingModel: { name: string; sha256: string }
  now?: Date
}

export interface BuiltPack {
  /** The unsigned pack; sign it with signPack. */
  bytes: Buffer
  manifest: PackManifest
  source: PackSource
  embedMs: number
}

export async function buildPack(dir: string, opts: BuildOptions): Promise<BuiltPack> {
  const source = await readPackSource(dir)
  const t0 = performance.now()
  const vectors = await embedCards(source.content.cards, opts.embedder)
  const embedMs = performance.now() - t0

  const files: ArchiveEntry[] = [
    { name: CONTENT_FILE, data: Buffer.from(canonicalJson(source.content)) },
    { name: EMBEDDINGS_FILE, data: Buffer.from(canonicalJson(encodeVectors(vectors))) }
  ]
  for (const [name, file] of [...source.audio].sort(([a], [b]) => (a < b ? -1 : 1))) {
    files.push({ name, data: await fs.readFile(file) })
  }

  const manifest: PackManifest = {
    format: 1,
    kind: 'content',
    ...source.info,
    created: (opts.now ?? new Date()).toISOString(),
    embedding: {
      model: opts.embeddingModel.name,
      sha256: opts.embeddingModel.sha256,
      recipe: CARD_EMBEDDING_RECIPE,
      // A pack with no cards has no vectors; any positive number keeps the schema simple.
      dims: vectorDims(vectors) || 1
    },
    files: files.map(({ name, data }) => ({ path: name, size: data.length, sha256: sha256Hex(data) }))
  }
  const bytes = writeArchive([{ name: MANIFEST_FILE, data: Buffer.from(canonicalJson(manifest)) }, ...files])
  return { bytes, manifest, source, embedMs }
}

/**
 * Adds (or replaces) the signature. The pack must be intact first: signing
 * vouches for every file the manifest lists.
 */
export function signPack(pack: Uint8Array, privateKey: KeyObject): { bytes: Buffer; manifest: PackManifest; keyId: string } {
  const entries = parseArchive(pack)
  const { manifest, manifestBytes, files } = checkParts(entries)
  const signature = signManifest(manifestBytes, privateKey)
  const bytes = writeArchive([
    { name: MANIFEST_FILE, data: manifestBytes },
    { name: SIGNATURE_FILE, data: Buffer.from(canonicalJson(signature)) },
    ...[...files].map(([name, data]) => ({ name, data }))
  ])
  return { bytes, manifest, keyId: signature.keyId }
}
