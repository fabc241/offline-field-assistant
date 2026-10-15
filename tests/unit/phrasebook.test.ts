import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeWav, encodeWav } from '../../src/core/audio.js'
import { PROJECT_ROOT } from '../../src/core/config.js'
import { parseCsv } from '../../src/core/csv.js'
import type { Embedder, Lang, Speaker } from '../../src/core/engines.js'
import { buildPack, signPack } from '../../src/features/packs/build.js'
import { phraseAudioPath, readPackSource, type Phrase } from '../../src/features/packs/content.js'
import { PackLoader, type LoadedPack } from '../../src/features/packs/loader.js'
import { sha256Hex } from '../../src/features/packs/manifest.js'
import { syntheticRecordFile } from '../../src/features/packs/recordings.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../../src/features/packs/signing.js'
import { PhraseNotFoundError, Phrasebook, searchWords, stems, substringDistance, wordMatch } from '../../src/features/phrasebook/phrasebook.js'
import { makePlaceholderRecordings } from '../../src/features/phrasebook/placeholders.js'
import { ReadAloud } from '../../src/features/voice/read-aloud.js'

const PHRASES: [id: string, category: string, en: string, sw: string][] = [
  ['greet-hello', 'greeting', 'Hello. I am a health worker from the clinic.', 'Habari. Mimi ni mhudumu wa afya kutoka kliniki.'],
  ['sym-pain', 'symptoms', 'Where does it hurt?', 'Unaumwa wapi?'],
  ['sym-fever', 'symptoms', 'Do you have a fever?', 'Una homa?'],
  ['sym-cough', 'symptoms', 'Do you have a cough?', 'Una kikohozi?'],
  ['sym-diarrhoea', 'symptoms', 'Do you have diarrhoea?', 'Unaharisha?'],
  ['hist-allergy', 'history', 'Are you allergic to any medicine?', 'Una mzio wa dawa yoyote?'],
  ['hist-vaccines', 'history', 'Has the child had all the vaccinations?', 'Mtoto amepata chanjo zote?'],
  ['inst-wait', 'instructions', 'Please wait here.', 'Tafadhali subiri hapa.']
]

/** A loaded pack as the loader returns it, with one WAV per phrase and language; sw recordings are synthetic. */
function fakePack(phrases = PHRASES): LoadedPack {
  const audio = new Map<string, Uint8Array>()
  const content: Phrase[] = phrases.map(([id, category, en, sw], i) => {
    for (const lang of ['en', 'sw'] as const) audio.set(phraseAudioPath(id, lang), encodeWav(new Float32Array([i / 10, lang === 'en' ? 0.1 : -0.1]), 16_000))
    return { id, category, text: { en, sw }, audio: { en: phraseAudioPath(id, 'en'), sw: phraseAudioPath(id, 'sw') }, vettedBy: 'PLACEHOLDER' }
  })
  const files = [...audio].map(([p, data]) => ({ path: p, size: data.length, sha256: sha256Hex(data), ...(p.endsWith('.sw.wav') ? { synthetic: true as const } : {}) }))
  return {
    manifest: {
      format: 1,
      kind: 'content',
      id: 'test-pack',
      title: 'Test',
      version: '1.2.0',
      created: '2026-10-15T08:00:00.000Z',
      notice: 'PLACEHOLDER',
      embedding: { model: 'm', sha256: 'a'.repeat(64), recipe: 'card-v1', dims: 1 },
      files
    },
    signedBy: { keyId: '0'.repeat(16), label: 'test' },
    content: { cards: [], phrases: content },
    audio,
    vectors: new Map(),
    embeddings: 'packed'
  }
}

const top = (book: Phrasebook, query: string, lang: Lang, opts = {}) => book.search(query, lang, opts).map((h) => h.phrase.id)

