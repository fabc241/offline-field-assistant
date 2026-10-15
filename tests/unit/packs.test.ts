import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeWav } from '../../src/core/audio.js'
import { PROJECT_ROOT } from '../../src/core/config.js'
import { parseCsvTable } from '../../src/core/csv.js'
import type { EmbedTask, Embedder } from '../../src/core/engines.js'
import { ArchiveError, readArchive, writeArchive } from '../../src/features/packs/archive.js'
import { buildPack, signPack } from '../../src/features/packs/build.js'
import { PackSourceError, readPackSource } from '../../src/features/packs/content.js'
import { cardEmbeddingText } from '../../src/features/packs/embeddings.js'
import { PackError, PackLoader, parseArchive, type PackProblem } from '../../src/features/packs/loader.js'
import { canonicalJson, compareVersions, sha256Hex, type PackManifest } from '../../src/features/packs/manifest.js'
import { generateSigningKey, loadPrivateKey, signManifest, trustedKey } from '../../src/features/packs/signing.js'
import { PackStore } from '../../src/features/packs/store.js'
import { TRUSTED_PACK_KEYS } from '../../src/features/packs/trusted-keys.js'

/** Deterministic 8-dimensional vectors from a hash of the text. */
class HashEmbedder implements Embedder {
  calls: { texts: string[]; task: EmbedTask }[] = []
  async embed(texts: string[], task: EmbedTask) {
    this.calls.push({ texts, task })
    return texts.map((t) => [...createHash('sha256').update(t).digest().subarray(0, 8)].map((b) => b / 255))
  }
}

const MODEL = { name: 'EMBEDDINGGEMMA_300M_Q8_0', sha256: 'a'.repeat(64) }
const OTHER_MODEL_SHA = 'b'.repeat(64)

const CARDS_HEADER = 'id,title_en,title_sw,danger_signs_en,danger_signs_sw,steps_en,steps_sw,tags,source,version'
const PHRASES_HEADER = 'id,category,en,sw,audio_en,audio_sw,vetted_by'

interface SourceFiles {
  pack?: object
  cards?: string[]
  phrases?: string[]
  /** Relative path → WAV bytes (or raw bytes). */
  files?: Record<string, Uint8Array>
}

const tiny = () => encodeWav(Float32Array.from({ length: 160 }, (_, i) => Math.sin(i / 4) * 0.5), 16_000)

let tmp: string
let n = 0
async function writeSource(src: SourceFiles = {}): Promise<string> {
  const dir = path.join(tmp, `src-${++n}`)
  await fs.mkdir(path.join(dir, 'recordings'), { recursive: true })
  const pack = src.pack ?? { id: 'test-pack', title: 'Test pack', version: '1.0.0', notice: 'PLACEHOLDER' }
  await fs.writeFile(path.join(dir, 'pack.json'), JSON.stringify(pack))
  const cards = src.cards ?? [
    'fever,Fever,Homa,Convulsions | Stiff neck,Degedege | Shingo imekakamaa,Give fluids,Mpe maji,fever|child,PLACEHOLDER,1',
    'burns,Burns,Kuungua moto,Burn on the face,Kuungua usoni,Cool with water | Cover it,Poza kwa maji | Funika,burns,PLACEHOLDER,2'
  ]
  const phrases = src.phrases ?? [
    'greet,greeting,Hello.,Habari.,recordings/hello-en.wav,recordings/hello-sw.wav,PLACEHOLDER',
    'wait,instructions,Please wait here.,Tafadhali subiri hapa.,,,PLACEHOLDER'
  ]
  await fs.writeFile(path.join(dir, 'cards.csv'), [CARDS_HEADER, ...cards].join('\n') + '\n')
  await fs.writeFile(path.join(dir, 'phrases.csv'), [PHRASES_HEADER, ...phrases].join('\n') + '\n')
  const files = src.files ?? { 'recordings/hello-en.wav': tiny(), 'recordings/hello-sw.wav': tiny() }
  for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(dir, name), data)
  return dir
}

const devKey = generateSigningKey()
const devPrivate = loadPrivateKey(devKey.privateKeyPem)
const trusted = [trustedKey('test key', devKey.publicKeyPem)]

