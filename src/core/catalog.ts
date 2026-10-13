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
