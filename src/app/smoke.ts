/**
 * The IPC smoke suite: every service called the way a renderer will call it
 * (page → preload → ipcMain → services → models), each answer checked. The
 * Electron main process runs it in its hidden window (`--ipc-smoke`); this
 * module only knows the plan and the checks.
 *
 * Fixtures are files a release-gate kit carries next to the app: two speech
 * clips and three documents that exercise each native path (sharp for a
 * photo, the canvas renderer for a scanned PDF, macOS sips for HEIC).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppEvent, Channel, Envelope } from './contract.js'

export const SMOKE_FIXTURES = {
  enWav: 'fleurs-en-1953.wav',
  swWav: 'fleurs-sw-1941-quiet.wav',
  photo: 'docs/med-label-en.jpg',
  scan: 'docs/dose-chart-sw.pdf',
  heic: 'docs/med-label-sw.heic'
} as const
export type Fixtures = Record<keyof typeof SMOKE_FIXTURES, Uint8Array>

export async function readFixtures(dir: string): Promise<Fixtures> {
  const entries = await Promise.all(
    Object.entries(SMOKE_FIXTURES).map(async ([k, f]) => [k, new Uint8Array(await fs.readFile(path.join(dir, f)))] as const)
  )
  return Object.fromEntries(entries) as Fixtures
}

/** What the renderer sends back: bytes are replaced by their length and first bytes. */
export type Stripped = unknown

export interface SmokeCall {
  channel: string
  request: unknown
  /** Collect `ofa:event` pushes for this call. */
  stream?: boolean
}

export interface SmokeAnswer {
  envelope: Envelope<any>
  events: Omit<AppEvent, 'wav'>[]
  ms: number
}

/** Runs one call in the renderer. */
export type CallInRenderer = (call: SmokeCall) => Promise<SmokeAnswer>

interface Step {
  name: string
  call: (fx: Fixtures, prior: Record<string, any>) => SmokeCall
  /** A problem, or undefined when the answer is right. */
  check: (answer: SmokeAnswer) => string | undefined
}

export interface StepResult {
  name: string
  channel: string
  ok: boolean
  ms: number
  problem?: string
  /** A few facts from the answer, for the report. */
  facts?: Record<string, unknown>
}

export interface SmokeReport {
  ok: boolean
  passed: number
  failed: number
  totalMs: number
  steps: StepResult[]
}

export interface SmokeOptions {
  /** Require the models to come from a signed model pack (the release gate). */
  requireModelPack?: boolean
}

/**
 * Segments each document gives when OCR runs alone (7, 7, 6), less one for
 * slack. OCR short of GPU memory found 2 or 0 without raising an error, so a
 * bare "found something" check would pass a broken read.
 */
const MIN_SEGMENTS = { photo: 6, scan: 6, heic: 5 }

const value = (a: SmokeAnswer) => (a.envelope.ok ? a.envelope.value : undefined)
const fail = (a: SmokeAnswer) => (a.envelope.ok ? undefined : `${a.envelope.error.code}: ${a.envelope.error.message}`)
const wavBytes = (w: unknown) => (w as { $bytes?: number; head?: string } | undefined)
const isWav = (w: unknown) => wavBytes(w)?.head === 'RIFF' && (wavBytes(w)?.$bytes ?? 0) > 1000

/** First problem among checks that are false, by message. */
function expectAll(checks: [boolean, string][]): string | undefined {
  return checks.find(([ok]) => !ok)?.[1]
}

