/**
 * A stand-in for `window.ofa`, for looking at the page in a browser without
 * Electron or the models (npm run ui:preview). Content comes from the sample
 * pack; speech, translation and reading are canned, with realistic delays.
 *
 * URL switches, to see the other states:
 *   ?license=read-only   ?models=missing   ?pack=none
 *
 * Never part of the app: scripts/ui-preview.ts bundles it into var/ only.
 */
import type { AppEvent, Channel, Envelope, OfaApi, RequestOf, Responses } from '../../../src/app/contract.js'
import type { Lang } from '../../../src/core/engines.js'
import type { GuideCard } from '../../../src/features/guide/guide.js'
import type { PhraseEntry } from '../../../src/features/phrasebook/phrasebook.js'

interface Sample {
  pack: { id: string; title: string; version: string; notice?: string }
  phrases: PhraseEntry[]
  cards: { id: string; en: GuideCard; sw: GuideCard; tags: string[] }[]
}
declare const __SAMPLE__: Sample
const sample = __SAMPLE__

const params = new URLSearchParams(location.search)
const readOnly = params.get('license') === 'read-only'
const modelsMissing = params.get('models') === 'missing'
const noPack = params.get('pack') === 'none'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const listeners = new Set<(e: AppEvent) => void>()
const emit = (e: AppEvent) => listeners.forEach((l) => l(e))

const ALL = ['conversation', 'translate', 'speech', 'read-aloud', 'documents', 'guide', 'phrasebook', 'packs'] as const
const license = {
  status: readOnly ? ('expired' as const) : ('valid' as const),
  mode: readOnly ? ('read-only' as const) : ('full' as const),
  message: readOnly ? 'The licence expired on 30 September 2026.' : 'Licensed to OFA development until 15 October 2027.',
  licensee: 'OFA development',
  expiry: readOnly ? '2026-09-30T00:00:00.000Z' : '2027-10-15T00:00:00.000Z',
  daysLeft: readOnly ? -16 : 364,
  warnings: [] as never[],
  available: readOnly ? (['guide', 'phrasebook'] as (typeof ALL)[number][]) : [...ALL],
  deviceId: 'mac-4f2a9c1e7b3d'
}
const MODELS = ['AFRISLM_1_7B', 'WHISPER_LARGE_V3_TURBO', 'CHATTERBOX_MULTILINGUAL', 'EMBEDDINGGEMMA_300M', 'OCR_LATIN', 'OCR_CRAFT']
const models = {
  dir: '~/Library/Application Support/OfflineFieldAssistant/models',
  pack: { status: 'none' as const },
  models: MODELS.map((name, i) => ({ name, status: modelsMissing && i < 2 ? ('missing' as const) : ('ok' as const), path: `models/${name}` }))
}
const packs = noPack ? [] : [{ id: sample.pack.id, version: sample.pack.version, file: 'var/packs/sample-intake.ofapack' }]

async function recording(lang: Lang, id?: string): Promise<Uint8Array> {
  const pick = id ?? sample.phrases[Math.floor(Math.random() * sample.phrases.length)]!.id
  const res = await fetch(`recordings/${pick}.${lang}.wav`)
  return new Uint8Array(await res.arrayBuffer())
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2)
function overlap(q: string, text: string): number {
  const qs = words(q)
  if (!qs.length) return 0
  const ts = words(text)
  return qs.filter((w) => ts.some((t) => t.startsWith(w.slice(0, Math.max(3, w.length - 2))))).length / qs.length
}

/** A sample phrase whose words best match `text`, as a stand-in translation. */
function closestPhrase(text: string, from: Lang): PhraseEntry {
  let best = sample.phrases[0]!
  let score = -1
  for (const p of sample.phrases) {
    const s = overlap(text, p.text[from])
    if (s > score) [best, score] = [p, s]
  }
  return best
}

/** Canned turns: the clinician asks sample phrases; the patient gives made-up answers. */
const CLINICIAN = ['sym-pain', 'sym-days', 'hist-allergy', 'inst-drink']
const PATIENT: Record<Lang, string>[] = [
  { sw: 'Tumbo linauma, na nina homa tangu jana.', en: 'My stomach hurts, and I have had a fever since yesterday.' },
  { sw: 'Siku tatu.', en: 'Three days.' },
  { sw: 'Hapana, sina mzio wa dawa yoyote.', en: 'No, I am not allergic to any medicine.' }
]
const turnCount = { clinician: 0, patient: 0 }

function scripted(side: 'clinician' | 'patient'): { text: Record<Lang, string>; id: string } {
  if (side === 'patient') return { text: PATIENT[turnCount.patient++ % PATIENT.length]!, id: 'sym-fever' }
  const id = CLINICIAN[turnCount.clinician++ % CLINICIAN.length]!
  return sample.phrases.find((p) => p.id === id) ?? sample.phrases[0]!
}

