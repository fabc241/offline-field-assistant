import type { LoadedPack } from '../features/packs/loader.js'
import type { PackStore } from '../features/packs/store.js'

/** Loads (and verifies) an installed pack: the one given, or the only one installed. */
export function loadInstalledPack(store: PackStore, packId: string | undefined): Promise<LoadedPack> {
  return store.loadDefault(packId)
}
