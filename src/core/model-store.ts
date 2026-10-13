import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export const MANIFEST_FILE = 'manifest.json'

export interface ManifestEntry {
  /** Registry name, e.g. WHISPER_LARGE_V3_TURBO. */
  name: string
  /** File name inside the models directory. */
  file: string
  size: number
  sha256: string
  /** QVAC addon kind from the registry, e.g. "whisper", "llm", "tts". */
  addon: string
  /** Canonical QVAC model type, e.g. "llamacpp-completion"; passed as `modelType` for local loads. */
  engine: string
}

export interface Manifest {
  sdkVersion: string
  createdAt: string
  models: ManifestEntry[]
}

export type VerifyStatus = 'ok' | 'missing' | 'size-mismatch' | 'hash-mismatch'

export interface VerifyResult {
  name: string
  status: VerifyStatus
  path: string
}

export class ModelNotInstalledError extends Error {
  constructor(name: string, modelsDir: string) {
    super(`Model ${name} is not in ${path.join(modelsDir, MANIFEST_FILE)}. Run "npm run fetch-models" while online.`)
    this.name = 'ModelNotInstalledError'
  }
}

const REMOTE_SOURCE = /^(registry|https?|pear|hyper|hyperdrive):\/\//i

/** Throws unless `src` is a plain local file path. Keeps runtime loads offline. */
export function assertLocalSource(src: string): void {
  if (REMOTE_SOURCE.test(src) || !path.isAbsolute(src)) {
    throw new Error(`Refusing non-local model source "${src}": runtime models must be absolute local paths`)
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export class ModelStore {
  private readonly byName: Map<string, ManifestEntry>

  private constructor(
    readonly dir: string,
    readonly manifest: Manifest
  ) {
    this.byName = new Map(manifest.models.map((m) => [m.name, m]))
  }

  static async open(dir: string): Promise<ModelStore> {
    const manifestPath = path.join(dir, MANIFEST_FILE)
    let raw: string
    try {
      raw = await fs.readFile(manifestPath, 'utf8')
    } catch {
      return new ModelStore(dir, { sdkVersion: 'none', createdAt: '', models: [] })
    }
    return new ModelStore(dir, JSON.parse(raw) as Manifest)
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  entry(name: string): ManifestEntry {
    const entry = this.byName.get(name)
    if (!entry) throw new ModelNotInstalledError(name, this.dir)
    return entry
  }

  /** Absolute local path of a model file. Does not touch the disk. */
  resolve(name: string): string {
    const p = path.join(this.dir, this.entry(name).file)
    assertLocalSource(p)
    return p
  }

  sizeOf(names: string[]): number {
    return names.reduce((sum, n) => sum + this.entry(n).size, 0)
  }

  /** Checks presence and size; with `full`, also the sha256 (slow for GB files). */
  async verify(name: string, { full = false } = {}): Promise<VerifyResult> {
    const entry = this.byName.get(name)
    const p = path.join(this.dir, entry?.file ?? name)
    if (!entry) return { name, status: 'missing', path: p }
    const stat = await fs.stat(p).catch(() => null)
    if (!stat) return { name, status: 'missing', path: p }
    if (stat.size !== entry.size) return { name, status: 'size-mismatch', path: p }
    if (full && (await sha256File(p)) !== entry.sha256) return { name, status: 'hash-mismatch', path: p }
    return { name, status: 'ok', path: p }
  }
}

export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await fs.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
}
