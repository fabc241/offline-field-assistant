/**
 * The F1–F9 services behind the IPC contract, with no Electron in sight:
 * the main process hands each call here, and unit tests do the same with a
 * fake SDK. Every call checks the license and records what it did in the
 * activity log, exactly as the matching ofa command does.
 *
 * Unlike the CLI, the app lives long: one QvacRuntime keeps models loaded
 * (under the memory budget) from one call to the next.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { WavFormatError, decodeWav, encodeWav, toSpeechInput } from '../core/audio.js'
import { ALL_MODEL_NAMES, MODEL_SPECS } from '../core/catalog.js'
import type { AppConfig } from '../core/config.js'
import { qvacEmbedder, qvacOcr, qvacSpeaker, qvacTranscriber, qvacTranslator, type SpeechAudio } from '../core/engines.js'
import { ModelNotInstalledError, ModelStore } from '../core/model-store.js'
import { QvacRuntime, sdkVersion, type SdkPort } from '../core/qvac.js'
import type { Conversation } from '../features/conversation/setup.js'
import { createConversation } from '../features/conversation/setup.js'
import { DocumentService } from '../features/documents/document-service.js'
import { DocumentError } from '../features/documents/input.js'
import { Guide } from '../features/guide/guide.js'
import { installModelPack, installedModelPack } from '../features/models/model-pack.js'
import { PackError, PackLoader, type LoadedPack } from '../features/packs/loader.js'
import type { TrustedKey } from '../features/packs/signing.js'
import { NoPackError, PackStore } from '../features/packs/store.js'
import { TRUSTED_PACK_KEYS } from '../features/packs/trusted-keys.js'
import { Phrasebook, PhraseNotFoundError } from '../features/phrasebook/phrasebook.js'
import { errorKind, type ActivityFeature } from '../features/platform/activity.js'
import { TRUSTED_LICENSE_KEYS } from '../features/platform/license-keys.js'
import { LICENSE_FEATURES, allows, checkLicense, type LicenseFeature, type LicenseState } from '../features/platform/license.js'
import { APP_VERSION, modelsOf, type Session } from '../features/platform/session.js'
import { SpeechToText } from '../features/speech/speech-service.js'
import { TranslationService } from '../features/translate/translation-service.js'
import { ReadAloud } from '../features/voice/read-aloud.js'
import { speakerSpecs } from '../features/voice/voices.js'
import type { AppEvent, CallError, Channel, ErrorCode, LicenseSummary, ModelsStatus, ParsedRequest, Responses } from './contract.js'

/** An error that crosses IPC with its code. */
export class CallFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Pick<CallError, 'problem' | 'refusal'> = {}
  ) {
    super(message)
    this.name = 'CallFailure'
  }
}

export interface CallContext {
  /** Pushes partial results to the caller, for calls made with `stream: true`. */
  emit?: (event: AppEvent) => void
  callId?: string
}

export interface AppServicesOptions {
  config: AppConfig
  session: Session
  sdk: SdkPort
  trustedPackKeys?: readonly TrustedKey[]
  trustedLicenseKeys?: readonly TrustedKey[]
}

type Handler<C extends Channel> = (req: ParsedRequest<C>, ctx: CallContext) => Promise<Responses[C]>
export type Handlers = { [C in Channel]: Handler<C> }

/** The feature and action each channel is logged under when it fails. */
export const CHANNEL_ACTIVITY: Record<Channel, { feature: ActivityFeature; action: string }> = {
  'app.status': { feature: 'license', action: 'status' },
  'license.status': { feature: 'license', action: 'show' },
  'license.install': { feature: 'license', action: 'install' },
  'models.status': { feature: 'models', action: 'status' },
  'models.install': { feature: 'models', action: 'install' },
  'packs.list': { feature: 'packs', action: 'list' },
  'packs.install': { feature: 'packs', action: 'install' },
  'translate.text': { feature: 'translate', action: 'translate' },
  'speech.transcribe': { feature: 'speech', action: 'transcribe' },
  'voice.speak': { feature: 'read-aloud', action: 'speak' },
  'conversation.turn': { feature: 'conversation', action: 'turn' },
  'phrasebook.list': { feature: 'phrasebook', action: 'list' },
  'phrasebook.search': { feature: 'phrasebook', action: 'search' },
  'phrasebook.recording': { feature: 'phrasebook', action: 'play' },
  'guide.search': { feature: 'guide', action: 'search' },
  'guide.ask': { feature: 'guide', action: 'voice-search' },
  'guide.card': { feature: 'guide', action: 'card' },
  'documents.read': { feature: 'documents', action: 'read' },
  'documents.translate': { feature: 'documents', action: 'translate' },
  'logs.status': { feature: 'logs', action: 'status' },
  'logs.export': { feature: 'logs', action: 'export' },
  'logs.wipe': { feature: 'logs', action: 'wipe' }
}

