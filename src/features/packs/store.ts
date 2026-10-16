/**
 * Installed packs on this device: one verified .ofapack per pack id, plus the
 * newest version ever installed of each. That record outlives the pack file,
 * so an older signed pack cannot be installed over a newer one, even after
 * the newer one was deleted. Packs are verified again on every load.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { PackError, PackLoader, type LoadedPack } from './loader.js'
import { SLUG, compareVersions, isVersion } from './manifest.js'

const VERSIONS_FILE = 'versions.json'
const VersionsSchema = z.record(z.string().regex(SLUG), z.string().refine(isVersion))

/** No pack is installed, or more than one and none was chosen. */
export class NoPackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoPackError'
  }
}

export interface InstalledPack {
  id: string
  /** Newest version installed so far: the floor for the next install. */
  version: string
  file: string
}

export class PackStore {
  constructor(
    readonly dir: string,
    private readonly loader: PackLoader
  ) {}

  /** Verifies a pack (file path or bytes) and installs it, replacing an older version of the same pack. */
  async install(pack: string | Uint8Array): Promise<LoadedPack> {
    const bytes = typeof pack === 'string' ? await fs.readFile(pack) : pack
    const versions = await this.versions()
    const loaded = await this.loader.verifyAndLoad(bytes)
    const { id, version } = loaded.manifest
    const floor = versions[id]
    if (floor && compareVersions(version, floor) < 0) {
      throw new PackError('downgrade', `Pack ${id} ${version} is older than version ${floor}, which this device already had`)
    }

    await fs.mkdir(this.dir, { recursive: true })
    await writeAtomic(this.packFile(id), bytes)
    if (!floor || compareVersions(version, floor) > 0) {
      await writeAtomic(path.join(this.dir, VERSIONS_FILE), JSON.stringify({ ...versions, [id]: version }, null, 2) + '\n')
    }
    return loaded
  }

  /** Loads an installed pack, verifying it again; refuses one older than the newest installed. */
  async load(id: string): Promise<LoadedPack> {
    if (!SLUG.test(id)) throw new Error(`"${id}" is not a pack id`)
    const floor = (await this.versions())[id]
    if (!floor) throw new NoPackError(`Pack ${id} is not installed`)
    return this.loader.verifyAndLoad(this.packFile(id), { minVersion: floor })
  }

  /** Loads the pack given, or the only one installed. */
  async loadDefault(id: string | undefined): Promise<LoadedPack> {
    if (id) return this.load(id)
    const installed = await this.list()
    if (!installed.length) throw new NoPackError(`No packs installed in ${this.dir}; install one with ofa pack install`)
    if (installed.length > 1) throw new NoPackError(`${installed.length} packs are installed (${installed.map((p) => p.id).join(', ')}); choose one with --pack`)
    return this.load(installed[0]!.id)
  }

  async list(): Promise<InstalledPack[]> {
    const versions = await this.versions()
    const installed: InstalledPack[] = []
    for (const [id, version] of Object.entries(versions).sort()) {
      const file = this.packFile(id)
      if (await fs.stat(file).catch(() => undefined)) installed.push({ id, version, file })
    }
    return installed
  }

  private packFile(id: string): string {
    return path.join(this.dir, `${id}.ofapack`)
  }

  private async versions(): Promise<Record<string, string>> {
    const raw = await fs.readFile(path.join(this.dir, VERSIONS_FILE), 'utf8').catch(() => undefined)
    if (raw === undefined) return {}
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      json = undefined
    }
    const parsed = VersionsSchema.safeParse(json)
    // A damaged record must not lower the floor silently.
    if (!parsed.success) throw new Error(`${path.join(this.dir, VERSIONS_FILE)} is damaged; restore it before installing packs`)
    return parsed.data
  }
}

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}
