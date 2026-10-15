import type { Lang } from './engines.js'
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
 * Whisper load config, after the SDK's whispercpp-filesystem example: greedy
 * decoding at temperature 0, Silero VAD, Metal. `language` is only the
 * initial value; the transcriber forces the language of each request, so
 * Whisper never auto-detects. Audio arrives as 16 kHz mono float32.
 */
const WHISPER_CONFIG = {
  audio_format: 'f32le',
  strategy: 'greedy',
  language: 'en',
  translate: false,
  no_timestamps: false,
  single_segment: false,
  temperature: 0,
  suppress_blank: true,
  suppress_nst: true,
  vad_params: {
    threshold: 0.35,
    min_speech_duration_ms: 200,
    min_silence_duration_ms: 150,
    max_speech_duration_s: 30,
    speech_pad_ms: 600,
    samples_overlap: 0.3
  },
  contextParams: { use_gpu: true, flash_attn: true, gpu_device: 0 }
}

/**
 * Whisper models compared in the F2 eval. Paza is Microsoft's Kenyan-language
 * fine-tune of large-v3-turbo, converted locally (scripts/import-paza.ts); it
 * is not a registry model, so fetch-models does not download it.
 */
export const STT_CANDIDATES = [MODEL_CATALOG.stt, 'WHISPER_PAZA_LARGE_V3_TURBO'] as const

/** Any whisper.cpp model (stock or a fine-tune in the manifest), for the A/B eval. */
export const sttSpec = (name: string = MODEL_CATALOG.stt): ModelSpec => ({
  name,
  config: WHISPER_CONFIG,
  companions: { vadModelSrc: MODEL_CATALOG.vad }
})

export interface TtsOptions {
  /**
   * Speech tokens per streamed chunk (25 ≈ 1 s of audio); 0 or unset
   * synthesizes each sentence whole. Chunks start the audio sooner but cost
   * more in total, since each re-runs S3Gen over the speech so far.
   */
  chunkTokens?: number
  /** Speaking-rate multiplier (time-stretch, pitch kept); 1 is unchanged. */
  speed?: number
  /** A consented recording to speak with (absolute path, checked by features/voice/voices.ts). */
  referenceAudio?: string
  /** RNG seed of the waveform stages; unset is the engine's 42. Another seed is another take of the same text. */
  seed?: number
}

/**
 * Chatterbox multilingual on Metal; the language is fixed at load time. The
 * engine defaults to CPU, which took 3–4.5 s per second of audio on the M4
 * (RTF 3–4.5) against ~0.6 s on the GPU. The seed is the engine's default
 * (42), so a sentence always sounds the same.
 */
export const ttsSpec = (language: Lang, opts: TtsOptions = {}): ModelSpec => ({
  name: MODEL_CATALOG.ttsT3,
  config: {
    ttsEngine: 'chatterbox',
    language,
    useGPU: true,
    ...(opts.chunkTokens ? { streamChunkTokens: opts.chunkTokens, streamFirstChunkTokens: Math.min(20, opts.chunkTokens) } : {}),
    ...(opts.speed && opts.speed !== 1 ? { ttsSpeed: opts.speed } : {}),
    ...(opts.referenceAudio ? { referenceAudioSrc: opts.referenceAudio } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {})
  },
  companions: { s3genModelSrc: MODEL_CATALOG.ttsS3gen }
})

/**
 * How each runtime model is loaded. Features and the doctor share these, so
 * the runtime sees one spec (and keeps one loaded instance) per model.
 */
export const MODEL_SPECS = {
  translator: translatorSpec(),
  stt: sttSpec(),
  tts: ttsSpec('sw'),
  embedder: { name: MODEL_CATALOG.embedder },
  ocr: {
    name: MODEL_CATALOG.ocrRecognizer,
    config: { langList: ['en'] },
    companions: { detectorModelSrc: MODEL_CATALOG.ocrDetector }
  }
} satisfies Record<string, ModelSpec>