async function signedPack(src: SourceFiles = {}, opts: { embedder?: Embedder; sha256?: string } = {}) {
  const built = await buildPack(await writeSource(src), {
    embedder: opts.embedder ?? new HashEmbedder(),
    embeddingModel: { ...MODEL, sha256: opts.sha256 ?? MODEL.sha256 },
    now: new Date('2026-10-15T08:00:00Z')
  })
  return signPack(built.bytes, devPrivate).bytes
}

/** Re-packs a signed pack with a changed manifest, re-hashing nothing and re-signing with `key` (if given). */
function withManifest(pack: Uint8Array, change: (m: PackManifest) => void, key = devPrivate): Buffer {
  const entries = parseArchive(pack)
  const manifest = JSON.parse(Buffer.from(entries.get('manifest.json')!).toString()) as PackManifest
  change(manifest)
  const manifestBytes = Buffer.from(canonicalJson(manifest))
  return writeArchive([
    { name: 'manifest.json', data: manifestBytes },
    { name: 'manifest.sig', data: Buffer.from(canonicalJson(signManifest(manifestBytes, key))) },
    ...[...entries].filter(([n]) => !n.startsWith('manifest.')).map(([name, data]) => ({ name, data }))
  ])
}

async function problemOf(promise: Promise<unknown>): Promise<PackProblem | 'accepted'> {
  try {
    await promise
    return 'accepted'
  } catch (err) {
    if (err instanceof PackError) return err.problem
    throw err
  }
}

const loader = new PackLoader({ trustedKeys: trusted })

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-packs-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('archive', () => {
  it('round-trips entries in order', () => {
    const entries = [
      { name: 'a.json', data: Buffer.from('{}') },
      { name: 'audio/x.wav', data: Buffer.from([0, 1, 2, 255]) },
      { name: 'empty', data: Buffer.alloc(0) }
    ]
    expect(readArchive(writeArchive(entries))).toEqual(entries)
  })

  it('refuses unsafe names on both ends', () => {
    for (const name of ['../evil', '/etc/passwd', 'a//b', 'a/./b', 'dir/', 'a\\b', 'C:x', '']) {
      expect(() => writeArchive([{ name, data: Buffer.alloc(1) }]), name).toThrow(ArchiveError)
    }
    // Same length as a safe name, so only the name check can catch it.
    const zip = writeArchive([{ name: 'xx/evil', data: Buffer.alloc(1) }])
    zip.write('../evil', 30, 'latin1')
    zip.write('../evil', zip.indexOf('xx/evil', 40), 'latin1')
    expect(() => readArchive(zip)).toThrow(/not a plain relative path/)
  })

  it('refuses trailing or leading bytes and duplicate entries', () => {
    const zip = writeArchive([{ name: 'a', data: Buffer.from('x') }])
    expect(() => readArchive(Buffer.concat([zip, Buffer.from([0])]))).toThrow(ArchiveError)
    expect(() => readArchive(Buffer.concat([Buffer.from([0]), zip]))).toThrow(ArchiveError)
    expect(() => writeArchive([{ name: 'a', data: Buffer.alloc(0) }, { name: 'a', data: Buffer.alloc(0) }])).toThrow(/Duplicate/)
  })
})