/** Maps any error a service throws to what the caller sees. */
export function toCallError(err: unknown): CallError {
  if (err instanceof CallFailure) return { code: err.code, message: err.message, ...err.extra }
  if (err instanceof PackError) return { code: 'pack-refused', message: err.message, problem: err.problem }
  if (err instanceof NoPackError) return { code: 'no-pack', message: err.message }
  if (err instanceof PhraseNotFoundError) return { code: 'not-found', message: err.message }
  if (err instanceof DocumentError || err instanceof WavFormatError) return { code: 'unreadable-input', message: err.message }
  if (err instanceof ModelNotInstalledError) return { code: 'models-missing', message: 'The models are not installed: install the model pack.' }
  return { code: 'failed', message: (err as Error)?.message ?? String(err) }
}

export class AppServices {
  readonly handlers: Handlers
  private readonly config: AppConfig
  private readonly session: Session
  private readonly sdk: SdkPort
  private readonly packKeys: readonly TrustedKey[]
  private readonly licenseKeys: readonly TrustedKey[]
  private runtimePromise: Promise<{ store: ModelStore; runtime: QvacRuntime }> | undefined
  private readonly views = new Map<string, Promise<Phrasebook | Guide>>()
  private conversation: Promise<Conversation> | undefined

  constructor(opts: AppServicesOptions) {
    this.config = opts.config
    this.session = opts.session
    this.sdk = opts.sdk
    this.packKeys = opts.trustedPackKeys ?? TRUSTED_PACK_KEYS
    this.licenseKeys = opts.trustedLicenseKeys ?? TRUSTED_LICENSE_KEYS
    this.handlers = this.createHandlers()
  }

  /** Unloads every model and flushes the log. */
  async close(): Promise<void> {
    const loaded = await this.runtimePromise?.catch(() => undefined)
    await loaded?.runtime.unloadAll()
    await this.session.close()
  }

  private models() {
    this.runtimePromise ??= ModelStore.open(this.config.modelsDir).then((store) => ({
      store,
      runtime: new QvacRuntime(store, this.sdk, this.config)
    }))
    return this.runtimePromise
  }

  /** Throws not-licensed (and records the refusal) unless the license covers `feature`. */
  private async gate(feature: LicenseFeature, action: string): Promise<void> {
    const refusal = await this.session.refuse(feature, action)
    if (refusal) throw new CallFailure('not-licensed', refusal.message, { refusal: { feature, available: refusal.available } })
  }

  private record = (input: Parameters<Session['activity']['record']>[0]) => this.session.activity.record(input)

  private async translation() {
    const { runtime } = await this.models()
    return { runtime, service: new TranslationService(qvacTranslator(runtime, MODEL_SPECS.translator), qvacEmbedder(runtime, MODEL_SPECS.embedder)) }
  }

  /** A pack's phrasebook or guide, built once per pack and dropped when a pack is installed. */
  private view<T extends Phrasebook | Guide>(kind: 'phrasebook' | 'guide', packId: string | undefined, make: (pack: LoadedPack) => Promise<T>): Promise<T> {
    const key = `${kind}:${packId ?? ''}`
    let view = this.views.get(key)
    if (!view) {
      view = (async () => {
        const loader = kind === 'guide' ? await this.guideLoader() : new PackLoader({ trustedKeys: this.packKeys })
        return make(await new PackStore(this.config.packsDir, loader).loadDefault(packId))
      })()
      this.views.set(key, view)
      view.catch(() => this.views.delete(key))
    }
    return view as Promise<T>
  }

  /** Recomputes card vectors when the pack was built with another embedding model than this device's. */
  private async guideLoader(): Promise<PackLoader> {
    const { store, runtime } = await this.models()
    const spec = MODEL_SPECS.embedder
    return new PackLoader({
      trustedKeys: this.packKeys,
      ...(store.has(spec.name) ? { embedding: { embedder: qvacEmbedder(runtime, spec), sha256: store.entry(spec.name).sha256 } } : {})
    })
  }

