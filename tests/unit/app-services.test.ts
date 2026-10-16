import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppEvent, Channel, Envelope, RequestOf, Responses } from '../../src/app/contract.js'
import { createDispatcher, type Dispatch } from '../../src/app/dispatch.js'
import { AppServices } from '../../src/app/services.js'
import { encodeWav } from '../../src/core/audio.js'
import { MODEL_CATALOG } from '../../src/core/catalog.js'
import { loadConfig, type AppConfig } from '../../src/core/config.js'
import { writeManifest, type ManifestEntry } from '../../src/core/model-store.js'
import type { TranslateRequest } from '../../src/core/qvac.js'
import { buildModelPack, signModelPack } from '../../src/features/models/model-pack.js'
import { buildPack, signPack } from '../../src/features/packs/build.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../../src/features/packs/signing.js'
import type { SecretVault } from '../../src/features/platform/keys.js'
import { LICENSE_FEATURES, issueLicense } from '../../src/features/platform/license.js'
import { openSession, type Session } from '../../src/features/platform/session.js'
import { FakeSdk } from './fake-sdk.js'

class MemoryVault implements SecretVault {
  name = 'memory vault'
  secret: Buffer | undefined
  async read() {
    return this.secret
  }
  async add(secret: Buffer) {
    if (this.secret) return false
    this.secret = secret
    return true
  }
  async delete() {
    this.secret = undefined
  }
}

/** Translates by tagging the text, so results are visible. */
class EchoSdk extends FakeSdk {
  override async translate(req: TranslateRequest) {
    return `[${req.to}] ${req.text}`
  }
}

const packKey = generateSigningKey()
const licenseKey = generateSigningKey()
const PACK_KEYS = [trustedKey('test pack key', packKey.publicKeyPem)]
const LICENSE_KEYS = [trustedKey('test license key', licenseKey.publicKeyPem)]

let tmp: string
let n = 0
const fresh = (name: string) => path.join(tmp, `${name}-${++n}`)
const tone = (seconds = 1, rate = 16_000) => encodeWav(Float32Array.from({ length: rate * seconds }, (_, i) => Math.sin(i / 5) * 0.3), rate)

/** Fake model files for every runtime model, in a models directory the runtime reads. */
async function fakeModels(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const models: ManifestEntry[] = []
  for (const name of new Set(Object.values(MODEL_CATALOG))) {
    const data = Buffer.from(`fake ${name}`)
    const file = `${name.toLowerCase()}.bin`
    await fs.writeFile(path.join(dir, file), data)
    models.push({ name, file, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), addon: 'x', engine: 'x' })
  }
  await writeManifest(dir, { sdkVersion: '0.21.0', createdAt: '2026-10-01T00:00:00.000Z', models })
}

/** A signed content pack with one card and two phrases. */
async function contentPack(version = '1.0.0'): Promise<Uint8Array> {
  const dir = fresh('content')
  await fs.mkdir(path.join(dir, 'recordings'), { recursive: true })
  await fs.writeFile(path.join(dir, 'pack.json'), JSON.stringify({ id: 'test-pack', title: 'Test pack', version, notice: 'PLACEHOLDER' }))
  await fs.writeFile(
    path.join(dir, 'cards.csv'),
    'id,title_en,title_sw,danger_signs_en,danger_signs_sw,steps_en,steps_sw,tags,source,version\n' +
      'fever,Fever in a child,Homa kwa mtoto,Convulsions | Stiff neck,Degedege | Shingo imekakamaa,Give fluids,Mpe maji,fever|child,PLACEHOLDER,1\n'
  )
  await fs.writeFile(
    path.join(dir, 'phrases.csv'),
    'id,category,en,sw,audio_en,audio_sw,vetted_by\n' +
      'greet,greeting,Hello.,Habari.,recordings/hello-en.wav,recordings/hello-sw.wav,PLACEHOLDER\n' +
      'wait,instructions,Please wait here.,Tafadhali subiri hapa.,recordings/wait-en.wav,recordings/wait-sw.wav,PLACEHOLDER\n'
  )
  for (const f of ['hello-en', 'hello-sw', 'wait-en', 'wait-sw']) await fs.writeFile(path.join(dir, 'recordings', `${f}.wav`), tone(1))
  const built = await buildPack(dir, {
    embedder: { embed: async (texts) => texts.map(() => [1, 0]) },
    embeddingModel: { name: MODEL_CATALOG.embedder, sha256: 'a'.repeat(64) }
  })
  return signPack(built.bytes, loadPrivateKey(packKey.privateKeyPem)).bytes
}

