/**
 * Builds conversation mode on the real models and keeps them loaded together:
 * Whisper, the translator, EmbeddingGemma (for the check) and one Chatterbox
 * per language, ~5.8 GB in all. A turn that has to reload a model blows the
 * latency budget, so warm-up reports anything the memory budget evicted.
 */
import { MODEL_SPECS } from '../../core/catalog.js'
import type { AppConfig } from '../../core/config.js'
import { qvacEmbedder, qvacSpeaker, qvacTranscriber, qvacTranslator, type Lang } from '../../core/engines.js'
import type { ModelSpec, QvacRuntime } from '../../core/qvac.js'
import { SpeechToText } from '../speech/speech-service.js'
import { TranslationService } from '../translate/translation-service.js'
import { ReadAloud } from '../voice/read-aloud.js'
import { speakerSpecs } from '../voice/voices.js'
import { ConversationService, type ConversationOptions, type WarmUpReport } from './conversation-service.js'

export interface Conversation {
  service: ConversationService
  /** Loads and warms every model, then checks that all of them are still loaded. */
  warmUp(): Promise<WarmUpReport & { evicted: string[] }>
}

export async function createConversation(
  runtime: QvacRuntime,
  config: AppConfig,
  opts: ConversationOptions = {}
): Promise<Conversation> {
  const tts = await speakerSpecs(config.voices)
  const service = new ConversationService(
    new SpeechToText(qvacTranscriber(runtime, MODEL_SPECS.stt)),
    new TranslationService(qvacTranslator(runtime, MODEL_SPECS.translator), qvacEmbedder(runtime, MODEL_SPECS.embedder)),
    new ReadAloud(qvacSpeaker(runtime, tts)),
    opts
  )
  const langs: Lang[] = [service.languageOf('clinician'), service.languageOf('patient')]
  const specs: ModelSpec[] = [MODEL_SPECS.stt, MODEL_SPECS.translator, MODEL_SPECS.embedder, ...langs.map(tts)]

  return {
    service,
    async warmUp() {
      const report = await service.warmUp()
      // Count by name: both Chatterbox instances share one.
      const loaded = runtime.loaded().map((m) => m.name)
      const evicted: string[] = []
      for (const { name } of specs) {
        const i = loaded.indexOf(name)
        if (i === -1) evicted.push(name)
        else loaded.splice(i, 1)
      }
      return { ...report, evicted }
    }
  }
}
