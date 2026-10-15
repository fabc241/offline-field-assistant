/**
 * Card vectors for the guide search (F7), computed at build time so a device
 * does not embed every card on first start. A vector is only valid for the
 * model and the text recipe it was made with: the manifest records both, and
 * a device with a different embedding model recomputes the vectors itself.
 */
import { z } from 'zod'
import { LANGS, type Embedder, type Lang } from '../../core/engines.js'
import type { Card } from './content.js'

/** Bump when cardEmbeddingText or the embed task changes: packs built before then get recomputed. */
export const CARD_EMBEDDING_RECIPE = 'card-v1:document:title+danger-signs+steps'

/** Cards per embed call. */
const BATCH = 8

export type CardVectors = Map<string, Record<Lang, Float32Array>>

/** One card in one language, as one passage. */
export function cardEmbeddingText(card: Card, lang: Lang): string {
  return [card.title[lang], ...card.dangerSigns[lang], ...card.steps[lang]].map(endSentence).join(' ')
}

const endSentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

export async function embedCards(cards: Card[], embedder: Embedder): Promise<CardVectors> {
  const jobs = cards.flatMap((card) => LANGS.map((lang) => ({ card, lang })))
  const vectors: CardVectors = new Map()
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH)
    const out = await embedder.embed(
      batch.map(({ card, lang }) => cardEmbeddingText(card, lang)),
      'document'
    )
    if (out.length !== batch.length) throw new Error(`The embedder returned ${out.length} vectors for ${batch.length} texts`)
    for (const [j, { card, lang }] of batch.entries()) {
      const entry = vectors.get(card.id) ?? ({} as Record<Lang, Float32Array>)
      entry[lang] = Float32Array.from(out[j]!)
      vectors.set(card.id, entry)
    }
  }
  const dims = new Set([...vectors.values()].flatMap((v) => LANGS.map((l) => v[l].length)))
  if (dims.size > 1) throw new Error(`The embedder returned vectors of different lengths: ${[...dims].join(', ')}`)
  return vectors
}

export const vectorDims = (vectors: CardVectors): number => {
  const first = vectors.values().next().value
  return first ? first.en.length : 0
}

/** embeddings.json: base64 of little-endian float32, which round-trips exactly. */
export const EmbeddingsFileSchema = z.strictObject({
  cards: z.record(z.string(), z.strictObject({ en: z.base64(), sw: z.base64() }))
})
export type EmbeddingsFile = z.infer<typeof EmbeddingsFileSchema>

export function encodeVectors(vectors: CardVectors): EmbeddingsFile {
  const cards: EmbeddingsFile['cards'] = {}
  for (const [id, v] of vectors) cards[id] = { en: encodeVector(v.en), sw: encodeVector(v.sw) }
  return { cards }
}

/** Throws unless every vector has `dims` finite values. */
export function decodeVectors(file: EmbeddingsFile, dims: number): CardVectors {
  const vectors: CardVectors = new Map()
  for (const [id, v] of Object.entries(file.cards)) {
    const entry = {} as Record<Lang, Float32Array>
    for (const lang of LANGS) {
      const vec = decodeVector(v[lang])
      if (vec.length !== dims) throw new Error(`card ${id} (${lang}) has ${vec.length} dimensions, the manifest says ${dims}`)
      if (!vec.every(Number.isFinite)) throw new Error(`card ${id} (${lang}) has a value that is not a finite number`)
      entry[lang] = vec
    }
    vectors.set(id, entry)
  }
  return vectors
}

function encodeVector(v: Float32Array): string {
  const bytes = Buffer.alloc(v.length * 4)
  v.forEach((x, i) => bytes.writeFloatLE(x, i * 4))
  return bytes.toString('base64')
}

function decodeVector(b64: string): Float32Array {
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length % 4 !== 0) throw new Error('a vector is not a whole number of float32 values')
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4))
}
