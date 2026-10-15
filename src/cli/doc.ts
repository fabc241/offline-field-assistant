import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { MODEL_SPECS } from '../core/catalog.js'
import type { AppConfig } from '../core/config.js'
import { isLang, qvacEmbedder, qvacOcr, qvacTranslator } from '../core/engines.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort } from '../core/qvac.js'
import {
  DOC_FLAG_HELP,
  DocumentService,
  type DocFlag,
  type DocPage,
  type DocSegment,
  type DocTranslation,
  type ReadDocument
} from '../features/documents/document-service.js'
import { DocumentError } from '../features/documents/input.js'
import { FLAG_HELP, TranslationService } from '../features/translate/translation-service.js'
import { modelsOf, type Session } from './session.js'

const USAGE = `Usage:
  ofa doc translate FILE --to en|sw [--out result.json] [--no-check] [--json]
                          a photo (PNG, JPEG, HEIC, …) or PDF, translated segment by segment
  ofa doc read FILE [--json]
                          the text found, without translating it`

const FLAG_TEXT: Record<DocFlag, string> = { ...DOC_FLAG_HELP, ...FLAG_HELP }
const LANG_NAME = { en: 'English', sw: 'Swahili' } as const

export async function docCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const [sub, ...rest] = args
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      out: { type: 'string' },
      'no-check': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false }
    }
  })
  const [file] = positionals
  if (!file || positionals.length > 1 || (sub !== 'read' && sub !== 'translate') || (sub === 'translate' && !(values.to && isLang(values.to)))) {
    console.error(USAGE)
    return false
  }
  if (!(await fs.stat(file).catch(() => undefined))) {
    console.error(`✖ Not found: ${file}`)
    return false
  }
  if (!(await session.require('documents', sub))) return false

  const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
  const service = new DocumentService(
    qvacOcr(runtime, MODEL_SPECS.ocr),
    // The translator and embedder load only if a segment needs them.
    new TranslationService(qvacTranslator(runtime, MODEL_SPECS.translator), qvacEmbedder(runtime, MODEL_SPECS.embedder))
  )
  try {
    const read = await service.read(file)
    const pages = { pages: read.pages.length, ocrPages: read.pages.filter((p) => p.source === 'ocr').length }
    if (sub === 'read') {
      await session.activity.record({
        feature: 'documents',
        action: 'read',
        outcome: 'ok',
        timings: { readMs: read.readMs },
        counts: { ...pages, segments: read.segments.length },
        detail: { kind: read.kind },
        ...modelsOf(runtime),
        content: { text: read.segments.map((x) => x.text).join('\n') }
      })
      if (values.json) return printJson(read)
      printRead(read)
      return true
    }

    const to = values.to as 'en' | 'sw'
    if (!values.json) {
      printPages(read.pages)
      console.log(`→ ${LANG_NAME[to]}${values['no-check'] ? '' : ' (each segment back-translated and checked)'}`)
    }
    const result = await service.translate(read, to, {
      check: !values['no-check'],
      onSegment: values.json ? undefined : (s, i, n) => printSegment(s, i, n, read.pages.length > 1)
    })
    await session.activity.record({
      feature: 'documents',
      action: 'translate',
      outcome: 'ok',
      langs: { to },
      timings: result.timings,
      counts: { ...pages, segments: result.segments.length, kept: result.segments.filter((x) => x.kept).length },
      detail: { kind: result.kind, check: values['no-check'] ? 'off' : 'on' },
      flags: result.flags,
      ...modelsOf(runtime),
      content: {
        original: result.segments.map((x) => x.original).join('\n'),
        translation: result.segments.map((x) => x.translation).join('\n')
      }
    })
    if (values.out) {
      await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true })
      await fs.writeFile(values.out, JSON.stringify(result, null, 2) + '\n')
    }
    if (values.json) return printJson(result)
    printSummary(result, values.out)
    return true
  } catch (err) {
    if (!(err instanceof DocumentError)) throw err
    console.error(`✖ ${err.message}`)
    return false
  } finally {
    await runtime.unloadAll()
  }
}

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function printPages(pages: DocPage[]) {
  for (const p of pages) {
    console.log(`page ${p.page}: ${p.source === 'ocr' ? 'OCR' : 'text layer'} (${s(p.readMs)})`)
  }
}

function printRead(read: ReadDocument) {
  printPages(read.pages)
  if (!read.segments.length) return noText()
  for (const seg of read.segments) {
    const conf = seg.ocrConfidence === null ? '' : `  [${seg.ocrConfidence.toFixed(2)}]`
    console.log(`\n${read.pages.length > 1 ? `p${seg.page} ` : ''}${seg.text}${conf}`)
  }
}

function printSegment(seg: DocSegment, i: number, n: number, pages: boolean) {
  const where = `${pages ? `p${seg.page} ` : ''}${i + 1}/${n}`
  console.log(`\n${where}  ${seg.original}`)
  if (seg.kept === 'target-language') console.log('   = already in the target language')
  else if (seg.kept === 'no-words') console.log('   = nothing to translate')
  else console.log(`   → ${seg.translation}`)
  if (seg.backTranslation && seg.flags.some((f) => f !== 'low-confidence')) console.log(`   ↩ ${seg.backTranslation}`)
  if (seg.flags.length) console.log(`   ⚠ ${seg.flags.join(', ')}${seg.ocrConfidence !== null && seg.flags.includes('low-confidence') ? ` (OCR ${seg.ocrConfidence.toFixed(2)})` : ''}`)
}

function printSummary(r: DocTranslation, out?: string) {
  if (!r.segments.length) noText()
  const t = r.timings
  console.log(`\n${r.segments.length} segments, ${r.pages.length} page${r.pages.length > 1 ? 's' : ''} in ${s(t.totalMs)} (read ${s(t.readMs)}, translate ${s(t.translateMs)}, check ${s(t.checkMs)})`)
  if (out) console.log(`Saved ${out}`)
  if (!r.flags.length) return
  console.log('\n⚠ Check before relying on this translation:')
  for (const f of r.flags) console.log(`  • ${f} (${r.segments.filter((x) => x.flags.includes(f)).length}): ${FLAG_TEXT[f]}`)
}

function noText() {
  console.log('\nNo text found. Photograph the page flat, in good light, filling the frame.')
}

function printJson(value: unknown): true {
  console.log(JSON.stringify(value, null, 2))
  return true
}