interface App {
  config: AppConfig
  session: Session
  sdk: EchoSdk
  services: AppServices
  dispatch: Dispatch
  call<C extends Channel>(channel: C, request: RequestOf<C>, ctx?: Parameters<Dispatch>[2]): Promise<Envelope<Responses[C]>>
  ok<C extends Channel>(channel: C, request: RequestOf<C>): Promise<Responses[C]>
  records(): Promise<Record<string, unknown>[]>
}

async function app(opts: { license?: 'full' | 'none' | Partial<{ features: string[] }> } = {}): Promise<App> {
  const home = fresh('home')
  const config = loadConfig({ OFA_HOME: home })
  await fakeModels(config.modelsDir)
  if (opts.license !== 'none') {
    const features = typeof opts.license === 'object' && opts.license.features ? opts.license.features : [...LICENSE_FEATURES]
    await fs.mkdir(path.dirname(config.licenseFile), { recursive: true })
    await fs.writeFile(
      config.licenseFile,
      issueLicense(
        {
          format: 1,
          kind: 'license',
          id: 'test-license',
          licensee: 'Test clinic',
          seats: 1,
          issued: '2026-01-01T00:00:00.000Z',
          expiry: '2099-01-01T00:00:00.000Z',
          features: features as never
        },
        loadPrivateKey(licenseKey.privateKeyPem)
      )
    )
  }
  const vault = new MemoryVault()
  const session = await openSession(config, { vault, trustedLicenseKeys: LICENSE_KEYS })
  const sdk = new EchoSdk()
  const services = new AppServices({ config, session, sdk, trustedPackKeys: PACK_KEYS, trustedLicenseKeys: LICENSE_KEYS })
  const dispatch = createDispatcher(services, session)
  const call = ((channel: Channel, request: unknown, ctx?: Parameters<Dispatch>[2]) => dispatch(channel, request, ctx)) as App['call']
  return {
    config,
    session,
    sdk,
    services,
    dispatch,
    call,
    async ok(channel, request) {
      const r = await call(channel, request)
      if (!r.ok) throw new Error(`${channel}: ${r.error.code} ${r.error.message}`)
      return r.value
    },
    async records() {
      await session.activity.flush()
      return (await session.log!.read()).entries.map((e) => e.record as Record<string, unknown>)
    }
  }
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-app-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('IPC contract checks', () => {
  it('refuses unknown channels and malformed requests before any service runs', async () => {
    const a = await app()
    expect(await a.dispatch('fs.read', {})).toMatchObject({ ok: false, error: { code: 'unknown-channel' } })
    expect(await a.dispatch('__proto__', {})).toMatchObject({ ok: false, error: { code: 'unknown-channel' } })
    const bad: [Channel, unknown][] = [
      ['translate.text', { text: 'hi', from: 'en' }],
      ['translate.text', { text: 'hi', from: 'en', to: 'fr' }],
      ['translate.text', { text: '   ', from: 'en', to: 'sw' }],
      ['translate.text', { text: 'x'.repeat(5001), from: 'en', to: 'sw' }],
      ['translate.text', { text: 'hi', from: 'en', to: 'sw', extra: 1 }],
      ['speech.transcribe', { wav: 'not bytes', lang: 'sw' }],
      ['speech.transcribe', { wav: new Uint8Array(0), lang: 'sw' }],
      ['models.install', { dir: 'relative/path' }],
      ['logs.wipe', {}],
      ['logs.wipe', { confirm: 'yes' }],
      ['guide.search', { query: 'homa', pack: '../etc' }]
    ]
    for (const [channel, request] of bad) {
      expect(await a.dispatch(channel, request), `${channel} ${JSON.stringify(request)}`).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
    expect(a.sdk.loads).toEqual([])
    expect(await a.records()).toEqual([])
  })
})

describe('licensing over IPC', () => {
  it('opens only the guide and the phrasebook without a license, and records each refusal', async () => {
    const a = await app({ license: 'none' })
    await a.ok('packs.list', {})
    const refused = await a.call('translate.text', { text: 'Hello', from: 'en', to: 'sw' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'not-licensed', refusal: { feature: 'translate', available: ['guide', 'phrasebook'] } } })
    expect((await a.ok('license.status', {})).mode).toBe('read-only')
    expect(a.sdk.loads).toEqual([])
    // Read-only means nothing new is installed, so the pack cannot be either.
    expect(await a.call('packs.install', { bytes: await contentPack() })).toMatchObject({ ok: false, error: { code: 'not-licensed' } })
    expect(await a.call('guide.search', { query: 'homa' })).toMatchObject({ ok: false, error: { code: 'no-pack' } })
    expect((await a.records()).map((r) => [r.feature, r.outcome, r.reason])).toEqual([
      ['translate', 'refused', 'license-missing'],
      ['packs', 'refused', 'license-missing'],
      ['guide', 'error', 'NoPackError']
    ])
  })

  it('refuses a feature the license leaves out', async () => {
    const a = await app({ license: { features: ['translate'] } })
    expect(await a.call('documents.read', { bytes: new Uint8Array([1]) })).toMatchObject({
      ok: false,
      error: { code: 'not-licensed', refusal: { feature: 'documents', available: ['translate'] } }
    })
  })

  it('installs a license file only when it checks out, for the next start', async () => {
    const a = await app({ license: 'none' })
    const forged = issueLicense(
      { format: 1, kind: 'license', id: 'x', licensee: 'X', seats: 1, issued: '2026-01-01T00:00:00.000Z', expiry: '2099-01-01T00:00:00.000Z', features: ['translate'] },
      loadPrivateKey(generateSigningKey().privateKeyPem)
    )
    expect(await a.call('license.install', { text: forged })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const good = issueLicense(
      { format: 1, kind: 'license', id: 'x', licensee: 'X', seats: 1, issued: '2026-01-01T00:00:00.000Z', expiry: '2099-01-01T00:00:00.000Z', features: ['translate'] },
      loadPrivateKey(licenseKey.privateKeyPem)
    )
    expect(await a.ok('license.install', { text: good })).toMatchObject({ status: 'valid', restartRequired: true, available: ['translate', 'guide', 'phrasebook'] })
    expect(await fs.readFile(a.config.licenseFile, 'utf8')).toBe(good)
    // This session keeps the mode it started with.
    expect((await a.ok('license.status', {})).mode).toBe('read-only')
  })
})

describe('services over IPC', () => {
  it('installs a content pack, then serves phrases as signed and cards danger signs first', async () => {
    const a = await app()
    expect(await a.ok('packs.install', { bytes: await contentPack() })).toMatchObject({ id: 'test-pack', version: '1.0.0', notice: 'PLACEHOLDER' })
    expect(await a.call('packs.install', { bytes: Uint8Array.from([1, 2, 3]) })).toMatchObject({ ok: false, error: { code: 'pack-refused', problem: 'malformed' } })

    const list = await a.ok('phrasebook.list', {})
    expect(list.phrases.map((p) => p.id)).toEqual(['greet', 'wait'])
    expect((await a.ok('phrasebook.search', { query: 'subiri', lang: 'sw' })).hits[0]!.phrase.id).toBe('wait')
    const rec = await a.ok('phrasebook.recording', { id: 'wait', lang: 'sw' })
    expect(Buffer.from(rec.wav).equals(Buffer.from(tone(1)))).toBe(true)
    expect(await a.call('phrasebook.recording', { id: 'nope', lang: 'sw' })).toMatchObject({ ok: false, error: { code: 'not-found' } })

    const found = await a.ok('guide.search', { query: 'homa kwa mtoto degedege' })
    expect(found).toMatchObject({ status: 'match', lang: 'sw' })
    if (found.status !== 'match') throw new Error('no match')
    expect(Object.keys(found.hits[0].card).indexOf('dangerSigns')).toBeLessThan(Object.keys(found.hits[0].card).indexOf('steps'))
    expect(await a.ok('guide.search', { query: 'broken leg', lang: 'en' })).toMatchObject({ status: 'no-match' })
    expect(await a.call('guide.card', { id: 'nope', lang: 'en' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('translates with the check, and logs metadata only', async () => {
    const a = await app()
    const r = await a.ok('translate.text', { text: 'The child has a fever.', from: 'en', to: 'sw' })
    expect(r.translation).toBe('[swh_Latn] The child has a fever.')
    expect('lines' in r).toBe(false)
    expect('backTranslation' in r).toBe(true)
    const plain = await a.ok('translate.text', { text: 'Hello.', from: 'en', to: 'sw', check: false })
    expect('backTranslation' in plain).toBe(false)
    expect(await a.call('translate.text', { text: 'Hello.', from: 'sw', to: 'sw' })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const records = await a.records()
    expect(records.map((x) => x.action)).toEqual(['translate', 'translate-plain'])
    expect(JSON.stringify(records)).not.toContain('fever')
  })

  it('transcribes and speaks WAV bytes, and refuses bytes that are not WAV', async () => {
    const a = await app()
    expect(await a.ok('speech.transcribe', { wav: tone(1, 44_100), lang: 'sw' })).toMatchObject({ lang: 'sw', text: 'Hello.' })
    expect(a.sdk.transcribed[0]!.audio.length).toBe(16_000)
    expect(await a.call('speech.transcribe', { wav: Uint8Array.from([1, 2, 3, 4]), lang: 'sw' })).toMatchObject({ ok: false, error: { code: 'unreadable-input' } })
    const speech = await a.ok('voice.speak', { text: 'Habari.', lang: 'sw' })
    expect(Buffer.from(speech.wav.subarray(0, 4)).toString()).toBe('RIFF')
    expect('samples' in speech).toBe(false)
    expect((await a.records()).map((x) => [x.feature, x.outcome])).toEqual([
      ['speech', 'ok'],
      ['speech', 'error'],
      ['read-aloud', 'ok']
    ])
  })

  it('streams a conversation turn as it happens and returns the translated speech', async () => {
    const a = await app()
    const events: AppEvent[] = []
    const r = await a.call('conversation.turn', { wav: tone(1), side: 'clinician', stream: true }, { callId: 'c1', emit: (e) => events.push(e) })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value).toMatchObject({ speakerSide: 'clinician', sourceText: 'Hello.', translation: '[swh_Latn] Hello.' })
    expect(Buffer.from(r.value.wav!.subarray(0, 4)).toString()).toBe('RIFF')
    expect('audioPath' in r.value).toBe(false)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('transcript')
    expect(types).toContain('translation')
    expect(types).toContain('audio')
    expect(types.at(-1)).toBe('check')
    expect(events.every((e) => e.callId === 'c1')).toBe(true)

    const quiet: AppEvent[] = []
    await a.call('conversation.turn', { wav: tone(1), side: 'patient' }, { callId: 'c2', emit: (e) => quiet.push(e) })
    expect(quiet).toEqual([])
  })

  it('reports documents it cannot read as unreadable input', async () => {
    const a = await app()
    expect(await a.call('documents.read', { bytes: Buffer.from('not a document') })).toMatchObject({ ok: false, error: { code: 'unreadable-input' } })
    expect((await a.records()).at(-1)).toMatchObject({ feature: 'documents', action: 'read', outcome: 'error', reason: 'DocumentError' })
  })

  it('installs a signed model pack, unloading models first', async () => {
    const a = await app()
    await a.ok('translate.text', { text: 'Hello.', from: 'en', to: 'sw' })
    expect(a.sdk.loads.length).toBeGreaterThan(0)

    const source = fresh('vendor-models')
    await fakeModels(source)
    const packDir = fresh('model-pack')
    await buildModelPack({ modelsDir: source, outDir: packDir, names: Object.values(MODEL_CATALOG), id: 'ofa-models', title: 'Models', version: '1.0.0', sdkVersion: '0.21.0' })
    await signModelPack(packDir, loadPrivateKey(packKey.privateKeyPem))

    const installed = await a.ok('models.install', { dir: packDir })
    expect(installed).toMatchObject({ id: 'ofa-models', version: '1.0.0', copied: [] })
    expect(installed.kept.length).toBe(new Set(Object.values(MODEL_CATALOG)).size)
    expect(a.sdk.unloads.length).toBe(a.sdk.loads.length)
    expect((await a.ok('models.status', {})).pack).toMatchObject({ status: 'signed', manifest: { id: 'ofa-models' } })
    const status = await a.ok('app.status', {})
    expect(status.license.mode).toBe('full')
    expect(status.models.models.every((m) => m.status === 'ok')).toBe(true)
    expect(status.log.keyStore).toBe('memory vault')

    expect(await a.call('models.install', { dir: path.join(tmp, 'nowhere') })).toMatchObject({ ok: false, error: { code: 'pack-refused', problem: 'malformed' } })
  })

  it('reads the activity log back and wipes it only when confirmed', async () => {
    const a = await app()
    await a.ok('translate.text', { text: 'Hello.', from: 'en', to: 'sw' })
    await a.session.activity.flush()
    const before = (await a.session.keys!.existingLogKey())!.id
    const status = await a.ok('logs.status', {})
    expect(status).toMatchObject({ keyStore: 'memory vault', lines: 1, problems: [] })
    expect((await a.ok('logs.export', {})).records).toHaveLength(1)
    expect(await a.ok('logs.wipe', { confirm: true })).toMatchObject({ files: 1 })
    // The new log, under a new key, starts by saying the old one was wiped.
    await a.session.activity.flush()
    expect((await a.session.keys!.existingLogKey())!.id).not.toBe(before)
    expect((await a.ok('logs.export', {})).records).toMatchObject([{ feature: 'logs', action: 'wipe' }])
  })
})