function plan(opts: SmokeOptions): Step[] {
  const ok = (name: string, channel: Channel, request: (fx: Fixtures, prior: Record<string, any>) => unknown, check: (v: any, a: SmokeAnswer) => string | undefined, stream = false): Step => ({
    name,
    call: (fx, prior) => ({ channel, request: request(fx, prior), stream }),
    check: (a) => fail(a) ?? check(value(a), a)
  })
  const refused = (name: string, channel: string, request: unknown, code: string): Step => ({
    name,
    call: () => ({ channel, request }),
    check: (a) => (a.envelope.ok ? 'was accepted' : a.envelope.error.code === code ? undefined : `got ${a.envelope.error.code}, expected ${code}`)
  })

  return [
    ok('app status', 'app.status', () => ({}), (v) =>
      expectAll([
        [v.license.mode === 'full', `license is ${v.license.status}: ${v.license.message}`],
        [v.models.models.every((m: { status: string }) => m.status === 'ok'), 'a model is missing or damaged'],
        [!opts.requireModelPack || v.models.pack.status === 'signed', `models are not from a signed model pack (${v.models.pack.status})`],
        [v.packs.length > 0, 'no content pack installed'],
        [Boolean(v.log.keyStore), 'no log key store']
      ])
    ),
    refused('unknown channel refused', 'fs.readFile', { path: '/etc/passwd' }, 'unknown-channel'),
    refused('malformed request refused', 'translate.text', { text: '', from: 'en', to: 'xx' }, 'bad-request'),
    refused('path instead of bytes refused', 'documents.read', { bytes: '/etc/passwd' }, 'bad-request'),
    ok('translate en→sw with check', 'translate.text', () => ({ text: 'The child has had a fever for 3 days.', from: 'en', to: 'sw' }), (v) =>
      expectAll([
        [v.translation.length > 10, 'empty translation'],
        [v.numericCheck.ok, `numbers changed: ${JSON.stringify(v.numericCheck)}`]
      ])
    ),
    ok('translate sw→en, no check', 'translate.text', () => ({ text: 'Mtoto ana homa.', from: 'sw', to: 'en', check: false }), (v) =>
      v.translation.length > 5 ? undefined : 'empty translation'
    ),
    ok('speech to text (sw)', 'speech.transcribe', (fx) => ({ wav: fx.swWav, lang: 'sw' }), (v) => (v.text.split(' ').length >= 5 ? undefined : `heard only "${v.text}"`)),
    ok('speech to text (en)', 'speech.transcribe', (fx) => ({ wav: fx.enWav, lang: 'en' }), (v) => (v.text.split(' ').length >= 5 ? undefined : `heard only "${v.text}"`)),
    ok('read aloud (sw)', 'voice.speak', () => ({ text: 'Karibu kliniki. Tafadhali keti.', lang: 'sw' }), (v) =>
      expectAll([
        [isWav(v.wav), 'no WAV'],
        [v.audioMs > 1000, `only ${v.audioMs} ms of audio`]
      ])
    ),
    ok(
      'conversation turn, streamed',
      'conversation.turn',
      (fx) => ({ wav: fx.enWav, side: 'clinician', stream: true }),
      (v, a) => {
        const types = new Set(a.events.map((e) => e.type))
        return expectAll([
          [v.translation.length > 10, 'empty translation'],
          [isWav(v.wav), 'no translated speech'],
          [['transcript', 'translation', 'audio', 'check'].every((t) => types.has(t as AppEvent['type'])), `events: ${[...types].join(', ')}`]
        ])
      },
      true
    ),
    ok('phrasebook list', 'phrasebook.list', () => ({}), (v) => (v.phrases.length > 0 ? undefined : 'no phrases')),
    ok('phrasebook search (sw)', 'phrasebook.search', () => ({ query: 'subiri', lang: 'sw' }), (v) => (v.hits.length > 0 ? undefined : 'no hits')),
    ok('phrase recording', 'phrasebook.recording', (_fx, prior) => ({ id: prior['phrasebook list'].phrases[0].id, lang: 'sw' }), (v) => (isWav(v.wav) ? undefined : 'no WAV')),
    ok('ask the guide (sw)', 'guide.search', () => ({ query: 'mtoto ana homa na kutapika' }), (v) => {
      if (v.status !== 'match') return `no match (${v.message})`
      const keys = Object.keys(v.hits[0].card)
      return expectAll([
        [v.mode === 'hybrid', `search ran ${v.mode}: ${v.degraded}`],
        [keys.indexOf('dangerSigns') < keys.indexOf('steps'), 'steps come before danger signs']
      ])
    }),
    ok('guide card', 'guide.card', (_fx, prior) => ({ id: prior['ask the guide (sw)'].hits[0].card.id, lang: 'en' }), (v) => (v.dangerSigns.length > 0 ? undefined : 'no danger signs')),
    ok('ask the guide by voice', 'guide.ask', (fx) => ({ wav: fx.swWav, lang: 'sw' }), (v) =>
      v.transcript.text && (v.result.status === 'match' || v.result.message) ? undefined : 'nothing heard'
    ),
    ok('read a photo (sharp + OCR)', 'documents.read', (fx) => ({ bytes: fx.photo }), (v) =>
      expectAll([
        [v.kind === 'jpeg' && v.pages[0].source === 'ocr', `read as ${v.kind}/${v.pages[0]?.source}`],
        [v.segments.length >= MIN_SEGMENTS.photo, `${v.segments.length} of 7 segments`]
      ])
    ),
    ok('read a scanned PDF (canvas + OCR)', 'documents.read', (fx) => ({ bytes: fx.scan }), (v) =>
      expectAll([
        [v.kind === 'pdf' && v.pages.some((p: { source: string }) => p.source === 'ocr'), 'no page was OCR\'d'],
        [v.segments.length >= MIN_SEGMENTS.scan, `${v.segments.length} of 7 segments`]
      ])
    ),
    ok('read a HEIC photo (sips)', 'documents.read', (fx) => ({ bytes: fx.heic }), (v) => (v.kind === 'heic' && v.segments.length >= MIN_SEGMENTS.heic ? undefined : `${v.kind}, ${v.segments.length} of 6 segments`)),
    ok('translate a photo', 'documents.translate', (fx) => ({ bytes: fx.photo, to: 'sw' }), (v) =>
      v.segments.some((s: { translation: string; kept?: string }) => !s.kept && s.translation) ? undefined : 'nothing translated'
    ),
    ok('license status', 'license.status', () => ({}), (v) => (v.mode === 'full' ? undefined : v.message)),
    ok('models status', 'models.status', () => ({}), (v) => (v.models.every((m: { status: string }) => m.status === 'ok') ? undefined : 'a model is not ok')),
    ok('packs list', 'packs.list', () => ({}), (v) => (v.length > 0 ? undefined : 'no packs')),
    ok('activity log intact', 'logs.status', () => ({}), (v) =>
      expectAll([
        [v.lines > 0, 'nothing was logged'],
        [v.problems.length === 0, `${v.problems.length} problems`]
      ])
    ),
    ok('log holds metadata only', 'logs.export', () => ({}), (v) => {
      if (v.transcripts) return undefined
      const text = JSON.stringify(v.records)
      return expectAll([
        [v.records.length >= 15, `${v.records.length} records`],
        [!text.includes('"content"'), 'a record has content'],
        [!/fever|homa|kutapika|Karibu/i.test(text), 'user text in the log']
      ])
    })
  ]
}

