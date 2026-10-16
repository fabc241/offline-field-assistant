/**
 * The small model interfaces features depend on, and their QVAC-backed
 * implementations. Unit tests pass fakes instead.
 */
import { MODEL_SPECS, ttsSpec } from './catalog.js'
import type { ModelSpec, OcrBlock, QvacRuntime, TranscriptSegment } from './qvac.js'

export type { OcrBlock, TranscriptSegment } from './qvac.js'

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

export interface Transcriber {
  /**
   * 16 kHz mono samples in, segments out. The language is forced: each side
   * of the push-to-talk screen knows its language, so nothing is detected.
   */
  transcribe(samples: Float32Array, lang: Lang): Promise<TranscriptSegment[]>
}

export interface SpeechAudio {
  /** Samples in [-1, 1]. */
  samples: Float32Array
  sampleRate: number
}

export interface Speaker {
  /**
   * Speaks one sentence, exactly as given (the caller spells out numbers).
   * `onAudio` receives the audio as the engine produces it, in order.
   */
  speak(text: string, lang: Lang, onAudio: (chunk: SpeechAudio) => void): Promise<void>
}

export interface OcrEngine {
  /** Lines of text found in a PNG, JPEG or BMP image, each with its box and confidence. */
  recognize(image: Uint8Array): Promise<OcrBlock[]>
}

/**
 * Calls that only return a result may be retried after a GPU allocation
 * failure (see QvacRuntime.use). Speech is not: it streams audio as it goes.
 */
const RETRY = { retryOnGpuMemory: true }

/** ISO 639-1 codes, as whisper.cpp expects. */
const WHISPER_LANG: Record<Lang, string> = { en: 'en', sw: 'sw' }

/** EmbeddingGemma's task prompts, from its model card. */
const EMBEDDINGGEMMA_PROMPT: Record<EmbedTask, string> = {
  similarity: 'task: sentence similarity | query: ',
  query: 'task: search result | query: ',
  document: 'title: none | text: '
}

export function qvacTranslator(runtime: QvacRuntime, spec: ModelSpec = MODEL_SPECS.translator): Translator {
  return {
    async translate(text, from, to) {
      const out = await runtime.use(spec, (modelId) => runtime.sdk.translate({ modelId, text, from: SDK_LANG[from], to: SDK_LANG[to] }), RETRY)
      return out.trim()
    }
  }
}

export function qvacEmbedder(runtime: QvacRuntime, spec: ModelSpec = MODEL_SPECS.embedder): Embedder {
  return {
    async embed(texts, task) {
      if (texts.length === 0) return []
      const prompted = texts.map((t) => EMBEDDINGGEMMA_PROMPT[task] + t)
      return runtime.use(spec, (modelId) => runtime.sdk.embed({ modelId, texts: prompted }), RETRY)
    }
  }
}

export function qvacTranscriber(runtime: QvacRuntime, spec: ModelSpec = MODEL_SPECS.stt): Transcriber {
  return {
    async transcribe(samples, lang) {
      return runtime.use(spec, async (modelId, state) => {
        // One loaded Whisper serves both languages: switching is a config
        // hot-reload, not a second 1.6 GB instance.
        const language = WHISPER_LANG[lang]
        const current = (state.language as string | undefined) ?? (spec.config?.language as string | undefined)
        if (current !== language) {
          await runtime.sdk.reconfigure({ modelId, modelType: runtime.modelType(spec), modelConfig: { language } })
          state.language = language
        }
        return runtime.sdk.transcribe({ modelId, audio: samples })
      }, RETRY)
    }
  }
}

/**
 * Chatterbox fixes the language when it loads, so each language is its own
 * instance (~1.1 GB each); the runtime evicts an idle one when memory is short.
 */
export function qvacSpeaker(runtime: QvacRuntime, spec: (lang: Lang) => ModelSpec = (lang) => ttsSpec(lang)): Speaker {
  return {
    async speak(text, lang, onAudio) {
      await runtime.use(spec(lang), (modelId) =>
        runtime.sdk.synthesize({
          modelId,
          text,
          onChunk: ({ samples, sampleRate }) => onAudio({ samples: Float32Array.from(samples, (s) => s / 32768), sampleRate })
        })
      )
    }
  }
}

/**
 * Line by line (`paragraph: false`): the engine's paragraph mode merges
 * neighbouring lines across languages and fields, and keeps only the lowest
 * confidence. features/documents/layout.ts groups the lines instead.
 */
export function qvacOcr(runtime: QvacRuntime, spec: ModelSpec = MODEL_SPECS.ocr): OcrEngine {
  return {
    async recognize(image) {
      return runtime.use(spec, (modelId) => runtime.sdk.ocr({ modelId, image, paragraph: false }), RETRY)
    }
  }
}
