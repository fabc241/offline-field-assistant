import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ModelStore, writeManifest, type ManifestEntry } from '../../src/core/model-store.js'
import {
  FILES_DIR,
  buildModelPack,
  installModelPack,
  installedModelPack,
  openModelPack,
  signModelPack,
  verifyModelPack
} from '../../src/features/models/model-pack.js'
import { readArchive } from '../../src/features/packs/archive.js'
import { buildPack, signPack } from '../../src/features/packs/build.js'
import { PackError, type PackProblem } from '../../src/features/packs/loader.js'
import { canonicalJson } from '../../src/features/packs/manifest.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../../src/features/packs/signing.js'

const key = generateSigningKey()
const privateKey = loadPrivateKey(key.privateKeyPem)
const TRUSTED = [trustedKey('test key', key.publicKeyPem)]
const other = generateSigningKey()

let tmp: string
let n = 0
const fresh = (name: string) => path.join(tmp, `${name}-${++n}`)

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** A models directory like fetch-models writes, with small stand-in files. */
async function modelsDir(files: Record<string, string>): Promise<string> {
  const dir = fresh('models')
  await fs.mkdir(dir, { recursive: true })
  const models: ManifestEntry[] = []
  for (const [name, content] of Object.entries(files)) {
    const file = `${name.toLowerCase()}.bin`
    const data = Buffer.from(content)
    await fs.writeFile(path.join(dir, file), data)
    models.push({ name, file, size: data.length, sha256: sha(data), addon: 'llm', engine: 'llamacpp-completion' })
  }
  await writeManifest(dir, { sdkVersion: '0.21.0', createdAt: '2026-10-01T00:00:00.000Z', models })
  return dir
}

async function signedPack(files: Record<string, string>, opts: { version?: string; id?: string } = {}): Promise<string> {
  const src = await modelsDir(files)
  const out = fresh('pack')
  await buildModelPack({
    modelsDir: src,
    outDir: out,
    names: Object.keys(files),
    id: opts.id ?? 'test-models',
    title: 'Test models',
    version: opts.version ?? '1.0.0',
    sdkVersion: '0.21.0',
    now: new Date('2026-10-16T00:00:00.000Z')
  })
  await signModelPack(out, privateKey)
  return out
}

