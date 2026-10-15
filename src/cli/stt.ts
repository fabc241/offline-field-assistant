import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { sttSpec } from '../core/catalog.js'
import type { AppConfig } from '../core/config.js'
import { isLang, qvacTranscriber } from '../core/engines.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort } from '../core/qvac.js'
import { STT_FLAG_HELP, SpeechToText } from '../features/speech/speech-service.js'
import { modelsOf, type Session } from './session.js'

const USAGE = 'Usage: ofa stt --lang en|sw [--model NAME] [--json] clip.wav [more.wav …]'

export async function sttCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      model: { type: 'string' },
      json: { type: 'boolean', default: false }
    }
  })
  const { lang } = values
  if (!lang || !isLang(lang) || positionals.length === 0) {
    console.error(USAGE)
    return false
  }
  const missing = await Promise.all(positionals.map((f) => fs.access(f).then(() => null, () => f)))
  if (missing.some(Boolean)) {
    console.error(`✖ Not found: ${missing.filter(Boolean).join(', ')}`)
    return false
  }
  if (!(await session.require('speech', 'transcribe'))) return false

  const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
  const spec = sttSpec(values.model)
  const stt = new SpeechToText(qvacTranscriber(runtime, spec))
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  try {
    // Load first, so the per-clip timings are inference only.
    const t0 = performance.now()
    await runtime.use(spec, async () => undefined)
    if (!values.json) console.error(`${spec.name} loaded in ${s(performance.now() - t0)}`)
    for (const file of positionals) {
      const t = await stt.transcribe(file, lang)
      await session.activity.record({
        feature: 'speech',
        action: 'transcribe',
        outcome: 'ok',
        langs: { from: lang },
        timings: { audioMs: t.audioMs, transcribeMs: t.transcribeMs },
        counts: { segments: t.segments.length },
        flags: t.flags,
        ...modelsOf(runtime),
        content: { transcript: t.text }
      })
      if (values.json) {
        console.log(JSON.stringify({ file, ...t }, null, 2))
        continue
      }
      if (positionals.length > 1) console.log(`\n${file}`)
      console.log(`${lang}  (${s(t.audioMs)} of audio in ${s(t.transcribeMs)}, RTF ${t.realTimeFactor.toFixed(2)})\n`)
      console.log(t.text || '—')
      for (const f of t.flags) console.log(`\n⚠ ${f}: ${STT_FLAG_HELP[f]}`)
    }
    return true
  } finally {
    await runtime.unloadAll()
  }
}