function guideSearch(query: string, lang?: Lang) {
  const guess: Lang = lang ?? (/\b(na|ya|ana|wa|kwa|mtoto|homa)\b/i.test(query) ? 'sw' : 'en')
  const hits = sample.cards
    .map((c) => {
      const card = c[guess]
      const hay = [card.title, ...card.dangerSigns, ...card.steps, ...c.tags, c.en.title, c.sw.title].join(' ')
      return { card, confidence: { keyword: overlap(query, hay) } }
    })
    .filter((x) => x.confidence.keyword >= 0.34)
    .sort((a, b) => b.confidence.keyword - a.confidence.keyword)
    .slice(0, 3)
  const base = { query, lang: guess, mode: 'hybrid' as const, notice: sample.pack.notice }
  return hits.length ? { ...base, status: 'match' as const, hits: hits as never } : { ...base, status: 'no-match' as const, message: 'No match — see a clinician' }
}

const FORM: [string, string, string?][] = [
  ['PATIENT INTAKE FORM', 'FOMU YA KUPOKEA MGONJWA'],
  ['Full name', 'Jina kamili'],
  ['Date of birth', 'Tarehe ya kuzaliwa'],
  ['12/03/2019', '12/03/2019', 'no-words'],
  ['Main symptom', 'Dalili kuu'],
  ['Fever and vomiting since Monday', 'Homa na kutapika tangu Jumatatu'],
  ['Temperature', 'Joto la mwili'],
  ['38.9 °C', '38.9 °C', 'no-words'],
  ['Allergies to medicine', 'Mzio wa dawa'],
  ['Signature of health worker', 'Sahihi ya mhudumu wa afya']
]

async function documentsTranslate(bytes: Uint8Array, to: Lang) {
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50
  let width = 612
  let height = 792
  if (!isPdf) {
    try {
      const bmp = await createImageBitmap(new Blob([bytes.slice()]))
      width = bmp.width
      height = bmp.height
    } catch {
      // Keep the letter-size page.
    }
  }
  await sleep(1800)
  const from: Lang = to === 'sw' ? 'en' : 'sw'
  const unit = isPdf ? ('pt' as const) : ('px' as const)
  const segments = FORM.map(([en, sw, kept], i) => {
    const y = height * (0.08 + i * 0.085)
    const original = from === 'en' ? en : sw
    const translation = kept ? original : to === 'sw' ? sw : en
    const low = i === 8
    return {
      page: 1,
      bbox: [width * 0.08, y, width * (i === 0 ? 0.75 : 0.62), y + height * 0.04] as [number, number, number, number],
      source: isPdf ? ('text-layer' as const) : ('ocr' as const),
      original,
      translation,
      ...(kept ? { kept: 'no-words' as const } : { backTranslation: original, fidelity: 0.93 }),
      ocrConfidence: isPdf ? null : low ? 0.41 : 0.92,
      flags: low && !isPdf ? (['low-confidence'] as const) : []
    }
  })
  return {
    kind: isPdf ? 'pdf' : 'image',
    from,
    to,
    pages: [{ page: 1, width, height, unit, source: isPdf ? 'text-layer' : 'ocr', readMs: 900 }],
    segments,
    flags: segments.some((s) => s.flags.length) ? ['low-confidence'] : [],
    timings: { readMs: 900, translateMs: 2400, checkMs: 1100, totalMs: 4400 }
  }
}

