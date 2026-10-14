import type { ModelSpec } from './qvac.js'

/**
 * The models this app ships with, keyed by role. Registry names are QVAC SDK
 * model constants (see @qvac/sdk model registry); they are only used by the
 * dev-time fetch script. At runtime models are resolved from the local
 * manifest by the same names.
 */
export const MODEL_CATALOG = {
  translator: 'TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M',
  stt: 'WHISPER_LARGE_V3_TURBO',
  vad: 'VAD_SILERO_5_1_2',
  ttsT3: 'TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0',
  ttsS3gen: 'TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0',
  embedder: 'EMBEDDINGGEMMA_300M_Q8_0',
  ocrRecognizer: 'OCR_LATIN',
  ocrDetector: 'OCR_CRAFT'
} as const

export type ModelRole = keyof typeof MODEL_CATALOG
export type ModelName = (typeof MODEL_CATALOG)[ModelRole]

export const ALL_MODEL_NAMES: string[] = [...new Set(Object.values(MODEL_CATALOG))]

/**
 * Translator load config, from the SDK's validated AfriqueGemma example. The
 * SDK applies the TranslatePsy model card's own sampling per call; the stop
 * sequence keeps each call to one line, so callers translate line by line.
 */
const TRANSLATOR_CONFIG = { ctx_size: 2048, predict: 256, stop_sequences: ['\n'] }

/** Any TranslatePsy-AfriSLM size, for the A/B eval. */
export const translatorSpec = (name: string = MODEL_CATALOG.translator): ModelSpec => ({
  name,
  config: TRANSLATOR_CONFIG
})

/**
 * How each runtime model is loaded. Features and the doctor share these, so
 * the runtime sees one spec (and keeps one loaded instance) per model.
 */
export const MODEL_SPECS = {
  translator: translatorSpec(),
  stt: { name: MODEL_CATALOG.stt, companions: { vadModelSrc: MODEL_CATALOG.vad } },
  tts: {
    name: MODEL_CATALOG.ttsT3,
    config: { ttsEngine: 'chatterbox', language: 'sw' },
    companions: { s3genModelSrc: MODEL_CATALOG.ttsS3gen }
  },
  embedder: { name: MODEL_CATALOG.embedder },
  ocr: {
    name: MODEL_CATALOG.ocrRecognizer,
    config: { langList: ['en'] },
    companions: { detectorModelSrc: MODEL_CATALOG.ocrDetector }
  }
} satisfies Record<string, ModelSpec>
