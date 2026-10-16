import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelStore, writeManifest } from '../../src/core/model-store.js'
import { ModelDoesNotFitError, QvacRuntime } from '../../src/core/qvac.js'
import { FakeSdk } from './fake-sdk.js'

const GB = 1024 ** 3
let dir: string
let store: ModelStore

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-rt-'))
  const model = (name: string, size: number, engine = 'llamacpp-completion') => ({
    name,
    file: `${name}.bin`,
    size,
    sha256: 'x',
    addon: 'llm',
    engine
  })
  await writeManifest(dir, {
    sdkVersion: '0.21.0',
    createdAt: '',
    models: [model('A', 3 * GB), model('B', 3 * GB), model('C', 3 * GB), model('T', 1 * GB, 'tts-ggml'), model('S', 1 * GB)]
  })
  store = await ModelStore.open(dir)
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('QvacRuntime', () => {
  it('loads lazily from local paths with the manifest engine as modelType', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    const id = await rt.use({ name: 'A', config: { ctx_size: 2048 } }, async (modelId) => modelId)
    expect(id).toBe('id-1')
    expect(sdk.loads[0]).toEqual({
      modelSrc: path.join(dir, 'A.bin'),
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 2048 }
    })
    await rt.use({ name: 'A', config: { ctx_size: 2048 } }, async () => undefined)
    expect(sdk.loads).toHaveLength(1)
  })

  it('resolves companion models to local paths inside modelConfig', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    await rt.use({ name: 'T', config: { language: 'sw' }, companions: { s3genModelSrc: 'S' } }, async () => undefined)
    expect(sdk.loads[0]!.modelType).toBe('tts-ggml')
    expect(sdk.loads[0]!.modelConfig).toEqual({ language: 'sw', s3genModelSrc: path.join(dir, 'S.bin') })
    expect(rt.loaded()[0]!.bytes).toBe(2 * GB)
  })

  it('lists every model it loaded, companions included, with a hash prefix, even after unloading', async () => {
    const rt = new QvacRuntime(store, new FakeSdk(), { memoryBudgetBytes: 10 * GB })
    expect(rt.modelVersions()).toEqual([])
    await rt.use({ name: 'T', companions: { s3genModelSrc: 'S' } }, async () => undefined)
    await rt.use({ name: 'A' }, async () => undefined)
    await rt.unloadAll()
    expect(rt.modelVersions()).toEqual(['A@x', 'S@x', 'T@x'])
  })

  it('evicts the least recently used idle model to stay under budget', async () => {
    let clock = 0
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 7 * GB }, () => ++clock)
    await rt.use({ name: 'A' }, async () => undefined)
    await rt.use({ name: 'B' }, async () => undefined)
    await rt.use({ name: 'A' }, async () => undefined) // A is now more recent than B
    await rt.use({ name: 'C' }, async () => undefined)
    expect(sdk.unloads).toEqual(['id-2'])
    expect(rt.loaded().map((m) => m.name).sort()).toEqual(['A', 'C'])
  })

  it('caps the budget at a share of system memory', async () => {
    const sdk = new FakeSdk()
    sdk.memory = 8 * GB
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    expect(await rt.budget()).toBeCloseTo(5.6 * GB)
  })

  it('refuses a model that cannot fit even after evicting idle ones', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 2 * GB })
    await expect(rt.use({ name: 'A' }, async () => undefined)).rejects.toThrow(ModelDoesNotFitError)
    expect(sdk.loads).toHaveLength(0)
  })

  it('never evicts a model that is in use', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 4 * GB })
    let release!: () => void
    const busy = rt.use({ name: 'A' }, () => new Promise<void>((r) => (release = r)))
    await new Promise((r) => setTimeout(r, 0))
    await expect(rt.use({ name: 'B' }, async () => undefined)).rejects.toThrow(ModelDoesNotFitError)
    release()
    await busy
    expect(sdk.unloads).toEqual([])
  })

  it('serializes requests to the same model', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    const order: string[] = []
    const job = (tag: string, ms: number) =>
      rt.use({ name: 'A' }, async () => {
        order.push(`${tag}:start`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`${tag}:end`)
      })
    await Promise.all([job('1', 20), job('2', 0)])
    expect(order).toEqual(['1:start', '1:end', '2:start', '2:end'])
  })

  it('admits concurrent loads of different models within budget', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 4 * GB })
    const results = await Promise.allSettled([
      rt.use({ name: 'A' }, async () => new Promise((r) => setTimeout(r, 10))),
      rt.use({ name: 'B' }, async () => undefined)
    ])
    // A is busy when B is admitted, so B must be refused rather than overcommit.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(sdk.loads).toHaveLength(1)
  })

  it('gives each loaded instance fresh state, even when the reload reuses the model id', async () => {
    const sdk = new FakeSdk()
    sdk.stableIds = true
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    await rt.use({ name: 'A' }, async (_id, state) => {
      state.language = 'sw'
    })
    expect(await rt.use({ name: 'A' }, async (_id, state) => state.language)).toBe('sw')
    await rt.unloadAll()
    const [id, language] = await rt.use({ name: 'A' }, async (id, state) => [id, state.language])
    expect(id).toBe('id-A')
    expect(language).toBeUndefined()
  })

  it('keeps the queue usable after a request fails', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    await expect(
      rt.use({ name: 'A' }, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(rt.use({ name: 'A' }, async () => 'ok')).resolves.toBe('ok')
  })

  it('forgets a model whose load failed so it can be retried', async () => {
    const sdk = new FakeSdk()
    sdk.failNext = true
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    await expect(rt.use({ name: 'A' }, async () => undefined)).rejects.toThrow('load failed')
    expect(rt.loaded()).toHaveLength(0)
    await expect(rt.use({ name: 'A' }, async (id) => id)).resolves.toBe('id-1')
  })

  it('after a GPU allocation failure, frees the idle models, reloads this one and retries once', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    await rt.use({ name: 'B' }, async () => undefined)
    await rt.use({ name: 'T' }, async () => undefined)
    let calls = 0
    const ocr = async (id: string) => {
      calls++
      if (calls === 1) throw new Error('StepDetectionInference: ggml_backend_graph_compute failed')
      return id
    }
    const id = await rt.use({ name: 'A' }, ocr, { retryOnGpuMemory: true })
    expect(calls).toBe(2)
    expect(rt.recoveries).toBe(1)
    expect(rt.loaded().map((m) => m.name)).toEqual(['A'])
    expect(sdk.loads.map((l) => path.basename(l.modelSrc))).toEqual(['B.bin', 'T.bin', 'A.bin', 'A.bin'])
    expect(id).toBe('id-4')
  })

  it('does not retry other errors, or calls that did not ask for it', async () => {
    const rt = new QvacRuntime(store, new FakeSdk(), { memoryBudgetBytes: 10 * GB })
    let calls = 0
    const failing = (message: string) => async () => {
      calls++
      throw new Error(message)
    }
    await expect(rt.use({ name: 'A' }, failing('bad input'), { retryOnGpuMemory: true })).rejects.toThrow('bad input')
    await expect(rt.use({ name: 'A' }, failing('ggml_backend_graph_compute failed'))).rejects.toThrow('graph_compute')
    expect(calls).toBe(2)
    expect(rt.recoveries).toBe(0)
  })

  it('runs an exclusive model alone: others finish, unload, and wait for it', async () => {
    const sdk = new FakeSdk()
    const rt = new QvacRuntime(store, sdk, { memoryBudgetBytes: 10 * GB })
    const order: string[] = []
    let releaseB!: () => void
    const bRunning = rt.use({ name: 'B' }, () => new Promise<void>((r) => (releaseB = () => (order.push('B done'), r()))))
    await new Promise((r) => setTimeout(r, 0))
    let releaseA!: () => void
    const aRunning = rt.use({ name: 'A', exclusive: true }, () => {
      order.push(`A runs beside ${rt.loaded().map((m) => m.name).join(',')}`)
      return new Promise<void>((r) => (releaseA = r))
    })
    const cWaiting = rt.use({ name: 'C' }, async () => void order.push('C runs'))
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([])
    releaseB()
    await bRunning
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['B done', 'A runs beside A'])
    releaseA()
    await Promise.all([aRunning, cWaiting])
    expect(order).toEqual(['B done', 'A runs beside A', 'C runs'])
    expect(rt.loaded().map((m) => m.name).sort()).toEqual(['A', 'C'])
  })
})
