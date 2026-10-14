/**
 * The small model interfaces features depend on, and their QVAC-backed
 * implementations. Unit tests pass fakes instead.
 */
import { MODEL_SPECS } from './catalog.js'
import type { ModelSpec, QvacRuntime } from './qvac.js'

export const LANGS = ['en', 'sw'] as const
export type Lang = (typeof LANGS)[number]

export const isLang = (value: string): value is Lang => (LANGS as readonly string[]).includes(value)

/** Codes the SDK's AfriSLM prompt builder understands. */
const SDK_LANG: Record<Lang, string> = { en: 'en', sw: 'swh_Latn' }

export interface Translator {
  /** Translates one line; multi-line text must be split by the caller. */
  translate(text: string, from: Lang, to: Lang): Promise<string>
}

/** What the vectors are for; the embedder picks the matching model prompt. */
export type EmbedTask = 'similarity' | 'query' | 'document'

export interface Embedder {
  /** Unit-length vectors, one per text. */
  embed(texts: string[], task: EmbedTask): Promise<number[][]>
}

/** EmbeddingGemma's task prompts, from its model card. */
const EMBEDDINGGEMMA_PROMPT: Record<EmbedTask, string> = {
  similarity: 'task: sentence similarity | query: ',
  query: 'task: search result | query: ',
  document: 'title: none | text: '
}

export function qvacTranslator(runtime: QvacRuntime, spec: ModelSpec = MODEL_SPECS.translator): Translator {
  return {
    async translate(text, from, to) {
      const out = await runtime.use(spec, (modelId) =>
        runtime.sdk.translate({ modelId, text, from: SDK_LANG[from], to: SDK_LANG[to] })
      )
      return out.trim()
    }
  }
}

export function qvacEmbedder(runtime: QvacRuntime, spec: ModelSpec = MODEL_SPECS.embedder): Embedder {
  return {
    async embed(texts, task) {
      if (texts.length === 0) return []
      const prompted = texts.map((t) => EMBEDDINGGEMMA_PROMPT[task] + t)
      return runtime.use(spec, (modelId) => runtime.sdk.embed({ modelId, texts: prompted }))
    }
  }
}
