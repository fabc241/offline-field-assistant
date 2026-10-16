import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { encodeWav } from '../core/audio.js'
import type { AppConfig } from '../core/config.js'
import { isLang, qvacSpeaker } from '../core/engines.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort } from '../core/qvac.js'
import { ReadAloud, TTS_FLAG_HELP } from '../features/voice/read-aloud.js'
import { speakerSpecs } from '../features/voice/voices.js'
import { AfplayQueue } from './player.js'
import { modelsOf, type Session } from './session.js'

const USAGE =
  'Usage: ofa speak --lang en|sw [--play] [--out FILE.wav] [--chunk-tokens N] [--raw] [--json] "text"   (no text: read stdin)'

export async function speakCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      play: { type: 'boolean', default: false },
      out: { type: 'string' },
      'chunk-tokens': { type: 'string' },
      raw: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false }
    }
  })
  const { lang } = values
  const chunkTokens = values['chunk-tokens'] === undefined ? undefined : Number(values['chunk-tokens'])
  if (!lang || !isLang(lang) || (chunkTokens !== undefined && !(Number.isInteger(chunkTokens) && chunkTokens >= 0))) {
    console.error(USAGE)
    return false
  }
  const text = positionals.length ? positionals.join(' ') : await readStdin()
  if (!text.trim()) {
    console.error(USAGE)
    return false
  }
  if (!(await session.require('read-aloud', 'speak'))) return false
  const out = path.resolve(values.out ?? path.join(config.dataDir, 'speech', `${lang}-${stamp()}.wav`))

  const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
  const spec = await speakerSpecs(config.voices, { chunkTokens })
  const reader = new ReadAloud(qvacSpeaker(runtime, spec))
  const player = values.play ? new AfplayQueue() : undefined
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  try {
    // Load first, so the timings are synthesis only.
    const t0 = performance.now()
    await runtime.use(spec(lang), async () => undefined)
    if (!values.json) console.error(`Chatterbox (${lang}) loaded in ${s(performance.now() - t0)}${config.voices[lang] ? `, voice ${config.voices[lang]}` : ''}`)

    const speech = await reader.speak(text, lang, { raw: values.raw, onAudio: player && ((c) => player.enqueue(c)) })
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, encodeWav(speech.samples, speech.sampleRate))
    await session.activity.record({
      feature: 'read-aloud',
      action: 'speak',
      outcome: 'ok',
      langs: { to: lang },
      timings: { audioMs: speech.audioMs, synthMs: speech.synthMs, firstAudioMs: speech.firstAudioMs, stallMs: speech.stallMs },
      counts: { parts: speech.parts.length, chars: text.length },
      detail: { voice: config.voices[lang] ? 'reference' : 'built-in', mode: values.raw ? 'raw' : 'spoken' },
      flags: speech.flags,
      ...modelsOf(runtime),
      content: { text }
    })
    if (values.json) {
      const { samples: _samples, ...rest } = speech
      console.log(JSON.stringify({ out, ...rest }, null, 2))
    } else {
      console.log(`${lang}  (${s(speech.audioMs)} of audio in ${s(speech.synthMs)}, first audio after ${s(speech.firstAudioMs)}, RTF ${speech.realTimeFactor.toFixed(2)})\n`)
      for (const p of speech.parts) console.log(`  ${p.spoken}${p.flags.length ? `  [${p.flags.join(', ')}]` : ''}`)
      console.log(`\n→ ${out}`)
      for (const f of speech.flags) console.log(`\n⚠ ${f}: ${TTS_FLAG_HELP[f]}`)
    }
    await player?.drain()
    return true
  } finally {
    await runtime.unloadAll()
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\s+$/, '')
}