  /** Whisper loads only when a question is spoken. */
  private guide(packId: string | undefined): Promise<Guide> {
    return this.view('guide', packId, async (pack) => {
      const { store, runtime } = await this.models()
      const embedder = store.has(MODEL_SPECS.embedder.name) ? qvacEmbedder(runtime, MODEL_SPECS.embedder) : undefined
      return new Guide(pack, { ...(embedder ? { embedder } : {}), speech: new SpeechToText(qvacTranscriber(runtime, MODEL_SPECS.stt)) })
    })
  }

  private phrasebook(packId: string | undefined): Promise<Phrasebook> {
    return this.view('phrasebook', packId, async (pack) => new Phrasebook(pack))
  }

  private async modelsStatus(): Promise<ModelsStatus> {
    const store = await ModelStore.open(this.config.modelsDir)
    return {
      dir: this.config.modelsDir,
      pack: await installedModelPack(this.config.modelsDir, this.packKeys),
      models: await Promise.all(ALL_MODEL_NAMES.map((n) => store.verify(n)))
    }
  }

  private createHandlers(): Handlers {
    return {
      'app.status': async () => ({
        app: APP_VERSION,
        sdk: await sdkVersion(),
        license: summarize(this.session.license),
        models: await this.modelsStatus(),
        packs: await new PackStore(this.config.packsDir, new PackLoader({ trustedKeys: this.packKeys })).list(),
        log: { keyStore: this.session.keys?.name ?? null, transcripts: this.config.logTranscripts }
      }),

      'license.status': async () => summarize(this.session.license),

      'license.install': async ({ text }) => {
        const state = checkLicense(text, { trustedKeys: this.licenseKeys, deviceId: this.session.license.deviceId })
        if (state.status !== 'valid') {
          await this.record({ feature: 'license', action: 'install', outcome: 'refused', reason: `license-${state.problem ?? state.status}` })
          throw new CallFailure('bad-request', `Not installed. ${state.message.replace(/: read-only.*$/, '')}.`)
        }
        await writeAtomic(this.config.licenseFile, text)
        await this.record({ feature: 'license', action: 'install', outcome: 'ok', detail: { license: state.license!.id } })
        return { ...summarize(state), restartRequired: true as const }
      },

      'models.status': () => this.modelsStatus(),

      'models.install': async ({ dir }) => {
        await this.gate('packs', 'install-models')
        // Nothing may hold the old files while they are replaced.
        const loaded = await this.runtimePromise?.catch(() => undefined)
        await loaded?.runtime.unloadAll()
        this.runtimePromise = undefined
        this.views.clear()
        this.conversation = undefined
        const r = await installModelPack(dir, this.config.modelsDir, { trustedKeys: this.packKeys })
        await this.record({
          feature: 'models',
          action: 'install',
          outcome: 'ok',
          timings: { installMs: r.ms },
          counts: { copied: r.copied.length, kept: r.kept.length, removed: r.removed.length, bytes: r.bytesCopied },
          detail: { pack: `${r.manifest.id}@${r.manifest.version}` }
        })
        return { id: r.manifest.id, version: r.manifest.version, copied: r.copied, kept: r.kept, removed: r.removed, bytesCopied: r.bytesCopied, ms: r.ms }
      },

      'packs.list': () => new PackStore(this.config.packsDir, new PackLoader({ trustedKeys: this.packKeys })).list(),

      'packs.install': async ({ bytes }) => {
        await this.gate('packs', 'install')
        const pack = await new PackStore(this.config.packsDir, await this.guideLoader()).install(bytes)
        this.views.clear()
        const { manifest } = pack
        await this.record({ feature: 'packs', action: 'install', outcome: 'ok', detail: { pack: `${manifest.id}@${manifest.version}`, vectors: pack.embeddings } })
        return {
          id: manifest.id,
          version: manifest.version,
          title: manifest.title,
          ...(manifest.notice ? { notice: manifest.notice } : {}),
          signedBy: pack.signedBy,
          files: manifest.files.map(({ path: p, synthetic }) => ({ path: p, ...(synthetic ? { synthetic } : {}) }))
        }
      },

      'translate.text': async ({ text, from, to, check }) => {
        await this.gate('translate', 'translate')
        if (from === to) throw new CallFailure('bad-request', `Source and target language are both "${from}"`)
        const { runtime, service } = await this.translation()
        if (!check) {
          const { lines: _lines, ...plain } = await service.translate(text, from, to)
          await this.record({
            feature: 'translate',
            action: 'translate-plain',
            outcome: 'ok',
            langs: { from, to },
            timings: { translateMs: plain.translateMs },
            counts: { sentences: plain.sentences.length, chars: text.length },
            ...modelsOf(runtime),
            content: { source: text, translation: plain.translation }
          })
          return plain
        }
        const result = await service.translateWithCheck(text, from, to)
        await this.record({
          feature: 'translate',
          action: 'translate',
          outcome: 'ok',
          langs: { from, to },
          timings: result.timings,
          counts: { sentences: result.sentences.length, chars: text.length },
          flags: result.flags,
          ...modelsOf(runtime),
          content: { source: text, translation: result.translation, backTranslation: result.backTranslation }
        })
        const { lines: _lines, ...rest } = result
        return rest
      },

      'speech.transcribe': async ({ wav, lang }) => {
        await this.gate('speech', 'transcribe')
        const samples = speechInput(wav)
        const { runtime } = await this.models()
        const t = await new SpeechToText(qvacTranscriber(runtime, MODEL_SPECS.stt)).transcribe(samples, lang)
        await this.record({
          feature: 'speech',
          action: 'transcribe',
          outcome: 'ok',
          langs: { from: lang },
          timings: { audioMs: t.audioMs, transcribeMs: t.transcribeMs },
          counts: { segments: t.segments.length },
          flags: t.flags,
          ...modelsOf(runtime),
          content: { transcript: t.text }
        })
        return t
      },

      'voice.speak': async ({ text, lang }) => {
        await this.gate('read-aloud', 'speak')
        const { runtime } = await this.models()
        const speech = await new ReadAloud(qvacSpeaker(runtime, await speakerSpecs(this.config.voices))).speak(text, lang)
        await this.record({
          feature: 'read-aloud',
          action: 'speak',
          outcome: 'ok',
          langs: { to: lang },
          timings: { audioMs: speech.audioMs, synthMs: speech.synthMs, firstAudioMs: speech.firstAudioMs, stallMs: speech.stallMs },
          counts: { parts: speech.parts.length, chars: text.length },
          detail: { voice: this.config.voices[lang] ? 'reference' : 'built-in', mode: 'spoken' },
          flags: speech.flags,
          ...modelsOf(runtime),
          content: { text }
        })
        const { samples, ...rest } = speech
        return { ...rest, wav: encodeWav(samples, speech.sampleRate) }
      },

      'conversation.turn': async ({ wav, side, stream }, ctx) => {
        await this.gate('conversation', 'turn')
        const samples = speechInput(wav)
        const { runtime } = await this.models()
        this.conversation ??= createConversation(runtime, this.config)
        const { service } = await this.conversation.catch((err) => {
          this.conversation = undefined
          throw err
        })
        const chunks: SpeechAudio[] = []
        const emit = stream && ctx.emit && ctx.callId ? ctx.emit : undefined
        const callId = ctx.callId ?? ''
        const turn = await service.turn({
          audio: samples,
          speakerSide: side,
          onEvent: (e) => {
            if (e.type === 'audio') chunks.push(e.chunk)
            if (!emit) return
            const base = { channel: 'conversation.turn' as const, callId, atMs: e.atMs }
            if (e.type === 'transcript') emit({ ...base, type: 'transcript', text: e.transcript.text })
            else if (e.type === 'translation') emit({ ...base, type: 'translation', text: e.translation.translation })
            else if (e.type === 'audio') emit({ ...base, type: 'audio', wav: encodeWav(e.chunk.samples, e.chunk.sampleRate) })
            else emit({ ...base, type: 'check', backTranslation: e.check.backTranslation, fidelity: e.check.fidelity, flags: e.check.flags })
          }
        })
        const { firstAudioMs, sttMs, translateMs, speechDoneMs, checkDoneMs, totalMs, utteranceMs } = turn.timings
        await this.record({
          feature: 'conversation',
          action: 'turn',
          outcome: 'ok',
          langs: { from: turn.sourceLang, to: turn.targetLang },
          timings: { utteranceMs, sttMs, translateMs, firstAudioMs, speechDoneMs, checkDoneMs, totalMs },
          detail: { side: turn.speakerSide },
          flags: turn.flags,
          ...modelsOf(runtime),
          content: { transcript: turn.sourceText, translation: turn.translation, backTranslation: turn.backTranslation }
        })
        const { audioPath: _audioPath, ...rest } = turn
        return { ...rest, ...(chunks.length ? { wav: joinWav(chunks) } : {}) }
      },

      'phrasebook.list': async ({ category, pack }) => {
        await this.gate('phrasebook', 'list')
        const book = await this.phrasebook(pack)
        const phrases = book.list(category)
        if (category && !phrases.length) throw new CallFailure('not-found', `No category "${category}"; categories: ${book.categories().join(', ')}`)
        return { packId: book.packId, packVersion: book.packVersion, ...(book.notice ? { notice: book.notice } : {}), categories: book.categories(), phrases }
      },

      'phrasebook.search': async ({ query, lang, limit, pack }) => {
        await this.gate('phrasebook', 'search')
        const book = await this.phrasebook(pack)
        const hits = book.search(query, lang, { limit: limit ?? 5 })
        await this.record({
          feature: 'phrasebook',
          action: 'search',
          outcome: 'ok',
          langs: { from: lang },
          counts: { hits: hits.length },
          detail: { pack: `${book.packId}@${book.packVersion}` },
          content: { query, phrases: hits.map((h) => h.phrase.id).join(',') }
        })
        return { packId: book.packId, ...(book.notice ? { notice: book.notice } : {}), hits }
      },

      'phrasebook.recording': async ({ id, lang, pack }) => {
        await this.gate('phrasebook', 'play')
        const book = await this.phrasebook(pack)
        const phrase = book.get(id)
        if (!phrase) throw new PhraseNotFoundError(id)
        const { synthetic } = phrase.recordings[lang]
        const wav = book.recording(id, lang)
        await this.record({
          feature: 'phrasebook',
          action: 'play',
          outcome: 'ok',
          langs: { to: lang },
          detail: { pack: `${book.packId}@${book.packVersion}`, recording: synthetic ? 'synthetic' : 'recorded' },
          content: { phrase: phrase.id }
        })
        return { phrase, lang, wav, synthetic }
      },

      'guide.search': async ({ query, lang, limit, pack }) => {
        await this.gate('guide', 'search')
        const t0 = performance.now()
        const guide = await this.guide(pack)
        const result = await guide.search(query, lang ?? guide.guessLang(query), { limit: limit ?? 3 })
        await this.recordGuide(guide, 'search', result, performance.now() - t0)
        return result
      },

      'guide.ask': async ({ wav, lang, limit, pack }) => {
        await this.gate('guide', 'voice-search')
        await this.gate('speech', 'voice-search')
        const samples = speechInput(wav)
        const t0 = performance.now()
        const guide = await this.guide(pack)
        const asked = await guide.searchByVoice(samples, lang, { limit: limit ?? 3 })
        await this.recordGuide(guide, 'voice-search', asked.result, performance.now() - t0, {
          sttMs: asked.transcript.transcribeMs,
          heard: asked.transcript.text,
          flags: asked.transcript.flags
        })
        return asked
      },

      'guide.card': async ({ id, lang, pack }) => {
        await this.gate('guide', 'card')
        const guide = await this.guide(pack)
        const card = guide.card(id, lang)
        if (!card) throw new CallFailure('not-found', `No card "${id}" in ${guide.packId}`)
        await this.record({ feature: 'guide', action: 'card', outcome: 'ok', langs: { to: lang }, detail: { pack: `${guide.packId}@${guide.packVersion}` }, content: { card: card.id } })
        return card
      },

      'documents.read': async ({ bytes }) => {
        await this.gate('documents', 'read')
        const { runtime, service } = await this.documents()
        const read = await service.read(bytes)
        await this.record({
          feature: 'documents',
          action: 'read',
          outcome: 'ok',
          timings: { readMs: read.readMs },
          counts: { pages: read.pages.length, ocrPages: read.pages.filter((p) => p.source === 'ocr').length, segments: read.segments.length },
          detail: { kind: read.kind },
          ...modelsOf(runtime),
          content: { text: read.segments.map((x) => x.text).join('\n') }
        })
        return read
      },

      'documents.translate': async ({ bytes, to, check }) => {
        await this.gate('documents', 'translate')
        const { runtime, service } = await this.documents()
        const read = await service.read(bytes)
        const result = await service.translate(read, to, { check })
        await this.record({
          feature: 'documents',
          action: 'translate',
          outcome: 'ok',
          langs: { to },
          timings: result.timings,
          counts: {
            pages: read.pages.length,
            ocrPages: read.pages.filter((p) => p.source === 'ocr').length,
            segments: result.segments.length,
            kept: result.segments.filter((x) => x.kept).length
          },
          detail: { kind: result.kind, check: check ? 'on' : 'off' },
          flags: result.flags,
          ...modelsOf(runtime),
          content: { original: result.segments.map((x) => x.original).join('\n'), translation: result.segments.map((x) => x.translation).join('\n') }
        })
        return result
      },

      'logs.status': async () => {
        const log = this.log()
        const { entries: _entries, problems, days, lines, keyId } = await log.read()
        return { dir: log.dir, keyStore: this.session.keys!.name, ...(keyId ? { keyId } : {}), transcripts: this.config.logTranscripts, days, lines, problems }
      },

      'logs.export': async ({ since, until }) => {
        const read = await this.log().read({ ...(since ? { since } : {}), ...(until ? { until } : {}) })
        await this.record({ feature: 'logs', action: 'export', outcome: 'ok', counts: { entries: read.entries.length, problems: read.problems.length, days: read.days.length } })
        return { records: read.entries.map((e) => e.record), problems: read.problems }
      },

      'logs.wipe': async () => {
        const wiped = await this.log().wipe()
        await this.record({ feature: 'logs', action: 'wipe', outcome: 'ok', counts: { files: wiped.files, bytes: wiped.bytes } })
        return wiped
      }
    }
  }