describe('Phrasebook', () => {
  const pack = fakePack()
  const book = new Phrasebook(pack)

  it('lists phrases and categories in pack order, and finds one by id', () => {
    expect(book.categories()).toEqual(['greeting', 'symptoms', 'history', 'instructions'])
    expect(book.list().map((p) => p.id)).toEqual(PHRASES.map(([id]) => id))
    expect(book.list('history').map((p) => p.id)).toEqual(['hist-allergy', 'hist-vaccines'])
    expect(book.list('nothing')).toEqual([])
    expect(book.get('sym-fever')).toEqual({
      id: 'sym-fever',
      category: 'symptoms',
      text: { en: 'Do you have a fever?', sw: 'Una homa?' },
      vettedBy: 'PLACEHOLDER',
      recordings: { en: { path: 'audio/sym-fever.en.wav', synthetic: false }, sw: { path: 'audio/sym-fever.sw.wav', synthetic: true } }
    })
    expect(book.get('nope')).toBeUndefined()
    expect([book.packId, book.packVersion, book.notice]).toEqual(['test-pack', '1.2.0', 'PLACEHOLDER'])
  })

  it('gives back the recording exactly as it is in the pack', () => {
    expect(book.audioPath('sym-fever', 'sw')).toBe('audio/sym-fever.sw.wav')
    expect(book.recording('sym-fever', 'sw')).toBe(pack.audio.get('audio/sym-fever.sw.wav'))
    expect(() => book.recording('nope', 'sw')).toThrow(PhraseNotFoundError)
  })

  it('refuses a pack where a phrase has no recording, instead of falling back to anything', () => {
    const broken = fakePack()
    broken.audio.delete('audio/sym-cough.en.wav')
    expect(() => new Phrasebook(broken)).toThrow(/sym-cough has no en recording/)
  })

  it('never speaks: the phrasebook does not import text-to-speech or the model runtime', async () => {
    const source = await fs.readFile(path.join(PROJECT_ROOT, 'src/features/phrasebook/phrasebook.ts'), 'utf8')
    const imports = [...source.matchAll(/^import .* from '(.*)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['../../core/engines.js', '../packs/content.js', '../packs/loader.js'])
    expect(source).not.toMatch(/import (?!type)[^;]*Speaker/)
  })
})

describe('Phrasebook.search', () => {
  const book = new Phrasebook(fakePack())

  it('finds whole words, ranking the rare word over the common ones', () => {
    expect(top(book, 'fever', 'en')).toEqual(['sym-fever'])
    expect(top(book, 'do you have a fever', 'en')[0]).toBe('sym-fever')
    expect(top(book, 'homa', 'sw')).toEqual(['sym-fever'])
    expect(top(book, 'una homa', 'sw')[0]).toBe('sym-fever')
  })

  it('finds word beginnings and Swahili stems inside words', () => {
    expect(top(book, 'vaccin', 'en')).toEqual(['hist-vaccines'])
    expect(top(book, 'allerg', 'en')).toEqual(['hist-allergy'])
    expect(top(book, 'harisha', 'sw')).toEqual(['sym-diarrhoea'])
    expect(top(book, 'umwa', 'sw')).toEqual(['sym-pain'])
  })

  it('forgives a small typo, case, accents and apostrophes', () => {
    expect(top(book, 'kikohzi', 'sw')).toEqual(['sym-cough'])
    expect(top(book, 'diarhoea', 'en')).toEqual(['sym-diarrhoea'])
    expect(top(book, 'VACCINATIONS', 'en')).toEqual(['hist-vaccines'])
    expect(top(book, 'fevér', 'en')).toEqual(['sym-fever'])
    expect(searchWords("Ng'ombe, SAWA? naïve")).toEqual(['ngombe', 'sawa', 'naive'])
  })

  it('finds another form of a word: English -ing and -ed, Swahili ku-', () => {
    expect(top(book, 'vaccinated', 'en')).toEqual(['hist-vaccines'])
    expect(top(book, 'hurting', 'en')).toEqual(['sym-pain'])
    expect(top(book, 'kuumwa', 'sw')).toEqual(['sym-pain'])
    expect(stems('vomiting')).toEqual(['vomit'])
    expect(stems('kupumua')).toEqual(['pumua'])
    // Too little left to stand on its own.
    expect(stems('red')).toEqual([])
    expect(stems('kuja')).toEqual([])
  })

  it('also matches the other language, ranked below its own', () => {
    expect(top(book, 'homa', 'en')).toEqual(['sym-fever'])
    expect(top(book, 'homa', 'en', { otherLangWeight: 0 })).toEqual([])
    const [hit] = book.search('homa', 'en')
    expect(hit!.score).toBeCloseTo(0.8)
  })

  it('returns nothing for no match or no words, and respects the limit', () => {
    expect(top(book, 'xylophone', 'en')).toEqual([])
    expect(top(book, '?!', 'en')).toEqual([])
    expect(top(book, 'you', 'en', { limit: 2 })).toHaveLength(2)
  })

  it('scores between 0 and 1, best first', () => {
    const hits = book.search('do you have a cough', 'en', { limit: 10 })
    expect(hits[0]!.phrase.id).toBe('sym-cough')
    expect(hits.every((h, i) => h.score > 0 && h.score <= 1 && (i === 0 || h.score <= hits[i - 1]!.score))).toBe(true)
  })

  it('measures typos as edits to some part of a word', () => {
    expect(substringDistance('kikohoz', 'kikohozi')).toBe(0)
    expect(substringDistance('harsha', 'unaharisha')).toBe(1)
    expect(substringDistance('hmoa', 'homa')).toBe(1)
    expect(substringDistance('abc', 'xyz')).toBe(3)
    expect(wordMatch('homa', 'homa')).toBe(1)
    expect(wordMatch('hom', 'homa')).toBe(0.9)
    expect(wordMatch('harisha', 'unaharisha')).toBe(0.8)
    expect(wordMatch('harsha', 'unaharisha')).toBe(0.6)
    // Short words need an exact start: too many words are one edit from them.
    expect(wordMatch('hma', 'homa')).toBe(0)
    expect(wordMatch('hima', 'homa')).toBe(0)
  })
})

/** Speaks a tone whose length follows the text, and records what it was asked to say. */
class ToneSpeaker implements Speaker {
  said: string[] = []
  async speak(text: string, _lang: Lang, onAudio: (c: { samples: Float32Array; sampleRate: number }) => void) {
    this.said.push(text)
    onAudio({ samples: Float32Array.from({ length: text.length * 2000 }, (_, i) => Math.sin(i / 5) * 0.3), sampleRate: 24_000 })
  }
}

let tmp: string
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-phrasebook-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('placeholder recordings', () => {
  const HEADER = 'id,category,en,sw,audio_en,audio_sw,vetted_by'
  const human = encodeWav(Float32Array.from({ length: 800 }, (_, i) => Math.sin(i / 3) * 0.4), 16_000)

  async function source(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(tmp, 'src-'))
    await fs.mkdir(path.join(dir, 'recordings'))
    await fs.writeFile(path.join(dir, 'pack.json'), JSON.stringify({ id: 'p', title: 'P', version: '1.0.0' }))
    await fs.writeFile(path.join(dir, 'cards.csv'), 'id,title_en,title_sw,danger_signs_en,danger_signs_sw,steps_en,steps_sw,tags,source,version\n')
    await fs.writeFile(path.join(dir, 'recordings/human-wait.sw.wav'), human)
    await fs.writeFile(
      path.join(dir, 'phrases.csv'),
      [
        HEADER,
        'fever,symptoms,Do you have a fever?,Una homa?,,,PLACEHOLDER',
        'wait,instructions,Please wait here.,Tafadhali subiri hapa.,,recordings/human-wait.sw.wav,PLACEHOLDER',
        'gone,instructions,Sit.,Keti.,recordings/missing.wav,,PLACEHOLDER'
      ].join('\n') + '\n'
    )
    return dir
  }

  it('makes the missing recordings, marks them synthetic, and leaves human recordings alone', async () => {
    const dir = await source()
    const speaker = new ToneSpeaker()
    const now = () => new Date('2026-10-15T09:00:00Z')
    const reader = new ReadAloud(speaker)
    const report = await makePlaceholderRecordings(dir, { engine: 'TTS_TEST', readerFor: () => reader, now })

    expect(report.made.map((m) => `${m.id}.${m.lang} ${m.ref}`)).toEqual([
      'fever.en recordings/fever.en.wav',
      'fever.sw recordings/fever.sw.wav',
      'wait.en recordings/wait.en.wav',
      'gone.sw recordings/gone.sw.wav'
    ])
    expect(report.human).toBe(1)
    expect(report.missing).toEqual([{ id: 'gone', lang: 'en', ref: 'recordings/missing.wav' }])
    expect(speaker.said).toEqual(['Do you have a fever?', 'Una homa?', 'Please wait here.', 'Keti.'])
    expect(await fs.readFile(path.join(dir, 'recordings/human-wait.sw.wav'))).toEqual(Buffer.from(human))

    const rows = parseCsv(await fs.readFile(path.join(dir, 'phrases.csv'), 'utf8'))
    expect(rows.map((r) => [r.audio_en, r.audio_sw])).toEqual([
      ['recordings/fever.en.wav', 'recordings/fever.sw.wav'],
      ['recordings/wait.en.wav', 'recordings/human-wait.sw.wav'],
      ['recordings/missing.wav', 'recordings/gone.sw.wav']
    ])
    const wav = await fs.readFile(path.join(dir, 'recordings/fever.sw.wav'))
    expect(decodeWav(wav).sampleRate).toBe(24_000)
    expect(JSON.parse(await fs.readFile(syntheticRecordFile(path.join(dir, 'recordings/fever.sw.wav')), 'utf8'))).toEqual({
      engine: 'TTS_TEST',
      lang: 'sw',
      text: 'Una homa?',
      sha256: sha256Hex(wav),
      created: '2026-10-15T09:00:00.000Z'
    })

    // Once the missing file is there, the source builds, and only the generated recordings are synthetic.
    await fs.writeFile(path.join(dir, 'recordings/missing.wav'), human)
    const { audio } = await readPackSource(dir)
    expect([...audio].filter(([, r]) => r.synthetic).map(([p]) => p).sort()).toEqual(
      ['audio/fever.en.wav', 'audio/fever.sw.wav', 'audio/gone.sw.wav', 'audio/wait.en.wav']
    )
  })

  it('makes a recording again only when its phrase changed, or when forced', async () => {
    const dir = await source()
    const reader = new ReadAloud(new ToneSpeaker())
    const opts = { engine: 'TTS_TEST', readerFor: () => reader }
    await makePlaceholderRecordings(dir, opts)
    const again = await makePlaceholderRecordings(dir, opts)
    expect(again.made).toEqual([])
    expect(again.current).toBe(4)

    const csvFile = path.join(dir, 'phrases.csv')
    await fs.writeFile(csvFile, (await fs.readFile(csvFile, 'utf8')).replace('Una homa?', 'Una homa kali?'))
    const edited = await makePlaceholderRecordings(dir, opts)
    expect(edited.made.map((m) => `${m.id}.${m.lang}`)).toEqual(['fever.sw'])

    const forced = await makePlaceholderRecordings(dir, { ...opts, force: true })
    expect(forced.made).toHaveLength(4)
    expect(forced.human).toBe(1)
  })

  it('renders other takes until one is heard well enough, and keeps the best', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'takes-'))
    await fs.writeFile(path.join(dir, 'phrases.csv'), `${HEADER}\nwait,instructions,Please wait here.,Tafadhali subiri hapa.,,,PLACEHOLDER\n`)
    // Each seed is a different take; the listener hears what each one "said".
    const heardBySeed: Record<string, Record<Lang, string>> = {
      default: { en: 'Please wait here. Should we wait here?', sw: 'Tafadhali subiri hapa.' },
      1: { en: 'Please wade here.', sw: '' },
      2: { en: 'Please wait here.', sw: '' },
      3: { en: 'Please wait here.', sw: '' }
    }
    const seeds: (number | undefined)[] = []
    const report = await makePlaceholderRecordings(dir, {
      engine: 'TTS_TEST',
      readerFor: (seed) => {
        seeds.push(seed)
        return new ReadAloud(new ToneSpeaker())
      },
      listen: async (speech) => heardBySeed[String(seeds.at(-1) ?? 'default')]![speech.lang]
    })
    // en: the default take doubled the phrase, seed 1 misheard a word, seed 2 is clean; seed 3 is never tried.
    expect(seeds).toEqual([undefined, 1, 2, undefined])
    expect(report.made.map(({ lang, seed, takes, cer, heard }) => ({ lang, seed, takes, cer, heard }))).toEqual([
      { lang: 'en', seed: 2, takes: 3, cer: 0, heard: 'Please wait here.' },
      { lang: 'sw', seed: undefined, takes: 1, cer: 0, heard: 'Tafadhali subiri hapa.' }
    ])
    const record = JSON.parse(await fs.readFile(syntheticRecordFile(path.join(dir, 'recordings/wait.en.wav')), 'utf8'))
    expect(record).toMatchObject({ seed: 2, heard: 'Please wait here.', cer: 0 })
    expect(JSON.parse(await fs.readFile(syntheticRecordFile(path.join(dir, 'recordings/wait.sw.wav')), 'utf8'))).not.toHaveProperty('seed')
  })

  it('keeps the best of all takes when none is heard well enough', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'takes-'))
    await fs.writeFile(path.join(dir, 'phrases.csv'), `${HEADER}\nfever,symptoms,Do you have a fever?,Una homa?,,,PLACEHOLDER\n`)
    let seed: number | undefined
    const heard: Record<string, string> = { default: 'Uno', 1: 'U', 2: 'Una ham', 3: 'xx' }
    const report = await makePlaceholderRecordings(dir, {
      engine: 'TTS_TEST',
      readerFor: (s) => ((seed = s), new ReadAloud(new ToneSpeaker())),
      listen: async (speech) => (speech.lang === 'en' ? 'Do you have a fever?' : heard[String(seed ?? 'default')]!)
    })
    expect(report.made.find((m) => m.lang === 'sw')).toMatchObject({ seed: 2, takes: 4, heard: 'Una ham', cer: 25 })
  })
})

