import { performance } from 'node:perf_hooks'
import { ALL_MODEL_NAMES, MODEL_SPECS } from '../core/catalog.js'
import type { AppConfig } from '../core/config.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort, sdkVersion, systemResources } from '../core/qvac.js'
import { installedModelPack } from '../features/models/model-pack.js'
import { TRUSTED_PACK_KEYS } from '../features/packs/trusted-keys.js'
import { LICENSE_FEATURES, allows } from '../features/platform/license.js'
import { describePack } from './models.js'
import type { Session } from './session.js'

/** One load per runtime model, with the companions it cannot load without. */
const SMOKE_SPECS = Object.values(MODEL_SPECS)

const gb = (b: number) => (b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(0)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`)

export async function doctor(config: AppConfig, session: Session, opts: { verify: boolean; load: boolean }): Promise<boolean> {
  let healthy = true
  const store = await ModelStore.open(config.modelsDir)
  const version = await sdkVersion()

  console.log(`QVAC SDK        ${version}`)
  console.log(`Models dir      ${config.modelsDir}`)
  const pack = await installedModelPack(config.modelsDir, TRUSTED_PACK_KEYS)
  if (pack.status === 'invalid') healthy = false
  console.log(`Model pack      ${describePack(pack)}`)
  if (store.manifest.sdkVersion !== version) {
    console.log(`⚠ manifest was written with SDK ${store.manifest.sdkVersion}`)
  }

  console.log(`\nModels${opts.verify ? ' (sha256 verified)' : ' (size checked; --verify for sha256)'}`)
  for (const name of ALL_MODEL_NAMES) {
    const res = await store.verify(name, { full: opts.verify })
    const size = store.has(name) ? gb(store.entry(name).size) : ''
    if (res.status !== 'ok') healthy = false
    console.log(`  ${res.status === 'ok' ? '✓' : '✗'} ${name.padEnd(44)} ${size.padStart(9)}  ${res.status}`)
  }
  const installed = ALL_MODEL_NAMES.filter((n) => store.has(n))
  console.log(`  total on disk ${gb(store.sizeOf(installed))}`)

  const res = await systemResources()
  const mem = res.capabilities.memory.totalBytes
  console.log(`\nSystem memory   ${mem.status === 'supported' ? gb(mem.value) : mem.status}`)
  const gpus = res.capabilities.gpus
  if (gpus.status === 'supported') {
    for (const g of gpus.value) {
      const name = g.name.status === 'supported' ? g.name.value : 'unknown GPU'
      const apis = Object.entries(g.drivers)
        .filter(([, d]) => d.status === 'supported' && d.value)
        .map(([api]) => api)
      const unified = g.unifiedMemory.status === 'supported' && g.unifiedMemory.value ? ', unified memory' : ''
      console.log(`GPU             ${name} (${apis.join(', ')}${unified})`)
      if (!apis.includes('metal')) {
        healthy = false
        console.log('⚠ Metal not reported: inference will fall back to CPU')
      }
    }
  } else {
    console.log(`GPU             ${gpus.status}`)
  }

  const { license } = session
  console.log(`\nLicense         ${license.mode === 'full' ? '✓' : '⚠'} ${license.message}`)
  console.log(`  available     ${LICENSE_FEATURES.filter((f) => allows(license, f)).join(', ')}`)
  console.log(`  device id     ${license.deviceId ?? 'unavailable'}`)
  if (license.mode !== 'full') healthy = false

  if (session.keys) {
    try {
      const key = await session.keys.existingLogKey()
      const days = (await session.log!.files()).length
      console.log(`Activity log    ✓ ${config.logDir}, ${days} day file${days === 1 ? '' : 's'}`)
      console.log(`  key           ${key ? key.id : 'none yet'} in ${session.keys.name}`)
      console.log(`  recording     metadata${config.logTranscripts ? ' and transcripts (OFA_LOG_TRANSCRIPTS=1)' : ' only'}`)
    } catch (err) {
      healthy = false
      console.log(`Activity log    ✗ ${(err as Error).message}`)
    }
  } else {
    console.log('Activity log    ⚠ off: no key store on this platform')
  }

  if (opts.load) {
    const runtime = new QvacRuntime(store, createSdkPort(), config)
    console.log(`\nLoad test (budget ${gb(await runtime.budget())})`)
    for (const spec of SMOKE_SPECS) {
      const t0 = performance.now()
      try {
        await runtime.use(spec, async () => undefined)
        console.log(`  ✓ ${spec.name.padEnd(44)} loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
      } catch (err) {
        healthy = false
        console.log(`  ✗ ${spec.name.padEnd(44)} ${(err as Error).message}`)
      }
      await runtime.unloadAll()
    }
  }

  console.log(healthy ? '\nAll checks passed.' : '\nSome checks failed.')
  return healthy
}