  private async documents() {
    const { runtime, service: translation } = await this.translation()
    return { runtime, service: new DocumentService(qvacOcr(runtime, MODEL_SPECS.ocr), translation) }
  }

  private log() {
    if (!this.session.log) throw new CallFailure('failed', 'The activity log has no key store on this system')
    return this.session.log
  }

  private async recordGuide(
    guide: Guide,
    action: string,
    r: Awaited<ReturnType<Guide['search']>>,
    totalMs: number,
    extra: { sttMs?: number; heard?: string; flags?: string[] } = {}
  ) {
    const { runtime } = await this.models()
    await this.record({
      feature: 'guide',
      action,
      outcome: 'ok',
      langs: { from: r.lang },
      timings: { totalMs, ...(extra.sttMs !== undefined ? { sttMs: extra.sttMs } : {}) },
      counts: { hits: r.status === 'match' ? r.hits.length : 0 },
      detail: { status: r.status, mode: r.mode, pack: `${guide.packId}@${guide.packVersion}` },
      flags: [...(extra.flags ?? []), ...(r.degraded ? ['keyword-fallback'] : [])],
      ...modelsOf(runtime),
      content: {
        query: r.query,
        ...(extra.heard !== undefined ? { heard: extra.heard } : {}),
        ...(r.status === 'match' ? { cards: r.hits.map((h) => h.card.id).join(',') } : {})
      }
    })
  }
}