describe('the sample pack', () => {
  class HashEmbedder implements Embedder {
    async embed(texts: string[]) {
      return texts.map((t) => [...createHash('sha256').update(t).digest().subarray(0, 8)].map((b) => b / 255))
    }
  }

  it('builds into a phrasebook whose every phrase plays its own recording in both languages', async () => {
    const dir = path.join(PROJECT_ROOT, 'content/sample')
    const built = await buildPack(dir, { embedder: new HashEmbedder(), embeddingModel: { name: 'E', sha256: 'a'.repeat(64) } })
    const key = generateSigningKey()
    const loaded = await new PackLoader({ trustedKeys: [trustedKey('test', key.publicKeyPem)] }).verifyAndLoad(
      signPack(built.bytes, loadPrivateKey(key.privateKeyPem)).bytes
    )
    const book = new Phrasebook(loaded)
    const rows = parseCsv(await fs.readFile(path.join(dir, 'phrases.csv'), 'utf8'))
    expect(book.list()).toHaveLength(30)
    for (const row of rows) {
      for (const lang of ['en', 'sw'] as const) {
        const entry = book.get(row.id!)!
        expect(entry.recordings[lang].synthetic, `${row.id} ${lang}`).toBe(true)
        expect(Buffer.from(book.recording(row.id!, lang))).toEqual(await fs.readFile(path.join(dir, row[`audio_${lang}`]!)))
      }
    }
  })
})
