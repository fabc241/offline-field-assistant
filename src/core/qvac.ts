/**
 * The only module that imports @qvac/sdk. Everything else talks to models
 * through QvacRuntime, which loads from local files only, keeps loaded models
 * under a memory budget and runs one request at a time per model.
 */
import { f32leBytes } from './audio.js'
import type { ModelStore } from './model-store.js'
import { assertLocalSource } from './model-store.js'

export interface LoadRequest {
  modelSrc: string
  modelType: string
  modelConfig: Record<string, unknown>
}

export interface TranslateRequest {
  modelId: string
  text: string
  /** SDK language codes, e.g. "en", "swh_Latn". */
  from: string
  to: string
}

export interface TranscriptSegment {
  text: string
  startMs: number
  endMs: number
}

/** The slice of the SDK the app needs. Faked in unit tests. */
export interface SdkPort {
  loadModel(req: LoadRequest): Promise<string>
  /** Merges `modelConfig` into a loaded model's config without reloading weights. */
  reconfigure(req: { modelId: string; modelType: string; modelConfig: Record<string, unknown> }): Promise<void>
  unloadModel(modelId: string): Promise<void>
  /** Total system memory in bytes, when the SDK can observe it. */
  systemMemoryBytes(): Promise<number | undefined>
  /** One line of text through an LLM translation model. */
  translate(req: TranslateRequest): Promise<string>
  /** One vector per input text. */
  embed(req: { modelId: string; texts: string[] }): Promise<number[][]>
  /** Speech to text; `audio` is 16 kHz mono float32, matching the model's `audio_format: 'f32le'`. */
  transcribe(req: { modelId: string; audio: Float32Array }): Promise<TranscriptSegment[]>
  /**
   * Text to speech for one sentence. `onChunk` gets 16-bit PCM values as the
   * engine produces them: the whole sentence at once, or every few speech
   * tokens when the model was loaded with `streamChunkTokens`.
   */
  synthesize(req: { modelId: string; text: string; onChunk: (chunk: PcmChunk) => void }): Promise<void>
}

export interface PcmChunk {
  /** 16-bit PCM values. */
  samples: number[]
  sampleRate: number
}

export interface ModelSpec {
  /** Manifest name of the main model file. */
  name: string
  /** Passed through as `modelConfig`. */
  config?: Record<string, unknown>
  /** `modelConfig` keys whose value is another manifest model, e.g. { s3genModelSrc: 'TTS_S3GEN_…' }. */
  companions?: Record<string, string>
}

/**
 * Scratch state that lives exactly as long as one loaded instance of a model,
 * e.g. a setting changed with `reconfigure`. Model ids are a hash of the load
 * request, so a reloaded model gets the same id but starts from its spec again.
 */
export type InstanceState = Record<string, unknown>

export interface LoadedModelInfo {
  key: string
  name: string
  bytes: number
  lastUsed: number
  busy: boolean
}

export class ModelDoesNotFitError extends Error {
  constructor(name: string, needed: number, budget: number) {
    super(
      `Model ${name} needs ~${gb(needed)} GB but only ${gb(budget)} GB of the memory budget can be freed. ` +
        'Raise OFA_MEMORY_BUDGET_GB or unload other models.'
    )
    this.name = 'ModelDoesNotFitError'
  }
}

interface Entry {
  key: string
  name: string
  bytes: number
  lastUsed: number
  active: number
  modelId: Promise<string>
  state: InstanceState
  /** Tail of the per-model request queue. */
  queue: Promise<unknown>
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

/** Share of physical memory the models may use when the SDK reports it. */
const SYSTEM_MEMORY_SHARE = 0.7

export class QvacRuntime {
  private readonly entries = new Map<string, Entry>()
  private readonly acquiring = new Map<string, Promise<Entry>>()
  private admission: Promise<unknown> = Promise.resolve()
  private budgetPromise: Promise<number> | undefined

  constructor(
    private readonly store: ModelStore,
    /** Inference calls go through here, with a model id from `use()`. */
    readonly sdk: SdkPort,
    private readonly opts: { memoryBudgetBytes: number },
    private readonly now: () => number = Date.now
  ) {}

