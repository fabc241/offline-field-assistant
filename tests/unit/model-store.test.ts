import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelNotInstalledError, ModelStore, assertLocalSource, writeManifest } from '../../src/core/model-store.js'

let dir: string
const content = Buffer.from('fake model weights')
const sha = createHash('sha256').update(content).digest('hex')

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-store-'))
  await fs.writeFile(path.join(dir, 'a.gguf'), content)
  await writeManifest(dir, {
    sdkVersion: '0.21.0',
    createdAt: '2026-10-13T00:00:00.000Z',
    models: [{ name: 'A', file: 'a.gguf', size: content.length, sha256: sha, addon: 'llm', engine: 'llamacpp-completion' }]
  })
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('ModelStore', () => {
  it('resolves manifest models to absolute local paths', async () => {
    const store = await ModelStore.open(dir)
    expect(store.resolve('A')).toBe(path.join(dir, 'a.gguf'))
    expect(store.sizeOf(['A'])).toBe(content.length)
  })

  it('throws a helpful error for models not in the manifest', async () => {
    const store = await ModelStore.open(dir)
    expect(() => store.resolve('B')).toThrow(ModelNotInstalledError)
  })

  it('treats a missing manifest as an empty store', async () => {
    const store = await ModelStore.open(path.join(dir, 'nope'))
    expect(store.has('A')).toBe(false)
  })

  it('verifies size and sha256', async () => {
    const store = await ModelStore.open(dir)
    expect((await store.verify('A', { full: true })).status).toBe('ok')

    await fs.writeFile(path.join(dir, 'a.gguf'), Buffer.from('fake model weightz'))
    expect((await store.verify('A')).status).toBe('ok') // same size, quick check passes
    expect((await store.verify('A', { full: true })).status).toBe('hash-mismatch')

    await fs.writeFile(path.join(dir, 'a.gguf'), 'short')
    expect((await store.verify('A')).status).toBe('size-mismatch')

    await fs.rm(path.join(dir, 'a.gguf'))
    expect((await store.verify('A')).status).toBe('missing')
  })
})

describe('assertLocalSource', () => {
  it.each(['registry://s3/x.gguf', 'https://huggingface.co/x.gguf', 'pear://key/x.gguf', 'models/x.gguf'])(
    'rejects %s',
    (src) => expect(() => assertLocalSource(src)).toThrow(/non-local/)
  )

  it('accepts absolute paths', () => {
    expect(() => assertLocalSource('/Users/x/models/a.gguf')).not.toThrow()
  })
})
