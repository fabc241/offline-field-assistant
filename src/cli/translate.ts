import { parseArgs } from 'node:util'
import type { AppConfig } from '../core/config.js'
import { isLang, qvacEmbedder, qvacTranslator, type Lang } from '../core/engines.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort } from '../core/qvac.js'
import { FLAG_HELP, TranslationService, type CheckedTranslation } from '../features/translate/translation-service.js'
import { modelsOf, type Session } from './session.js'

const USAGE = 'Usage: ofa translate --from en|sw --to sw|en [--plain] [--json] "text"   (no text: read stdin)'

export async function translateCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      plain: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false }
    }
  })
  const { from, to } = values
  if (!from || !to || !isLang(from) || !isLang(to)) {
    console.error(USAGE)
    return false
  }
  const text = positionals.length ? positionals.join(' ') : await readStdin()
  if (!text.trim()) {
    console.error(USAGE)
    return false
  }
  if (!(await session.require('translate', 'translate'))) return false

  const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
  const service = new TranslationService(qvacTranslator(runtime), qvacEmbedder(runtime))
  try {
    if (values.plain) {
      const plain = await service.translate(text, from, to)
      console.log(plain.translation)
      await session.activity.record({
        feature: 'translate',
        action: 'translate-plain',
        outcome: 'ok',
        langs: { from, to },
        timings: { translateMs: plain.translateMs },
        counts: { sentences: plain.sentences.length, chars: text.length },
        ...modelsOf(runtime),
        content: { source: text, translation: plain.translation }
      })
      return true
    }
    const result = await service.translateWithCheck(text, from, to)
    await session.activity.record({
      feature: 'translate',
      action: 'translate',
      outcome: 'ok',
      langs: { from, to },
      timings: result.timings,
      counts: { sentences: result.sentences.length, chars: text.length },
      flags: result.flags,
      ...modelsOf(runtime),
      content: { source: text, translation: result.translation, backTranslation: result.backTranslation }
    })
    if (values.json) {
      const { lines: _layout, ...rest } = result
      console.log(JSON.stringify(rest, null, 2))
    } else {
      printChecked(result, from, to)
    }
    return true
  } finally {
    await runtime.unloadAll()
  }
}

function printChecked(r: CheckedTranslation, from: Lang, to: Lang) {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  console.log(`${from} → ${to}  (translate ${s(r.timings.translateMs)}, check ${s(r.timings.backTranslateMs + r.timings.checkMs)})\n`)
  console.log(r.translation)
  console.log(`\n  back-translation  ${r.backTranslation.replace(/\n/g, '\n                    ')}`)
  console.log(`  fidelity          ${r.fidelity.toFixed(2)}`)
  const n = r.numericCheck
  const diff = [...n.translation.missing, ...n.backTranslation.missing].map((q) => `-${q}`)
  diff.push(...[...n.translation.added, ...n.backTranslation.added].map((q) => `+${q}`))
  console.log(`  numbers           ${n.source.join(', ') || '—'} ${n.ok ? '✓' : `✗ (${diff.join(' ')})`}`)

  if (r.flags.length === 0) {
    console.log('  flags             none')
    return
  }
  console.log('\n⚠ Check before relying on this translation:')
  for (const f of r.flags) console.log(`  • ${f}: ${FLAG_HELP[f]}`)
  if (r.sentences.length > 1) {
    for (const sentence of r.sentences.filter((x) => x.flags.length)) {
      console.log(`\n  "${sentence.source}"\n    → ${sentence.translation}\n    ↩ ${sentence.backTranslation}  [${sentence.flags.join(', ')}]`)
    }
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\s+$/, '')
}