describe('pack source', () => {
  it('reads the shipped sample, every item marked as placeholder', async () => {
    const { info, content, audio } = await readPackSource(path.join(PROJECT_ROOT, 'content/sample'))
    expect(info.id).toBe('sample-intake')
    expect(content.cards).toHaveLength(10)
    expect(content.phrases).toHaveLength(30)
    expect(audio.size).toBe(0)
    expect(info.notice).toMatch(/NOT CLINICALLY VETTED/)
    for (const c of content.cards) expect(c.source).toMatch(/PLACEHOLDER – NOT CLINICALLY VETTED/)
    for (const p of content.phrases) expect(p.vettedBy).toMatch(/PLACEHOLDER – NOT CLINICALLY VETTED/)
  })

  it('turns CSV rows into bilingual cards and phrases', async () => {
    const { content, audio } = await readPackSource(await writeSource())
    expect(content.cards[0]).toEqual({
      id: 'fever',
      title: { en: 'Fever', sw: 'Homa' },
      dangerSigns: { en: ['Convulsions', 'Stiff neck'], sw: ['Degedege', 'Shingo imekakamaa'] },
      steps: { en: ['Give fluids'], sw: ['Mpe maji'] },
      tags: ['fever', 'child'],
      source: 'PLACEHOLDER',
      version: 1
    })
    expect(content.phrases[0]!.audio).toEqual({ en: 'audio/greet.en.wav', sw: 'audio/greet.sw.wav' })
    expect(content.phrases[1]!.audio).toEqual({})
    expect([...audio.keys()].sort()).toEqual(['audio/greet.en.wav', 'audio/greet.sw.wav'])
  })

  it('reports every problem at once, by file, row and column', async () => {
    const dir = await writeSource({
      pack: { id: 'Bad Id', title: 'T', version: '1.0' },
      cards: [
        'fever,Fever,,Convulsions,Degedege,Give fluids,Mpe maji,fever,src,1',
        'fever,Fever,Homa,Convulsions | Stiff neck,Degedege,Give fluids,Mpe maji,fever,src,1',
        'cough,Cough,Kikohozi,,,Count breaths,Hesabu pumzi,cough,src,one',
        'extra,Extra,Ziada,a,b,c,d,e,f,1,too-many'
      ],
      phrases: [
        'p1,greeting,Hi.,Habari.,recordings/missing.wav,,src',
        'p2,greeting,Hi.,Habari.,../outside.wav,,src',
        'p3,greeting,Hi.,Habari.,recordings/not-audio.wav,,src',
        'p4,greeting,Hi.,Habari.,,,'
      ],
      files: { 'recordings/not-audio.wav': Buffer.from('hello') }
    })
    const err = await readPackSource(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PackSourceError)
    const problems = (err as PackSourceError).problems.join('\n')
    expect(problems).toMatch(/pack\.json: id lowercase/)
    expect(problems).toMatch(/pack\.json: version MAJOR\.MINOR\.PATCH/)
    expect(problems).toMatch(/cards\.csv row 1 \(fever\): title_sw must not be empty/)
    expect(problems).toMatch(/cards\.csv row 2 \(fever\): dangerSigns has 2 items in en but 1 in sw/)
    expect(problems).toMatch(/cards\.csv row 3 \(cough\): danger_signs_en needs at least one danger sign/)
    expect(problems).toMatch(/cards\.csv row 3 \(cough\): version must be a whole number/)
    expect(problems).toMatch(/cards\.csv row 4 \(extra\): has 11 fields, the header has 10/)
    expect(problems).toMatch(/cards\.csv row 2 \(fever\): id "fever" is used more than once/)
    expect(problems).toMatch(/phrases\.csv row 1 \(p1\): audio_en: "recordings\/missing\.wav" not found/)
    expect(problems).toMatch(/phrases\.csv row 2 \(p2\): audio_en: "\.\.\/outside\.wav" must be a relative path inside/)
    expect(problems).toMatch(/phrases\.csv row 3 \(p3\): audio_en: "recordings\/not-audio\.wav" is not a readable WAV/)
    expect(problems).toMatch(/phrases\.csv row 4 \(p4\): vetted_by must not be empty/)
  })

  it('names missing and unknown columns', async () => {
    const dir = await writeSource()
    await fs.writeFile(path.join(dir, 'phrases.csv'), 'id,category,en,sw,audio_en,vetted_by,notes\n')
    const err = (await readPackSource(dir).catch((e: unknown) => e)) as PackSourceError
    expect(err.problems).toEqual(['phrases.csv: missing column audio_sw', 'phrases.csv: unknown column notes'])
  })

  it('accepts a spreadsheet export with a byte-order mark and CRLF line ends', async () => {
    const dir = await writeSource()
    const csv = await fs.readFile(path.join(dir, 'cards.csv'), 'utf8')
    await fs.writeFile(path.join(dir, 'cards.csv'), '﻿' + csv.replace(/\n/g, '\r\n'))
    expect((await readPackSource(dir)).content.cards).toHaveLength(2)
    expect(parseCsvTable('﻿a,b\r\n1,2\r\n').header).toEqual(['a', 'b'])
  })
})

