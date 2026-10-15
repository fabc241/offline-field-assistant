import type { LoadedPack } from '../features/packs/loader.js'
import type { PackStore } from '../features/packs/store.js'

/** Loads (and verifies) an installed pack: the one given, or the only one installed. */
export async function loadInstalledPack(store: PackStore, packId: string | undefined): Promise<LoadedPack> {
  if (!packId) {
    const installed = await store.list()
    if (!installed.length) throw new Error(`No packs installed in ${store.dir}; install one with ofa pack install`)
    if (installed.length > 1) throw new Error(`${installed.length} packs are installed (${installed.map((p) => p.id).join(', ')}); choose one with --pack`)
    packId = installed[0]!.id
  }
  return store.load(packId)
}