type Handler<C extends Channel> = (req: RequestOf<C>, callId?: string) => Promise<Responses[C]>
const handlers: { [C in Channel]?: Handler<C> } = {
  'app.status': async () => ({ app: '0.1.0', sdk: '0.21.0', license, models, packs, log: { keyStore: 'safeStorage', transcripts: false } }) as never,
  'license.status': async () => license as never,
  'models.status': async () => models as never,
  'packs.list': async () => packs,
  'phrasebook.list': async () => {
    if (noPack) throw Object.assign(new Error('No content pack installed'), { code: 'no-pack' })
    return {
      packId: sample.pack.id,
      packVersion: sample.pack.version,
      notice: sample.pack.notice,
      categories: [...new Set(sample.phrases.map((p) => p.category))],
      phrases: sample.phrases
    }
  },
  'phrasebook.search': async ({ query, lang }) => ({
    packId: sample.pack.id,
    hits: sample.phrases
      .map((phrase) => ({ phrase, score: overlap(query, phrase.text[lang]) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
  }),
  'phrasebook.recording': async ({ id, lang }) => {
    const phrase = sample.phrases.find((p) => p.id === id)!
    return { phrase, lang, wav: await recording(lang, id), synthetic: phrase.recordings[lang].synthetic }
  },
  'guide.search': async ({ query, lang }) => {
    if (noPack) throw Object.assign(new Error('No content pack installed'), { code: 'no-pack' })
    await sleep(350)
    return guideSearch(query, lang) as never
  },
  'guide.ask': async ({ lang }) => {
    await sleep(1200)
    const text = lang === 'sw' ? 'Mtoto ana homa na anatapika' : 'The child has a fever and is vomiting'
    return { transcript: { lang, text, segments: [], audioMs: 2400, transcribeMs: 600, realTimeFactor: 0.25, flags: [] }, result: guideSearch(text, lang) } as never
  },
  'guide.card': async ({ id, lang }) => sample.cards.find((c) => c.id === id)![lang],
  'translate.text': async ({ text, from, to }) => {
    await sleep(900)
    const p = closestPhrase(text, from)
    const numbers = /\d/.test(text)
    return {
      from,
      to,
      source: text,
      translation: p.text[to],
      backTranslation: p.text[from],
      fidelity: numbers ? 0.71 : 0.94,
      numericCheck: { ok: !numbers, source: [], translation: { missing: [], added: [] }, backTranslation: { missing: [], added: [] } },
      flags: numbers ? ['numbers-changed'] : [],
      sentences: [],
      translateMs: 700,
      timings: { translateMs: 700, backTranslateMs: 500, checkMs: 60 }
    } as never
  },
  'voice.speak': async ({ lang }) => {
    await sleep(700)
    return { lang, text: '', parts: [], sampleRate: 24000, audioMs: 2000, synthMs: 700, firstAudioMs: 400, realTimeFactor: 0.3, stallMs: 0, flags: [], wav: await recording(lang) } as never
  },
  'conversation.turn': async ({ side, stream }, callId) => {
    const p = scripted(side)
    const [from, to]: [Lang, Lang] = side === 'clinician' ? ['en', 'sw'] : ['sw', 'en']
    const base = { channel: 'conversation.turn' as const, callId: callId! }
    const flags = side === 'clinician' && p.id === 'sym-days' ? ['numbers-changed'] : []
    await sleep(900)
    if (stream) emit({ ...base, type: 'transcript', atMs: 900, text: p.text[from] })
    await sleep(800)
    if (stream) emit({ ...base, type: 'translation', atMs: 1700, text: p.text[to] })
    const wav = await recording(to, side === 'clinician' ? p.id : undefined)
    if (stream) emit({ ...base, type: 'audio', atMs: 2100, wav })
    await sleep(700)
    if (stream) emit({ ...base, type: 'check', atMs: 2800, backTranslation: p.text[from], fidelity: 0.92, flags })
    return { id: callId, speakerSide: side, sourceLang: from, targetLang: to, sourceText: p.text[from], translation: p.text[to], backTranslation: p.text[from], fidelity: 0.92, flags, wav } as never
  },
  'documents.translate': async ({ bytes, to }) => (await documentsTranslate(bytes, to)) as never,
  'logs.status': async () => ({ dir: 'var/logs', keyStore: 'safeStorage', transcripts: false, days: ['2026-10-14', '2026-10-15', '2026-10-16'], lines: 214, problems: [] }),
  'logs.export': async () => ({ records: [{ feature: 'guide', action: 'search', ms: 312, outcome: 'match' }], problems: [] }),
  'logs.wipe': async () => ({ files: 3, bytes: 48120 }),
  'license.install': async () => ({ ...license, restartRequired: true }) as never,
  'packs.install': async () => ({ id: sample.pack.id, version: sample.pack.version, title: sample.pack.title, signedBy: { keyId: 'dev', label: 'Development key' }, files: [] })
}

const LICENSED: Partial<Record<Channel, string>> = {
  'conversation.turn': 'conversation',
  'translate.text': 'translate',
  'voice.speak': 'read-aloud',
  'documents.translate': 'documents',
  'speech.transcribe': 'speech'
}

const api: OfaApi = {
  async invoke(channel, request, opts) {
    const feature = LICENSED[channel]
    if (feature && !license.available.includes(feature as never))
      return { ok: false, error: { code: 'not-licensed', message: 'Not licensed' } } as Envelope<never>
    if (feature && feature !== 'read-aloud' && modelsMissing)
      return { ok: false, error: { code: 'models-missing', message: 'Models missing' } } as Envelope<never>
    const handler = handlers[channel] as Handler<typeof channel> | undefined
    if (!handler) return { ok: false, error: { code: 'unknown-channel', message: `The preview has no ${channel}` } } as Envelope<never>
    try {
      return { ok: true, value: await handler(request, opts?.callId) } as Envelope<never>
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'failed'
      return { ok: false, error: { code, message: (err as Error).message } } as Envelope<never>
    }
  },
  onEvent(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

window.ofa = api

/** A warbling tone in place of a microphone, so push-to-talk can be tried anywhere. */
const realGetUserMedia = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices)
if (navigator.mediaDevices) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints?.video && realGetUserMedia) return realGetUserMedia(constraints)
    const ac = new AudioContext()
    const voice = ac.createOscillator()
    voice.frequency.value = 180
    const gain = ac.createGain()
    gain.gain.value = 0.15
    const lfo = ac.createOscillator()
    lfo.frequency.value = 3.3
    const depth = ac.createGain()
    depth.gain.value = 0.14
    lfo.connect(depth).connect(gain.gain)
    const out = ac.createMediaStreamDestination()
    voice.connect(gain).connect(out)
    voice.start()
    lfo.start()
    return out.stream
  }
}
