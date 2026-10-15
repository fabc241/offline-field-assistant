/**
 * F5 against the real embedding model (npm run fetch-models first): builds
 * the shipped sample pack, signs it, loads it, and recomputes its vectors.
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MODEL_SPECS } from '../../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../../src/core/config.js'
import { qvacEmbedder } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { buildPack, signPack } from '../../src/features/packs/build.js'
import { PackLoader } from '../../src/features/packs/loader.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../../src/features/packs/signing.js'
import { cosine } from '../../src/features/translate/checks.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const spec = MODEL_SPECS.embedder
const installed = store.has(spec.name)

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
})

describe.skipIf(!installed)('content pack with EmbeddingGemma', { timeout: 120_000 }, () => {
  it('builds, signs and loads the sample pack, with vectors that match on recompute', async () => {
    const embedder = qvacEmbedder(runtime, spec)
    const sha256 = store.entry(spec.name).sha256
    const built = await buildPack(path.join(PROJECT_ROOT, 'content/sample'), { embedder, embeddingModel: { name: spec.name, sha256 } })
    const key = generateSigningKey()
    const pack = signPack(built.bytes, loadPrivateKey(key.privateKeyPem)).bytes
    const trustedKeys = [trustedKey('test', key.publicKeyPem)]

    const loaded = await new PackLoader({ trustedKeys, embedding: { embedder, sha256 } }).verifyAndLoad(pack)
    expect(loaded.embeddings).toBe('packed')
    expect(loaded.manifest.embedding.dims).toBe(768)
    const fever = loaded.vectors!.get('fever-child')!
    expect(Math.hypot(...fever.en)).toBeCloseTo(1, 3)
    // The same card in the other language lands nearer than an unrelated card.
    expect(cosine([...fever.sw], [...fever.en])).toBeGreaterThan(cosine([...fever.sw], [...loaded.vectors!.get('burns')!.en]))

    const other = new PackLoader({ trustedKeys, embedding: { embedder, sha256: '0'.repeat(64) } })
    const recomputed = await other.verifyAndLoad(pack)
    expect(recomputed.embeddings).toBe('recomputed')
    expect(cosine([...recomputed.vectors!.get('fever-child')!.sw], [...fever.sw])).toBeGreaterThan(0.9999)
  })
})
