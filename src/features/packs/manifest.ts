/**
 * The pack manifest: what the pack is, which version, and the size and
 * sha256 of every file in it. It is written as canonical JSON (sorted keys,
 * fixed layout), and the signature covers those exact bytes.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const MANIFEST_FILE = 'manifest.json'
export const CONTENT_FILE = 'content.json'
export const EMBEDDINGS_FILE = 'embeddings.json'
export const AUDIO_DIR = 'audio'

/** Lowercase letters, digits and dashes, e.g. "intake-ke-2026". */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

export const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

export const PackFileSchema = z.strictObject({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/)
})
export type PackFile = z.infer<typeof PackFileSchema>

/** How the card vectors were made; the device recomputes them when its embedding model differs. */
export const EmbeddingInfoSchema = z.strictObject({
  /** Model manifest name, e.g. EMBEDDINGGEMMA_300M_Q8_0. */
  model: z.string().min(1),
  /** sha256 of the model file the vectors were computed with. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Which card text was embedded, and how (see embeddings.ts). */
  recipe: z.string().min(1),
  dims: z.number().int().positive().max(65_536)
})
export type EmbeddingInfo = z.infer<typeof EmbeddingInfoSchema>

export const PackManifestSchema = z.strictObject({
  format: z.literal(1),
  kind: z.literal('content'),
  id: z.string().regex(SLUG, 'lowercase letters, digits and dashes'),
  title: z.string().min(1),
  version: z.string().regex(SEMVER, 'MAJOR.MINOR.PATCH'),
  created: z.iso.datetime(),
  /** Shown wherever the pack's content is, e.g. "PLACEHOLDER – NOT CLINICALLY VETTED". */
  notice: z.string().min(1).optional(),
  embedding: EmbeddingInfoSchema,
  files: z.array(PackFileSchema).min(1)
})
export type PackManifest = z.infer<typeof PackManifestSchema>

/** Sorted keys, two-space indent, trailing newline: one byte string per value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n'
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => [k, sortKeys(obj[k])])
  )
}

/** Negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export const isVersion = (s: string) => SEMVER.test(s)