/** The facts worth keeping from an answer, for the report. */
function factsOf(channel: string, v: any, a: SmokeAnswer): Record<string, unknown> | undefined {
  if (!v) return undefined
  switch (channel) {
    case 'translate.text':
      return { translation: v.translation, flags: v.flags }
    case 'speech.transcribe':
      return { text: v.text, audioMs: v.audioMs, transcribeMs: Math.round(v.transcribeMs) }
    case 'voice.speak':
      return { audioMs: Math.round(v.audioMs), firstAudioMs: Math.round(v.firstAudioMs) }
    case 'conversation.turn':
      return { heard: v.sourceText, translation: v.translation, firstAudioMs: Math.round(v.timings.firstAudioMs), events: a.events.map((e) => e.type) }
    case 'guide.search':
      return { status: v.status, mode: v.mode, card: v.hits?.[0]?.card.id }
    case 'guide.ask':
      return { heard: v.transcript.text, status: v.result.status }
    case 'documents.read':
      return { kind: v.kind, pages: v.pages.map((p: { source: string }) => p.source), segments: v.segments.length, readMs: Math.round(v.readMs) }
    case 'documents.translate':
      return { segments: v.segments.length, flags: v.flags, totalMs: Math.round(v.timings.totalMs) }
    case 'logs.status':
      return { lines: v.lines, problems: v.problems.length }
    case 'logs.export':
      return { records: v.records.length }
    case 'app.status':
      return { license: v.license.status, modelPack: v.models.pack.status === 'signed' ? `${v.models.pack.manifest.id}@${v.models.pack.manifest.version}` : v.models.pack.status, packs: v.packs.map((p: { id: string; version: string }) => `${p.id}@${p.version}`) }
    default:
      return undefined
  }
}

export async function runSmoke(callInRenderer: CallInRenderer, fixtures: Fixtures, opts: SmokeOptions = {}, onStep?: (r: StepResult) => void): Promise<SmokeReport> {
  const t0 = performance.now()
  const prior: Record<string, any> = {}
  const steps: StepResult[] = []
  for (const step of plan(opts)) {
    let result: StepResult
    let call: SmokeCall | undefined
    try {
      call = step.call(fixtures, prior)
      const answer = await callInRenderer(call)
      const problem = step.check(answer)
      if (answer.envelope.ok) prior[step.name] = answer.envelope.value
      const facts = factsOf(call.channel, value(answer), answer)
      result = { name: step.name, channel: call.channel, ok: !problem, ms: Math.round(answer.ms), ...(problem ? { problem } : {}), ...(facts ? { facts } : {}) }
    } catch (err) {
      result = { name: step.name, channel: call?.channel ?? '?', ok: false, ms: 0, problem: `threw: ${(err as Error).message}` }
    }
    steps.push(result)
    onStep?.(result)
  }
  const failed = steps.filter((s) => !s.ok).length
  return { ok: failed === 0, passed: steps.length - failed, failed, totalMs: Math.round(performance.now() - t0), steps }
}

/**
 * Script evaluated in the renderer for one call. Bytes go in as base64 and
 * come back as { $bytes, head }, so large audio never crosses back to main.
 */
export function rendererScript(call: SmokeCall): string {
  const encoded = JSON.stringify(call.request, (_k, v) => (v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v))
  return `(async () => {
    const request = JSON.parse(${JSON.stringify(encoded)}, (k, v) =>
      v && typeof v === 'object' && typeof v.$b64 === 'string' ? Uint8Array.from(atob(v.$b64), (c) => c.charCodeAt(0)) : v)
    const strip = (v) => {
      if (v instanceof Uint8Array) return { $bytes: v.length, head: String.fromCharCode(...v.subarray(0, 4)) }
      if (Array.isArray(v)) return v.map(strip)
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]))
      return v
    }
    const callId = 'smoke-' + Math.random().toString(36).slice(2)
    const events = []
    const off = ${call.stream ? `window.ofa.onEvent((e) => { if (e.callId === callId) events.push(strip(e)) })` : '() => {}'}
    const t0 = performance.now()
    const envelope = await window.ofa.invoke(${JSON.stringify(call.channel)}, request, { callId })
    const ms = performance.now() - t0
    off()
    return JSON.stringify({ envelope: strip(envelope), events, ms })
  })()`
}