async function problemOf(p: Promise<unknown>): Promise<PackProblem | string> {
  try {
    await p
    return 'accepted'
  } catch (err) {
    return err instanceof PackError ? err.problem : `other: ${(err as Error).message}`
  }
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-model-pack-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('model pack build and sign', () => {
  it('copies the listed models and writes a canonical manifest', async () => {
    const dir = await signedPack({ A_MODEL: 'aaaa', B_MODEL: 'bbbbbb' })
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
    expect(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')).toBe(canonicalJson(manifest))
    expect(manifest).toMatchObject({ format: 1, kind: 'models', id: 'test-models', version: '1.0.0', sdkVersion: '0.21.0' })
    expect(manifest.models.map((m: { name: string }) => m.name)).toEqual(['A_MODEL', 'B_MODEL'])
    expect(await fs.readFile(path.join(dir, FILES_DIR, 'a_model.bin'), 'utf8')).toBe('aaaa')
    const pack = await verifyModelPack(dir, TRUSTED)
    expect(pack.signedBy.label).toBe('test key')
  })

  it('refuses to pack a model whose file differs from the models manifest', async () => {
    const src = await modelsDir({ A_MODEL: 'aaaa' })
    await fs.writeFile(path.join(src, 'a_model.bin'), 'aaab')
    await expect(
      buildModelPack({ modelsDir: src, outDir: fresh('pack'), names: ['A_MODEL'], id: 'x', title: 'x', version: '1.0.0', sdkVersion: '0.21.0' })
    ).rejects.toThrow(/sha256/)
  })

  it('refuses to sign a pack whose files were changed after it was built', async () => {
    const src = await modelsDir({ A_MODEL: 'aaaa' })
    const out = fresh('pack')
    await buildModelPack({ modelsDir: src, outDir: out, names: ['A_MODEL'], id: 'x', title: 'x', version: '1.0.0', sdkVersion: '0.21.0' })
    await fs.writeFile(path.join(out, FILES_DIR, 'a_model.bin'), 'aaab')
    expect(await problemOf(signModelPack(out, privateKey))).toBe('hash-mismatch')
  })
})

describe('model pack verification', () => {
  it('rejects an unsigned pack, an unknown key and an edited manifest', async () => {
    const dir = await signedPack({ A_MODEL: 'aaaa' })
    const sig = await fs.readFile(path.join(dir, 'manifest.sig'))

    await fs.rm(path.join(dir, 'manifest.sig'))
    expect(await problemOf(openModelPack(dir, TRUSTED))).toBe('unsigned')
    await fs.writeFile(path.join(dir, 'manifest.sig'), sig)
    expect(await problemOf(openModelPack(dir, [trustedKey('other', other.publicKeyPem)]))).toBe('unknown-key')

    const manifest = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')
    await fs.writeFile(path.join(dir, 'manifest.json'), manifest.replace('"1.0.0"', '"9.0.0"'))
    expect(await problemOf(openModelPack(dir, TRUSTED))).toBe('bad-signature')
  })

  it('rejects every single-byte change to the manifest or the signature', async () => {
    const dir = await signedPack({ A_MODEL: 'aaaa' })
    for (const name of ['manifest.json', 'manifest.sig']) {
      const file = path.join(dir, name)
      const original = await fs.readFile(file)
      for (let i = 0; i < original.length; i++) {
        const copy = Buffer.from(original)
        copy[i] = copy[i]! ^ 0x01
        await fs.writeFile(file, copy)
        expect(await problemOf(openModelPack(dir, TRUSTED)), `${name} byte ${i}`).not.toBe('accepted')
      }
      await fs.writeFile(file, original)
    }
    expect(await problemOf(openModelPack(dir, TRUSTED))).toBe('accepted')
  })

  it('finds missing, resized, altered and unlisted files; ignores Finder litter', async () => {
    const dir = await signedPack({ A_MODEL: 'aaaa', B_MODEL: 'bbbb' })
    const a = path.join(dir, FILES_DIR, 'a_model.bin')
    await fs.writeFile(path.join(dir, FILES_DIR, '.DS_Store'), 'x')
    await fs.writeFile(path.join(dir, FILES_DIR, '._a_model.bin'), 'x')
    expect(await problemOf(verifyModelPack(dir, TRUSTED))).toBe('accepted')

    await fs.writeFile(a, 'aaab')
    expect(await problemOf(openModelPack(dir, TRUSTED))).toBe('accepted') // same size: only hashing finds it
    expect(await problemOf(verifyModelPack(dir, TRUSTED))).toBe('hash-mismatch')
    await fs.writeFile(a, 'aaaaa')
    expect(await problemOf(openModelPack(dir, TRUSTED))).toBe('hash-mismatch')
    await fs.rm(a)
    expect(await problemOf(openModelPack(dir, TRUSTED))).toBe('missing-file')
    await fs.writeFile(a, 'aaaa')
    await fs.writeFile(path.join(dir, FILES_DIR, 'extra.bin'), 'x')
    expect(await problemOf(openModelPack(dir, TRUSTED))).toBe('unexpected-file')
  })

  it('does not take a signed content pack manifest for a model pack', async () => {
    const dir = fresh('content')
    await fs.mkdir(path.join(dir, 'recordings'), { recursive: true })
    await fs.writeFile(path.join(dir, 'pack.json'), JSON.stringify({ id: 'c', title: 'C', version: '1.0.0' }))
    await fs.writeFile(
      path.join(dir, 'cards.csv'),
      'id,title_en,title_sw,danger_signs_en,danger_signs_sw,steps_en,steps_sw,tags,source,version\nf,F,H,D,D,S,S,t,src,1\n'
    )
    await fs.writeFile(path.join(dir, 'phrases.csv'), 'id,category,en,sw,audio_en,audio_sw,vetted_by\n')
    const built = await buildPack(dir, {
      embedder: { embed: async (texts) => texts.map(() => [1, 0]) },
      embeddingModel: { name: 'E', sha256: 'a'.repeat(64) }
    })
    const { bytes } = signPack(built.bytes, privateKey)
    const entries = readArchive(bytes)
    const fake = fresh('fake')
    await fs.mkdir(path.join(fake, FILES_DIR), { recursive: true })
    for (const e of entries) if (e.name.startsWith('manifest.')) await fs.writeFile(path.join(fake, e.name), e.data)
    expect(await problemOf(openModelPack(fake, TRUSTED))).toBe('malformed')
  })
})

describe('model pack install', () => {
  it('installs the models and a manifest the runtime reads, then keeps unchanged files on reinstall', async () => {
    const pack = await signedPack({ A_MODEL: 'aaaa', B_MODEL: 'bbbb' })
    const dest = fresh('installed')
    const first = await installModelPack(pack, dest, { trustedKeys: TRUSTED })
    expect(first.copied).toEqual(['A_MODEL', 'B_MODEL'])
    expect(first.bytesCopied).toBe(8)

    const store = await ModelStore.open(dest)
    expect((await store.verify('A_MODEL', { full: true })).status).toBe('ok')
    expect(store.resolve('B_MODEL')).toBe(path.join(dest, 'b_model.bin'))
    expect(await installedModelPack(dest, TRUSTED)).toMatchObject({ status: 'signed', manifest: { id: 'test-models', version: '1.0.0' } })
    expect(await fs.readdir(dest)).not.toContain('.incoming')

    const again = await installModelPack(pack, dest, { trustedKeys: TRUSTED })
    expect(again).toMatchObject({ copied: [], kept: ['A_MODEL', 'B_MODEL'], bytesCopied: 0 })
  })

  it('refuses a file changed after signing and leaves the installed models as they were', async () => {
    const v1 = await signedPack({ A_MODEL: 'aaaa', B_MODEL: 'bbbb' })
    const dest = fresh('installed')
    await installModelPack(v1, dest, { trustedKeys: TRUSTED })

    const v2 = await signedPack({ A_MODEL: 'AAAA', B_MODEL: 'BBBB' }, { version: '1.1.0' })
    await fs.writeFile(path.join(v2, FILES_DIR, 'b_model.bin'), 'BBBX') // same size: caught while copying
    expect(await problemOf(installModelPack(v2, dest, { trustedKeys: TRUSTED }))).toBe('hash-mismatch')
    expect(await fs.readFile(path.join(dest, 'a_model.bin'), 'utf8')).toBe('aaaa')
    expect(await installedModelPack(dest, TRUSTED)).toMatchObject({ status: 'signed', manifest: { version: '1.0.0' } })
    expect(await fs.readdir(dest)).not.toContain('.incoming')
  })

  it('refuses an older version and removes models a newer pack dropped', async () => {
    const dest = fresh('installed')
    await installModelPack(await signedPack({ A_MODEL: 'aaaa', B_MODEL: 'bbbb' }, { version: '1.2.0' }), dest, { trustedKeys: TRUSTED })
    await fs.writeFile(path.join(dest, 'notes.txt'), 'not from a pack')

    expect(await problemOf(installModelPack(await signedPack({ A_MODEL: 'aaaa' }, { version: '1.1.9' }), dest, { trustedKeys: TRUSTED }))).toBe('downgrade')

    const v13 = await installModelPack(await signedPack({ A_MODEL: 'aaaa', C_MODEL: 'cc' }, { version: '1.3.0' }), dest, { trustedKeys: TRUSTED })
    expect(v13).toMatchObject({ kept: ['A_MODEL'], copied: ['C_MODEL'], removed: ['B_MODEL'] })
    expect((await fs.readdir(dest)).sort()).toEqual(
      ['a_model.bin', 'c_model.bin', 'manifest.json', 'model-pack-versions.json', 'model-pack.json', 'model-pack.sig', 'notes.txt'].sort()
    )
  })

  it('reports an installed record that no longer matches the models manifest', async () => {
    const dest = fresh('installed')
    await installModelPack(await signedPack({ A_MODEL: 'aaaa' }), dest, { trustedKeys: TRUSTED })
    const store = JSON.parse(await fs.readFile(path.join(dest, 'manifest.json'), 'utf8'))
    store.models[0].sha256 = 'f'.repeat(64)
    await fs.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(store))
    expect(await installedModelPack(dest, TRUSTED)).toMatchObject({ status: 'invalid' })
    expect(await installedModelPack(fresh('empty'), TRUSTED)).toEqual({ status: 'none' })
  })
})