describe('build, sign and load', () => {
  it('round-trips the content, recordings and card vectors', async () => {
    const embedder = new HashEmbedder()
    const pack = await signedPack({}, { embedder })
    const loaded = await loader.verifyAndLoad(pack)

    expect(loaded.manifest).toMatchObject({ id: 'test-pack', version: '1.0.0', notice: 'PLACEHOLDER', kind: 'content' })
    expect(loaded.manifest.embedding).toMatchObject({ model: MODEL.name, sha256: MODEL.sha256, dims: 8 })
    expect(loaded.signedBy.keyId).toBe(devKey.keyId)
    expect(loaded.content.cards.map((c) => c.id)).toEqual(['fever', 'burns'])
    expect(Buffer.from(loaded.audio.get('audio/greet.sw.wav')!)).toEqual(Buffer.from(tiny()))
    expect(loaded.embeddings).toBe('packed')

    // Vectors survive the trip bit for bit, and were embedded as documents.
    const [expected] = await new HashEmbedder().embed([cardEmbeddingText(loaded.content.cards[1]!, 'sw')], 'document')
    expect([...loaded.vectors!.get('burns')!.sw]).toEqual([...Float32Array.from(expected!)])
    expect(embedder.calls.every((c) => c.task === 'document')).toBe(true)
    expect(embedder.calls.flatMap((c) => c.texts)).toHaveLength(4)
  })

  it('builds the shipped sample pack', async () => {
    const built = await buildPack(path.join(PROJECT_ROOT, 'content/sample'), { embedder: new HashEmbedder(), embeddingModel: MODEL })
    const loaded = await loader.verifyAndLoad(signPack(built.bytes, devPrivate).bytes)
    expect(loaded.content.cards).toHaveLength(10)
    expect(loaded.vectors!.size).toBe(10)
  })

  it('embeds the title, danger signs and steps of a card in one passage', async () => {
    const { content } = await readPackSource(await writeSource())
    expect(cardEmbeddingText(content.cards[0]!, 'en')).toBe('Fever. Convulsions. Stiff neck. Give fluids.')
  })

  it('rejects any single flipped byte, anywhere in the pack', async () => {
    const pack = await signedPack()
    const accepted: number[] = []
    for (let i = 0; i < pack.length; i++) {
      const bad = Buffer.from(pack)
      bad[i]! ^= 0x01
      if ((await problemOf(loader.verifyAndLoad(bad))) === 'accepted') accepted.push(i)
    }
    expect(accepted).toEqual([])
  })

  it('rejects any flipped byte of any file even when the archive CRCs are repaired', async () => {
    const entries = [...parseArchive(await signedPack())].map(([name, data]) => ({ name, data }))
    const accepted: string[] = []
    for (const [e, entry] of entries.entries()) {
      for (let i = 0; i < entry.data.length; i++) {
        const data = Buffer.from(entry.data)
        data[i]! ^= 0x01
        const bad = writeArchive(entries.map((x, j) => (j === e ? { name: x.name, data } : x)))
        if ((await problemOf(loader.verifyAndLoad(bad))) === 'accepted') accepted.push(`${entry.name}@${i}`)
      }
    }
    expect(accepted).toEqual([])
  })

  it('rejects an unsigned pack', async () => {
    const built = await buildPack(await writeSource(), { embedder: new HashEmbedder(), embeddingModel: MODEL })
    expect(await problemOf(loader.verifyAndLoad(built.bytes))).toBe('unsigned')
  })

  it('rejects a pack signed with a key the app does not trust', async () => {
    const stranger = loadPrivateKey(generateSigningKey().privateKeyPem)
    const pack = withManifest(await signedPack(), () => undefined, stranger)
    expect(await problemOf(loader.verifyAndLoad(pack))).toBe('unknown-key')
  })

  it('rejects a signature that claims a trusted key it was not made with', async () => {
    const pack = await signedPack()
    const entries = parseArchive(pack)
    const sig = JSON.parse(Buffer.from(entries.get('manifest.sig')!).toString())
    const stranger = loadPrivateKey(generateSigningKey().privateKeyPem)
    const forged = signManifest(entries.get('manifest.json')!, stranger)
    entries.set('manifest.sig', Buffer.from(canonicalJson({ ...forged, keyId: sig.keyId })))
    const bytes = writeArchive([...entries].map(([name, data]) => ({ name, data })))
    expect(await problemOf(loader.verifyAndLoad(bytes))).toBe('bad-signature')
  })

  it('rejects a manifest changed after signing', async () => {
    const pack = await signedPack()
    const entries = parseArchive(pack)
    const manifest = JSON.parse(Buffer.from(entries.get('manifest.json')!).toString()) as PackManifest
    entries.set('manifest.json', Buffer.from(canonicalJson({ ...manifest, version: '9.0.0' })))
    const bytes = writeArchive([...entries].map(([name, data]) => ({ name, data })))
    expect(await problemOf(loader.verifyAndLoad(bytes))).toBe('bad-signature')
  })

  it('rejects files that differ from, are missing from or are not in the manifest, even when signed', async () => {
    const pack = await signedPack()
    const swapped = withManifest(pack, (m) => {
      m.files.find((f) => f.path === 'content.json')!.sha256 = sha256Hex(Buffer.from('other'))
    })
    expect(await problemOf(loader.verifyAndLoad(swapped))).toBe('hash-mismatch')
    const missing = withManifest(pack, (m) => {
      m.files.push({ path: 'audio/ghost.en.wav', size: 0, sha256: sha256Hex(Buffer.alloc(0)) })
    })
    expect(await problemOf(loader.verifyAndLoad(missing))).toBe('missing-file')
    const unlisted = withManifest(pack, (m) => {
      m.files = m.files.filter((f) => f.path !== 'audio/greet.en.wav')
    })
    expect(await problemOf(loader.verifyAndLoad(unlisted))).toBe('unexpected-file')
  })

  it('will not sign a pack whose files do not match its manifest', async () => {
    const built = await buildPack(await writeSource(), { embedder: new HashEmbedder(), embeddingModel: MODEL })
    const entries = parseArchive(built.bytes)
    entries.set('content.json', Buffer.from('{"cards":[],"phrases":[]}'))
    const bytes = writeArchive([...entries].map(([name, data]) => ({ name, data })))
    expect(() => signPack(bytes, devPrivate)).toThrow(/does not match the sha256/)
  })

  it('rejects a version older than the given floor', async () => {
    const pack = await signedPack()
    expect(await problemOf(loader.verifyAndLoad(pack, { minVersion: '1.0.0' }))).toBe('accepted')
    expect(await problemOf(loader.verifyAndLoad(pack, { minVersion: '1.0.1' }))).toBe('downgrade')
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('recomputes card vectors when the device has another embedding model', async () => {
    const pack = await signedPack({}, { sha256: OTHER_MODEL_SHA })
    const deviceEmbedder = new HashEmbedder()
    const device = new PackLoader({ trustedKeys: trusted, embedding: { embedder: deviceEmbedder, sha256: MODEL.sha256 } })
    const loaded = await device.verifyAndLoad(pack)
    expect(loaded.embeddings).toBe('recomputed')
    expect(deviceEmbedder.calls.flatMap((c) => c.texts)).toHaveLength(4)
    expect(loaded.vectors!.get('fever')!.en).toHaveLength(8)

    const same = new HashEmbedder()
    const sameModel = new PackLoader({ trustedKeys: trusted, embedding: { embedder: same, sha256: OTHER_MODEL_SHA } })
    expect((await sameModel.verifyAndLoad(pack)).embeddings).toBe('packed')
    expect(same.calls).toHaveLength(0)
  })

  it('trusts the development key, named by its own public key', () => {
    expect(TRUSTED_PACK_KEYS.map((k) => k.keyId)).toEqual(['af9afd9a72d9ad17'])
  })
})

describe('PackStore', () => {
  it('installs, lists and reloads a pack, and refuses to go back a version', async () => {
    const dir = path.join(tmp, 'installed')
    const store = new PackStore(dir, loader)
    const v1 = path.join(tmp, 'v1.ofapack')
    const v2 = path.join(tmp, 'v2.ofapack')
    await fs.writeFile(v1, await signedPack())
    await fs.writeFile(v2, await signedPack({ pack: { id: 'test-pack', title: 'Test pack', version: '1.1.0' } }))

    await store.install(v1)
    await store.install(v2)
    expect(await store.list()).toEqual([{ id: 'test-pack', version: '1.1.0', file: path.join(dir, 'test-pack.ofapack') }])
    expect((await store.load('test-pack')).manifest.version).toBe('1.1.0')
    expect(await problemOf(store.install(v1))).toBe('downgrade')

    // Deleting the newer pack does not reopen the door to the older one.
    await fs.rm(path.join(dir, 'test-pack.ofapack'))
    expect(await problemOf(store.install(v1))).toBe('downgrade')
    // Nor does copying the older pack over the installed file.
    await fs.copyFile(v1, path.join(dir, 'test-pack.ofapack'))
    expect(await problemOf(store.load('test-pack'))).toBe('downgrade')
  })
})