  /** Runs `fn` with a loaded model; calls for the same model are serialized. */
  async use<T>(spec: ModelSpec, fn: (modelId: string, state: InstanceState) => Promise<T>): Promise<T> {
    const entry = await this.acquire(spec)
    entry.active++
    const run = entry.queue.then(async () => fn(await entry.modelId, entry.state))
    entry.queue = run.catch(() => undefined)
    try {
      return await run
    } finally {
      entry.active--
      entry.lastUsed = this.now()
    }
  }

  /** The SDK model type a spec loads as, e.g. "whispercpp-transcription". */
  modelType(spec: ModelSpec): string {
    return this.store.entry(spec.name).engine
  }

  loaded(): LoadedModelInfo[] {
    return [...this.entries.values()].map((e) => ({
      key: e.key,
      name: e.name,
      bytes: e.bytes,
      lastUsed: e.lastUsed,
      busy: e.active > 0
    }))
  }

  async unload(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.acquiring.delete(key)
    await entry.queue
    const modelId = await entry.modelId.catch(() => undefined)
    if (modelId) await this.sdk.unloadModel(modelId).catch(() => undefined)
  }

  async unloadAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((k) => this.unload(k)))
  }

  /** Effective budget: the configured one, capped by a share of physical memory. */
  budget(): Promise<number> {
    this.budgetPromise ??= this.sdk
      .systemMemoryBytes()
      .catch(() => undefined)
      .then((total) =>
        total ? Math.min(this.opts.memoryBudgetBytes, total * SYSTEM_MEMORY_SHARE) : this.opts.memoryBudgetBytes
      )
    return this.budgetPromise
  }

  /**
   * Every caller for the same spec awaits the same promise, so their
   * continuations (and queue positions) keep call order.
   */
  private acquire(spec: ModelSpec): Promise<Entry> {
    const key = specKey(spec)
    let pending = this.acquiring.get(key)
    if (!pending) {
      // Admit new models one at a time so concurrent loads can't jointly exceed the budget.
      pending = this.admission.then(() => this.createEntry(key, spec))
      this.admission = pending.catch(() => undefined)
      this.acquiring.set(key, pending)
      pending.catch(() => this.acquiring.delete(key))
    }
    return pending
  }

  private async createEntry(key: string, spec: ModelSpec): Promise<Entry> {
    const companions = Object.entries(spec.companions ?? {})
    const bytes = this.store.sizeOf([spec.name, ...companions.map(([, n]) => n)])
    await this.makeRoom(spec.name, bytes)

    const modelSrc = this.store.resolve(spec.name)
    const modelConfig: Record<string, unknown> = { ...spec.config }
    for (const [configKey, companionName] of companions) {
      modelConfig[configKey] = this.store.resolve(companionName)
    }
    // Every file the SDK will open: the model, its companions, a reference voice.
    assertLocalSource(modelSrc)
    for (const [k, v] of Object.entries(modelConfig)) if (k.endsWith('Src') && typeof v === 'string') assertLocalSource(v)

    const entry: Entry = {
      key,
      name: spec.name,
      bytes,
      lastUsed: this.now(),
      active: 0,
      modelId: this.sdk.loadModel({ modelSrc, modelType: this.store.entry(spec.name).engine, modelConfig }),
      state: {},
      queue: Promise.resolve()
    }
    this.entries.set(key, entry)
    entry.modelId.catch(() => {
      this.entries.delete(key)
      this.acquiring.delete(key)
    })
    return entry
  }

  /** Evicts idle models, least recently used first, until `bytes` fits the budget. */
  private async makeRoom(name: string, bytes: number): Promise<void> {
    const budget = await this.budget()
    const used = () => [...this.entries.values()].reduce((s, e) => s + e.bytes, 0)
    const idle = [...this.entries.values()].filter((e) => e.active === 0).sort((a, b) => a.lastUsed - b.lastUsed)
    while (used() + bytes > budget && idle.length > 0) {
      await this.unload(idle.shift()!.key)
    }
    if (used() + bytes > budget) throw new ModelDoesNotFitError(name, bytes, budget - used())
  }
}