/**
 * Records a failed call the way the CLI records a failed command. License
 * refusals and refused license files were recorded where they happened.
 */
export async function recordFailure(session: Session, channel: Channel, err: unknown): Promise<void> {
  if (err instanceof CallFailure && (err.code === 'not-licensed' || err.code === 'bad-request')) return
  const { feature, action } = CHANNEL_ACTIVITY[channel]
  if (err instanceof PackError) await session.activity.record({ feature, action, outcome: 'refused', reason: err.problem })
  else await session.activity.record({ feature, action, outcome: 'error', reason: errorKind(err) })
}

export function summarize(state: LicenseState): LicenseSummary {
  return {
    status: state.status,
    mode: state.mode,
    message: state.message,
    ...(state.license ? { licensee: state.license.licensee, expiry: state.license.expiry } : {}),
    ...(state.daysLeft !== undefined ? { daysLeft: state.daysLeft } : {}),
    warnings: state.warnings,
    available: LICENSE_FEATURES.filter((f) => allows(state, f)),
    ...(state.deviceId ? { deviceId: state.deviceId } : {})
  }
}

/** WAV bytes from the renderer to 16 kHz mono samples. */
function speechInput(wav: Uint8Array): Float32Array {
  return toSpeechInput(decodeWav(wav))
}

function joinWav(chunks: SpeechAudio[]): Uint8Array {
  const rate = chunks[0]!.sampleRate
  const all = new Float32Array(chunks.reduce((s, c) => s + c.samples.length, 0))
  let at = 0
  for (const c of chunks) {
    all.set(c.samples, at)
    at += c.samples.length
  }
  return encodeWav(all, rate)
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