function specKey(spec: ModelSpec): string {
  return `${spec.name}|${stableStringify(spec.config ?? {})}|${stableStringify(spec.companions ?? {})}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}

// ---------------------------------------------------------------------------
// Real SDK bindings. Imported lazily so unit tests never start a QVAC worker.
// ---------------------------------------------------------------------------

type Sdk = typeof import('@qvac/sdk')
let sdkModule: Promise<Sdk> | undefined
const loadSdk = () => (sdkModule ??= import('@qvac/sdk'))

export function createSdkPort(): SdkPort {
  return {
    async loadModel(req) {
      const sdk = await loadSdk()
      // modelType is a runtime string from the manifest; the SDK validates it.
      return sdk.loadModel(req as unknown as Parameters<Sdk['loadModel']>[0])
    },
    async reconfigure({ modelId, modelType, modelConfig }) {
      const sdk = await loadSdk()
      await sdk.loadModel({ modelId, modelType, modelConfig } as unknown as Parameters<Sdk['loadModel']>[0])
    },
    async unloadModel(modelId) {
      const sdk = await loadSdk()
      await sdk.unloadModel({ modelId, clearStorage: false })
    },
    async systemMemoryBytes() {
      const res = await systemResources()
      const total = res.capabilities.memory.totalBytes
      return total.status === 'supported' ? total.value : undefined
    },
    async translate({ modelId, text, from, to }) {
      const sdk = await loadSdk()
      return sdk.translate({ modelId, text, from, to, modelType: 'llamacpp-completion', stream: false }).text
    },
    async embed({ modelId, texts }) {
      const sdk = await loadSdk()
      return (await sdk.embed({ modelId, text: texts })).embedding
    },
    async transcribe({ modelId, audio }) {
      const sdk = await loadSdk()
      // Raw f32le PCM, no container. The SDK types the buffer as bare-buffer's
      // Buffer; the Node client only calls toString('base64') on it.
      const bytes = f32leBytes(audio)
      const audioChunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as Parameters<Sdk['transcribe']>[0]['audioChunk']
      const segments = await sdk.transcribe({ modelId, audioChunk, metadata: true })
      return segments.map(({ text, startMs, endMs }) => ({ text, startMs, endMs }))
    },
    async synthesize({ modelId, text, onChunk }) {
      const sdk = await loadSdk()
      // The sentence-stream mode is the one that hands over whole chunks with
      // their boundaries; plain streaming yields one sample at a time.
      const result = sdk.textToSpeech({ modelId, text, inputType: 'text', stream: true, sentenceStream: true })
      for await (const chunk of result.chunkUpdates!) {
        if (chunk.buffer.length === 0) continue
        const sampleRate = chunk.sampleRate ?? (await result.sampleRate)
        if (!sampleRate) throw new Error('The TTS engine did not report a sample rate')
        onChunk({ samples: chunk.buffer, sampleRate })
      }
      await result.done
    }
  }
}

export async function systemResources(sample = false) {
  const sdk = await loadSdk()
  return sdk.getSystemResources({ sample })
}

export interface RegistryModelInfo {
  name: string
  modelId: string
  expectedSize: number
  sha256Checksum: string
  addon: string
  engine: string
  /** "s3" (QVAC blob store) or "hf" (Hugging Face, pinned to a commit in registryPath). */
  registrySource: string
  registryPath: string
}

/** Dev-time only: registry metadata for a model constant exported by the SDK. */
export async function registryModel(name: string): Promise<RegistryModelInfo> {
  const sdk = (await loadSdk()) as unknown as Record<string, unknown>
  const constant = sdk[name] as Partial<RegistryModelInfo> | undefined
  if (!constant || typeof constant !== 'object' || !constant.sha256Checksum || !constant.engine) {
    throw new Error(`${name} is not a model constant exported by @qvac/sdk`)
  }
  return constant as RegistryModelInfo
}

/**
 * Dev-time only (needs network): downloads a registry model into the SDK cache
 * and returns the cached file paths.
 */
export async function downloadRegistryModel(
  name: string,
  onProgress?: (percentage: number) => void
): Promise<string[]> {
  const sdk = await loadSdk()
  const constant = (sdk as unknown as Record<string, unknown>)[name]
  await sdk.downloadAsset({
    assetSrc: constant as Parameters<Sdk['downloadAsset']>[0]['assetSrc'],
    onProgress: onProgress ? (p: { percentage: number }) => onProgress(p.percentage) : undefined
  })
  const info = await sdk.getModelInfo({ name })
  return info.cacheFiles.filter((f) => f.isCached).map((f) => f.path)
}

/** Stops the QVAC worker process, if one was started. */
export async function shutdown(): Promise<void> {
  if (!sdkModule) return
  const sdk = await sdkModule
  await sdk.close()
}

export async function sdkVersion(): Promise<string> {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  return (require('@qvac/sdk/package') as { version: string }).version
}
